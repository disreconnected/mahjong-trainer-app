// Game logger: builds the per-game log object (see docs/contract.md "Log file").
// No DOM; imports cleanly under Node.
import { shanten, waits, liveCount } from './rules.js';
import { pickStore } from './store.js';

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const HUMAN = 0;

// Every tile player 0 can see: own hand, all discards, all melds.
function visibleTo(state) {
  const tiles = [...state.players[HUMAN].hand];
  for (const p of state.players) {
    tiles.push(...p.discards);
    for (const m of p.melds) tiles.push(...m.tiles);
  }
  return tiles;
}

// rngSeed (optional): the seed of the bots' rngs, written as a top-level field when given.
export function createLogger({ settings, state, now = Date.now, rngSeed }) {
  const log = {
    version: 2,
    startedAt: new Date(now()).toISOString(),
    endedAt: null,
    settings: copy(settings),
    seed: state.seed,
    ...(rngSeed === undefined ? {} : { rngSeed }),
    dealer: state.dealer,
    wall: copy(state.initialWall),
    startHands: state.players.map((p) => copy(p.hand)),
    startFlowers: state.players.map((p) => copy(p.flowers)),
    events: copy(state.setupEvents),
    decisions: [],
    result: null,
    finalHands: null,
    finalMelds: null,
  };
  let pending = null;
  let turns = 0; // player 0's turns started so far
  let continuesTurn = false; // the last decision was a turn-phase Kong: its replacement draw is the same turn

  return {
    record(events) {
      for (const ev of events) log.events.push(copy(ev));
    },

    beginDecision(st, offered) {
      const { hand, melds } = st.players[HUMAN];
      const kind = st.phase === 'claim' ? 'claim' : 'turn';
      if (kind === 'turn' && !continuesTurn) turns += 1;
      pending = {
        kind,
        turn: turns,
        wallLeft: st.wall.length,
        drew: kind === 'turn' ? st.lastDraw ?? null : null,
        claim: kind === 'claim' ? { claimTile: st.claim.tile, claimFrom: st.claim.from } : {},
        hand: copy(hand),
        melds: copy(melds),
        offered: copy(offered),
        shantenBefore: shanten(hand, melds.length),
        startedAt: now(),
        eventIndex: log.events.length,
      };
    },

    endDecision(st, chosen, { timedOut = false, outranked } = {}) {
      if (!pending) throw new Error('endDecision called without beginDecision');
      const since = log.events.slice(pending.eventIndex);
      // The event the human's action produced; if the claim lost (or produced nothing
      // itself), the first event of the claim's resolution (pass events only precede it).
      const own = since.find((e) => e.player === HUMAN && e.type === chosen.type);
      const fallback = since.find((e) => e.type !== 'pass') ?? since[0];
      const n = (own ?? fallback)?.n ?? null;
      const { hand, melds } = st.players[HUMAN];
      const shantenAfter = shanten(hand, melds.length);
      const waitList =
        hand.length % 3 === 1 && shantenAfter === 0
          ? waits(hand, melds.length).map((tile) => ({ tile, live: liveCount(tile, visibleTo(st)) }))
          : [];
      log.decisions.push({
        n,
        kind: pending.kind,
        turn: pending.turn,
        wallLeft: pending.wallLeft,
        drew: pending.drew,
        ...pending.claim,
        hand: pending.hand,
        melds: pending.melds,
        offered: pending.offered,
        chosen: copy(chosen),
        timedOut: Boolean(timedOut),
        outranked: outranked ?? (chosen.type !== 'pass' && !own),
        thinkMs: now() - pending.startedAt,
        shantenBefore: pending.shantenBefore,
        shantenAfter,
        handAfter: copy(hand),
        meldsAfter: copy(melds),
        waits: waitList,
      });
      continuesTurn = pending.kind === 'turn' && chosen.type === 'kong';
      pending = null;
    },

    finish(st) {
      log.result = copy(st.result);
      log.finalHands = st.players.map((p) => copy(p.hand));
      log.finalMelds = st.players.map((p) => copy(p.melds));
      log.endedAt = new Date(now()).toISOString();
    },

    toJSON() {
      return copy(log);
    },
  };
}

// Saving goes through the storage module (store.js): the server on the PC, IndexedDB on a phone.
// storeOpts: { mode, device } — in local mode the store needs the device name.
export async function saveLog(log, fetchImpl = globalThis.fetch, storeOpts = {}) {
  return pickStore({ ...storeOpts, fetchImpl }).saveLog(log);
}
