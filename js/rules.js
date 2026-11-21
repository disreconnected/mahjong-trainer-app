// Pure rule functions. No state, no DOM.
import { ALL_CODES, isBonus, isSuit, suitOf, rankOf, sortTiles } from './tiles.js';

const countOf = (hand, tile) => hand.filter((c) => c === tile).length;

export function chiOptions(hand, tile) {
  if (!isSuit(tile)) return [];
  const s = suitOf(tile), r = rankOf(tile);
  const options = [];
  // Tile as high, middle, low: options come out lowest tile first.
  for (const [da, db] of [[-2, -1], [-1, 1], [1, 2]]) {
    const ra = r + da, rb = r + db;
    if (ra < 1 || rb > 9) continue;
    const a = s + ra, b = s + rb;
    if (hand.includes(a) && hand.includes(b)) options.push([a, b]);
  }
  return options;
}

export function canPong(hand, tile) {
  return countOf(hand, tile) >= 2;
}

export function canKongClaim(hand, tile) {
  return countOf(hand, tile) >= 3;
}

export function concealedKongs(hand) {
  return sortTiles([...new Set(hand)]).filter((c) => countOf(hand, c) === 4);
}

export function addedKongs(hand, melds) {
  const pongs = melds.filter((m) => m.type === 'pong').map((m) => m.tiles[0]);
  return sortTiles([...new Set(hand)]).filter((c) => pongs.includes(c));
}

// Can the counted tiles be split entirely into sets (runs or triplets)?
function allSets(counts) {
  const code = ALL_CODES.find((c) => counts[c] > 0);
  if (!code) return true;
  if (counts[code] >= 3) {
    counts[code] -= 3;
    const ok = allSets(counts);
    counts[code] += 3;
    if (ok) return true;
  }
  if (isSuit(code) && rankOf(code) <= 7) {
    const b = suitOf(code) + (rankOf(code) + 1);
    const c = suitOf(code) + (rankOf(code) + 2);
    if (counts[b] > 0 && counts[c] > 0) {
      counts[code]--; counts[b]--; counts[c]--;
      const ok = allSets(counts);
      counts[code]++; counts[b]++; counts[c]++;
      if (ok) return true;
    }
  }
  return false;
}

export function isWin(hand, meldCount) {
  if (!Number.isInteger(meldCount) || meldCount < 0 || meldCount > 4) return false;
  if (hand.length !== 3 * (4 - meldCount) + 2) return false;
  const counts = {};
  for (const c of hand) {
    if (!ALL_CODES.includes(c) || isBonus(c)) return false;
    counts[c] = (counts[c] || 0) + 1;
  }
  for (const c of Object.keys(counts)) {
    if (counts[c] < 2) continue;
    counts[c] -= 2;
    const ok = allSets(counts);
    counts[c] += 2;
    if (ok) return true;
  }
  return false;
}

// --- Analysis: shanten, waits, liveCount ---
//
// Shanten is computed exactly as (fewest tiles missing from any complete hand) - 1.
// A complete hand is (4 - meldCount) sets + 1 pair with at most 4 copies of any code;
// "missing" counts target tiles the hand doesn't hold. Each suit is solved by a small
// DP over ranks and cached by its count vector; honors are solved per code.

const INF = 99;
const suitCache = new Map();

// cost[s][p]: fewest tiles missing to turn this suit's counts into s sets + p pairs.
function suitCosts(counts) {
  const key = counts.join('');
  let table = suitCache.get(key);
  if (table) return table;
  const memo = new Map();
  // a: runs needing rank i as their 3rd tile; b: runs needing rank i as 2nd (and i+1 as 3rd).
  const g = (i, a, b, s, p) => {
    if (i === 9) return a === 0 && b === 0 && s === 0 && p === 0 ? 0 : INF;
    const k = ((((i * 5 + a) * 5 + b) * 5 + s) * 2) + p;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let best = INF;
    for (let r = 0; r <= (i <= 6 ? s : 0); r++) {
      for (let t = 0; t <= (s - r > 0 ? 1 : 0); t++) {
        for (let q = 0; q <= p; q++) {
          const want = a + b + r + 3 * t + 2 * q;
          if (want > 4) continue;
          const sub = g(i + 1, b, r, s - r - t, p - q);
          if (sub >= INF) continue;
          const cost = Math.max(0, want - counts[i]) + sub;
          if (cost < best) best = cost;
        }
      }
    }
    memo.set(k, best);
    return best;
  };
  table = [];
  for (let s = 0; s <= 4; s++) table.push([g(0, 0, 0, s, 0), g(0, 0, 0, s, 1)]);
  suitCache.set(key, table);
  return table;
}

function honorCosts(h) {
  const t = [];
  for (let s = 0; s <= 4; s++) t.push([INF, INF]);
  t[0][0] = 0;
  t[1][0] = Math.max(0, 3 - h);
  t[0][1] = Math.max(0, 2 - h);
  return t;
}

function merge(dp, table, sets) {
  const out = [];
  for (let s = 0; s <= sets; s++) out.push([INF, INF]);
  for (let s1 = 0; s1 <= sets; s1++) for (let p1 = 0; p1 <= 1; p1++) {
    if (dp[s1][p1] >= INF) continue;
    for (let s2 = 0; s1 + s2 <= sets; s2++) for (let p2 = 0; p1 + p2 <= 1; p2++) {
      const c = dp[s1][p1] + table[s2][p2];
      if (c < out[s1 + s2][p1 + p2]) out[s1 + s2][p1 + p2] = c;
    }
  }
  return out;
}

export function shanten(hand, meldCount) {
  const sets = 4 - meldCount;
  const suits = { m: Array(9).fill(0), p: Array(9).fill(0), s: Array(9).fill(0) };
  const honors = {};
  for (const c of hand) {
    if (isSuit(c)) suits[suitOf(c)][rankOf(c) - 1]++;
    else if (!isBonus(c)) honors[c] = (honors[c] || 0) + 1;
  }
  let dp = [];
  for (let s = 0; s <= sets; s++) dp.push([INF, INF]);
  dp[0][0] = 0;
  for (const k of ['m', 'p', 's']) dp = merge(dp, suitCosts(suits[k]), sets);
  for (const c of ALL_CODES) {
    if (isSuit(c) || isBonus(c)) continue;
    dp = merge(dp, honorCosts(honors[c] || 0), sets);
  }
  return dp[sets][1] - 1;
}

export function waits(hand, meldCount) {
  return ALL_CODES.filter((c) => !isBonus(c) && countOf(hand, c) < 4 && isWin([...hand, c], meldCount));
}

export function liveCount(code, visibleTiles) {
  return Math.max(0, 4 - countOf(visibleTiles, code));
}
