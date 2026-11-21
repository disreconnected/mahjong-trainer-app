// Tile codes, seeded RNG, wall building and tile helpers. No DOM access.

const SUITS = ['m', 'p', 's'];
const WINDS = ['we', 'ws', 'ww', 'wn'];
const DRAGONS = ['dr', 'dg', 'dw'];
const BONUS = ['f1', 'f2', 'f3', 'f4', 'g1', 'g2', 'g3', 'g4'];

export const ALL_CODES = [
  ...SUITS.flatMap((s) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => s + r)),
  ...WINDS,
  ...DRAGONS,
  ...BONUS,
];

const ORDER = new Map(ALL_CODES.map((c, i) => [c, i]));

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWall(seed) {
  const wall = [];
  for (const code of ALL_CODES) {
    const copies = isBonus(code) ? 1 : 4;
    for (let i = 0; i < copies; i++) wall.push(code);
  }
  const rng = makeRng(seed);
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  return wall;
}

export function sortTiles(codes) {
  return [...codes].sort((a, b) => ORDER.get(a) - ORDER.get(b));
}

export function suitOf(code) {
  return code[0];
}

export function isBonus(code) {
  const s = suitOf(code);
  return s === 'f' || s === 'g';
}

export function isSuit(code) {
  return SUITS.includes(suitOf(code));
}

export function isHonor(code) {
  const s = suitOf(code);
  return s === 'w' || s === 'd';
}

export function rankOf(code) {
  return isSuit(code) ? Number(code[1]) : null;
}
