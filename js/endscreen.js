// End-of-game screen: text and hand analysis. No DOM; imports under Node.
import { ALL_CODES, isSuit, suitOf, rankOf, sortTiles } from './tiles.js';
import { isWin, shanten, waits, liveCount } from './rules.js';
import { tileLabel } from './tileart.js';

export const NAMES = Object.freeze(['You', 'Bot 1', 'Bot 2', 'Bot 3']);
export const WIND_NAMES = Object.freeze({ E: 'East', S: 'South', W: 'West', N: 'North' });

const order = (code) => ALL_CODES.indexOf(code);
// "Bot 3's" / "your"
const owner = (p) => (p === 0 ? 'your' : `${NAMES[p]}'s`);

// Splits counted tiles into sets (triplets first, then runs), or null.
function splitSets(counts) {
  const code = ALL_CODES.find((c) => counts[c] > 0);
  if (!code) return [];
  if (counts[code] >= 3) {
    counts[code] -= 3;
    const rest = splitSets(counts);
    counts[code] += 3;
    if (rest) return [{ kind: 'triplet', tiles: [code, code, code] }, ...rest];
  }
  if (isSuit(code) && rankOf(code) <= 7) {
    const b = suitOf(code) + (rankOf(code) + 1);
    const c = suitOf(code) + (rankOf(code) + 2);
    if (counts[b] > 0 && counts[c] > 0) {
      counts[code]--; counts[b]--; counts[c]--;
      const rest = splitSets(counts);
      counts[code]++; counts[b]++; counts[c]++;
      if (rest) return [{ kind: 'run', tiles: [code, b, c] }, ...rest];
    }
  }
  return null;
}

/**
 * A winning hand as (4 - meldCount) sets + 1 pair, in sort order:
 * [{ kind: 'run'|'triplet'|'pair', tiles: [codes] }], or null if the hand does not win.
 * With winTile, the first group holding that tile gets winIndex (its position in tiles).
 */
export function decomposeWin(hand, meldCount, winTile = null) {
  if (!isWin(hand, meldCount)) return null;
  const counts = {};
  for (const c of hand) counts[c] = (counts[c] || 0) + 1;
  let groups = null;
  for (const pair of sortTiles([...new Set(hand)])) {
    if (counts[pair] < 2) continue;
    counts[pair] -= 2;
    const sets = splitSets(counts);
    counts[pair] += 2;
    if (sets) {
      groups = [...sets, { kind: 'pair', tiles: [pair, pair] }];
      break;
    }
  }
  groups.sort((a, b) => order(a.tiles[0]) - order(b.tiles[0]));
  if (winTile) {
    const g = groups.find((x) => x.tiles.includes(winTile));
    if (g) g.winIndex = g.tiles.indexOf(winTile);
  }
  return groups;
}

// --- result text ---

export function resultHeadline(result) {
  if (!result || result.type === 'draw') return 'Draw: the wall ran out';
  return result.winner === 0 ? 'You win!' : `${NAMES[result.winner]} wins`;
}

// How the game was won, in plain words ('' for a draw).
export function resultSubline(result) {
  if (!result || result.type === 'draw') return '';
  const { winner, tile, from, kind } = result;
  if (kind === 'selfdraw') return tile ? `Self-drawn win on ${tileLabel(tile)}` : 'Won on the dealt hand';
  const label = tile ? tileLabel(tile) : 'unknown tile';
  if (kind === 'robkong') return `Robbed ${owner(from)} Kong: ${label}`;
  if (from === 0 && winner !== 0) return `You discarded the winning tile: ${label}`;
  return `Won on ${NAMES[from]}'s discard: ${label}`;
}

// When player 0's own claim on the winning discard lost to the win: "Your Pong was overruled: a
// win takes priority over Pong." `decision` is the log's last decision ('' when it does not apply).
// A Hu of player 0 loses only a tie, to the player sooner in turn order after the thrower.
export function overruledLine(result, decision) {
  if (!result || result.type !== 'win' || result.winner === 0 || result.kind === 'selfdraw') return '';
  const d = decision;
  if (!d || d.kind !== 'claim' || !d.outranked || d.claimTile !== result.tile || d.claimFrom !== result.from) return '';
  const type = d.chosen && d.chosen.type;
  if (type === 'hu') {
    return `Your Hu was overruled: ${NAMES[result.winner]} comes sooner after ${NAMES[result.from]} in turn order, so that win counts.`;
  }
  const word = { chi: 'Chi', pong: 'Pong', kong: 'Kong' }[type];
  return word ? `Your ${word} was overruled: a win takes priority over ${word}.` : '';
}

// Ticker line for a hu event: "Bot 2 wins on your discard: 7 of Circles".
export function winTickerLine(e) {
  const who = e.player === 0 ? 'You win' : `${NAMES[e.player]} wins`;
  const label = e.tile ? tileLabel(e.tile) : '';
  if (e.kind === 'selfdraw') return label ? `${who} by self-draw: ${label}` : `${who} on the dealt hand`;
  if (e.kind === 'robkong') return `${who} by robbing ${owner(e.from)} Kong: ${label}`;
  return `${who} on ${owner(e.from)} discard: ${label}`;
}

// --- non-winners ---

// Tiles player p can see at the end: own hand, every discard, every meld.
export function visibleTo(state, p) {
  const seen = [...state.players[p].hand];
  for (const pl of state.players) {
    seen.push(...pl.discards);
    for (const m of pl.melds) seen.push(...m.tiles);
  }
  return seen;
}

/**
 * How close a hand is to winning: { text, ready, shanten, waits: [{ tile, live }] }.
 * live = copies not in visibleTiles (see liveCount).
 */
export function handStatus(hand, meldCount, visibleTiles) {
  const s = shanten(hand, meldCount);
  if (s <= 0) {
    const ws = hand.length % 3 === 1 ? waits(hand, meldCount).map((tile) => ({ tile, live: liveCount(tile, visibleTiles) })) : [];
    const list = ws.map((w) => `${tileLabel(w.tile)} (${w.live} left)`).join(', ');
    return { text: list ? `Ready: waiting on ${list}` : 'Ready', ready: true, shanten: s, waits: ws };
  }
  return { text: `${s} tile${s === 1 ? '' : 's'} from ready`, ready: false, shanten: s, waits: [] };
}

// --- small lines ---

export function statsLine({ wallLeft, yourDiscards, gameNumber, tally }) {
  const t = tally ?? { played: 0, wins: 0 };
  return (
    `${wallLeft} tile${wallLeft === 1 ? '' : 's'} left in the wall · You discarded ${yourDiscards} · ` +
    `Game ${gameNumber} · Played ${t.played}, your wins ${t.wins}`
  );
}

// save: { status: 'autoplay'|'none'|'pending'|'saved'|'failed', file }
export function logStatusText(save) {
  switch (save && save.status) {
    case 'autoplay': return 'Not saved (autoplay)';
    case 'pending': return 'Saving log…';
    case 'saved': return save.file ? `Saved: ${save.file}` : 'Saved';
    case 'failed': return 'Log could not be saved';
    default: return 'Not saved';
  }
}

// Top bar: "Game 3 · Dealer: Bot 1 · You: West"
export function gameInfoText(gameNumber, dealer, yourWind) {
  return `Game ${gameNumber} · Dealer: ${NAMES[dealer]} · You: ${WIND_NAMES[yourWind]}`;
}
