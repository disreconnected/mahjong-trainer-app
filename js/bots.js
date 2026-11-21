// Bot players. chooseAction picks one of the legal actions for a bot seat.
// Information rule: decision code reads only the view built by viewFor(), which holds
// what that player could see at the table (own hand, everyone's discards/melds/flowers,
// wall count). It never touches other hands, state.wall contents or state.initialWall.
import { ALL_CODES, isBonus, isHonor, isSuit, suitOf, rankOf } from './tiles.js';
import { shanten } from './rules.js';

const copyMeld = (m) => ({ type: m.type, tiles: [...m.tiles], from: m.from, concealed: m.concealed });

// Everything a player may legitimately know, as a fresh copy (no shared references).
export function viewFor(state, player) {
  return {
    player,
    dealer: state.dealer,
    phase: state.phase,
    turn: state.turn,
    hand: [...state.players[player].hand],
    lastDraw: state.phase === 'turn' && state.turn === player ? state.lastDraw : null,
    wallCount: state.wall.length,
    players: state.players.map((p) => ({
      melds: p.melds.map(copyMeld),
      flowers: [...p.flowers],
      discards: [...p.discards],
    })),
    claim: state.claim
      ? { tile: state.claim.tile, from: state.claim.from, robKong: state.claim.robKong }
      : null,
  };
}

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

function countTiles(hand) {
  const counts = new Map();
  for (const t of hand) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

// No other tile of the same suit within 2 ranks (a duplicate counts as a neighbour).
function isIsolatedSuit(tile, counts) {
  const s = suitOf(tile);
  const r = rankOf(tile);
  if (counts.get(tile) > 1) return false;
  for (let d = -2; d <= 2; d++) {
    if (d !== 0 && counts.has(s + (r + d))) return false;
  }
  return true;
}

// --- easy ---

function easyDiscard(view, discards, rng) {
  if (rng() < 0.15) return pick(discards, rng);
  const counts = countTiles(view.hand);
  const tiers = [[], [], [], []];
  for (const a of discards) {
    const t = a.tile;
    if (isHonor(t)) {
      if (counts.get(t) === 1) tiers[0].push(a);
    } else if (isSuit(t) && isIsolatedSuit(t, counts)) {
      const r = rankOf(t);
      tiers[r === 1 || r === 9 ? 1 : 2].push(a);
    }
    if (counts.get(t) === 1) tiers[3].push(a);
  }
  for (const tier of tiers) if (tier.length) return pick(tier, rng);
  return pick(discards, rng);
}

function chooseEasy(view, actions, rng) {
  const byType = (type) => actions.filter((a) => a.type === type);
  const hu = byType('hu');
  if (hu.length) return hu[0];
  const kong = byType('kong');
  if (kong.length) return kong[0];
  const pong = byType('pong');
  if (pong.length) return pong[0];
  const chi = byType('chi');
  if (chi.length && rng() < 0.5) return pick(chi, rng);
  const pass = byType('pass');
  if (pass.length) return pass[0];
  return easyDiscard(view, byType('discard'), rng);
}

// --- normal ---
// Builds by shanten and live acceptance, defends when far from ready against an
// opponent showing 3+ melds. Does not read discards beyond simple safety counts.

const TILE_CODES = ALL_CODES.filter((c) => !isBonus(c));

function withoutTiles(hand, tiles) {
  const out = [...hand];
  for (const t of tiles) out.splice(out.indexOf(t), 1);
  return out;
}

// Per-decision context: visible-tile counts and opponents' discards.
// For simplicity every meld's tiles count as visible, including other players'
// concealed kongs (face-down in real play, but the state exposes them).
function makeContext(view) {
  const visible = countTiles([
    ...view.hand,
    ...view.players.flatMap((p) => [...p.discards, ...p.melds.flatMap((m) => m.tiles)]),
  ]);
  const opponents = [1, 2, 3].map((k) => (view.player + k) % 4);
  return {
    melds: view.players[view.player].melds.length,
    visible,
    live: (c) => Math.max(0, 4 - (visible.get(c) || 0)),
    opponents,
    threats: opponents.filter((o) => view.players[o].melds.length >= 3),
    discardedBy: view.players.map((p) => new Set(p.discards)),
  };
}

// Higher = safer. A fully seen-out honor (3+ visible) is completely safe; otherwise more
// visible copies help, and a tile an opponent already threw is safe against that opponent.
function safety(tile, ctx, against) {
  const seen = ctx.visible.get(tile) || 0;
  if (isHonor(tile) && seen >= 3) return 100;
  let score = seen;
  for (const o of against) if (ctx.discardedBy[o].has(tile)) score += 5;
  return score;
}

// Live count of every code that would lower the shanten of a 3k+1 hand.
function acceptance(hand, meldCount, sh, ctx) {
  let total = 0;
  for (const c of TILE_CODES) {
    const live = ctx.live(c);
    if (live === 0) continue;
    hand.push(c);
    if (shanten(hand, meldCount) < sh) total += live;
    hand.pop();
  }
  return total;
}

const kindRank = (t) => (isHonor(t) ? 0 : rankOf(t) === 1 || rankOf(t) === 9 ? 1 : 2);

// Best discard from a 3k+2 hand by efficiency: lowest shanten, then acceptance, then
// safety, then honors > terminals > others, then rng. Returns { tile, shanten, acceptance }.
function bestDiscard(hand, meldCount, ctx, rng, tiles = [...new Set(hand)]) {
  const shOf = new Map(tiles.map((t) => [t, shanten(withoutTiles(hand, [t]), meldCount)]));
  const minSh = Math.min(...shOf.values());
  let best = [];
  let bestKey = null;
  for (const t of tiles) {
    if (shOf.get(t) !== minSh) continue;
    const key = [acceptance(withoutTiles(hand, [t]), meldCount, minSh, ctx),
      safety(t, ctx, ctx.opponents), -kindRank(t)];
    const cmp = bestKey ? compareKeys(key, bestKey) : 1;
    if (cmp > 0) { best = [t]; bestKey = key; } else if (cmp === 0) best.push(t);
  }
  return { tile: pick(best, rng), shanten: minSh, acceptance: bestKey[0] };
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Result of a claim judged by its best follow-up discard; smaller shanten, then more acceptance.
const betterResult = (a, b) => a.shanten - b.shanten || b.acceptance - a.acceptance;

function normalDiscard(view, discards, ctx, rng) {
  const eff = bestDiscard(view.hand, ctx.melds, ctx, rng, discards.map((a) => a.tile));
  if (!ctx.threats.length || eff.shanten < 2) return discards.find((a) => a.tile === eff.tile);
  // Defense: safest tile against the threatening opponents; ties go to the lower shanten.
  const keyOf = (t) => [safety(t, ctx, ctx.threats), -shanten(withoutTiles(view.hand, [t]), ctx.melds)];
  const keys = discards.map((a) => keyOf(a.tile));
  const top = keys.reduce((m, k) => (compareKeys(k, m) > 0 ? k : m));
  return pick(discards.filter((_, i) => compareKeys(keys[i], top) === 0), rng);
}

function chooseNormal(view, actions, rng) {
  const ctx = makeContext(view);
  const byType = (type) => actions.filter((a) => a.type === type);
  const hu = byType('hu');
  if (hu.length) return hu[0];
  const hand = view.hand;

  if (view.phase === 'turn') {
    const kongs = byType('kong');
    const added = kongs.find((a) => a.kind === 'added');
    if (added) return added;
    const before = shanten(hand, ctx.melds);
    const concealed = kongs.find((a) =>
      shanten(withoutTiles(hand, [a.tile, a.tile, a.tile, a.tile]), ctx.melds + 1) <= before);
    if (concealed) return concealed;
    return normalDiscard(view, byType('discard'), ctx, rng);
  }

  // Claim phase (discard or robbed kong).
  const tile = view.claim.tile;
  const current = shanten(hand, ctx.melds);
  const kong = byType('kong')[0];
  if (kong && shanten(withoutTiles(hand, [tile, tile, tile]), ctx.melds + 1) <= current) return kong;
  let choice = null;
  let best = null;
  const consider = (action, used) => {
    const res = bestDiscard(withoutTiles(hand, used), ctx.melds + 1, ctx, rng);
    if (res.shanten < current && (!best || betterResult(res, best) < 0)) { choice = action; best = res; }
  };
  const pong = byType('pong')[0];
  if (pong) consider(pong, [tile, tile]); // considered first, so it wins ties
  for (const chi of byType('chi')) consider(chi, chi.tiles);
  return choice || byType('pass')[0];
}

const LEVELS = {
  easy: chooseEasy,
  normal: chooseNormal,
};

export function chooseAction(state, player, level, actions, rng) {
  const choose = LEVELS[level];
  if (!choose) throw new Error(`unknown bot level: ${level}`);
  if (!actions.length) throw new Error('no actions to choose from');
  return choose(viewFor(state, player), actions, rng);
}
