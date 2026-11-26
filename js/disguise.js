// Disguised practice items: the same position with every tile relabelled, so a repeat showing tests the
// decision and not the player's memory of the hand. Pure, no DOM; imports under Node.
// See docs/contract.md "disguise.js".
//
// A disguise d = { suits, mirror, winds, dragons }:
//   suits    a permutation of ['m','p','s']: suits[i] is what SUITS[i] becomes (m, p, s in that order)
//   mirror   true: rank r becomes 10 - r
//   winds    a permutation of ['we','ws','ww','wn'], dragons a permutation of ['dr','dg','dw'] (same reading)
// Flowers and seasons are unchanged. Casual play has no scoring, so no wind or dragon means anything
// beyond "an honor tile" to the rules, the bots or the grading (checked: nothing reads a specific one).
import { makeRng, sortTiles } from './tiles.js';
import { analyzeLog } from './review.js';
import { buildQuizItems, gradeAnswer } from './quiz.js';

const SUITS = ['m', 'p', 's'];
const WINDS = ['we', 'ws', 'ww', 'wn'];
const DRAGONS = ['dr', 'dg', 'dw'];

/** Shown on a disguised practice question. */
export const DISGUISE_NOTE = 'Shown in disguise: the tiles are relabelled, the decision is the same.';

// --- the tile map ---

/** mapTile(code, d) -> the code `code` is shown as under the disguise d. */
export function mapTile(code, d) {
  const lead = code[0];
  const suit = SUITS.indexOf(lead);
  if (suit >= 0) return d.suits[suit] + (d.mirror ? 10 - Number(code[1]) : code[1]);
  if (lead === 'w') return d.winds[WINDS.indexOf(code)] ?? code;
  if (lead === 'd') return d.dragons[DRAGONS.indexOf(code)] ?? code;
  return code; // flowers and seasons
}

/** A quiz choice id under d: a tile, 'chi:a-b' (its two tiles, lowest first again) or 'hu' / 'pass' / 'pong' / 'kong'. */
export function mapChoiceId(id, d) {
  if (id.startsWith('chi:')) return `chi:${sortTiles(id.slice(4).split('-').map((t) => mapTile(t, d))).join('-')}`;
  return ['hu', 'pass', 'pong', 'kong'].includes(id) ? id : mapTile(id, d);
}

/** disguiseKey(d) -> a short string that is the same exactly for equal disguises (a cache key). */
export const disguiseKey = (d) =>
  `${d.suits.join('')}${d.mirror ? 'r' : '-'}.${d.winds.map((w) => w[1]).join('')}.${d.dragons.map((w) => w[1]).join('')}`;

// --- choosing a disguise ---

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest]));
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const stridesOf = (n) => Array.from({ length: n - 1 }, (_, i) => i + 1).filter((k) => gcd(k, n) === 1);

// Every way to relabel the suited tiles that visibly changes them: a suit permutation and/or the mirror,
// all but "no permutation, no mirror" (11 of 12).
const SUIT_LOOKS = [false, true]
  .flatMap((mirror) => permutations(SUITS).map((suits) => ({ suits, mirror })))
  .filter((l) => l.mirror || l.suits.some((s, i) => s !== SUITS[i]));
const WIND_PERMS = permutations(WINDS);
const DRAGON_PERMS = permutations(DRAGONS);
const ATTEMPT_SHIFTS = [1, 5, 5]; // per attempt: 1 mod 11, 5 mod 24 and 5 mod 6 (each coprime to its list's length)
const STRIDES = [SUIT_LOOKS.length, WIND_PERMS.length, DRAGON_PERMS.length].map(stridesOf);

// FNV-1a: a stable 32-bit hash of the item id.
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * disguiseFor(itemId, variant, attempt = 0) -> the disguise for an item's `variant`-th repeat (variant = how
 * many times the item was seen before). Deterministic. The item id's hash picks a start and a step in each
 * list of looks (suited relabellings, wind orders, dragon orders) and the variant walks along it, so
 * successive repeats always look different (the first 11 never repeat a suited look) and the suited tiles
 * are never shown as played: the suited looks leave out "no permutation, no mirror". attempt > 0 moves
 * every list on by a fixed amount per attempt (the 11 suited looks are all different for attempts 0 to
 * 10): the other disguises tried when attempt 0 did not give the same decision (disguiseWithRetry). An
 * attempt can by chance share its suited look with a neighbouring repeat.
 */
export function disguiseFor(itemId, variant = 1, attempt = 0) {
  const v = Math.max(0, Math.floor(Number(variant)) || 0);
  const a = Math.max(0, Math.floor(Number(attempt)) || 0);
  const rng = makeRng(hashOf(String(itemId)));
  const lists = [SUIT_LOOKS, WIND_PERMS, DRAGON_PERMS];
  const [look, winds, dragons] = lists.map((list, k) => {
    const start = Math.floor(rng() * list.length);
    const step = STRIDES[k][Math.floor(rng() * STRIDES[k].length)];
    return list[(start + step * v + ATTEMPT_SHIFTS[k] * a) % list.length];
  });
  return { suits: [...look.suits], mirror: look.mirror, winds: [...winds], dragons: [...dragons] };
}

// --- the disguised review and item ---

/** reviewUnder(log, d) -> analyzeLog(log) with every tile relabelled by d (every sentence regenerated). */
export const reviewUnder = (log, d) => analyzeLog(log, { tileMap: (code) => mapTile(code, d) });

function sameSet(a, b) {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

// What the table of the disguised item must show: the original hand mapped and sorted by the game (the drawn
// tile, if any, last), the same drawn tile, and for every player the same number of discards and of sets.
function positionProblem(item, made, d) {
  const { hand, drew, players } = item.table;
  const kept = drew && hand.at(-1) === drew ? hand.slice(0, -1) : hand;
  const want = [...sortTiles(kept.map((t) => mapTile(t, d))), ...(kept.length < hand.length ? [mapTile(drew, d)] : [])];
  if (JSON.stringify(made.table.hand) !== JSON.stringify(want)) return 'the hand differs';
  if ((made.table.drew ?? null) !== (drew ? mapTile(drew, d) : null)) return 'the drawn tile differs';
  const same = players.every((p, i) => p.discards.length === made.table.players[i].discards.length && p.melds.length === made.table.players[i].melds.length);
  return same ? null : 'the discards or sets differ';
}

/**
 * disguiseCheck(item, review, d) -> { item } or { reason }. `review` is the game's review made under d
 * (reviewUnder). The disguised item is the quiz item of the same step in that review, accepted only when it
 * poses the same decision: same kind and verdict, the player's choice, the right answers and the choices
 * all equal the original's under the tile map (their order may differ: ties sort differently), the table
 * matches (positionProblem), and every choice earns the verdict its original earns (grading has tie-order
 * dependencies, so a wrong answer's verdict could flip). It keeps the original id, file, date, stepIndex,
 * lessonIds and reviewVersion, so the schedule stays keyed to the original.
 */
export function disguiseCheck(item, review, d) {
  if (!review || review.ok !== true) return { reason: 'the disguised game did not replay' };
  const made = buildQuizItems([{ file: item.file, review }]).find((it) => it.stepIndex === item.stepIndex);
  if (!made) return { reason: 'the step is no longer flagged' };
  if (made.kind !== item.kind) return { reason: 'kind differs' };
  if (made.original.verdict !== item.original.verdict) return { reason: 'verdict differs' };
  const choice = mapChoiceId(item.original.choice, d);
  if (made.original.choice !== choice) return { reason: "the player's choice differs" };
  if (!sameSet(made.answers, item.answers.map((id) => mapChoiceId(id, d)))) return { reason: 'answers differ' };
  if (!sameSet(made.choices.map((c) => c.id), item.choices.map((c) => mapChoiceId(c.id, d)))) return { reason: 'choices differ' };
  const position = positionProblem(item, made, d);
  if (position) return { reason: position };
  for (const c of item.choices) {
    if (gradeAnswer(made, mapChoiceId(c.id, d)).verdict !== gradeAnswer(item, c.id).verdict) return { reason: "a choice's verdict differs" };
  }
  const { id, file, date, stepIndex, lessonIds, reviewVersion } = item;
  return { item: { ...made, id, file, date, stepIndex, lessonIds, reviewVersion, disguised: true, disguise: d } };
}

/** disguiseItem(item, review, d) -> the disguised item, or null when the disguised step does not pose the same decision. */
export const disguiseItem = (item, review, d) => disguiseCheck(item, review, d).item ?? null;

/** Extra disguises tried after the first one fails the check (see disguiseWithRetry). */
export const DISGUISE_RETRIES = 5;

/**
 * disguiseWithRetry(item, log, variant) -> { item, attempts } or { reason, attempts }: the item disguised for
 * its `variant`-th repeat. When the first disguise does not pose the same decision (a tie that orders
 * differently under it), up to DISGUISE_RETRIES other disguises are tried, always the same ones for the same
 * item and variant, before giving up (the caller then shows the item as played). A game that does not replay
 * is not retried. `log` is the game's log.
 */
export function disguiseWithRetry(item, log, variant) {
  let reason = null;
  for (let attempt = 0; attempt <= DISGUISE_RETRIES; attempt++) {
    const d = disguiseFor(item.id, variant, attempt);
    const review = reviewUnder(log, d);
    const got = disguiseCheck(item, review, d);
    if (got.item) return { item: got.item, attempts: attempt + 1 };
    reason = got.reason;
    if (!review.ok) return { reason, attempts: attempt + 1 };
  }
  return { reason, attempts: DISGUISE_RETRIES + 1 };
}
