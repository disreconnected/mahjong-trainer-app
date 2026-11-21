// Discard safety from one player's point of view: how close each opponent looks, and how
// likely a tile is to be an opponent's winning tile. Pure functions, no DOM, no hidden
// information: only what that player could see. See docs/contract.md "safety.js".
//
// Rules that matter here (casual mahjong): any 4 sets + 1 pair wins, there is no scoring and
// NO furiten rule, so a player may win on a tile they discarded earlier. Bots always take a win.
import { isHonor, isSuit, suitOf, rankOf } from './tiles.js';
import { NAMES } from './endscreen.js';

/** Tunable numbers. Change them here only; tests and the contract read them from this object. */
// A threat rule: an opponent showing at least `sets` face-up sets, with `wall` tiles or fewer left
// in the wall, is at `level`. Rules are per bot level (the log's settings.botLevel; Easy when
// unknown) and checked in order: the first match wins, else 'none'.
// Principle (tuning pass, 300 autoplay games): 'high' where at least 1 in 3 such opponents was
// already ready (one tile from winning), 'watch' where at least 1 in 10 was. X3 (fifth pass, 400
// Normal games): a Normal bot showing no sets was ready 27.7% of the time with 40-59 tiles left and
// 56% with 20-39, so 0 sets rates watch and then high late in the wall (Easy stays under 3%).
const rule = (sets, wall, level) => Object.freeze({ sets, wall, level });
export const SAFETY = Object.freeze({
  threat: Object.freeze({
    easy: Object.freeze([
      rule(3, Infinity, 'high'),
      rule(2, 59, 'watch'),
      rule(1, 19, 'watch'),
    ]),
    normal: Object.freeze([
      rule(3, Infinity, 'high'),
      rule(2, 79, 'high'),
      rule(1, 59, 'high'),
      rule(2, Infinity, 'watch'),
      rule(1, 79, 'watch'),
      rule(0, 39, 'high'),
      rule(0, 59, 'watch'),
    ]),
  }),
  // Score = pair/triplet part + run part, then the adjustments below; clamped to 0..100.
  score: Object.freeze({
    pairWeight: 25, // times (unseen copies of the tile, at most 3) / 3
    pairWeightClose: 40, // the same against an opponent showing 3+ sets (few tiles left: pair waits are common)
    runWeight: 20, // per run shape that waits on the tile, times min(unseen partners) / 4
    suitStep: 20, // opponent's sets all in one suit: that suit +, other suits -
    earlierStep: 25, // the opponent discarded this tile earlier (never down to safe)
    honorThreeSeen: 10, // an honor with 3 copies visible: at most this (low)
  }),
  // Score -> level: score <= safe -> 'safe', <= low -> 'low', <= medium -> 'medium', else 'high'.
  // 'safe' only comes from the hard rules (all 4 visible, passed since, their latest discard).
  levels: Object.freeze({ safe: 5, low: 30, medium: 60 }),
  // Per-opponent risk counted in discardRisk: 'none' opponents are capped at the top of 'low'.
  threatFactor: Object.freeze({ none: 1, watch: 0.85, high: 1.2 }),
});

export const RISK_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high']);
export const THREAT_LEVELS = Object.freeze(['none', 'watch', 'high']);

export const riskIndex = (level) => RISK_LEVELS.indexOf(level);

export function riskLevelOf(score) {
  const t = SAFETY.levels;
  if (score <= t.safe) return 'safe';
  if (score <= t.low) return 'low';
  if (score <= t.medium) return 'medium';
  return 'high';
}

const SUIT_NAMES = { m: 'Characters', p: 'Circles', s: 'Bamboo' };
const meOf = (view) => view.me ?? view.player ?? 0;

// Copies of each code the viewer can see: own hand, every discard on the table, every meld
// (opponents' concealed Kongs included, as in review.js).
function visibleCounts(view) {
  const counts = new Map();
  const add = (t) => counts.set(t, (counts.get(t) || 0) + 1);
  view.hand.forEach(add);
  for (const p of view.players) {
    p.discards.forEach(add);
    for (const m of p.melds) m.tiles.forEach(add);
  }
  return counts;
}

/**
 * threatLevel(view, opponent) -> { level: 'none'|'watch'|'high', sets, reasons: [strings] }.
 * Counts the opponent's face-up sets against the tiles left in the wall, with the rules of
 * view.botLevel ('easy' | 'normal'; Easy when missing).
 */
export function threatLevel(view, opponent) {
  const rules = SAFETY.threat[view.botLevel] ?? SAFETY.threat.easy;
  const sets = view.players[opponent].melds.length;
  const wall = view.wallCount;
  const name = NAMES[opponent];
  const shows = sets ? `${name} shows ${sets} set${sets === 1 ? '' : 's'}` : `${name} shows no sets`;
  const r = rules.find((x) => sets >= x.sets && wall <= x.wall);
  if (!r) return { level: 'none', sets, reasons: [] };
  return { level: r.level, sets, reasons: [r.wall === Infinity ? shows : `${shows} with ${wall} tiles left`] };
}

// The opponent's discards (in order, claimed ones included) and what came after their latest.
function discardFacts(view, opponent, tile) {
  const log = view.discardLog;
  if (!Array.isArray(log)) {
    // No ordered log: only the opponent's own discards still on the table are known.
    const own = view.players[opponent].discards;
    return { known: false, latest: false, earlier: own.includes(tile), passedBy: null };
  }
  let last = -1;
  for (let i = 0; i < log.length; i++) if (log[i].player === opponent) last = i;
  const latest = last >= 0 && log[last].tile === tile;
  const earlier = log.some((d, i) => i < last && d.player === opponent && d.tile === tile);
  const pass = log.slice(last + 1).find((d) => d.tile === tile);
  return { known: true, latest, earlier, passedBy: pass ? pass.player : null };
}

// One opponent's sets, if at least 2 are suited and all suited sets share one suit.
function oneSuitOf(view, opponent) {
  const suits = view.players[opponent].melds.map((m) => suitOf(m.tiles[0])).filter((s) => SUIT_NAMES[s]);
  if (suits.length < 2 || suits.some((s) => s !== suits[0])) return null;
  return suits[0];
}

// The run shapes that wait on a suited tile, as partner pairs.
function runShapes(tile) {
  const s = suitOf(tile);
  const r = rankOf(tile);
  const shapes = [];
  for (const [a, b] of [[-2, -1], [-1, 1], [1, 2]]) {
    if (r + a >= 1 && r + b <= 9) shapes.push([s + (r + a), s + (r + b)]);
  }
  return shapes;
}

function kindWords(tile) {
  if (isHonor(tile)) return 'Honor tile: no run can wait on it';
  const r = rankOf(tile);
  if (r === 1 || r === 9) return 'Terminal: only one run shape waits on it';
  if (r === 2 || r === 8) return '2 or 8: two run shapes wait on it';
  return 'Middle tile: three run shapes wait on it';
}

const result = (score, reasons) => ({ level: riskLevelOf(score), score, reasons });

/**
 * tileRisk(view, tile, opponent) -> { level: 'safe'|'low'|'medium'|'high', score: 0..100, reasons }
 * against one opponent, from what the viewer can see.
 */
export function tileRisk(view, tile, opponent) {
  const S = SAFETY.score;
  const name = NAMES[opponent];
  const counts = visibleCounts(view);
  const seen = Math.min(4, counts.get(tile) || 0);
  if (seen >= 4 && !isSuit(tile)) return result(0, ['All 4 copies are visible']);
  const facts = discardFacts(view, opponent, tile);
  if (facts.passedBy !== null) {
    const by = facts.passedBy === meOf(view) ? 'You' : NAMES[facts.passedBy];
    return result(0, [`${by} threw it after ${name}'s last discard and ${name} did not win on it`]);
  }
  if (facts.latest) return result(0, [`${name}'s most recent discard`]);

  const reasons = [];
  const unseen = (c) => Math.max(0, 4 - (counts.get(c) || 0));
  // Pair and triplet waits need copies the viewer cannot see.
  const close = view.players[opponent].melds.length >= 3;
  let score = (close ? S.pairWeightClose : S.pairWeight) * Math.min(3, unseen(tile)) / 3;
  if (seen > 0) reasons.push(`${seen} cop${seen === 1 ? 'y' : 'ies'} visible`);
  reasons.push(kindWords(tile));
  // With 4 face-up sets the opponent holds a single tile: only a pair wait is possible.
  const single = view.players[opponent].melds.length >= 4;
  if (single) reasons.push(`${name} holds a single tile: only a pair wait is possible`);
  if (isSuit(tile)) {
    const shapes = single ? [] : runShapes(tile);
    const open = shapes.reduce((n, [a, b]) => n + Math.min(unseen(a), unseen(b)) / 4, 0);
    if (unseen(tile) === 0 && open === 0) {
      return result(0, [seen >= 4 ? 'All 4 copies are visible and no run can wait on it' : 'No copy or run partner is left']);
    }
    score += S.runWeight * open;
    if (shapes.length && open <= 0.4 * shapes.length) reasons.push('Neighbouring tiles mostly visible: few run waits left');
    const suit = oneSuitOf(view, opponent);
    if (suit) {
      if (suit === suitOf(tile)) {
        score += S.suitStep;
        reasons.push(`${name}'s sets are all ${SUIT_NAMES[suit]}: riskier in that suit`);
      } else {
        score -= S.suitStep;
        reasons.push(`${name}'s sets are all ${SUIT_NAMES[suit]}: other suits are safer`);
      }
    }
  } else if (seen >= 3) {
    score = Math.min(score, S.honorThreeSeen);
    reasons.push('Only a single-tile pair wait remains');
  }
  if (facts.earlier) {
    score -= S.earlierStep;
    reasons.push(`${name} threw this earlier (they can still win on it: no furiten rule)`);
  }
  score = Math.round(Math.min(100, Math.max(SAFETY.levels.safe + 1, score)));
  return result(score, reasons);
}

/**
 * discardRisk(view, tile) -> { level, score, reasons, against: [per opponent], threatened }.
 * The overall risk is the highest threat-weighted risk over the opponents; an opponent at
 * threat 'none' adds nothing above 'low'. threatened: any opponent at 'high', or two at 'watch'.
 */
export function discardRisk(view, tile) {
  const me = meOf(view);
  const against = [];
  for (let k = 1; k <= 3; k++) {
    const p = (me + k) % 4;
    const threat = threatLevel(view, p);
    const risk = tileRisk(view, tile, p);
    let weighted = Math.min(100, Math.round(risk.score * SAFETY.threatFactor[threat.level]));
    if (threat.level === 'none') weighted = Math.min(weighted, SAFETY.levels.low);
    if (risk.level === 'safe') weighted = risk.score;
    against.push({ player: p, threat: threat.level, sets: threat.sets, level: risk.level, score: risk.score, weighted, reasons: risk.reasons });
  }
  const top = against.reduce((a, b) => (b.weighted > a.weighted ? b : a));
  const score = top.weighted;
  return {
    tile,
    level: riskLevelOf(score),
    score,
    order: orderScore(against),
    worst: top.player,
    reasons: score > SAFETY.levels.safe ? [`Against ${NAMES[top.player]}: ${top.reasons.join('; ')}`] : top.reasons,
    against,
    threatened: isThreatened(against.map((a) => a.threat)),
  };
}

/**
 * U5: a finer ordering of options than the level, for display only (never a verdict): the sum of the
 * threat-weighted risks against every opponent at threat 'watch' or 'high'. Two Medium tiles differ
 * when one is Medium against two threatening opponents and the other against one. Lower is safer.
 */
export function orderScore(against) {
  return against.filter((a) => a.threat !== 'none').reduce((n, a) => n + a.weighted, 0);
}

/**
 * U5: the discard options marked "safest here": the lowest order score, only when two or more
 * opponents are at threat 'high'. [] otherwise. Display only; verdicts do not use it.
 */
export function safestOptions(options, threat) {
  if ((threat || []).filter((t) => t.level === 'high').length < 2) return [];
  const scored = options.filter((o) => o.risk && typeof o.risk.order === 'number');
  if (!scored.length) return [];
  const low = Math.min(...scored.map((o) => o.risk.order));
  return scored.filter((o) => o.risk.order === low).map((o) => o.tile);
}

export function isThreatened(levels) {
  return levels.includes('high') || levels.filter((l) => l === 'watch').length >= 2;
}

/** threats(view) -> [{ player, level, sets, reasons }] for the three opponents, and threatened. */
export function threats(view) {
  const me = meOf(view);
  const list = [1, 2, 3].map((k) => {
    const p = (me + k) % 4;
    return { player: p, ...threatLevel(view, p) };
  });
  return { list, threatened: isThreatened(list.map((t) => t.level)) };
}

// "Low risk", used by the review screen and costs.
export function riskWords(level) {
  return { safe: 'Safe', low: 'Low risk', medium: 'Medium risk', high: 'High risk' }[level] ?? '';
}
