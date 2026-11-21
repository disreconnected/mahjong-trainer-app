// Tile drawings as inline SVG strings. Pure string building, no DOM access.
// Every tile uses viewBox 0 0 60 80: the face is the top 74 units, the darker strip
// below it is the tile's edge. The face centre is (30, 38).
import { ALL_CODES, suitOf, rankOf } from './tiles.js';

// Colours match the tokens in style.css (SVG attributes cannot read CSS variables).
const FACE = '#f7f1e1';
const EDGE = '#cdbf9c';
const EDGE_LINE = '#8f8468';
const BACK = '#2f6e62';
const BACK_LINE = '#5fa594';
const INK = {
  m: '#b3261e', // Characters
  p: '#1f5fa8', // Circles
  s: '#1d7a45', // Bamboo
  dark: '#1d2430',
  red: '#c62828',
  flower: '#c2185b',
  season: '#d9822b',
  gold: '#e6a817',
};
const FONT = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif";

const KNOWN = new Set(ALL_CODES);
const SUIT_NAME = { m: 'Characters', p: 'Circles', s: 'Bamboo' };
const WINDS = { we: ['East', 'E', '東'], ws: ['South', 'S', '南'], ww: ['West', 'W', '西'], wn: ['North', 'N', '北'] };
const DRAGONS = { dr: 'Red', dg: 'Green', dw: 'White' };
const CHINESE_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

// Circles: [x, y, r, red?] per pip.
const PIPS = [
  null,
  [[30, 38, 13, 1]],
  [[30, 22, 9], [30, 54, 9]],
  [[16, 18, 8], [30, 38, 8, 1], [44, 58, 8]],
  [[19, 24, 9], [41, 24, 9], [19, 52, 9], [41, 52, 9]],
  [[17, 20, 8], [43, 20, 8], [30, 38, 8, 1], [17, 56, 8], [43, 56, 8]],
  [[19, 17, 7.5], [41, 17, 7.5], [19, 45, 7.5, 1], [41, 45, 7.5, 1], [19, 62, 7.5, 1], [41, 62, 7.5, 1]],
  [[17, 14, 6.5], [30, 22, 6.5], [43, 30, 6.5], [19, 46, 7, 1], [41, 46, 7, 1], [19, 63, 7, 1], [41, 63, 7, 1]],
  [[19, 14, 6.5], [41, 14, 6.5], [19, 30.5, 6.5], [41, 30.5, 6.5], [19, 47, 6.5], [41, 47, 6.5], [19, 63.5, 6.5], [41, 63.5, 6.5]],
  [[15, 16, 6.2], [30, 16, 6.2], [45, 16, 6.2], [15, 38, 6.2, 1], [30, 38, 6.2, 1], [45, 38, 6.2, 1], [15, 60, 6.2], [30, 60, 6.2], [45, 60, 6.2]],
];

// Bamboo: [x, y, height, red?] per stick (width is fixed). 1 of Bamboo is drawn separately.
const STICKS = [
  null,
  null,
  [[30, 24, 20], [30, 52, 20]],
  [[30, 24, 20], [20, 52, 20], [40, 52, 20]],
  [[20, 24, 20], [40, 24, 20], [20, 52, 20], [40, 52, 20]],
  [[17, 22, 18], [43, 22, 18], [30, 38, 18, 1], [17, 54, 18], [43, 54, 18]],
  [[17, 24, 20], [30, 24, 20], [43, 24, 20], [17, 52, 20], [30, 52, 20], [43, 52, 20]],
  [[30, 14, 14, 1], [17, 37, 16], [30, 37, 16], [43, 37, 16], [17, 60, 16], [30, 60, 16], [43, 60, 16]],
  [[12, 24, 20], [24, 24, 20], [36, 24, 20], [48, 24, 20], [12, 52, 20], [24, 52, 20], [36, 52, 20], [48, 52, 20]],
  [[17, 16, 16], [30, 16, 16, 1], [43, 16, 16], [17, 38, 16], [30, 38, 16, 1], [43, 38, 16], [17, 60, 16], [30, 60, 16, 1], [43, 60, 16]],
];
const STICK_W = 7;

function svg(label, body, face = FACE) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80" role="img" aria-label="${label}" class="tile-svg">` +
    `<rect x="0.75" y="0.75" width="58.5" height="78.5" rx="7" fill="${EDGE}" stroke="${EDGE_LINE}" stroke-width="1.5"/>` +
    `<rect x="2" y="1.5" width="56" height="73" rx="6" fill="${face}"/>` +
    body +
    '</svg>'
  );
}

function text(x, y, size, fill, str) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="700" fill="${fill}" font-family="${FONT}" text-anchor="middle" dominant-baseline="central">${str}</text>`;
}

function pip([x, y, r, red]) {
  const c = red ? INK.red : INK.p;
  return (
    `<g class="pip"><circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>` +
    `<circle cx="${x}" cy="${y}" r="${+(r * 0.6).toFixed(2)}" fill="${FACE}"/>` +
    `<circle cx="${x}" cy="${y}" r="${+(r * 0.28).toFixed(2)}" fill="${c}"/></g>`
  );
}

function stick([x, y, h, red]) {
  const c = red ? INK.red : INK.s;
  const left = x - STICK_W / 2;
  return (
    `<g class="stick"><rect x="${left}" y="${y - h / 2}" width="${STICK_W}" height="${h}" rx="3" fill="${c}"/>` +
    `<line x1="${left}" y1="${y}" x2="${left + STICK_W}" y2="${y}" stroke="${FACE}" stroke-width="1.2"/></g>`
  );
}

// 1 of Bamboo: one tall cane with leaves, so it can't be mistaken for anything else.
function bambooOne() {
  return (
    `<g class="cane"><rect x="25" y="9" width="10" height="60" rx="4" fill="${INK.s}"/>` +
    [24, 39, 54].map((y) => `<line x1="25" y1="${y}" x2="35" y2="${y}" stroke="${FACE}" stroke-width="1.5"/>`).join('') +
    `<ellipse cx="44" cy="21" rx="9" ry="3.5" transform="rotate(-35 44 21)" fill="${INK.s}"/>` +
    `<ellipse cx="16" cy="45" rx="9" ry="3.5" transform="rotate(35 16 45)" fill="${INK.s}"/></g>`
  );
}

// Shrinks pip/stick artwork around the face centre so the corner index has room.
function roomForIndex(body) {
  return `<g transform="translate(30 38) scale(0.86) translate(-30 -38)">${body}</g>`;
}

function cornerIndex(rank, colour) {
  return text(7.5, 9, 12, colour, rank);
}

function suitedBody(suit, rank, arabic) {
  if (suit === 'm') {
    const top = arabic ? text(30, 25, 32, INK.dark, rank) : text(30, 25, 26, INK.dark, CHINESE_NUM[rank - 1]);
    return top + text(30, 56, arabic ? 26 : 30, INK.m, '萬');
  }
  const art = suit === 'p' ? PIPS[rank].map(pip).join('') : rank === 1 ? bambooOne() : STICKS[rank].map(stick).join('');
  const ring = suit === 'p' && rank === 1 ? `<circle cx="30" cy="38" r="19" fill="none" stroke="${INK.p}" stroke-width="1.5"/>` : '';
  return arabic ? roomForIndex(ring + art) : ring + art;
}

function flower(n) {
  const petals = [0, 72, 144, 216, 288]
    .map((deg) => {
      const a = ((deg - 90) * Math.PI) / 180;
      return `<circle cx="${+(30 + 8 * Math.cos(a)).toFixed(2)}" cy="${+(27 + 8 * Math.sin(a)).toFixed(2)}" r="6" fill="${INK.flower}"/>`;
    })
    .join('');
  return (
    `<line x1="30" y1="34" x2="30" y2="50" stroke="${INK.s}" stroke-width="2.5" stroke-linecap="round"/>` +
    `<ellipse cx="36" cy="45" rx="5.5" ry="2.5" transform="rotate(-30 36 45)" fill="${INK.s}"/>` +
    petals +
    `<circle cx="30" cy="27" r="4.5" fill="${INK.gold}"/>` +
    text(30, 63, 18, INK.flower, n)
  );
}

function season(n) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      const p = (d) => [+(30 + d * Math.cos(a)).toFixed(2), +(29 + d * Math.sin(a)).toFixed(2)];
      const [x1, y1] = p(12);
      const [x2, y2] = p(17);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK.season}" stroke-width="2.5" stroke-linecap="round"/>`;
    })
    .join('');
  return `<circle cx="30" cy="29" r="9" fill="${INK.season}"/>` + rays + text(30, 63, 18, INK.season, n);
}

export function tileLabel(code) {
  if (!KNOWN.has(code)) throw new Error(`Unknown tile code: ${code}`);
  const suit = suitOf(code);
  if (SUIT_NAME[suit]) return `${rankOf(code)} of ${SUIT_NAME[suit]}`;
  if (suit === 'w') return `${WINDS[code][0]} wind`;
  if (suit === 'd') return `${DRAGONS[code]} dragon`;
  return `${suit === 'f' ? 'Flower' : 'Season'} ${code[1]}`;
}

export function tileSvg(code, { numbers = 'chinese' } = {}) {
  const label = tileLabel(code); // throws on unknown codes
  const arabic = numbers === 'arabic';
  const suit = suitOf(code);
  let body;
  if (SUIT_NAME[suit]) {
    const rank = rankOf(code);
    body = suitedBody(suit, rank, arabic) + (arabic ? cornerIndex(rank, INK[suit]) : '');
  } else if (suit === 'w') {
    const [, letter, han] = WINDS[code];
    body = arabic ? text(30, 30, 36, INK.dark, letter) + text(30, 62, 18, INK.dark, han) : text(30, 38, 40, INK.dark, han);
  } else if (code === 'dr') {
    body = text(30, 38, 42, INK.red, '中');
  } else if (code === 'dg') {
    body = text(30, 38, 40, INK.s, '發');
  } else if (code === 'dw') {
    body =
      `<rect x="12" y="12" width="36" height="53" rx="3" fill="none" stroke="${INK.p}" stroke-width="3"/>` +
      `<rect x="17" y="17" width="26" height="43" rx="2" fill="none" stroke="${INK.p}" stroke-width="1.5"/>`;
  } else {
    body = suit === 'f' ? flower(code[1]) : season(code[1]);
  }
  return svg(label, body);
}

export function tileBackSvg() {
  return svg(
    'Face-down tile',
    `<rect x="7" y="6.5" width="46" height="63" rx="4" fill="none" stroke="${BACK_LINE}" stroke-width="1.5"/>` +
      `<path d="M30 26 L40 38 L30 50 L20 38 Z" fill="none" stroke="${BACK_LINE}" stroke-width="2"/>`,
    BACK,
  );
}
