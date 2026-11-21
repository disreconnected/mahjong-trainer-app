// Centre-of-table announcements for Chi, Pong, Kong, Hu and a drawn game. Pure: no DOM,
// imports under Node. ui.js draws the result and keeps it on screen for `ms`.
import { tileLabel } from './tileart.js';

const NAMES = ['You', 'Bot 1', 'Bot 2', 'Bot 3'];
const fromWords = (p) => (p === 0 ? 'you' : NAMES[p]);

// How long an announcement stays up. Claims follow the bot speed; a win or a drawn game stays
// for the pause before the end screen opens (ui.js END_DELAY), which then covers it.
export const ANNOUNCE_MS = Object.freeze({ slow: 1200, normal: 1200, fast: 700, end: 1000 });
export const ANNOUNCE_TYPES = Object.freeze(['chi', 'pong', 'kong', 'hu', 'drawgame']);

export function announceMs(type, botSpeed) {
  if (type === 'hu' || type === 'drawgame') return ANNOUNCE_MS.end;
  return botSpeed === 'fast' ? ANNOUNCE_MS.fast : botSpeed === 'slow' ? ANNOUNCE_MS.slow : ANNOUNCE_MS.normal;
}

// "3-4-5 of Bamboo" for a run of one suit.
function runLabel(tiles) {
  const suit = tileLabel(tiles[0]).replace(/^\d+ of /, '');
  return `${tiles.map((t) => t.slice(1)).join('-')} of ${suit}`;
}

/**
 * One event -> announcement data, or null (flower, discard, draw, deal, pass, ...).
 * { n, type, kind ('chi'|'pong'|'kong'|'hu'|'draw'), player, title, who, tiles: [{ code, back }],
 *   marked (index into tiles, or null), sub, text (plain, for the aria-live region), ms,
 *   meld: { player, type, tile, tiles } | null (the set on the table to glow) }
 */
export function announcementFor(e, botSpeed = 'normal') {
  if (!e || !ANNOUNCE_TYPES.includes(e.type)) return null;
  const who = e.type === 'drawgame' ? '' : NAMES[e.player];
  const base = { n: e.n, type: e.type, kind: e.type, player: e.type === 'drawgame' ? null : e.player, who, ms: announceMs(e.type, botSpeed), meld: null };
  const faces = (codes) => codes.map((code) => ({ code, back: false }));
  const say = (title, parts) => `${who}: ${[title, ...parts].filter(Boolean).join(', ')}`;
  switch (e.type) {
    case 'chi': {
      const tiles = e.tiles ? [...e.tiles] : [e.tile];
      const sub = `from ${fromWords(e.from)}`;
      return {
        ...base, title: 'Chi', tiles: faces(tiles), marked: tiles.indexOf(e.tile), sub,
        text: say('Chi', [`${runLabel(tiles)} (took the ${tileLabel(e.tile)})`, sub]),
        meld: { player: e.player, type: 'chi', tile: e.tile, tiles },
      };
    }
    case 'pong': {
      const tiles = e.tiles ? [...e.tiles] : [e.tile, e.tile, e.tile];
      const sub = `from ${fromWords(e.from)}`;
      return {
        ...base, title: 'Pong', tiles: faces(tiles), marked: tiles.length - 1, sub,
        text: say('Pong', [tileLabel(e.tile), sub]),
        meld: { player: e.player, type: 'pong', tile: e.tile, tiles },
      };
    }
    case 'kong': {
      const four = [e.tile, e.tile, e.tile, e.tile];
      const meld = { player: e.player, type: 'kong', tile: e.tile, tiles: four };
      let tiles = faces(four);
      let marked = 3;
      let sub;
      if (e.kind === 'concealed') {
        // As the table shows it: a bot's concealed Kong has its two end tiles face down.
        if (e.player !== 0) tiles = tiles.map((t, i) => ({ ...t, back: i === 0 || i === 3 }));
        marked = null;
        sub = 'concealed';
      } else if (e.kind === 'added') {
        sub = `added to ${e.player === 0 ? 'your' : 'their'} Pong`;
      } else {
        sub = `from ${fromWords(e.from)}`;
      }
      return { ...base, title: 'Kong', tiles, marked, sub, text: say('Kong', [tileLabel(e.tile), sub]), meld };
    }
    case 'hu': {
      const tiles = e.tile ? faces([e.tile]) : [];
      let sub;
      if (e.kind === 'selfdraw') sub = e.tile ? 'self-drawn' : 'dealt hand';
      else if (e.kind === 'robkong') sub = `robbed Kong from ${fromWords(e.from)}`;
      else sub = `from ${fromWords(e.from)}`;
      return {
        ...base, title: 'Hu', tiles, marked: tiles.length ? 0 : null, sub,
        text: say('Hu', [e.tile ? tileLabel(e.tile) : '', sub]),
      };
    }
    default: // drawgame
      return { ...base, kind: 'draw', title: 'Draw', tiles: [], marked: null, sub: 'the wall ran out', text: 'Draw: the wall ran out' };
  }
}

/**
 * Which events to announce, exactly once each. `track` is the previous result's track (or
 * null); `key` identifies the game (the controller); `events` are the newest events (any
 * window that holds every event since the last call); `eventCount` is the game's last event
 * number. A new key (a new game, or the first sight of one) starts from eventCount, so nothing
 * that happened before is replayed. Of several new announceable events, the last one wins.
 * Returns { track, announcement | null }.
 */
export function nextAnnouncement(track, key, events, eventCount, botSpeed = 'normal') {
  if (!track || track.key !== key) return { track: { key, seenN: eventCount }, announcement: null };
  let announcement = null;
  let seenN = track.seenN;
  for (const e of events ?? []) {
    if (!(e.n > track.seenN)) continue;
    seenN = Math.max(seenN, e.n);
    const a = announcementFor(e, botSpeed);
    if (a) announcement = a;
  }
  seenN = Math.max(seenN, eventCount ?? 0);
  return { track: { key, seenN }, announcement };
}
