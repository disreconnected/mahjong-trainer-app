// Game loop: owns the game state, the logger and the bots' rngs. No DOM access, so it
// runs under Node. The UI calls createController() and re-renders in onUpdate.
import { makeRng, sortTiles } from './tiles.js';
import { createGame, legalActions, applyAction, nextDealer } from './game.js';
import { chooseAction } from './bots.js';
import { createLogger } from './logger.js';

export const DEFAULT_SETTINGS = Object.freeze({
  botLevel: 'easy',
  tileNumbers: 'chinese',
  view: '2d',
  claimHelp: true,
  sound: true,
  autoSort: false,
  botSpeed: 'normal',
  claimWindow: 20,
  autoplayHuman: false,
});

export const BOT_DELAY = Object.freeze({ slow: 1200, normal: 700, fast: 250 });

const HUMAN = 0;
const LOG_SETTING_KEYS = ['botLevel', 'claimHelp', 'claimWindow', 'tileNumbers', 'view', 'botSpeed', 'autoSort'];
// Settings that apply to a game in progress (updateSettings). botLevel waits for the next
// game; autoplayHuman is fixed for the game.
export const LIVE_SETTING_KEYS = Object.freeze(['tileNumbers', 'view', 'claimHelp', 'sound', 'autoSort', 'botSpeed', 'claimWindow']);
const RECENT_MAX = 30;

// Same comparison as the engine uses to match an action against legalActions().
const sameAction = (a, b) =>
  a.type === b.type && a.player === b.player && a.tile === b.tile && a.kind === b.kind &&
  JSON.stringify(a.tiles) === JSON.stringify(b.tiles);

// --- Pure helpers for the action bar (no DOM; unit-tested) ---

export const BUTTONS = Object.freeze(['hu', 'kong', 'pong', 'chi', 'pass', 'discard']);

// Which action-bar buttons are enabled: exactly the offered action types.
export function buttonStates(actions) {
  const types = new Set((actions ?? []).map((a) => a.type));
  return Object.fromEntries(BUTTONS.map((b) => [b, types.has(b)]));
}

// Chi options as full runs: { action, run: [3 codes, sorted], claimedIndex }.
export function chiChoices(actions, claimTile) {
  return (actions ?? [])
    .filter((a) => a.type === 'chi')
    .map((action) => {
      const run = sortTiles([...action.tiles, claimTile]);
      return { action, run, claimedIndex: run.indexOf(claimTile) };
    });
}

// Kong options: { action, tiles: [4 codes], kind }.
export function kongChoices(actions) {
  return (actions ?? [])
    .filter((a) => a.type === 'kong')
    .map((action) => ({ action, tiles: [action.tile, action.tile, action.tile, action.tile], kind: action.kind }));
}

/**
 * Options:
 *   settings      merged over DEFAULT_SETTINGS
 *   seed, dealer  passed to createGame
 *   rngSeed       seeds the bots' rngs (defaults to seed)
 *   onUpdate(c)   called once at start and after every applyAction
 *   schedule(fn, ms)  delay for bot moves and the claim timer; returns a handle (default setTimeout)
 *   cancel(handle)    cancels a scheduled fn (default clearTimeout)
 *   saveLog(log)  optional; called once when the game ends
 *   now           clock for the logger and the claim deadline (default Date.now)
 *   initialState  optional ready-made game state (tests rig hands with it); default createGame
 *   chooseBot     bot policy, same signature as bots.js chooseAction (tests); default chooseAction
 * Hooks for later tasks (all optional):
 *   onEvents(events, c)          after each applyAction, before onUpdate (sounds)
 *   onHumanPrompt(c, actions)    when player 0 is asked to decide
 */
export function createController({
  settings = {},
  seed,
  dealer = 0,
  rngSeed = seed,
  onUpdate = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  saveLog = null,
  now = Date.now,
  initialState = null,
  chooseBot = chooseAction,
  onEvents = null,
  onHumanPrompt = null,
} = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const state = initialState ?? createGame({ seed, dealer });
  if (initialState) rngSeed = rngSeed ?? state.seed;
  const logSettings = Object.fromEntries(LOG_SETTING_KEYS.map((k) => [k, cfg[k]]));
  const logger = createLogger({ settings: logSettings, state, now, rngSeed: rngSeed >>> 0 });
  const rngs = [0, 1, 2, 3].map((p) => makeRng(((rngSeed >>> 0) ^ Math.imul(p + 1, 0x9e3779b9)) >>> 0));

  let scheduled = false;
  let botHandle = null; // handle of the scheduled bot step
  let paused = false;
  let stopped = false; // abandoned: never moves again, never saves
  const settingsChanges = []; // [{ n, key, value }] mid-game changes, added to the log
  let decisionOpen = false; // beginDecision called for player 0, endDecision pending
  let pendingClaim = null; // { claim, action, timedOut } human answered, claim not resolved yet
  let claimTimer = null; // { handle, claim } running claim-window countdown
  let pausedClaim = null; // the claim whose timer pause() froze

  const isBot = (p) => p !== HUMAN || cfg.autoplayHuman;

  const controller = {
    state,
    settings: cfg,
    lastEvents: [],
    recentEvents: [...state.setupEvents].slice(-RECENT_MAX),
    lastDiscard: null, // { player, index } of the newest discard still on the table
    isOver: false,
    saved: null, // promise from saveLog, if any; resolves to null when saving failed
    saveError: null, // the reason, when saving failed
    // Claim-window countdown, in the `now` clock: set while player 0 is asked to claim.
    claimDeadline: null,
    claimWindowMs: 0,
    // While paused with a claim timer running: the ms that were left (deadline is null).
    claimRemainingMs: null,
    paused: false,
    stopped: false,

    humanActions() {
      if (controller.isOver || stopped || cfg.autoplayHuman) return [];
      return legalActions(state, HUMAN);
    },

    // Freezes the game: no bot moves, the claim timer stops and keeps its remaining time.
    pause() {
      if (paused || stopped) return;
      paused = true;
      controller.paused = true;
      if (scheduled) {
        if (botHandle != null) cancel(botHandle);
        botHandle = null;
        scheduled = false;
      }
      if (claimTimer) {
        const remaining = Math.max(0, controller.claimDeadline - now());
        const { claim } = claimTimer;
        stopClaimTimer();
        controller.claimRemainingMs = remaining;
        pausedClaim = claim;
      }
    },

    resume() {
      if (!paused || stopped) return;
      paused = false;
      controller.paused = false;
      const remaining = controller.claimRemainingMs;
      controller.claimRemainingMs = null;
      const claim = pausedClaim;
      pausedClaim = null;
      if (remaining != null && !controller.isOver && state.claim === claim && !(HUMAN in claim.responses)) {
        startClaimTimer(remaining);
      }
      advance();
    },

    // Abandons the game: cancels everything pending; no further moves, no log is saved.
    stop() {
      if (stopped) return;
      if (botHandle != null) cancel(botHandle);
      botHandle = null;
      scheduled = false;
      stopClaimTimer();
      stopped = true;
      controller.stopped = true;
    },

    // Applies settings to the game in progress (LIVE_SETTING_KEYS only; others are ignored
    // here) and records each real change for the log as { n, key, value }.
    updateSettings(patch = {}) {
      for (const key of LIVE_SETTING_KEYS) {
        if (!(key in patch) || cfg[key] === patch[key]) continue;
        cfg[key] = patch[key];
        if (!controller.isOver && !stopped) settingsChanges.push({ n: state.eventCount, key, value: patch[key] });
      }
    },

    // True when player 0 has answered the open claim and others are still answering.
    waitingForOthers() {
      return !controller.isOver && state.phase === 'claim' && HUMAN in state.claim.responses;
    },

    // Applies player 0's action. opts.timedOut marks the claim-window auto-pass.
    act(action, { timedOut = false } = {}) {
      if (controller.isOver) throw new Error('game is over');
      if (stopped) throw new Error('game was abandoned');
      if (paused) throw new Error('game is paused');
      if (cfg.autoplayHuman) throw new Error('player 0 is on autoplay');
      if (!action || action.player !== HUMAN) throw new Error('act() is for player 0 only');
      applyHuman(action, timedOut);
      advance();
    },

    log() {
      return fullLog();
    },
  };

  // The logger's log plus, when settings changed mid-game, settingsChanges.
  function fullLog() {
    const log = logger.toJSON();
    if (settingsChanges.length) log.settingsChanges = settingsChanges.map((c) => ({ ...c }));
    return log;
  }

  function track(events) {
    for (const e of events) {
      if (e.type === 'discard') {
        controller.lastDiscard = { player: e.player, index: state.players[e.player].discards.length - 1 };
      } else if (e.from != null && ['chi', 'pong', 'kong', 'hu'].includes(e.type) && e.kind !== 'robkong') {
        controller.lastDiscard = null; // the discard was taken off the table
      }
    }
    // A discard that is no longer where we recorded it was claimed.
    const ld = controller.lastDiscard;
    if (ld && state.players[ld.player].discards.length <= ld.index) controller.lastDiscard = null;
    controller.recentEvents = [...controller.recentEvents, ...events].slice(-RECENT_MAX);
  }

  function apply(action) {
    const events = applyAction(state, action); // throws on illegal actions
    controller.lastEvents = events;
    logger.record(events);
    track(events);
    if (pendingClaim && state.claim !== pendingClaim.claim) {
      logger.endDecision(state, pendingClaim.action, { timedOut: pendingClaim.timedOut });
      pendingClaim = null;
      decisionOpen = false;
    }
    if (state.phase === 'ended' && !controller.isOver) finishGame();
    // Open player 0's next decision (and its claim timer) before the UI renders this state.
    if (!controller.isOver) openDecision();
    if (onEvents) onEvents(events, controller);
    onUpdate(controller);
  }

  function openDecision() {
    if (decisionOpen || pendingClaim) return;
    const actions = legalActions(state, HUMAN);
    if (!actions.length) return;
    logger.beginDecision(state, actions);
    decisionOpen = true;
    if (!cfg.autoplayHuman && state.phase === 'claim') startClaimTimer();
    if (!cfg.autoplayHuman && onHumanPrompt) onHumanPrompt(controller, actions);
  }

  // Claim phase only: pass automatically when settings.claimWindow seconds run out.
  // `remaining` restarts a timer frozen by pause() (claimWindowMs is kept).
  function startClaimTimer(remaining = null) {
    let ms = remaining;
    if (ms == null) {
      const seconds = Number(cfg.claimWindow);
      if (!(seconds > 0)) return;
      ms = seconds * 1000;
      controller.claimWindowMs = ms;
    }
    const claim = state.claim;
    controller.claimDeadline = now() + ms;
    claimTimer = { claim, handle: null };
    const timer = claimTimer;
    timer.handle = schedule(() => {
      if (claimTimer !== timer) return; // cancelled, or a later decision owns the timer
      claimTimer = null;
      controller.claimDeadline = null;
      if (controller.isOver || state.claim !== claim || HUMAN in claim.responses) return;
      try {
        controller.act({ type: 'pass', player: HUMAN }, { timedOut: true });
      } catch (err) {
        console.error('Claim-window auto-pass failed:', err);
      }
    }, ms);
  }

  function stopClaimTimer() {
    if (claimTimer) {
      const { handle } = claimTimer;
      claimTimer = null;
      if (handle != null) cancel(handle);
    }
    controller.claimDeadline = null;
  }

  function applyHuman(action, timedOut) {
    openDecision(); // normally already open; harmless otherwise
    if (!legalActions(state, HUMAN).some((a) => sameAction(a, action))) {
      throw new Error(`illegal action: ${JSON.stringify(action)}`); // keeps the claim timer running
    }
    stopClaimTimer();
    const claim = state.phase === 'claim' ? state.claim : null;
    if (claim) pendingClaim = { claim, action, timedOut };
    try {
      apply(action);
    } catch (err) {
      if (claim) pendingClaim = null;
      throw err;
    }
    if (claim) return;
    if (state.phase === 'claim' && state.claim.robKong && state.claim.from === HUMAN) {
      // Our added Kong may be robbed: log the decision once that claim resolves.
      pendingClaim = { claim: state.claim, action, timedOut };
      return;
    }
    logger.endDecision(state, action, { timedOut });
    decisionOpen = false;
  }

  // Whoever must act next and is played by a bot, or null.
  function nextBot() {
    if (state.phase === 'turn') return isBot(state.turn) ? state.turn : null;
    if (state.phase === 'claim') {
      const { options, responses, from } = state.claim;
      for (let k = 1; k <= 3; k++) {
        const p = (from + k) % 4;
        if (options[p] && !(p in responses) && isBot(p)) return p;
      }
    }
    return null;
  }

  function step() {
    scheduled = false;
    botHandle = null;
    if (controller.isOver || paused || stopped) return;
    const p = nextBot();
    if (p === null) return;
    const actions = legalActions(state, p);
    const action = chooseBot(state, p, cfg.botLevel, actions, rngs[p]);
    if (p === HUMAN) applyHuman(action, false);
    else apply(action);
    advance();
  }

  function advance() {
    if (controller.isOver || stopped) return;
    openDecision(); // player 0 may need to decide now (logged even on autoplay)
    if (paused || scheduled || nextBot() === null) return;
    scheduled = true;
    const handle = schedule(step, BOT_DELAY[cfg.botSpeed] ?? BOT_DELAY.normal);
    if (scheduled) botHandle = handle; // an immediate scheduler has already run the step
  }

  function finishGame() {
    controller.isOver = true;
    stopClaimTimer();
    logger.finish(state);
    if (saveLog) {
      controller.saved = Promise.resolve()
        .then(() => saveLog(fullLog()))
        .catch((err) => {
          console.warn('Could not save the game log:', err);
          controller.saveError = err; // read by the end screen when saved resolves to null
          return null;
        });
    }
  }

  onUpdate(controller);
  advance();
  return controller;
}

export const randomSeed = () => Math.floor(Math.random() * 2 ** 32) >>> 0;

/**
 * A run of games: the current controller plus an in-memory tally.
 * Options are createController's, plus makeSeed() for later games (default random).
 * onUpdate(controller, session) is called like createController's.
 * newGame() starts the next game with dealer = nextDealer(previous state) and a new seed.
 */
export function createSession({
  makeSeed = randomSeed, seed, dealer = 0, onUpdate = () => {}, settings = {}, ...opts
} = {}) {
  const nextSettings = { ...settings }; // settings for games started from now on
  const session = {
    controller: null,
    tally: { played: 0, wins: 0 },
    gameNumber: 0, // 1 for the first game; counts every game started, abandoned ones too
    // The settings the next game will start with.
    get settings() {
      return { ...nextSettings };
    },
    // { abandon: true } stops a game in progress (no log, not counted; the dealer stays).
    newGame({ abandon = false } = {}) {
      const prev = session.controller;
      if (!prev.isOver) {
        if (!abandon) throw new Error('the current game has not ended');
        prev.stop();
        return start(makeSeed() >>> 0, prev.state.dealer);
      }
      return start(makeSeed() >>> 0, nextDealer(prev.state));
    },
    // Changes settings: live ones apply to the current game now, all apply to later games.
    setSettings(patch) {
      Object.assign(nextSettings, patch);
      session.controller.updateSettings(patch);
    },
  };

  function start(gameSeed, gameDealer) {
    let counted = false;
    session.gameNumber += 1;
    session.controller = createController({
      ...opts,
      settings: { ...nextSettings },
      seed: gameSeed,
      dealer: gameDealer,
      rngSeed: gameSeed,
      onUpdate: (c) => {
        if (c.isOver && !counted) {
          counted = true;
          const r = c.state.result;
          session.tally = {
            played: session.tally.played + 1,
            wins: session.tally.wins + (r && r.type === 'win' && r.winner === HUMAN ? 1 : 0),
          };
        }
        onUpdate(c, session);
      },
    });
    return session.controller;
  }

  start(seed, dealer);
  return session;
}
