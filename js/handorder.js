// Player 0's own tile order when auto-sort is off. The engine keeps the hand sorted; the
// custom order is UI state: an array of tile codes in display order, reconciled with the
// engine's hand after every change. Pure, no DOM; unit-tested.
import { isBonus, sortTiles } from './tiles.js';

const sameMultiset = (a, b) => a.length === b.length && sortTiles(a).join() === sortTiles(b).join();

/**
 * dealtOrder(hand, setupEvents, player = 0) -> the player's hand in the order it was dealt:
 * the dealt non-bonus tiles in deal order, then the replacement draws (for bonus tiles) in
 * the order drawn. Falls back to a copy of `hand` when the events don't match the hand.
 */
export function dealtOrder(hand, setupEvents, player = 0) {
  const tiles = [];
  for (const e of setupEvents ?? []) {
    if (!e || e.player !== player) continue;
    if (e.type === 'deal' && Array.isArray(e.tiles)) tiles.push(...e.tiles);
    else if (e.type === 'draw' && e.kind === 'replacement') tiles.push(e.tile);
  }
  const order = tiles.filter((t) => !isBonus(t));
  return sameMultiset(order, hand) ? order : [...hand];
}

// Sort button: the standard order; a just-drawn tile (drawn = its code, kept last) stays last.
export function sortOrder(order, drawn = null) {
  if (drawn && order.at(-1) === drawn) return [...sortTiles(order.slice(0, -1)), drawn];
  return sortTiles(order);
}

// Dragging: where a tile dropped at `x` lands, given the x-centers of the other tiles in
// display order (the index `to` for moveTile).
export function insertIndex(centers, x) {
  return centers.filter((c) => c < x).length;
}

// Display index of the tile now at `i` after moveTile(order, from, to).
export function movedIndex(i, from, to) {
  if (i === from) return to;
  const j = i < from ? i : i - 1;
  return j < to ? j : j + 1;
}

/**
 * reconcileOrder(order, hand) -> new display order holding exactly the tiles of `hand`.
 * Tiles still in the hand keep their relative order; tiles that left are removed (for a
 * duplicate code, the rightmost copies go first); new tiles are appended on the right,
 * in hand order.
 */
export function reconcileOrder(order, hand) {
  const { kept, added } = splitOrder(order, hand);
  return [...kept, ...added];
}

// Tiles of `order` that stay (the leftmost copies) and tiles of `hand` that are new.
function splitOrder(order, hand) {
  const left = new Map();
  for (const t of hand) left.set(t, (left.get(t) ?? 0) + 1);
  // Copies of each code to keep from `order`: the leftmost ones.
  const kept = [];
  for (const t of order ?? []) {
    const n = left.get(t) ?? 0;
    if (n > 0) {
      kept.push(t);
      left.set(t, n - 1);
    }
  }
  const added = [];
  for (const t of hand) {
    const n = left.get(t) ?? 0;
    if (n > 0) {
      added.push(t);
      left.set(t, n - 1);
    }
  }
  return { kept, added };
}

/**
 * drawnAfterSync(order, hand, lastDraw) -> the just-drawn tile to mark (its code), or null.
 * After reconcileOrder(order, hand), the tile is marked when lastDraw is set and it is the tile
 * appended last in this sync, however many tiles left the hand at the same time (a Kong and
 * its replacement draw). A Chi or Pong appends nothing, so nothing is marked.
 */
export function drawnAfterSync(order, hand, lastDraw) {
  if (!lastDraw) return null;
  return splitOrder(order, hand).added.at(-1) === lastDraw ? lastDraw : null;
}

// Moves the tile at `from` so that it lands at index `to` (both in display order).
export function moveTile(order, from, to) {
  const out = [...order];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [t] = out.splice(from, 1);
  out.splice(to, 0, t);
  return out;
}

/**
 * For each index of the sorted `hand`, its index in `order` (same multiset). The k-th copy of
 * a code in the hand maps to the k-th copy of that code in the display order.
 */
export function sortedToOrderIndex(order, hand) {
  const slots = new Map();
  order.forEach((t, i) => {
    if (!slots.has(t)) slots.set(t, []);
    slots.get(t).push(i);
  });
  const used = new Map();
  return hand.map((t) => {
    const k = used.get(t) ?? 0;
    used.set(t, k + 1);
    return slots.get(t)?.[k] ?? -1;
  });
}
