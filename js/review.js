// Game review: replays a saved log through the real engine and grades player 0's decisions.
// No DOM; imports under Node and in the browser. See docs/contract.md "review.js".
import { ALL_CODES, buildWall, isBonus, isSuit, rankOf, sortTiles, suitOf } from './tiles.js';
import { shanten, waits as waitsOf, isWin, chiOptions } from './rules.js';
import { createGame, legalActions, applyAction, seatWind } from './game.js';
import { resultHeadline, resultSubline, NAMES } from './endscreen.js';
import { tileLabel } from './tileart.js';
import { discardRisk, threats, riskIndex, RISK_LEVELS } from './safety.js';

/** Version of the analysis itself (not of the log): bump when grading changes. */
export const REVIEW_VERSION = 15;

/**
 * Grading thresholds, in one place (tuning pass, from the study in docs/review-tuning.md).
 * Same distance from ready: a throw is 'fine' when it keeps at most max(fineAbs, fineRel x the
 * best's useful tiles) fewer useful tiles; claims use the same band. A speed inaccuracy's gapSize
 * is 'large' when it loses more than largeRel of the best's useful tiles, 'moderate' above
 * moderateRel, else 'small'. A passed Chi/Pong whose same-distance gain is 'large' (the taken count
 * is the base) is an inaccuracy unless player 0 is threatened (AD1) or the offer is a Pong that would use the hand's only
 * pair and leave mostly single-tile waits (AE1). longThinkMs: a long think (summary.longEqualThinks, on equal or nearly
 * equal choices). slowThinkMs: a slow decision for the pace line (summary.slowThinks, V2).
 */
export const GRADING = Object.freeze({ fineAbs: 3, fineRel: 0.2, moderateRel: 0.25, largeRel: 0.4, longThinkMs: 20000, slowThinkMs: 30000 });

/** The fine band for a useful-tile gap, given the larger of the two counts. */
export const fineGap = (bigger) => Math.max(GRADING.fineAbs, GRADING.fineRel * bigger);

/** 'small' | 'moderate' | 'large': how much of the best's useful tiles a same-distance throw lost. */
export function gapSizeOf(bestAcceptance, chosenAcceptance) {
  const rel = bestAcceptance > 0 ? (bestAcceptance - chosenAcceptance) / bestAcceptance : 0;
  if (rel > GRADING.largeRel) return 'large';
  if (rel > GRADING.moderateRel) return 'moderate';
  return 'small';
}

const HUMAN = 0;
const TILE_CODES = ALL_CODES.filter((c) => !isBonus(c));
const PRIORITY = { hu: 3, kong: 2, pong: 2, chi: 1, pass: 0 };
const VERDICTS = ['best', 'fine', 'inaccuracy', 'mistake'];
const LABELS = { best: 'Best', fine: 'Fine', inaccuracy: 'Inaccuracy', mistake: 'Mistake' };

/** 'Inaccuracy', or 'Inaccuracy (large)' with gapSize 'large'. */
export function verdictLabel(verdict, gapSize = null) {
  if (verdict === 'inaccuracy' && gapSize === 'large') return 'Inaccuracy (large)';
  return LABELS[verdict] ?? '';
}

class Divergence extends Error {}
const fail = (msg) => { throw new Divergence(msg); };

const clone = (v) => JSON.parse(JSON.stringify(v));

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const sameAction = (a, b) =>
  a.type === b.type && a.player === b.player && a.tile === b.tile && a.kind === b.kind &&
  JSON.stringify(a.tiles) === JSON.stringify(b.tiles);

const countIn = (tiles, code) => tiles.reduce((n, t) => n + (t === code), 0);

function without(hand, tiles) {
  const out = [...hand];
  for (const t of tiles) {
    const i = out.indexOf(t);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

// --- wording ---

// "3 tiles from ready", "1 tile from ready", "ready (one tile from winning)".
export function distanceWords(s) {
  if (s < 0) return 'a winning hand';
  if (s === 0) return 'ready (one tile from winning)';
  return `${s} tile${s === 1 ? '' : 's'} from ready`;
}

function worseCost(chosen, best) {
  // "Kept you 4 tiles from ready instead of 3"
  if (best === 0) return `You could have been ready (one tile from winning); this throw kept you ${distanceWords(chosen)}.`;
  const tail = best >= 1 ? String(best) : distanceWords(best);
  return `Kept you ${distanceWords(chosen)} instead of ${tail}`;
}

/** "1 useful tile", "8 useful tiles" (Z3: every useful-tile count is worded through this). */
export const usefulTiles = (n) => `${n} useful tile${n === 1 ? '' : 's'}`;

// W1: the cost line of a claim graded fine, said neutrally (either choice was fine).
// "Either was fine: taking it added 3 useful tiles (17 instead of 14) but did not bring you closer"
function fineClaimCost(taken, withClaim, withoutClaim) {
  const n = withClaim - withoutClaim;
  const tiles = `${usefulTiles(n)} (${withClaim} instead of ${withoutClaim})`;
  return taken
    ? `Either was fine: taking it added ${tiles} but did not bring you closer`
    : `Either was fine: taking it would have added ${tiles} but not brought you closer`;
}

// AD1: a pass that gave up a large gain at the same distance.
// "Taking it would have added 21 useful tiles (37 instead of 16) at the same distance; opening the hand costs nothing by itself"
function largeClaimCost(withClaim, withoutClaim) {
  return `Taking it would have added ${usefulTiles(withClaim - withoutClaim)} (${withClaim} instead of ${withoutClaim}) at the same distance; ` +
    'opening the hand costs nothing by itself';
}

// AE1: a pass that gave up a large gain by not Ponging the hand's only pair, 1 from ready, when the Pong would
// have left mostly single-tile waits.
// "Either was fine: taking it would have added 11 useful tiles (26 instead of 15), but it would have used your only pair,
// so most of the new ready hands would wait on a single tile"
function pairPongCost(withClaim, withoutClaim) {
  return `Either was fine: taking it would have added ${usefulTiles(withClaim - withoutClaim)} (${withClaim} instead of ${withoutClaim}), ` +
    'but it would have used your only pair, so most of the new ready hands would wait on a single tile';
}

/**
 * onlyRealPairOf(hand, meldCount) -> the code of the hand's only pair, or null: the one code held exactly twice
 * among realPairs (the keep-a-pair notion; lessons.js onlyPair is this with a meldCount).
 */
export function onlyRealPairOf(hand, meldCount) {
  const pairs = realPairs(hand, meldCount).filter((c) => countIn(hand, c) === 2);
  return pairs.length === 1 ? pairs[0] : null;
}

// AE1: the share of a hand's useful-tile weight (the live copies of each useful draw) that reaches a ready hand whose
// best wait (the throw leaving the most live winning tiles, the first on a tie) is a single tile code. The hand is
// 1 from ready (3k+1 tiles); counts are player 0's visible counts.
function singleWaitShare(hand, meldCount, counts) {
  let weight = 0;
  let single = 0;
  for (const { tile, live } of acceptance(hand, meldCount, 1, counts).accepts) {
    if (live <= 0) continue;
    const seen = new Map(counts).set(tile, (counts.get(tile) || 0) + 1);
    const drawn = [...hand, tile];
    let best = null;
    for (const d of new Set(drawn)) {
      const rest = without(drawn, [d]);
      if (shanten(rest, meldCount) !== 0) continue;
      const codes = waitsOf(rest, meldCount);
      const size = codes.reduce((n, c) => n + liveOf(seen, c), 0);
      if (!best || size > best.size) best = { size, one: codes.length === 1 };
    }
    if (best) {
      weight += live;
      if (best.one) single += live;
    }
  }
  return weight ? single / weight : 0;
}

// AE1: passing a Pong of the hand's only pair (onlyRealPairOf is the claimed tile), 1 from ready, is exempt from AD1
// when the Pong would leave mostly single-tile waits: the share of its useful-tile weight reaching a single-tile
// ready wait (after the review's best follow-up discard) is above half and above the passed hand's share.
function pongCostsPairWaits(hand, meldCount, tile, counts) {
  const taken = without(hand, [tile, tile]);
  const top = discardOptions(taken, meldCount + 1, counts)[0];
  if (top.shanten !== 1) return false;
  const afterShare = singleWaitShare(without(taken, [top.tile]), meldCount + 1, counts);
  return afterShare > 0.5 && afterShare > singleWaitShare(hand, meldCount, counts);
}

// Passing a Chi or Pong that keeps the distance but adds useful tiles beyond the fine band (the best such
// offer): fine with the neutral sentence (W1), or, when the gap is large (AD1: gapSizeOf with the taken count
// as the base, as a discard gap uses the best's), an inaccuracy. Not while player 0 is threatened: "opening
// the hand costs nothing by itself" is false then (fewer concealed tiles to fold with, and the discard the
// claim forces is not weighed for risk), so the pass stays fine. AE1: a Pong that uses the hand's only pair and
// would leave mostly single-tile waits (`pongCostsOnlyPairWaits`, the claim step's flag, only set 1 from ready)
// is not judged by AD1: its extra useful tiles mostly buy single-tile waits, so opening the hand did cost
// something. Offers are judged one by one, so a large Chi still makes the pass an inaccuracy. Shared by
// gradeClaim and gradeClaimChoice.
function richerPassOf(offers, before, passedAcceptance, threatened, pongCostsOnlyPairWaits) {
  const richer = offers
    .filter((o) => (o.action.type === 'chi' || o.action.type === 'pong') && o.shantenIfTaken === before &&
      o.acceptanceIfTaken - passedAcceptance > fineGap(o.acceptanceIfTaken))
    .sort((a, b) => b.acceptanceIfTaken - a.acceptanceIfTaken);
  if (!richer.length) return null;
  const large = (o) => gapSizeOf(o.acceptanceIfTaken, passedAcceptance) === 'large';
  const result = (o, verdict, cost) => ({ verdict, cost, loss: { shanten: 0, acceptance: o.acceptanceIfTaken - passedAcceptance } });
  if (!threatened) {
    const judged = richer.find((o) => large(o) && !(pongCostsOnlyPairWaits && o.action.type === 'pong'));
    if (judged) return result(judged, 'inaccuracy', largeClaimCost(judged.acceptanceIfTaken, passedAcceptance));
    // The best offer is large but is the exempt Pong (a large offer that is not would have been judged above).
    if (large(richer[0])) return result(richer[0], 'fine', pairPongCost(richer[0].acceptanceIfTaken, passedAcceptance));
  }
  return result(richer[0], 'fine', fineClaimCost(false, richer[0].acceptanceIfTaken, passedAcceptance));
}

// "This Kong left you 2 tiles from ready instead of 1"; when the hand was ready, said without nesting.
function kongCost(after, before) {
  if (before === 0) return `You were ready (one tile from winning); this Kong left you ${distanceWords(after)}`;
  return `This Kong left you ${distanceWords(after)} instead of ${distanceWords(before)}`;
}

// Convention for a missed win (Hu offered, something else chosen), on discard, claim and Kong
// steps alike: loss.shanten is larger than any real shanten gap (shanten runs from -1 to 8), so
// summary.costliest always ranks a missed win first.
const MISSED_WIN_LOSS = { shanten: 10, acceptance: 0 };

// --- tile counting from player 0's point of view ---

// Copies of each code player 0 can see: own hand, every discard on the table, every meld
// (other players' concealed Kongs included: the UI shows two of their tiles face up, so the
// code is known, and a Kong holds all four copies).
function visibleCounts(table) {
  const counts = new Map();
  const add = (t) => counts.set(t, (counts.get(t) || 0) + 1);
  table.players[HUMAN].hand.forEach(add);
  for (const p of table.players) {
    p.discards.forEach(add);
    for (const m of p.melds) m.tiles.forEach(add);
  }
  return counts;
}

const liveOf = (counts, code) => Math.max(0, 4 - (counts.get(code) || 0));

// Tiles that would lower the shanten of a 3k+1 hand, with their live counts.
function acceptance(hand, meldCount, sh, counts) {
  const accepts = [];
  let total = 0;
  const h = [...hand];
  for (const c of TILE_CODES) {
    if (countIn(hand, c) >= 4) continue; // a fifth copy does not exist
    h.push(c);
    if (shanten(h, meldCount) < sh) {
      const live = liveOf(counts, c);
      accepts.push({ tile: c, live });
      total += live;
    }
    h.pop();
  }
  return { acceptance: total, accepts };
}

// Every distinct discard from a 3k+2 hand: [{ tile, shanten, acceptance, accepts }], best first.
function discardOptions(hand, meldCount, counts, tiles = [...new Set(hand)]) {
  const opts = tiles.map((tile) => {
    const rest = without(hand, [tile]);
    const sh = shanten(rest, meldCount);
    return { tile, shanten: sh, ...acceptance(rest, meldCount, sh, counts) };
  });
  opts.sort((a, b) => a.shanten - b.shanten || b.acceptance - a.acceptance || ALL_CODES.indexOf(a.tile) - ALL_CODES.indexOf(b.tile));
  return opts;
}

// --- replay ---

function tableSnapshot(state, lastDiscard) {
  return {
    players: state.players.map((p) => ({
      hand: sortTiles(p.hand),
      melds: clone(p.melds),
      flowers: [...p.flowers],
      discards: [...p.discards],
    })),
    dealer: state.dealer,
    turnPlayer: state.turn,
    lastDiscard: lastDiscard ? { ...lastDiscard } : null,
    wallCount: state.wall.length,
  };
}

// The log as it would read with every tile relabelled by f (code -> code), for a disguised replay. Only what
// replay() and the grading read is mapped: the wall, the events, the chosen actions, the result and the final
// hands. Arrays the engine keeps sorted (chi/pong melds, a chi's two tiles, hands) are sorted again, since
// the relabelling changes the order; the deal's tiles are in wall order and stay so.
function mapLogTiles(log, f) {
  if (!log || typeof log !== 'object') return log;
  const mapTiles = (tiles) => tiles.map(f);
  const mapEvent = (e) => {
    if (!e || typeof e !== 'object') return e;
    const out = { ...e };
    if (typeof e.tile === 'string') out.tile = f(e.tile);
    if (Array.isArray(e.tiles)) out.tiles = e.type === 'chi' || e.type === 'pong' ? sortTiles(mapTiles(e.tiles)) : mapTiles(e.tiles);
    return out;
  };
  const mapDecision = (d) => {
    if (!d || typeof d !== 'object' || !d.chosen || typeof d.chosen !== 'object') return d;
    const chosen = { ...d.chosen };
    if (typeof chosen.tile === 'string') chosen.tile = f(chosen.tile);
    if (Array.isArray(chosen.tiles)) chosen.tiles = sortTiles(mapTiles(chosen.tiles));
    return { ...d, chosen };
  };
  const mapped = { ...log };
  if (Array.isArray(log.wall)) mapped.wall = mapTiles(log.wall);
  if (Array.isArray(log.events)) mapped.events = log.events.map(mapEvent);
  if (Array.isArray(log.decisions)) mapped.decisions = log.decisions.map(mapDecision);
  if (log.result && typeof log.result === 'object' && typeof log.result.tile === 'string') mapped.result = { ...log.result, tile: f(log.result.tile) };
  if (Array.isArray(log.finalHands)) mapped.finalHands = log.finalHands.map((h) => (Array.isArray(h) ? sortTiles(mapTiles(h)) : h));
  return mapped;
}

// Replays the log. Calls back with the raw material for every player-0 decision. `tileMap` (optional): the log
// has already been relabelled by it (mapLogTiles), so the wall is the seed's wall under the same relabelling.
function replay(log, tileMap) {
  if (!log || typeof log !== 'object') fail('not a log object');
  if (!Number.isInteger(log.seed) || log.seed < 0) fail('log has no valid seed');
  if (![0, 1, 2, 3].includes(log.dealer)) fail('log has no valid dealer');
  if (!Array.isArray(log.events) || !Array.isArray(log.decisions)) fail('log has no events or decisions');
  const wall = tileMap ? buildWall(log.seed).map(tileMap) : buildWall(log.seed);
  if (log.wall && !deepEqual(wall, log.wall)) fail('the wall does not match the seed');

  const state = createGame({ seed: log.seed, dealer: log.dealer, wall });
  const ev = log.events;
  const setup = state.setupEvents.length;
  if (!deepEqual(clone(state.setupEvents), ev.slice(0, setup))) fail('the deal does not match the log');

  const decisions = [];
  const timeline = [];
  let ptr = setup;
  let di = 0;
  let turns = 0;
  let continuesTurn = false;
  let lastDiscard = null;
  let pendingAfter = null; // decision waiting for its "after" state (robbable added Kong)
  let prevHands = null;
  const history = []; // every discard in order: { n, player, tile, claimedBy, claimedAs } (claimed ones included)
  const hiddenReady = []; // X2: opponents ready with no melds: { player, n, wallLeft, waits, later }, in the order it began
  const followed = [null, null, null, null]; // Y2: each opponent's hiddenReady entry while it stays ready

  const pushTimeline = () => {
    const key = JSON.stringify(state.players.map((p) => p.hand));
    if (key === prevHands) return;
    prevHands = key;
    const sh = state.players.map((p) => shanten(p.hand, p.melds.length));
    timeline.push({ n: state.eventCount, turn: turns, shanten: sh });
    // X2, HIDDEN INFORMATION: the first moment each opponent held a ready hand (13 concealed tiles,
    // the turn's throw made) while showing no sets: the throw that made it ready (one batch of events
    // can run on to the next draw), or the deal. Y2: while it stays ready (sets shown later included),
    // each change of its waits is added to `later` with the sets it showed then.
    for (let p = 1; p < 4; p++) {
      const pl = state.players[p];
      if (pl.hand.length % 3 !== 1) continue;
      if (sh[p] !== 0) {
        followed[p] = null;
        continue;
      }
      const thrown = ev.slice(0, ptr).findLast((e) => e.type === 'discard' && e.player === p);
      const at = (after) => (thrown && thrown.n > after
        ? { n: thrown.n, wallLeft: thrown.wallLeft } : { n: state.eventCount, wallLeft: state.wall.length });
      if (!pl.melds.length && !hiddenReady.some((h) => h.player === p)) {
        followed[p] = { player: p, ...at(-1), waits: waitsOf(pl.hand, 0), later: [] };
        hiddenReady.push(followed[p]);
      } else if (followed[p]) {
        const h = followed[p];
        const last = h.later.at(-1) ?? h;
        const waits = waitsOf(pl.hand, pl.melds.length);
        if (!deepEqual(waits, last.waits)) h.later.push({ ...at(last.n), waits, sets: pl.melds.length });
      }
    }
  };

  const run = (action) => {
    const from = ptr;
    let produced;
    try {
      produced = applyAction(state, action);
    } catch (err) {
      fail(`event ${ev[from]?.n ?? '?'}: the logged action is illegal here (${err.message})`);
    }
    if (!deepEqual(clone(produced), ev.slice(from, from + produced.length))) {
      fail(`event ${ev[from]?.n ?? '?'}: the replay produced different events than the log`);
    }
    ptr += produced.length;
    for (const e of produced) {
      if (e.type === 'discard') {
        lastDiscard = { player: e.player, tile: e.tile };
        history.push({ n: e.n, player: e.player, tile: e.tile, claimedBy: null, claimedAs: null });
      } else if (e.from != null && ['chi', 'pong', 'kong', 'hu'].includes(e.type) && e.kind !== 'robkong') {
        lastDiscard = null;
        if (history.length) Object.assign(history[history.length - 1], { claimedBy: e.player, claimedAs: e.type });
      }
    }
    pushTimeline();
  };

  const finishAfter = (dec) => {
    const { hand, melds } = state.players[HUMAN];
    dec.handAfter = [...hand];
    dec.meldsAfter = clone(melds);
  };

  const nextDecision = () => {
    const d = log.decisions[di++];
    if (!d) fail('the log has fewer decisions than the replay needs');
    if (!d.chosen || d.chosen.player !== HUMAN) fail(`decision ${di}: no valid chosen action`);
    return d;
  };

  pushTimeline();
  let guard = 0;
  while (state.phase !== 'ended') {
    if (guard++ > 5000) fail('the replay does not end');
    if (ptr >= ev.length) fail('the log ends before the game does');
    if (pendingAfter && !(state.phase === 'claim' && state.claim.robKong && state.claim.from === HUMAN)) {
      finishAfter(pendingAfter);
      pendingAfter = null;
    }

    if (state.phase === 'turn') {
      const p = state.turn;
      let action;
      let dec = null;
      if (p === HUMAN) {
        const d = nextDecision();
        if (d.kind !== 'turn') fail(`decision ${di}: expected a turn decision`);
        if (!continuesTurn) turns += 1;
        dec = {
          log: d,
          kind: 'turn',
          turn: turns,
          wallLeft: state.wall.length,
          drew: state.lastDraw ?? null,
          claimTile: null,
          claimFrom: null,
          robKong: false,
          offered: legalActions(state, HUMAN),
          afterClaim: state.afterClaim,
          table: tableSnapshot(state, lastDiscard),
          wall: [...state.wall],
          history: history.map((h) => ({ ...h })),
        };
        action = clone(d.chosen);
        continuesTurn = action.type === 'kong';
      } else {
        const e = ev[ptr];
        if (e.type === 'discard') action = { type: 'discard', player: p, tile: e.tile };
        else if (e.type === 'hu' && e.kind === 'selfdraw') action = { type: 'hu', player: p };
        else if (e.type === 'kong' && (e.kind === 'concealed' || e.kind === 'added')) action = { type: 'kong', player: p, tile: e.tile, kind: e.kind };
        else {
          // An added Kong that opened a rob-the-Kong claim: passes, then the kong or a robkong hu.
          const k = ev.slice(ptr).find((x) => (x.type === 'kong' && x.kind === 'added') || x.kind === 'robkong');
          if (!k) fail(`event ${e.n}: unexpected ${e.type} on player ${p}'s turn`);
          action = { type: 'kong', player: p, tile: k.tile, kind: 'added' };
        }
      }
      run(action);
      if (dec) {
        // V4: player 0's own discard entry, filled in later if an opponent claims it.
        if (action.type === 'discard') dec.ownDiscard = history[history.length - 1];
        decisions.push(dec);
        if (state.phase === 'claim' && state.claim.robKong && state.claim.from === HUMAN) pendingAfter = dec;
        else finishAfter(dec);
      }
      continue;
    }

    // Claim phase: logged passes, the winning claim (if any), and claims that lost (no event).
    const cl = state.claim;
    const responders = Object.keys(cl.options).map(Number);
    let j = ptr;
    const passers = [];
    while (ev[j] && ev[j].type === 'pass') passers.push(ev[j++].player);
    const res = ev[j];
    const winEv = res && ['chi', 'pong', 'kong', 'hu'].includes(res.type) && res.from === cl.from && res.player !== cl.from &&
      responders.includes(res.player) && !passers.includes(res.player) ? res : null;

    let dec = null;
    let humanAction = null;
    if (responders.includes(HUMAN)) {
      const d = nextDecision();
      if (d.kind !== 'claim') fail(`decision ${di}: expected a claim decision`);
      humanAction = clone(d.chosen);
      continuesTurn = false;
      dec = {
        log: d,
        kind: 'claim',
        turn: turns,
        wallLeft: state.wall.length,
        drew: null,
        claimTile: cl.tile,
        claimFrom: cl.from,
        robKong: cl.robKong,
        offered: legalActions(state, HUMAN),
        afterClaim: false,
        table: tableSnapshot(state, cl.robKong ? null : lastDiscard),
        wall: [...state.wall],
        history: history.map((h) => ({ ...h })),
      };
      if (passers.includes(HUMAN) !== (humanAction.type === 'pass')) fail(`decision ${di}: the logged choice does not match the events`);
    }

    const plan = passers.map((p) => (p === HUMAN ? humanAction : { type: 'pass', player: p }));
    let winnerAction = null;
    for (const p of responders) {
      if (passers.includes(p)) continue;
      const opts = cl.options[p];
      let a;
      if (p === HUMAN) {
        a = humanAction;
      } else if (winEv && winEv.player === p) {
        if (winEv.type === 'chi') {
          const used = without(winEv.tiles, [winEv.tile]);
          a = opts.find((x) => x.type === 'chi' && deepEqual(sortTiles(x.tiles), sortTiles(used)));
        } else {
          a = opts.find((x) => x.type === winEv.type);
        }
      } else {
        // A claim that lost: anything below the winner's priority (or equal and farther away).
        if (!winEv) fail(`event ${res?.n ?? '?'}: player ${p} neither passed nor claimed`);
        const dist = (q) => (q - cl.from + 4) % 4;
        const wp = PRIORITY[winEv.type];
        a = opts.find((x) => x.type !== 'pass' &&
          (PRIORITY[x.type] < wp || (PRIORITY[x.type] === wp && dist(p) > dist(winEv.player))));
      }
      if (!a) fail(`event ${res?.n ?? '?'}: no claim of player ${p} fits the log`);
      if (winEv && winEv.player === p) winnerAction = a;
      else plan.push(a);
    }
    if (winnerAction) plan.push(winnerAction);
    for (const a of plan) run(a);
    if (state.claim === cl) fail('a claim did not resolve');
    // Player 0's added Kong followed by a rob-the-Kong hu on that tile: the Kong was robbed.
    const robbedBy = ev[ptr - 1];
    if (pendingAfter && robbedBy.type === 'hu' && robbedBy.kind === 'robkong' && robbedBy.from === HUMAN &&
      robbedBy.tile === pendingAfter.log.chosen.tile) {
      pendingAfter.robbedBy = robbedBy.player;
    }
    if (dec) {
      decisions.push(dec);
      finishAfter(dec);
    }
  }
  if (pendingAfter) finishAfter(pendingAfter);
  if (ptr !== ev.length) fail(`the log has ${ev.length - ptr} events after the game ended`);
  if (di !== log.decisions.length) fail('the log has more decisions than the replay');
  if (log.result && !deepEqual(log.result, clone(state.result))) fail('the result does not match the log');
  if (log.finalHands && !deepEqual(log.finalHands, state.players.map((p) => p.hand))) fail('the final hands do not match the log');
  const last = timeline.at(-1);
  if (last.n !== state.eventCount) {
    timeline.push({ n: state.eventCount, turn: turns, shanten: [...last.shanten] });
  }
  return { state, decisions, timeline, turns, hiddenReady };
}

// --- grading ---

// The "fine" band (fineGap, above) is used by discards and claims alike.
const SEVERITY = { best: 0, fine: 1, inaccuracy: 2, mistake: 3 };
const RISK_WORD = { safe: 'safe', low: 'low risk' };
const sets = (n) => `${n} set${n === 1 ? '' : 's'}`;
// "low risk against medium" (the safer level first), shared by saferReasonOf and the tied-best risk
// tie-break.
const riskAgainst = (saferLevel, otherLevel) =>
  `${saferLevel === 'safe' ? 'safe' : `${saferLevel} risk`} against ${saferLevel === 'safe' ? `${otherLevel} risk` : otherLevel}`;

export const SAFETY_NOTES = Object.freeze({
  justified: 'Risky, but your hand was close enough to justify it',
  noSafer: 'Risky, but no safer tile was available',
  defensive: 'Sensible defensive throw: gave up some speed for safety',
});

// What player 0 could see when asked, in the shape safety.js reads (no concealed hands but their own).
function safetyView(dec, botLevel) {
  const t = dec.table;
  return {
    me: HUMAN,
    botLevel: botLevel ?? 'easy',
    hand: [...t.players[HUMAN].hand],
    players: t.players.map((p) => ({ melds: p.melds, flowers: p.flowers, discards: p.discards })),
    discardLog: dec.history.map((h) => ({ player: h.player, tile: h.tile, claimed: h.claimedBy !== null })),
    wallCount: t.wallCount,
  };
}

function threatFields(view) {
  const t = threats(view);
  return { threat: t.list.map((x) => ({ player: x.player, level: x.level, sets: x.sets, reasons: x.reasons })), threatened: t.threatened };
}

function gradeDiscard(step, dec, counts, view) {
  const { hand, melds } = dec.table.players[HUMAN];
  const tiles = dec.offered.filter((a) => a.type === 'discard').map((a) => a.tile);
  const options = discardOptions(hand, melds.length, counts, tiles);
  for (const o of options) {
    const r = discardRisk(view, o.tile);
    o.risk = { level: r.level, score: r.score, order: r.order, worst: r.worst, reasons: r.reasons, against: r.against };
  }
  if (dec.offered.some((a) => a.type === 'hu')) {
    // The best action was Hu, not a discard: no discard is presented as best.
    step.costReason = null;
    Object.assign(step, {
      options, best: [], bestReason: 'speed', chosenRank: null, verdict: 'mistake', gapSize: null, speedVerdict: 'mistake', safetyVerdict: null,
      cost: 'Missed a win', speedCost: 'Missed a win', safetyNote: null, missedWin: true, tiedBest: false, loss: { ...MISSED_WIN_LOSS },
    });
    return;
  }
  Object.assign(step, { options, ...gradeDiscardChoice(options, step.chosen.tile, step.threatened) });
  // T8: a plain-words reason for a slow speed throw, appended to the cost. Y1: a kept dead shape
  // is named on Fine throws too.
  // Z1: when no cause applies, a threatened Fine or Inaccuracy throw that was safer than every
  // speed-best tile says so (the causes come first: they explain the speed lost; this only offsets it).
  const slow = step.verdict === 'inaccuracy' || step.verdict === 'mistake';
  const why = (slow || step.verdict === 'fine') && step.cost === step.speedCost
    ? (slow ? slipReasonOf(options, hand, melds.length, step.chosen.tile) : null) ??
      deadShapeOf(dec.table, options, step.chosen.tile) ??
      (step.threatened && step.verdict !== 'mistake' ? saferReasonOf(options, step.chosen.tile, step.threat, dec.table.wallCount) : null)
    : null;
  step.costReason = why ? why.words : null;
  // Z3: a cost sentence that already ends in a full stop loses it before the reason is joined on.
  if (why) step.cost = `${step.cost.replace(/\.$/, '')}: ${why.words}.`;
}

// --- shared hand helpers (player 0's own tiles: no hidden information) ---

const HONOR_FILLERS = ['we', 'ws', 'ww', 'wn', 'dr', 'dg', 'dw'];

/**
 * realPairs(hand, meldCount) -> codes held 2+ times that some best arrangement of the hand uses:
 * as its pair, or as a set of three (outside any run). A pair whose tiles are better spent in
 * runs is not counted.
 */
export function realPairs(hand, meldCount) {
  const total = shanten(hand, meldCount);
  const filler = HONOR_FILLERS.find((h) => !hand.includes(h));
  const out = [];
  for (const x of [...new Set(hand)]) {
    const c = countIn(hand, x);
    if (c < 2) continue;
    // As the pair: the rest needs only sets (an absent honor pair stands in as the pair).
    const asPair = filler ? shanten([...without(hand, [x, x]), filler, filler], meldCount) : total;
    let asSet = Infinity;
    if (meldCount < 4) {
      const k = Math.min(3, c);
      asSet = (3 - k) + shanten(without(hand, Array(k).fill(x)), meldCount + 1);
    }
    if (asPair === total || asSet === total) out.push(x);
  }
  return out;
}

/**
 * isMadeTriplet(hand, meldCount, tile) -> true when the hand holds `tile` exactly 3 times (not 4)
 * and some best arrangement of the hand uses them as a set of three: taking the three out and
 * counting them as a meld leaves the hand no further from ready. Three tiles that read better
 * as parts of runs (7 7 7 beside 5 6 and 8 9, say) are not a made set. (AF1; realPairs' test.)
 */
export function isMadeTriplet(hand, meldCount, tile) {
  return countIn(hand, tile) === 3 && shanten(without(hand, [tile, tile, tile]), meldCount + 1) === shanten(hand, meldCount);
}

/**
 * addsSomethingNew(options, tile) -> true when keeping `tile` makes some draw useful that would
 * not be otherwise: throwing it costs distance, or another throw at the best distance (one that
 * keeps the tile) is helped by a draw (with copies left) that does not help once the tile is
 * thrown. options: step.options (with accepts).
 */
export function addsSomethingNew(options, tile) {
  const top = options[0].shanten;
  const own = options.find((o) => o.tile === tile);
  if (!own) return false;
  if (own.shanten > top) return true;
  const mine = new Set(own.accepts.filter((a) => a.live > 0).map((a) => a.tile));
  return options.some((o) => o !== own && o.shanten === top && o.accepts.some((a) => a.live > 0 && !mine.has(a.tile)));
}

const near = (a, b) => isSuit(a) && isSuit(b) && suitOf(a) === suitOf(b) && Math.abs(rankOf(a) - rankOf(b)) <= 2;

/** Whether tile p of `tiles` is part of a complete set (triplet or run) within `tiles`. */
export function inSet(tiles, p) {
  if (countIn(tiles, p) >= 3) return true;
  if (!isSuit(p)) return false;
  const s = suitOf(p);
  const r = rankOf(p);
  for (let a = r - 2; a <= r; a++) {
    if (a < 1 || a + 2 > 9) continue;
    if ([a, a + 1, a + 2].every((k) => tiles.includes(s + k))) return true;
  }
  return false;
}

/**
 * True when `tile` (one copy of it in `hand`) has a free partner: another copy, or a tile of the
 * same suit within 2 ranks, that is not already part of a complete set among the other tiles.
 */
export function isConnected(hand, tile) {
  const others = without(hand, [tile]);
  return others.some((p) => (p === tile || near(p, tile)) && !inSet(others, p));
}

/** A spare tile: it looks connected, but adds nothing new (see addsSomethingNew). */
export function isSpare(options, hand, tile) {
  return isConnected(hand, tile) && !addsSomethingNew(options, tile);
}

/**
 * slipReasonOf(options, hand, meldCount, chosenTile) -> { lesson, tile, words } or null: why a
 * throw slower than the best was slow, in plain words.
 * 'keep-your-sets' (AF1): the throw broke a concealed triplet that a best arrangement of the hand
 * uses as a set (isMadeTriplet: held exactly 3 times, not 4) while a best throw was held fewer than
 * 3 times. That throw (`tile`) is the one at the lowest risk level among the speed-best tiles
 * held fewer than 3 times, then one held once before one held twice, then the options order.
 * Runs are not covered: a run tile can belong to several arrangements of the hand.
 * 'keep-a-pair' (AB1): the hand had exactly one real pair, thrown here, while a best throw (`tile`)
 * was held once.
 * 'keep-your-pairs': it broke one of 2+ real pairs while a best throw (`tile`) was not a pair.
 * 'spare-tile': a best throw (`tile`) was spare, and the thrown tile added something new.
 */
export function slipReasonOf(options, hand, meldCount, chosenTile) {
  const top = options[0];
  const speedBest = options.filter((o) => o.shanten === top.shanten && o.acceptance === top.acceptance);
  if (speedBest.some((o) => o.tile === chosenTile)) return null;
  if (isMadeTriplet(hand, meldCount, chosenTile)) {
    const rank = (o) => (o.risk ? riskIndex(o.risk.level) : 0);
    let alt = null;
    for (const o of speedBest) {
      if (countIn(hand, o.tile) >= 3) continue;
      if (!alt || rank(o) < rank(alt) || (rank(o) === rank(alt) && countIn(hand, o.tile) < countIn(hand, alt.tile))) alt = o;
    }
    if (alt) {
      return {
        lesson: 'keep-your-sets',
        tile: alt.tile,
        words: isSpare(options, hand, alt.tile)
          ? `you broke a set you had already made (the three ${tilesLabel(chosenTile)}) while ${the(alt.tile)} was spare`
          : `you broke a set you had already made (the three ${tilesLabel(chosenTile)}) instead of throwing ${the(alt.tile)}`,
      };
    }
  }
  const pairs = realPairs(hand, meldCount).filter((c) => countIn(hand, c) === 2);
  if (pairs.length === 1 && pairs.includes(chosenTile)) {
    const alt = speedBest.find((o) => countIn(hand, o.tile) === 1);
    if (alt) {
      return {
        lesson: 'keep-a-pair',
        tile: alt.tile,
        words: isSpare(options, hand, alt.tile)
          ? `you broke your only pair (the ${tilesLabel(chosenTile)}) while ${the(alt.tile)} was spare`
          : `you broke your only pair (the ${tilesLabel(chosenTile)}) instead of throwing ${the(alt.tile)}`,
      };
    }
  }
  if (pairs.length >= 2 && pairs.includes(chosenTile)) {
    const alt = speedBest.find((o) => countIn(hand, o.tile) < 2);
    if (alt) {
      return {
        lesson: 'keep-your-pairs',
        tile: alt.tile,
        words: isSpare(options, hand, alt.tile)
          ? `you broke a pair while ${the(alt.tile)} was spare`
          : `you broke a pair instead of throwing ${the(alt.tile)}`,
      };
    }
  }
  const spare = speedBest.find((o) => isSpare(options, hand, o.tile));
  if (spare && addsSomethingNew(options, chosenTile)) {
    return { lesson: 'spare-tile', tile: spare.tile, words: `you kept ${the(spare.tile)}, which added nothing new` };
  }
  return null;
}

const MELD_WORD = { chi: 'Chi', pong: 'Pong', kong: 'Kong' };

// Y1: where player 0 can see the copies of `code`: "Bot 2's Kong shows all four", "all four are in
// the discards", or "all four are showing: 3 in Bot 3's Pong, 1 in the discards".
function seenWhere(table, code) {
  const owner = (p) => (p === HUMAN ? 'your' : `${NAMES[p]}'s`);
  const parts = [];
  const mine = countIn(table.players[HUMAN].hand, code);
  if (mine) parts.push(`${mine} in your hand`);
  table.players.forEach((p, i) => p.melds.forEach((m) => {
    const k = countIn(m.tiles, code);
    if (k === 4) parts.push(`${owner(i)} Kong shows all four`);
    else if (k) parts.push(`${k} in ${owner(i)} ${MELD_WORD[m.type] ?? 'set'}`);
  }));
  const thrown = table.players.reduce((s, p) => s + countIn(p.discards, code), 0);
  if (thrown) parts.push(`${thrown} in the discards`);
  if (parts.length === 1) return parts[0].endsWith('all four') ? parts[0] : `all four are ${parts[0].replace(/^4 /, '')}`;
  return `all four are showing: ${parts.join(', ')}`;
}

/**
 * deadShapeOf(table, options, chosenTile) -> { tile, partner, needs, words } or null (Y1): a
 * speed-best throw (`tile`, held once, in no complete set) whose every free partner makes a dead
 * two-tile shape with it, while the chosen throw kept one of them (`partner`). A shape is a gap
 * (4-6), an edge (1-2, 8-9) or two-sided (4-5) in one suit; it is dead when player 0 can see all
 * four copies of every tile that would complete it (`needs`; own hand, discards, every meld).
 * Visible information only. A pair is not counted: it can still be the hand's pair.
 */
export function deadShapeOf(table, options, chosenTile) {
  const hand = table.players[HUMAN].hand;
  const counts = visibleCounts(table);
  const top = options[0];
  const speedBest = options.filter((o) => o.shanten === top.shanten && o.acceptance === top.acceptance);
  if (speedBest.some((o) => o.tile === chosenTile)) return null;
  const needsOf = (a, b) => {
    const [lo, hi] = rankOf(a) < rankOf(b) ? [a, b] : [b, a];
    const s = suitOf(lo);
    const ranks = rankOf(hi) - rankOf(lo) === 2 ? [rankOf(lo) + 1] : [rankOf(lo) - 1, rankOf(hi) + 1];
    return { lo, hi, needs: ranks.filter((r) => r >= 1 && r <= 9).map((r) => s + r) };
  };
  for (const { tile } of speedBest) {
    if (!isSuit(tile) || countIn(hand, tile) !== 1 || inSet(hand, tile)) continue;
    const others = without(hand, [tile]);
    const partners = [...new Set(others)].filter((p) => near(p, tile) && p !== tile && !inSet(others, p));
    if (!partners.length) continue;
    const shapes = partners.map((p) => ({ partner: p, ...needsOf(tile, p) }));
    if (!shapes.every((sh) => sh.needs.every((c) => (counts.get(c) || 0) >= 4))) continue;
    const kept = shapes.find((sh) => countIn(hand, sh.partner) - (chosenTile === sh.partner ? 1 : 0) >= 1);
    if (!kept) continue;
    const span = `${rankOf(kept.lo)}-${rankOf(kept.hi)}`;
    const words = kept.needs.length === 1
      ? `${the(kept.needs[0])} is all used up (${seenWhere(table, kept.needs[0])}), so ${span} can never become a set`
      : `the ${rankOf(kept.needs[0])} and ${the(kept.needs[1])} are all used up (all eight are showing), so ${span} can never become a set`;
    return { tile, partner: kept.partner, needs: kept.needs, words };
  }
  return null;
}

/**
 * saferReasonOf(options, chosenTile, threat, wallLeft) -> { tile, level, bestLevel, words } or null
 * (Z1): the chosen throw, not speed-best, had a lower risk level than every speed-best throw.
 * threat: step.threat; the words name the opponents at the highest threat level present
 * ("the 9 of Bamboo was safer (low risk against medium) while Bot 1 and Bot 2 show 2 sets"; AA2: with all
 * three opponents at that level, "... while all three bots looked close").
 * Never a verdict input; the caller uses it only on threatened Fine or Inaccuracy throws.
 */
export function saferReasonOf(options, chosenTile, threat, wallLeft) {
  const top = options[0];
  const speedBest = options.filter((o) => o.shanten === top.shanten && o.acceptance === top.acceptance);
  const chosen = options.find((o) => o.tile === chosenTile);
  if (!chosen || !chosen.risk || speedBest.includes(chosen)) return null;
  const mine = riskIndex(chosen.risk.level);
  const theirs = Math.min(...speedBest.map((o) => riskIndex(o.risk.level)));
  if (mine >= theirs) return null;
  const bestLevel = RISK_LEVELS[theirs];
  const lead = (threat || []).some((t) => t.level === 'high') ? 'high' : 'watch';
  const who = (threat || []).filter((t) => t.level === lead);
  const groups = [];
  for (const t of who) {
    const g = groups.find((x) => x.sets === t.sets);
    if (g) g.names.push(NAMES[t.player]);
    else groups.push({ sets: t.sets, names: [NAMES[t.player]] });
  }
  const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
  // AA2: all three opponents at the lead level read "all three bots looked close"; otherwise the
  // groups are joined with commas and one final "and".
  const showing = who.length === 3 ? 'all three bots looked close' : andList(groups.map((g) => {
    const what = g.sets ? sets(g.sets) : `no sets with ${wallLeft} tiles left`;
    return `${andList(g.names)} ${g.names.length > 1 ? 'show' : 'shows'} ${what}`;
  }));
  const words = `${the(chosenTile)} was safer (${riskAgainst(chosen.risk.level, bestLevel)})${showing ? ` while ${showing}` : ''}`;
  return { tile: chosenTile, level: chosen.risk.level, bestLevel, words };
}

/**
 * Grades one discard from its options alone (no hidden information): options as in step.options
 * (best first, each with risk), the thrown tile, and whether player 0 was threatened.
 * -> { best, bestReason, chosenRank, verdict, gapSize, speedVerdict, safetyVerdict, cost, speedCost,
 *      safetyNote, missedWin: false, tiedBest, loss }. See docs/contract.md "Verdicts".
 * Every tile in `best` is one this grading calls best.
 */
export function gradeDiscardChoice(options, chosenTile, threatened) {
  const g = gradeRaw(options, chosenTile, threatened);
  const verdictOf = (t) => (t === chosenTile ? g.verdict : gradeRaw(options, t, threatened).verdict);
  let best = g.best.filter((t) => verdictOf(t) === 'best');
  if (best.length === g.best.length) return g;
  let bestReason = g.bestReason;
  if (!best.length) {
    // Every recommended tile is graded down (a speed-best tile too risky while a safer one is
    // close in speed): recommend the fastest of the tiles with the mildest verdict, as a safety choice.
    const sev = options.map((o) => SEVERITY[verdictOf(o.tile)]);
    const mild = options.filter((_, i) => sev[i] === Math.min(...sev));
    best = mild.filter((o) => o.shanten === mild[0].shanten && o.acceptance === mild[0].acceptance).map((o) => o.tile);
    bestReason = 'safety';
  }
  const out = { ...g, best, bestReason };
  if (best.includes(chosenTile) && g.verdict !== 'best') Object.assign(out, { verdict: 'best', cost: null, gapSize: null });
  out.tiedBest = out.verdict === 'best' && best.length >= 2 && best.includes(chosenTile);
  return out;
}

function gradeRaw(options, chosenTile, threatened) {
  const top = options[0];
  const speedBest = options.filter((o) => o.shanten === top.shanten && o.acceptance === top.acceptance).map((o) => o.tile);
  const chosen = options.find((o) => o.tile === chosenTile);
  const chosenRank = 1 + options.filter((o) => o.shanten < chosen.shanten ||
    (o.shanten === chosen.shanten && o.acceptance > chosen.acceptance)).length;
  const gap = top.acceptance - chosen.acceptance;
  // Speed: distance first, then useful tiles (the grading before safety, kept as speedVerdict).
  let speedVerdict;
  let speedCost = null;
  if (speedBest.includes(chosen.tile)) {
    speedVerdict = 'best';
  } else if (chosen.shanten > top.shanten) {
    speedVerdict = 'mistake';
    speedCost = worseCost(chosen.shanten, top.shanten);
  } else {
    speedVerdict = gap <= fineGap(top.acceptance) ? 'fine' : 'inaccuracy';
    speedCost = `Same distance, but ${usefulTiles(chosen.acceptance)} instead of ${top.acceptance}`;
  }
  let verdict = speedVerdict;
  let cost = speedCost;
  let best = speedBest;
  let bestReason = 'speed';
  let safetyVerdict = null;
  let safetyNote = null;
  if (threatened) {
    const ri = (o) => riskIndex(o.risk.level);
    const optOf = (t) => options.find((o) => o.tile === t);
    const quiet = options.filter((o) => ri(o) <= 1); // safe or low, fastest first
    const speedBestHigh = speedBest.every((t) => ri(optOf(t)) === 3);
    if (speedBest.some((t) => ri(optOf(t)) === 3) && top.shanten >= 2 && quiet.length) {
      // Far from ready and a quiet tile exists: recommend the fastest tiles that are not high risk.
      const calm = options.filter((o) => ri(o) < 3);
      best = calm.filter((o) => o.shanten === calm[0].shanten && o.acceptance === calm[0].acceptance).map((o) => o.tile);
      bestReason = 'safety';
    }
    safetyVerdict = 'ok';
    let sVerdict = 'best';
    let sCost = null;
    const mine = ri(chosen);
    // AC1: a speed tie is broken by risk. `best` keeps only the tied tiles at the lowest risk level
    // among them, ordered by risk score (the calmest first), and throwing a riskier tied tile is
    // Fine (a reckless/risky safety verdict below still takes precedence). That Fine cost says what
    // the safety note would, so the note is left off those steps.
    let ac1Cost = null;
    if (bestReason === 'speed' && speedBest.length > 1) {
      const low = Math.min(...speedBest.map((t) => ri(optOf(t))));
      if (speedBest.some((t) => ri(optOf(t)) > low)) {
        best = speedBest.filter((t) => ri(optOf(t)) === low)
          .sort((a, b) => optOf(a).risk.score - optOf(b).risk.score);
        if (speedBest.includes(chosen.tile) && mine > low) {
          verdict = 'fine';
          cost = `Same speed, but ${the(best[0])} was safer (${riskAgainst(RISK_LEVELS[low], chosen.risk.level)})`;
          ac1Cost = cost;
        }
      }
    }
    if (mine === 3) {
      const sameSpeedSafer = options.filter((o) => o !== chosen && ri(o) <= mine - 2 &&
        (o.shanten < chosen.shanten || (o.shanten === chosen.shanten &&
          o.acceptance >= chosen.acceptance - fineGap(Math.max(o.acceptance, chosen.acceptance)))));
      if (chosen.shanten >= 2 && quiet.length) {
        const by = chosen.risk.against.find((a) => a.player === chosen.risk.worst);
        const alt = quiet[0];
        const rec = optOf(best[0]);
        safetyVerdict = 'reckless';
        sVerdict = 'mistake';
        sCost = `Too risky for a hand this far from ready: ${NAMES[by.player]} ${by.sets ? `shows ${sets(by.sets)}` : 'shows no sets but may already be ready'}. ` +
          (rec && ri(rec) > 1 ? `The ${tileLabel(rec.tile)} was ${rec.shanten === chosen.shanten && rec.acceptance >= chosen.acceptance ? 'as fast and ' : ''}less risky; the ${tileLabel(alt.tile)} was ${RISK_WORD[alt.risk.level]}.`
            : `The ${tileLabel(alt.tile)} was ${RISK_WORD[alt.risk.level]}.`);
      } else if (sameSpeedSafer.length) {
        safetyVerdict = 'risky';
        sVerdict = 'inaccuracy';
        sCost = `Same speed, but a safer tile was available: ${tileLabel(sameSpeedSafer[0].tile)}`;
      } else if (chosen.shanten <= 1) {
        // AC2: at the best distance, a tile one level safer, inside the fine band, makes the throw
        // not "justified"; the verdict stays as it is. A speed mistake keeps the old note.
        const near = chosen.shanten === top.shanten
          ? options.filter((o) => o !== chosen && o.shanten === chosen.shanten && ri(o) === mine - 1 &&
            o.acceptance > 0 && o.acceptance >= chosen.acceptance - fineGap(Math.max(o.acceptance, chosen.acceptance)))
          : [];
        const alt = near.reduce((a, b) => (!a || b.acceptance > a.acceptance ? b : a), null);
        if (!alt) safetyNote = SAFETY_NOTES.justified;
        else if (best.includes(alt.tile)) {
          // AE2: the speed cost already names its useful tiles ("9 instead of 10"), so the note only adds the risk.
          safetyNote = `Risky: ${the(alt.tile)}, ${best.length > 1 ? 'one of the best throws' : 'the best throw'}, was also less risky (${alt.risk.level})`;
        } else if (alt.acceptance > chosen.acceptance) {
          safetyNote = `Risky: ${the(alt.tile)} had more useful tiles (${alt.acceptance} against ${chosen.acceptance}) and was less risky (${alt.risk.level})`;
        } else if (alt.acceptance === chosen.acceptance) {
          safetyNote = `Risky: ${the(alt.tile)} was as fast and less risky (${alt.risk.level})`;
        } else {
          safetyNote = `Risky: ${the(alt.tile)} was nearly as fast (${usefulTiles(alt.acceptance)} against ${chosen.acceptance}) and less risky (${alt.risk.level})`;
        }
      } else {
        safetyNote = SAFETY_NOTES.noSafer;
      }
    } else if (mine <= 1 && speedVerdict !== 'best' && speedBestHigh) {
      // Defensive: capped at 'fine' whatever the speed gap.
      safetyVerdict = 'defensive';
      verdict = 'fine';
      cost = SAFETY_NOTES.defensive;
      safetyNote = SAFETY_NOTES.defensive;
    }
    // Precedence: at equal severity the safety reason wins (reckless over a speed mistake,
    // safer-tile-available over a speed inaccuracy).
    if (SEVERITY[sVerdict] > 0 && SEVERITY[sVerdict] >= SEVERITY[verdict]) {
      verdict = sVerdict;
      cost = sCost;
    }
    if (bestReason === 'safety' && best.includes(chosen.tile)) {
      verdict = 'best';
      cost = null;
    }
    // The AC1 Fine cost already says which safer tile to prefer, and its verdict is not a
    // "justified"/"no safer tile" situation: no safety note on those steps.
    if (ac1Cost) safetyNote = null;
  }
  const gapSize = verdict === 'inaccuracy' && cost === speedCost && chosen.shanten === top.shanten
    ? gapSizeOf(top.acceptance, chosen.acceptance) : null;
  return {
    best, bestReason, chosenRank, verdict, gapSize, speedVerdict, safetyVerdict, cost, speedCost, safetyNote,
    missedWin: false,
    tiedBest: verdict === 'best' && best.length >= 2 && best.includes(chosen.tile),
    loss: { shanten: chosen.shanten - top.shanten, acceptance: Math.max(0, gap) },
  };
}

// Result of taking a claim, judged by the best follow-up discard (a Kong: by the hand left).
function claimOutcome(action, hand, meldCount, tile, counts) {
  if (action.type === 'hu') return { shanten: -1, acceptance: 0 };
  if (action.type === 'kong') {
    const rest = without(hand, [tile, tile, tile]);
    const sh = shanten(rest, meldCount + 1);
    return { shanten: sh, acceptance: acceptance(rest, meldCount + 1, sh, counts).acceptance };
  }
  const used = action.type === 'pong' ? [tile, tile] : action.tiles;
  const top = discardOptions(without(hand, used), meldCount + 1, counts)[0];
  return { shanten: top.shanten, acceptance: top.acceptance };
}

function gradeClaim(step, dec, counts) {
  const { hand, melds } = dec.table.players[HUMAN];
  const before = shanten(hand, melds.length);
  const offers = dec.offered.filter((a) => a.type !== 'pass').map((action) => {
    const o = claimOutcome(action, hand, melds.length, dec.claimTile, counts);
    return { action, shantenIfTaken: o.shanten, acceptanceIfTaken: o.acceptance };
  });
  const passed = acceptance(hand, melds.length, before, counts);
  // AE1: a Pong of the claimed tile uses the hand's only pair, 1 from ready, and would leave mostly single-tile waits.
  const pongOffer = offers.find((o) => o.action.type === 'pong');
  const pongCostsOnlyPairWaits = before === 1 && Boolean(pongOffer) && pongOffer.shantenIfTaken === 1 &&
    onlyRealPairOf(hand, melds.length) === dec.claimTile && pongCostsPairWaits(hand, melds.length, dec.claimTile, counts);
  const chosen = step.chosen;
  const huOffered = offers.some((o) => o.action.type === 'hu');
  const lowering = offers.filter((o) => o.shantenIfTaken < before);
  let verdict = 'best';
  let cost = null;
  let loss = { shanten: 0, acceptance: 0 };
  let missedWin = false;
  if (huOffered && chosen.type !== 'hu') {
    verdict = 'mistake';
    cost = 'Missed a win';
    missedWin = true;
    loss = { ...MISSED_WIN_LOSS };
  } else if (chosen.type === 'pass') {
    if (lowering.length) {
      const bestOffer = lowering.reduce((a, b) => (b.shantenIfTaken < a.shantenIfTaken ? b : a));
      const steps = before - bestOffer.shantenIfTaken;
      verdict = 'inaccuracy';
      cost = (bestOffer.shantenIfTaken === 0
        ? `This claim would have made you ready (one tile from winning) instead of ${distanceWords(before)}; `
        : `This claim would have brought you ${steps === 1 ? 'one step' : `${steps} steps`} closer ` +
          `(${distanceWords(bestOffer.shantenIfTaken)} instead of ${distanceWords(before)}); `) +
        'staying concealed can be a fair choice, so this is only an inaccuracy';
      loss = { shanten: steps, acceptance: 0 };
    } else {
      // Same distance either way: a Chi or Pong that would clearly have added useful tiles.
      const richer = richerPassOf(offers, before, passed.acceptance, step.threatened, pongCostsOnlyPairWaits);
      if (richer) ({ verdict, cost, loss } = richer);
    }
  } else if (chosen.type !== 'hu') {
    const mine = offers.find((o) => sameAction(o.action, chosen));
    if (chosen.type === 'kong') {
      if (mine.shantenIfTaken > before) {
        verdict = 'inaccuracy';
        cost = kongCost(mine.shantenIfTaken, before);
        loss = { shanten: mine.shantenIfTaken - before, acceptance: 0 };
      }
    } else if (mine.shantenIfTaken > before) {
      verdict = 'inaccuracy';
      cost = `This claim left you ${distanceWords(mine.shantenIfTaken)} instead of ${distanceWords(before)}`;
      loss = { shanten: mine.shantenIfTaken - before, acceptance: 0 };
    } else if (mine.shantenIfTaken === before) {
      // Distance first, then useful tiles, with the discard thresholds.
      const gain = mine.acceptanceIfTaken - passed.acceptance;
      if (gain > fineGap(mine.acceptanceIfTaken)) {
        verdict = 'best';
      } else if (gain > 0) {
        verdict = 'fine';
        cost = fineClaimCost(true, mine.acceptanceIfTaken, passed.acceptance);
      } else {
        verdict = 'inaccuracy';
        cost = 'This claim did not bring you closer or add useful tiles';
        loss = { shanten: 0, acceptance: -gain };
      }
    }
  }
  const meldNote = ['chi', 'pong', 'kong'].includes(chosen.type) && !step.outranked;
  const mine = offers.find((o) => sameAction(o.action, chosen));
  const tiedBest = verdict === 'best' && Boolean(mine) && ['chi', 'pong'].includes(chosen.type) &&
    offers.some((o) => o !== mine && ['chi', 'pong'].includes(o.action.type) &&
      o.shantenIfTaken === mine.shantenIfTaken && o.acceptanceIfTaken === mine.acceptanceIfTaken);
  Object.assign(step, {
    offers, shantenIfPassed: before, acceptanceIfPassed: passed.acceptance, pongCostsOnlyPairWaits, verdict, speedVerdict: verdict, safetyVerdict: null,
    cost, missedWin, loss, tiedBest,
    note: meldNote ? `Your hand now shows ${sets(step.meldsAfter.length)}` : null,
  });
}

/**
 * gradeClaimChoice({ offers, shantenIfPassed, acceptanceIfPassed, threatened, pongCostsOnlyPairWaits }, action) -> { verdict, cost }:
 * the verdict gradeClaim gives a claim-step choice, from the step's offers alone (the same rules;
 * checked against it in the tests; `threatened` and `pongCostsOnlyPairWaits` are the step's, false when missing).
 * Used by lessons.js and quiz.js.
 */
export function gradeClaimChoice(g, action) {
  const before = g.shantenIfPassed;
  const passed = g.acceptanceIfPassed;
  const offers = g.offers;
  const same = (a, b) => a.type === b.type && JSON.stringify(a.tiles ?? null) === JSON.stringify(b.tiles ?? null);
  if (offers.some((o) => o.action.type === 'hu') && action.type !== 'hu') return { verdict: 'mistake', cost: 'Missed a win' };
  if (action.type === 'hu') return { verdict: 'best', cost: null };
  if (action.type === 'pass') {
    const lowering = offers.filter((o) => o.shantenIfTaken < before);
    if (lowering.length) {
      const b = lowering.reduce((x, y) => (y.shantenIfTaken < x.shantenIfTaken ? y : x));
      const steps = before - b.shantenIfTaken;
      const cost = (b.shantenIfTaken === 0
        ? `This claim would have made you ready (one tile from winning) instead of ${distanceWords(before)}; `
        : `This claim would have brought you ${steps === 1 ? 'one step' : `${steps} steps`} closer ` +
          `(${distanceWords(b.shantenIfTaken)} instead of ${distanceWords(before)}); `) +
        'staying concealed can be a fair choice, so this is only an inaccuracy';
      return { verdict: 'inaccuracy', cost };
    }
    const richer = richerPassOf(offers, before, passed, g.threatened, g.pongCostsOnlyPairWaits);
    return richer ? { verdict: richer.verdict, cost: richer.cost } : { verdict: 'best', cost: null };
  }
  const mine = offers.find((o) => same(o.action, action));
  if (!mine) return { verdict: null, cost: null };
  if (action.type === 'kong') {
    return mine.shantenIfTaken > before ? { verdict: 'inaccuracy', cost: kongCost(mine.shantenIfTaken, before) } : { verdict: 'best', cost: null };
  }
  if (mine.shantenIfTaken > before) {
    return { verdict: 'inaccuracy', cost: `This claim left you ${distanceWords(mine.shantenIfTaken)} instead of ${distanceWords(before)}` };
  }
  if (mine.shantenIfTaken < before) return { verdict: 'best', cost: null };
  const gain = mine.acceptanceIfTaken - passed;
  if (gain > fineGap(mine.acceptanceIfTaken)) return { verdict: 'best', cost: null };
  if (gain > 0) {
    return { verdict: 'fine', cost: fineClaimCost(true, mine.acceptanceIfTaken, passed) };
  }
  return { verdict: 'inaccuracy', cost: 'This claim did not bring you closer or add useful tiles' };
}

function gradeTurnOther(step, dec) {
  const { hand, melds } = dec.table.players[HUMAN];
  const a = step.chosen;
  step.tiedBest = false;
  step.safetyVerdict = null;
  if (a.type === 'hu') {
    Object.assign(step, { verdict: 'best', speedVerdict: 'best', cost: null, missedWin: false, loss: { shanten: 0, acceptance: 0 } });
    return;
  }
  // Kong: the hand without the four tiles (before the replacement draw) against the hand now.
  const before = shanten(hand, melds.length);
  const after = a.kind === 'added'
    ? shanten(without(hand, [a.tile]), melds.length)
    : shanten(without(hand, [a.tile, a.tile, a.tile, a.tile]), melds.length + 1);
  const huOffered = dec.offered.some((x) => x.type === 'hu');
  if (huOffered) {
    Object.assign(step, { verdict: 'mistake', cost: 'Missed a win', missedWin: true, loss: { ...MISSED_WIN_LOSS } });
  } else if (after <= before) {
    Object.assign(step, { verdict: 'best', cost: null, missedWin: false, loss: { shanten: 0, acceptance: 0 } });
  } else {
    Object.assign(step, {
      verdict: 'inaccuracy',
      cost: kongCost(after, before),
      missedWin: false,
      loss: { shanten: after - before, acceptance: 0 },
    });
  }
}

// Player 0's waits with where the copies really are (hidden information).
function waitDetails(handAfter, meldCount, table, wall, counts) {
  if (handAfter.length % 3 !== 1 || shanten(handAfter, meldCount) !== 0) return [];
  return waitsOf(handAfter, meldCount).map((tile) => {
    const live = liveOf(counts, tile);
    const inWall = countIn(wall, tile);
    const inOpponentHands = [1, 2, 3].reduce((n, p) => n + countIn(table.players[p].hand, tile), 0);
    const own = countIn(handAfter, tile);
    return { tile, live, inWall, inOpponentHands, dead: Math.max(0, 4 - own - inWall - inOpponentHands) };
  });
}

// Opponents one tile from winning when player 0 discarded (hidden information).
function dangerOf(table, tile) {
  const ready = [];
  for (const p of [1, 2, 3]) {
    const { hand, melds } = table.players[p];
    if (hand.length % 3 !== 1 || shanten(hand, melds.length) !== 0) continue;
    const ws = waitsOf(hand, melds.length);
    ready.push({ player: p, waits: ws, dealtIn: ws.includes(tile) });
  }
  return { opponentsReady: ready.map((r) => r.player), ready, dealtIn: ready.some((r) => r.dealtIn) };
}

// --- wait shape (human-visible: player 0's own hand) ---

const the = (code) => `the ${tileLabel(code)}`;
// AB1: a plural tile name, for the pair a throw broke: "5s of Characters", "East winds", "Red dragons".
const tilesLabel = (code) => {
  const label = tileLabel(code);
  return isSuit(code) ? `${rankOf(code)}s of ${label.replace(/^\d+ of /, '')}` : `${label}s`;
};
const orList = (codes) => (codes.length <= 1 ? codes.map(the).join('')
  : `${codes.slice(0, -1).map(the).join(', ')} or ${the(codes.at(-1))}`);

// True when the tiles split exactly into sets: a pair of an absent honor makes it a win test.
function allSetsWith(tiles, meldCount) {
  const filler = ['we', 'ws', 'ww', 'wn', 'dr', 'dg', 'dw'].find((h) => !tiles.includes(h));
  return filler ? isWin([...tiles, filler, filler], meldCount) : false;
}

// Every way the wait tile w completes a 3k+1 hand: 'pair' (single tile), 'triplet' (one of two
// pairs), 'two-sided', 'edge' or 'middle' (a run), with the two tiles it joins.
function waitRoles(hand, meldCount, w) {
  const roles = [];
  if (hand.includes(w) && allSetsWith(without(hand, [w]), meldCount)) roles.push({ role: 'pair', with: [w] });
  if (countIn(hand, w) >= 2 && isWin(without(hand, [w, w]), meldCount + 1)) roles.push({ role: 'triplet', with: [w, w] });
  if (isSuit(w)) {
    const s = suitOf(w);
    const r = rankOf(w);
    for (const [da, db] of [[-2, -1], [-1, 1], [1, 2]]) {
      if (r + da < 1 || r + db > 9) continue;
      const a = s + (r + da);
      const b = s + (r + db);
      if (!hand.includes(a) || !hand.includes(b) || !isWin(without(hand, [a, b]), meldCount + 1)) continue;
      let role = 'two-sided';
      if (da === -1) role = 'middle';
      else if ((da === -2 && r === 3) || (da === 1 && r === 7)) role = 'edge';
      roles.push({ role, with: [a, b] });
    }
  }
  return roles;
}

const rankSpan = (pair) => pair.map(rankOf).join('-');

/**
 * waitShapeOf(hand, meldCount, waits) -> { shape, words } for a ready 3k+1 hand:
 * 'two-sided' | 'middle' | 'edge' | 'pair' | 'two-pairs' | 'multi'.
 */
export function waitShapeOf(hand, meldCount, waits) {
  if (!waits.length) return null;
  const roles = waits.map((w) => waitRoles(hand, meldCount, w));
  const has = (i, role) => roles[i].find((x) => x.role === role);
  if (waits.length === 1) {
    const w = waits[0];
    const pick = ['middle', 'edge', 'two-sided', 'pair', 'triplet'].map((r) => has(0, r)).find(Boolean);
    if (pick && pick.role === 'middle') {
      return { shape: 'middle', words: `a middle wait: only ${the(w)} completes ${rankSpan(pick.with)}` };
    }
    if (pick && (pick.role === 'edge' || pick.role === 'two-sided')) {
      return { shape: 'edge', words: `an edge wait: only ${the(w)} completes ${rankSpan(pick.with)}` };
    }
    if (pick) return { shape: 'pair', words: `a single-tile wait: only another ${tileLabel(w)} makes your pair` };
  }
  if (waits.length === 2) {
    const [a, b] = roles.map((r, i) => r.find((x) => x.role === 'two-sided' &&
      roles[1 - i].some((y) => y.role === 'two-sided' && String(y.with) === String(x.with))));
    if (a && b) {
      return { shape: 'two-sided', words: `a two-sided wait: ${orList(waits)} completes ${rankSpan(a.with)}` };
    }
    if (has(0, 'triplet') && has(1, 'triplet')) {
      return { shape: 'two-pairs', words: `a two-pair wait: ${orList(waits)} turns one of your pairs into a set` };
    }
  }
  return { shape: 'multi', words: `a wait on ${waits.length} different tiles: ${orList(waits)}` };
}

// --- hindsight (what came next: information player 0 could not have had) ---

// How tile t could lower the shanten of a 3k+1 hand: by drawing it, or by claiming a discard
// from `from` (Hu or Pong from anyone, Chi only from the left player). { how, shanten } or null.
function bestUse(hand, meldCount, t, from) {
  const sh = shanten(hand, meldCount);
  if (from === null) {
    const after = shanten([...hand, t], meldCount);
    return after < sh ? { how: 'draw', shanten: after } : null;
  }
  if (isWin([...hand, t], meldCount)) return { how: 'hu', shanten: -1 };
  let best = null;
  const consider = (how, used) => {
    const after = shanten(without(hand, used), meldCount + 1);
    if (after < sh && (!best || after < best.shanten)) best = { how, shanten: after };
  };
  if (countIn(hand, t) >= 2) consider('pong', [t, t]);
  if (from === (HUMAN + 3) % 4) for (const pair of chiOptions(hand, t)) consider('chi', pair);
  return best;
}

const HOW_WORDS = { draw: 'it', hu: 'Hu on it', pong: 'a Pong on it', chi: 'a Chi on it' };
const KEPT_WORDS = { hu: 'Hu', pong: 'Pong', chi: 'Chi' };
const resultWords = (sh) => (sh < 0 ? 'won you the game'
  : sh === 0 ? `made you ${distanceWords(0)}` : `brought you to ${distanceWords(sh)}`);

// X1: what the alternative hand throws on player 0's discards: the same tile when it holds it,
// else its own best throw (lowest distance, then most useful tiles counting every copy unseen).
function altThrow(hand, meldCount, tile) {
  return hand.includes(tile) ? tile : discardOptions(hand, meldCount, new Map())[0].tile;
}

// X1: the tiles a claim or Kong by player 0 takes from the concealed hand, and the melds it adds.
function claimUse(e) {
  if (e.type === 'chi') return { used: without(e.tiles, [e.tile]), melds: 1 };
  if (e.type === 'pong') return { used: [e.tile, e.tile], melds: 1 };
  if (e.kind === 'added') return { used: [e.tile], melds: 0 };
  return { used: Array(e.kind === 'claimed' ? 3 : 4).fill(e.tile), melds: 1 };
}

/**
 * The first tile after this discard (until player 0's turn after next) that would have lowered the
 * distance of the best option's hand but not of the hand player 0 kept. Null when none did.
 * W2: balanced. The same scan looks for tiles the kept hand could use and the best option's hand
 * could not; one counts when it reached the same distance or closer, and came no later than the
 * alternative's tile or was a discard player 0 really claimed. For claims the scan runs on to the
 * claim that would start player 0's third turn. Such a gain is stated after the alternative's
 * (`kept`); hindsight never changes a verdict.
 * X1: both hands evolve through the same later events. Player 0's draws go to both; the kept hand
 * throws and claims what player 0 really did; the alternative throws the same tile when it holds
 * it, else its own best throw (altThrow), and makes the same claim or Kong when it holds the tiles
 * (otherwise the hands no longer follow the same turns and the scan stops there). Each tile is
 * weighed against the hands as they stood at that moment, and the alternative's gain is not
 * reported when the kept hand was already at least as close as that gain would bring it.
 */
function hindsightOf(step, events) {
  if (step.chosen.type !== 'discard' || step.missedWin || step.verdict === 'best' || !step.best.length) return null;
  const { hand, melds } = step.table.players[HUMAN];
  const bestTile = step.best[0];
  let alt = without(hand, [bestTile]);
  let mine = without(hand, [step.chosen.tile]);
  let altMelds = melds.length;
  let mineMelds = melds.length;
  let moved = false;
  let turnStarts = 0;
  let altOpen = true;
  let found = null;
  const kept = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.n <= step.n) continue;
    const humanTurn = e.player === HUMAN && ((e.type === 'draw' && e.kind !== 'replacement') ||
      e.type === 'chi' || e.type === 'pong' || (e.type === 'kong' && e.kind === 'claimed'));
    if (humanTurn) turnStarts += 1;
    if (humanTurn && turnStarts >= 3) break;
    let from;
    if (e.type === 'draw' && e.player === HUMAN && e.tile && !isBonus(e.tile)) from = null;
    else if (e.type === 'discard' && e.player !== HUMAN) from = e.player;
    else from = undefined;
    if (from !== undefined) {
      const use = bestUse(alt, altMelds, e.tile, from);
      const keptUse = bestUse(mine, mineMelds, e.tile, from);
      const keptSh = shanten(mine, mineMelds);
      if (altOpen && !found && use && !keptUse && keptSh > use.shanten) {
        const when = from === null
          ? `${turnStarts <= 1 ? 'On your next turn' : 'Two turns later'} you drew ${the(e.tile)}`
          : `${NAMES[from]} then threw ${the(e.tile)}`;
        const had = moved
          ? `Had you thrown ${the(bestTile)} instead, that hand would by then have been ${distanceWords(shanten(alt, altMelds))}, and `
          : `Had you thrown ${the(bestTile)} instead, `;
        found = {
          n: e.n, tile: e.tile, how: use.how, shanten: use.shanten,
          lead: `${when}. ${had}${HOW_WORDS[use.how]} would have ${resultWords(use.shanten)}`,
          tail: moved ? `; the hand you kept was ${distanceWords(keptSh)} and could not use it.` : '; the hand you kept could not use it.',
        };
      }
      if (keptUse && !use) {
        const next = from === null ? null : events.slice(i + 1).find((x) => x.type !== 'pass');
        const claimed = Boolean(next) && next.player === HUMAN && ['chi', 'pong', 'kong', 'hu'].includes(next.type);
        kept.push({ n: e.n, tile: e.tile, from, how: keptUse.how, shanten: keptUse.shanten, claimed, turn: turnStarts });
      }
    }
    // X1: carry both hands through the event.
    if (from === null) {
      alt = [...alt, e.tile];
      mine = [...mine, e.tile];
      moved = true;
    } else if (e.player === HUMAN && e.type === 'discard') {
      mine = without(mine, [e.tile]);
      alt = without(alt, [altThrow(alt, altMelds, e.tile)]);
    } else if (e.player === HUMAN && ['chi', 'pong', 'kong'].includes(e.type)) {
      const { used, melds: m } = claimUse(e);
      if (without(alt, used).length !== alt.length - used.length) break;
      mine = without(mine, used);
      alt = without(alt, used);
      mineMelds += m;
      altMelds += m;
      moved = true;
    }
    if (humanTurn && turnStarts >= 2) {
      altOpen = false;
      if (!found) return null;
    }
  }
  if (!found) return null;
  const k = kept.find((g) => g.shanten <= found.shanten && (g.n < found.n || g.claimed));
  const out = { n: found.n, tile: found.tile, how: found.how, kept: null };
  if (!k) return { ...out, words: `${found.lead}${found.tail}` };
  const what = k.from === null
    ? `drawing ${the(k.tile)} ${k.turn <= 1 ? 'on your next turn' : 'two turns later'}`
    : k.claimed ? `your ${KEPT_WORDS[k.how]} on ${the(k.tile)} from ${NAMES[k.from]}`
      : `${k.how === 'hu' ? 'Hu' : `a ${KEPT_WORDS[k.how]}`} on ${the(k.tile)} from ${NAMES[k.from]}`;
  return {
    ...out,
    kept: { n: k.n, tile: k.tile, how: k.how },
    words: `${found.lead}. The hand you kept could not use it, but ${what} ${resultWords(k.shanten)}.`,
  };
}

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function buildStep(dec, index, events, botLevel) {
  const d = dec.log;
  const table = dec.table;
  const counts = visibleCounts(table);
  const { hand, melds } = table.players[HUMAN];
  const humanHand = dec.drew ? [...without(hand, [dec.drew]), dec.drew] : [...hand];
  const step = {
    index,
    n: d.n ?? null,
    kind: dec.kind,
    turn: dec.turn,
    wallLeft: dec.wallLeft,
    drew: dec.drew,
    claimTile: dec.claimTile,
    claimFrom: dec.claimFrom,
    robKong: dec.robKong,
    thinkMs: Number.isFinite(d.thinkMs) ? d.thinkMs : null,
    timedOut: Boolean(d.timedOut),
    outranked: Boolean(d.outranked),
    robbed: dec.robbedBy != null,
    robbedBy: dec.robbedBy ?? null,
    table: { ...table, humanHand, offered: clone(dec.offered) },
    chosen: clone(d.chosen),
    shantenBefore: shanten(hand, melds.length),
    shantenAfter: shanten(dec.handAfter, dec.meldsAfter.length),
    handAfter: [...dec.handAfter],
    meldsAfter: clone(dec.meldsAfter),
  };
  const view = safetyView(dec, botLevel);
  Object.assign(step, threatFields(view));
  if (dec.kind === 'claim') gradeClaim(step, dec, counts);
  else if (step.chosen.type === 'discard') gradeDiscard(step, dec, counts, view);
  else gradeTurnOther(step, dec);
  if (step.speedVerdict === undefined) step.speedVerdict = step.verdict;
  if (step.gapSize === undefined) step.gapSize = null;
  if (step.costReason === undefined) step.costReason = null;
  if (step.note === undefined) step.note = null;
  if (step.safetyNote === undefined) step.safetyNote = null;
  step.waits = waitDetails(dec.handAfter, dec.meldsAfter.length, table, dec.wall, counts);
  // The wait shape (player 0's own hand: not hidden information) and a wider wait, if any.
  const shape = step.waits.length ? waitShapeOf(dec.handAfter, dec.meldsAfter.length, step.waits.map((w) => w.tile)) : null;
  step.waitShape = shape ? shape.shape : null;
  step.waitWords = shape ? shape.words : null;
  step.widerWaitAvailable = null;
  if (shape && step.options) {
    const mine = step.options.find((o) => o.tile === step.chosen.tile);
    const wider = step.options.filter((o) => o.shanten === 0 && o.acceptance > mine.acceptance)
      .sort((a, b) => b.acceptance - a.acceptance)[0];
    if (wider) {
      step.widerWaitAvailable = {
        tile: wider.tile,
        live: wider.acceptance,
        yourLive: mine.acceptance,
        words: `Throwing ${the(wider.tile)} instead would also have left you ready, with ${wider.acceptance} ` +
          `winning tiles left instead of ${mine.acceptance}`,
      };
    }
  }
  step.danger = step.chosen.type === 'discard' ? dangerOf(table, step.chosen.tile) : null;
  step.hindsight = step.chosen.type === 'discard' ? hindsightOf(step, events) : null;
  // V4: an opponent claimed this discard (visible to player 0). A neutral note only: never graded.
  const own = dec.ownDiscard;
  step.claimedBy = own && own.claimedBy !== null ? { player: own.claimedBy, type: own.claimedAs } : null;
  return step;
}

// A choice where the options were equal: tied for best, or a discard where every throw was
// graded best or fine for speed (all within the fine band of the best).
function equalChoice(s) {
  if (s.tiedBest) return true;
  if (!s.options || s.missedWin) return false;
  const top = s.options[0];
  return s.options.every((o) => o.shanten === top.shanten && top.acceptance - o.acceptance <= fineGap(top.acceptance));
}

// V1: a nearly equal choice: a discard graded best or fine whose throw was at the best distance
// and within the fine band of the best for speed (speedVerdict 'fine'). A clear best found is not one.
function nearEqualChoice(s) {
  return Boolean(s.options) && !s.missedWin && s.speedVerdict === 'fine' && (s.verdict === 'best' || s.verdict === 'fine');
}

// U4: player 0's turns that began with the hand ready (each a draw that could win), or null when
// the hand was never ready. Counted on turn steps: the hand before the drawn tile is ready.
function readyTurnsOf(steps, firstReadyStep) {
  if (firstReadyStep === null) return null;
  const turns = new Set();
  for (const s of steps) {
    if (s.kind !== 'turn' || !s.drew) continue;
    const { hand, melds } = s.table.players[HUMAN];
    if (shanten(without(hand, [s.drew]), melds.length) === 0) turns.add(s.turn);
  }
  return turns.size;
}

// U4, HIDDEN INFORMATION: the winning tiles player 0 could count (live) against the copies really
// left in the wall (W3: and in opponents' hands), at the first and the last step that left the
// hand ready. Null when never ready.
function readyWallOf(steps) {
  const ready = steps.filter((s) => s.waits.length);
  if (!ready.length) return null;
  const at = (s) => ({
    step: s.index,
    live: s.waits.reduce((n, w) => n + w.live, 0),
    inWall: s.waits.reduce((n, w) => n + w.inWall, 0),
    inOpponentHands: s.waits.reduce((n, w) => n + w.inOpponentHands, 0),
  });
  return { start: at(ready[0]), end: at(ready.at(-1)) };
}

// U4, HIDDEN INFORMATION: discards one rank from a ready opponent's winning tile (same suit,
// adjacent rank) that were not a winning tile for that opponent. One entry per step.
function nearMissesOf(steps) {
  const out = [];
  for (const s of steps) {
    if (s.chosen.type !== 'discard' || !s.danger) continue;
    const t = s.chosen.tile;
    if (!isSuit(t)) continue;
    for (const r of s.danger.ready) {
      if (r.waits.includes(t)) continue;
      const w = r.waits.find((x) => isSuit(x) && suitOf(x) === suitOf(t) && Math.abs(rankOf(x) - rankOf(t)) === 1);
      if (w) {
        out.push({ step: s.index, tile: t, player: r.player, wait: w });
        break;
      }
    }
  }
  return out;
}

// AA1: runs of 3 or more player-0 turns in a row where the drawn tile was thrown while the hand
// was not ready before the draw (shantenAfter >= 1: throwing the draw leaves the hand as it was
// before the draw; shantenBefore counts the drawn tile and may be 0 when the draw offered ready)
// and the throw was not graded best. Claim steps and turns with no draw (a discard after a claim)
// are skipped: they neither count nor break a run. Any other turn with a draw breaks it.
// shanten: the closest the hand was in the run, shantenMax the farthest.
export const DRAW_THROW_MIN_RUN = 3;
export function drawThrowRunsOf(steps) {
  const out = [];
  let run = [];
  const close = () => {
    if (run.length >= DRAW_THROW_MIN_RUN) {
      const sh = run.map((s) => s.shantenAfter);
      out.push({
        fromStep: run[0].index, toStep: run.at(-1).index, fromTurn: run[0].turn, toTurn: run.at(-1).turn,
        turns: run.length, steps: run.map((s) => s.index), shanten: Math.min(...sh), shantenMax: Math.max(...sh),
      });
    }
    run = [];
  };
  for (const s of steps) {
    if (s.kind !== 'turn' || !s.drew) continue;
    const hit = s.chosen.type === 'discard' && s.chosen.tile === s.drew && !s.missedWin &&
      s.verdict !== 'best' && s.shantenAfter >= 1;
    if (hit) run.push(s);
    else close();
  }
  close();
  return out;
}

function summarize(steps, state, durationMs, hiddenReady) {
  const zero = () => Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const discards = zero();
  const claims = zero();
  const other = zero();
  for (const s of steps) {
    const bucket = s.kind === 'claim' ? claims : s.chosen.type === 'discard' ? discards : other;
    bucket[s.verdict] += 1;
  }
  const severity = (s) => VERDICTS.indexOf(s.verdict);
  const costliest = steps
    .filter((s) => s.verdict === 'mistake' || s.verdict === 'inaccuracy')
    .sort((a, b) => severity(b) - severity(a) || b.loss.shanten - a.loss.shanten ||
      b.loss.acceptance - a.loss.acceptance || a.index - b.index)
    .slice(0, 3)
    .map((s) => s.index);
  const ready = steps.find((s) => s.shantenAfter === 0);
  const r = state.result;
  // A robbed Kong is not a deal-in (no discard was involved): it is reported as kongRobbedStep.
  const dealtIn = Boolean(r && r.type === 'win' && r.winner !== HUMAN && r.from === HUMAN && r.kind === 'discard');
  const dealtStep = dealtIn ? steps.filter((s) => s.chosen.type === 'discard').at(-1) : null;
  const robbedStep = steps.find((s) => s.robbed);
  const me = state.players[HUMAN];
  const times = steps.map((s) => s.thinkMs).filter((t) => Number.isFinite(t));
  const totalDiscards = VERDICTS.reduce((n, v) => n + discards[v], 0);
  const good = discards.best + discards.fine;
  const totalClaims = VERDICTS.reduce((n, v) => n + claims[v], 0);
  const goodClaims = claims.best + claims.fine;
  const safety = { ok: 0, risky: 0, reckless: 0, defensive: 0 };
  for (const s of steps) if (s.safetyVerdict) safety[s.safetyVerdict] += 1;
  return {
    discards,
    claims,
    other,
    costliest,
    firstReadyStep: ready ? ready.index : null,
    readyTurns: readyTurnsOf(steps, ready ? ready.index : null),
    readyWall: readyWallOf(steps),
    drawThrowRuns: drawThrowRunsOf(steps),
    nearMisses: nearMissesOf(steps),
    hiddenReady,
    dealtIn,
    dealtInStep: dealtStep ? dealtStep.index : null,
    kongRobbedStep: robbedStep ? robbedStep.index : null,
    heldPairAtEnd: realPairs(me.hand, me.melds.length).length > 0,
    thinkMsTotal: times.reduce((a, b) => a + b, 0),
    thinkMsMedian: median(times),
    // V2: share of the game's wall-clock time spent on player 0's decisions (null without a duration),
    // and the decisions that took over GRADING.slowThinkMs. Think time includes time with the settings open.
    thinkShare: Number.isFinite(durationMs) && durationMs > 0 ? times.reduce((a, b) => a + b, 0) / durationMs : null,
    slowThinks: steps.filter((s) => (s.thinkMs ?? 0) > GRADING.slowThinkMs).map((s) => s.index),
    longEqualThinks: steps.filter((s) => (s.thinkMs ?? 0) >= GRADING.longThinkMs && (equalChoice(s) || nearEqualChoice(s))).map((s) => s.index),
    score: `${good} of ${totalDiscards} discards best or fine`,
    scoreGood: good,
    scoreTotal: totalDiscards,
    scoreClaims: `${goodClaims} of ${totalClaims} claims best or fine`,
    scoreClaimsGood: goodClaims,
    scoreClaimsTotal: totalClaims,
    scoreAll: `${good + goodClaims} of ${totalDiscards + totalClaims} discards and claims best or fine`,
    scoreAllGood: good + goodClaims,
    scoreAllTotal: totalDiscards + totalClaims,
    safety,
    threatenedSteps: steps.filter((s) => s.chosen.type === 'discard' && s.threatened).map((s) => s.index),
  };
}

/**
 * analyzeLog(log, { tileMap }?) -> review object (see docs/contract.md "review.js"), or { ok: false, error }
 * when the log is not a replayable game log (corrupt, incompatible, or diverging events).
 * tileMap (optional, code -> code): the same game with every tile relabelled (a "disguise", disguise.js);
 * the real replay and grading run on the relabelled tiles, so every sentence names the new tiles.
 */
export function analyzeLog(log, { tileMap } = {}) {
  let replayed;
  let src = log;
  try {
    if (tileMap) src = mapLogTiles(log, tileMap);
    replayed = replay(src, tileMap);
  } catch (err) {
    return { ok: false, error: err instanceof Divergence ? err.message : `replay failed: ${err.message}` };
  }
  const { state, decisions, timeline, turns, hiddenReady } = replayed;
  const steps = decisions.map((d, i) => buildStep(d, i, src.events, src.settings?.botLevel));
  const result = clone(state.result);
  const started = Date.parse(log.startedAt);
  const ended = Date.parse(log.endedAt);
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null;
  return {
    ok: true,
    reviewVersion: REVIEW_VERSION,
    meta: {
      version: log.version ?? null,
      startedAt: log.startedAt ?? null,
      endedAt: log.endedAt ?? null,
      durationMs,
      botLevel: log.settings?.botLevel ?? null,
      dealer: state.dealer,
      humanWind: seatWind(state, HUMAN),
      result: { ...result, headline: resultHeadline(result), sub: resultSubline(result) },
      wallLeftAtEnd: state.wall.length,
      humanTurns: turns,
    },
    steps,
    timeline,
    summary: summarize(steps, state, durationMs, hiddenReady),
  };
}
