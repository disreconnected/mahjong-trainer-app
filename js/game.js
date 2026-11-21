// Game state machine. No DOM, no timers; all randomness comes from the seed.
import { buildWall, sortTiles, isBonus } from './tiles.js';
import {
  isWin, canPong, canKongClaim, chiOptions, concealedKongs, addedKongs,
} from './rules.js';

// --- helpers ---

function emit(state, events, ev) {
  state.eventCount += 1;
  const out = { n: state.eventCount, ...ev, wallLeft: state.wall.length };
  events.push(out);
  return out;
}

function removeTile(hand, tile) {
  const i = hand.indexOf(tile);
  if (i < 0) throw new Error(`tile ${tile} not in hand`);
  hand.splice(i, 1);
}

function endAsWin(state, events, winner, tile, from, kind) {
  state.phase = 'ended';
  state.claim = null;
  state.result = { type: 'win', winner, tile, from, kind };
  const ev = { type: 'hu', player: winner };
  if (tile !== null) ev.tile = tile;
  if (from !== null) ev.from = from;
  ev.kind = kind;
  emit(state, events, ev);
}

function endAsDraw(state, events) {
  state.phase = 'ended';
  state.claim = null;
  state.lastDraw = null;
  state.result = { type: 'draw', winner: null, tile: null, from: null, kind: null };
  emit(state, events, { type: 'drawgame' });
}

// Move bonus tiles out of `player`'s hand into flowers, replacing each from the back
// of the wall. Returns the last replacement tile (or null), or false if the wall ran out.
function resolveBonus(state, player, events) {
  const p = state.players[player];
  let last = null;
  for (let i = 0; i < p.hand.length; ) {
    const tile = p.hand[i];
    if (!isBonus(tile)) { i++; continue; }
    p.hand.splice(i, 1);
    p.flowers.push(tile);
    emit(state, events, { type: 'flower', player, tile });
    if (state.wall.length === 0) { endAsDraw(state, events); return false; }
    const rep = state.wall.pop();
    p.hand.push(rep);
    emit(state, events, { type: 'draw', player, tile: rep, kind: 'replacement' });
    last = rep;
    // The replacement sits at the end of the hand, so the scan checks it too.
  }
  return last;
}

// Draw for `player` (front of the wall, or back for a replacement draw), resolve bonus
// tiles, sort the hand and make it that player's turn. Returns false if the game ended.
function drawFor(state, player, events, fromBack = false) {
  if (state.wall.length === 0) { endAsDraw(state, events); return false; }
  const p = state.players[player];
  const tile = fromBack ? state.wall.pop() : state.wall.shift();
  p.hand.push(tile);
  emit(state, events, fromBack
    ? { type: 'draw', player, tile, kind: 'replacement' }
    : { type: 'draw', player, tile });
  const rep = resolveBonus(state, player, events);
  if (rep === false) return false;
  p.hand = sortTiles(p.hand);
  state.phase = 'turn';
  state.turn = player;
  state.lastDraw = rep ?? tile;
  state.afterClaim = false;
  return true;
}

// Claim options of every other player on `tile` released by `from`.
function claimOptions(state, tile, from) {
  const options = {};
  for (let k = 1; k <= 3; k++) {
    const player = (from + k) % 4;
    const hand = state.players[player].hand;
    const acts = [];
    if (isWin([...hand, tile], state.players[player].melds.length)) acts.push({ type: 'hu', player });
    // No Kong on an empty wall: it needs a replacement draw.
    if (state.wall.length > 0 && canKongClaim(hand, tile)) acts.push({ type: 'kong', player, tile, kind: 'claimed' });
    if (canPong(hand, tile)) acts.push({ type: 'pong', player });
    if (k === 1) {
      for (const tiles of chiOptions(hand, tile)) acts.push({ type: 'chi', player, tiles });
    }
    if (acts.length) {
      acts.push({ type: 'pass', player });
      options[player] = acts;
    }
  }
  return options;
}

// After a discard: open the claim phase, or draw for the next player if nobody can claim.
function afterDiscard(state, from, tile, events) {
  const options = claimOptions(state, tile, from);
  if (Object.keys(options).length === 0) {
    drawFor(state, (from + 1) % 4, events);
    return;
  }
  state.phase = 'claim';
  state.claim = { tile, from, robKong: false, options, responses: {} };
}

const PRIORITY = { hu: 3, kong: 2, pong: 2, chi: 1, pass: 0 };

// Added Kong: before it completes, players who win on the tile may rob it.
function declareAddedKong(state, player, tile, events) {
  const options = {};
  for (let k = 1; k <= 3; k++) {
    const other = (player + k) % 4;
    const p = state.players[other];
    if (isWin([...p.hand, tile], p.melds.length)) {
      options[other] = [{ type: 'hu', player: other }, { type: 'pass', player: other }];
    }
  }
  if (Object.keys(options).length === 0) {
    completeAddedKong(state, player, tile, events);
    return;
  }
  state.phase = 'claim';
  state.claim = { tile, from: player, robKong: true, options, responses: {} };
}

function completeAddedKong(state, player, tile, events) {
  const p = state.players[player];
  removeTile(p.hand, tile);
  const meld = p.melds.find((m) => m.type === 'pong' && m.tiles[0] === tile);
  meld.type = 'kong';
  meld.tiles = [tile, tile, tile, tile];
  emit(state, events, { type: 'kong', player, tile, kind: 'added' });
  drawFor(state, player, events, true);
}

// Once every player in options has answered: the highest-priority response wins,
// ties going to the player nearest after the releaser.
function resolveClaim(state, events) {
  const { tile, from, responses } = state.claim;
  let winner = null;
  for (let k = 1; k <= 3; k++) {
    const r = responses[(from + k) % 4];
    if (r && PRIORITY[r.type] > 0 && (!winner || PRIORITY[r.type] > PRIORITY[winner.type])) winner = r;
  }
  const robKong = state.claim.robKong;
  state.claim = null;
  if (robKong) {
    if (!winner) {
      completeAddedKong(state, from, tile, events);
      return;
    }
    removeTile(state.players[from].hand, tile);
  } else {
    if (!winner) {
      drawFor(state, (from + 1) % 4, events);
      return;
    }
    const discards = state.players[from].discards;
    discards.splice(discards.lastIndexOf(tile), 1);
  }
  const player = winner.player;
  const p = state.players[player];
  if (winner.type === 'hu') {
    p.hand = sortTiles([...p.hand, tile]);
    endAsWin(state, events, player, tile, from, robKong ? 'robkong' : 'discard');
    return;
  }
  if (winner.type === 'kong') {
    for (let i = 0; i < 3; i++) removeTile(p.hand, tile);
    p.melds.push({ type: 'kong', tiles: [tile, tile, tile, tile], from, concealed: false });
    emit(state, events, { type: 'kong', player, tile, from, kind: 'claimed' });
    drawFor(state, player, events, true);
    return;
  }
  const used = winner.type === 'pong' ? [tile, tile] : winner.tiles;
  for (const t of used) removeTile(p.hand, t);
  const meld = { type: winner.type, tiles: sortTiles([...used, tile]), from, concealed: false };
  p.melds.push(meld);
  emit(state, events, { type: winner.type, player, tile, tiles: [...meld.tiles], from });
  state.phase = 'turn';
  state.turn = player;
  state.lastDraw = null;
  state.afterClaim = true; // no hu until this player draws again
}

const sameAction = (a, b) =>
  a.type === b.type && a.player === b.player && a.tile === b.tile && a.kind === b.kind &&
  JSON.stringify(a.tiles) === JSON.stringify(b.tiles);

// --- API ---

export function createGame({ seed, dealer }) {
  const wall = buildWall(seed);
  const state = {
    seed, dealer,
    initialWall: [...wall],
    wall,
    phase: 'turn',
    turn: dealer,
    players: [0, 1, 2, 3].map(() => ({ hand: [], melds: [], flowers: [], discards: [] })),
    lastDraw: null,
    afterClaim: false, // true between the turn player's own chi/pong and its next draw
    claim: null,
    result: null,
    eventCount: 0,
    setupEvents: [],
  };
  const events = state.setupEvents;
  const order = [0, 1, 2, 3].map((k) => (dealer + k) % 4);
  for (const player of order) {
    const tiles = state.wall.splice(0, player === dealer ? 14 : 13);
    state.players[player].hand = tiles;
    emit(state, events, { type: 'deal', player, tiles: [...tiles] });
  }
  for (const player of order) {
    resolveBonus(state, player, events); // 144-tile wall cannot run out during the deal
    state.players[player].hand = sortTiles(state.players[player].hand);
  }
  return state;
}

export function legalActions(state, player) {
  if (!Number.isInteger(player) || player < 0 || player > 3) return [];
  if (state.phase === 'turn' && player === state.turn) {
    const { hand, melds } = state.players[player];
    const acts = [];
    if (!state.afterClaim && isWin(hand, melds.length)) acts.push({ type: 'hu', player });
    if (state.wall.length > 0) { // no Kong on an empty wall: it needs a replacement draw
      for (const tile of concealedKongs(hand)) acts.push({ type: 'kong', player, tile, kind: 'concealed' });
      for (const tile of addedKongs(hand, melds)) acts.push({ type: 'kong', player, tile, kind: 'added' });
    }
    for (const tile of new Set(hand)) acts.push({ type: 'discard', player, tile });
    return acts;
  }
  if (state.phase === 'claim') {
    const { options, responses } = state.claim;
    if (options[player] && !(player in responses)) {
      return options[player].map((a) => (a.tiles ? { ...a, tiles: [...a.tiles] } : { ...a }));
    }
  }
  return [];
}

export function applyAction(state, action) {
  const match = legalActions(state, action.player).find((a) => sameAction(a, action));
  if (!match) {
    throw new Error(`illegal action: ${JSON.stringify(action)}`);
  }
  const events = [];
  if (state.phase === 'claim') {
    state.claim.responses[action.player] = match; // a fresh copy holding only contract fields
    if (action.type === 'pass') emit(state, events, { type: 'pass', player: action.player });
    const pending = Object.keys(state.claim.options).some((p) => !(p in state.claim.responses));
    if (!pending) resolveClaim(state, events);
    return events;
  }
  const { player } = action;
  const p = state.players[player];
  switch (action.type) {
    case 'discard': {
      removeTile(p.hand, action.tile);
      p.discards.push(action.tile);
      state.lastDraw = null;
      emit(state, events, { type: 'discard', player: action.player, tile: action.tile });
      afterDiscard(state, action.player, action.tile, events);
      break;
    }
    case 'hu':
      endAsWin(state, events, player, state.lastDraw, null, 'selfdraw');
      break;
    case 'kong':
      if (action.kind === 'concealed') {
        for (let i = 0; i < 4; i++) removeTile(p.hand, action.tile);
        p.melds.push({ type: 'kong', tiles: Array(4).fill(action.tile), from: null, concealed: true });
        emit(state, events, { type: 'kong', player, tile: action.tile, kind: 'concealed' });
        drawFor(state, player, events, true);
      } else {
        declareAddedKong(state, player, action.tile, events);
      }
      break;
    default:
      throw new Error(`unsupported action: ${action.type}`);
  }
  return events;
}

export function nextDealer(state) {
  if (state.phase !== 'ended') throw new Error('game has not ended');
  const { result, dealer } = state;
  return result.type === 'draw' || result.winner === dealer ? dealer : (dealer + 1) % 4;
}

export function seatWind(state, player) {
  return ['E', 'S', 'W', 'N'][(player - state.dealer + 4) % 4];
}
