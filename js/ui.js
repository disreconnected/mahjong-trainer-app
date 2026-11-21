// DOM rendering of the table (2D, or the same table tilted in 3D by style.css). renderTable()
// re-renders everything from the controller's state on every update; the table is small, so no diffing.
import { tileSvg, tileBackSvg, tileLabel } from './tileart.js';
import { seatWind } from './game.js';
import { buttonStates, chiChoices, kongChoices } from './controller.js';
import { claimHelp } from './claimhelp.js';
import { SETTING_OPTIONS } from './settings.js';
import {
  reconcileOrder, drawnAfterSync, moveTile, sortedToOrderIndex, dealtOrder, sortOrder, insertIndex, movedIndex,
} from './handorder.js';
import { sortTiles } from './tiles.js';
import { nextAnnouncement } from './announce.js';
import { buildExport, shareOrDownload, packRecords } from './exportlogs.js';
import { pickStore, deviceNameOf, suggestDeviceName } from './store.js';
import {
  decomposeWin, resultHeadline, resultSubline, winTickerLine, visibleTo, handStatus, statsLine, logStatusText, gameInfoText,
} from './endscreen.js';

const NAMES = ['You', 'Bot 1', 'Bot 2', 'Bot 3'];
// Player 0 at the bottom; turn order runs counter-clockwise.
const POSITIONS = ['bottom', 'right', 'top', 'left'];
const WIND_NAMES = { E: 'East', S: 'South', W: 'West', N: 'North' };
const TICKER_LINES = 5;
const TILT_MS = 400; // switching to 3D: the table tilts back over this time (CSS, unless reduced motion)

const svgCache = new Map();
function faceSvg(code, numbers) {
  const key = code + numbers;
  if (!svgCache.has(key)) svgCache.set(key, tileSvg(code, { numbers }));
  return svgCache.get(key);
}
const BACK_SVG = tileBackSvg();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 3D view: tiles on the table and in your seat are drawn as solid blocks (style.css 6.7). The
// tile element is the face; its pseudo-elements are the top or near side and the contact
// shadow. Standing blocks (your seat, opponents' concealed tiles) also get one empty child
// that carries the left and right sides ('full'); tiles lying on the table skip it ('lying'):
// their neighbours hide those sides and the table holds 100+ tiles. Set only while
// renderTable builds those areas, so every other caller (review, end screen, pickers) keeps
// the flat tile.
let blocks = false; // false | 'lying' | 'full'
const BLOCK_CLS = ' tile--block';
const BLOCK_SIDES = '<i class="tile-sides"></i>';

function withBlocks(mode, build) {
  const outer = blocks;
  blocks = mode;
  try {
    return build();
  } finally {
    blocks = outer;
  }
}

const blockCls = () => (blocks ? BLOCK_CLS : '');
const blockSides = () => (blocks === 'full' ? BLOCK_SIDES : '');

export function face(code, size, numbers, extra = '', attrs = '') {
  return `<span class="tile tile--${size}${extra ? ' ' + extra : ''}${blockCls()}" data-tile="${code}" data-label="${esc(tileLabel(code))}"${attrs}>${faceSvg(code, numbers)}${blockSides()}</span>`;
}

// --- interaction state (survives re-renders) ---

const ui = {
  controller: null,
  root: null,
  opts: {},
  selected: null, // { code, index } into displayedHand()
  handKey: '',
  picker: null, // 'chi' | 'kong'
  actionsKey: '',
  error: null,
  help: null, // claimHelp() result for the current decision, or null when claim help is off
  hoverKey: null, // help key of the hovered button: 'pong', 'chi', 'pick:1', ...
  focusKey: null, // same, for the keyboard-focused button
  overlay: null, // null | 'settings' | 'confirm-new' (the game is paused while one is open)
  order: null, // auto-sort off: player 0's tiles in their own order (codes), else null
  orderDrawn: null, // auto-sort off: the just-drawn tile, shown apart at the right end
  drag: null, // auto-sort off: the tile drag in progress (pointer events), see bindDrag
  mode: null, // 'start' | 'table'
  startOpts: null, // renderStartScreen options
  endView: null, // game over: 'pending' (short pause) | 'shown' | 'hidden' (View table), else null
  save: null, // game over: { status, file, reason } for the end screen's log line
  yourDiscards: 0, // game over: discards player 0 made
  view: null, // '2d' | '3d' last rendered
  tiltAt: null, // performance.now() when the view last switched to 3D
  exportState: { count: null, total: null, status: 'idle', message: '' }, // phone only: the log export row
  devicePrompt: false, // phone only: Play was pressed with no device name, so the field is showing
  deviceSuggestion: '', // phone only: the name offered in that field
  deviceError: '', // phone only: why the typed device name was not accepted
};

const END_DELAY = 1000; // ms the final move stays visible before the end screen opens

// Player 0's tiles in display order. Auto-sort on: the sorted hand with the just-drawn tile
// last. Off: the player's own order (ui.order, reconciled in syncUiState).
function displayedHand(state) {
  if (ui.order) return { tiles: ui.order, drawn: ui.orderDrawn };
  const hand = [...state.players[0].hand];
  let drawn = null;
  if (state.phase === 'turn' && state.turn === 0 && state.lastDraw && hand.includes(state.lastDraw)) {
    hand.splice(hand.lastIndexOf(state.lastDraw), 1);
    drawn = state.lastDraw;
  }
  return { tiles: drawn ? [...hand, drawn] : hand, drawn };
}

// Drops selection and picker state that no longer applies to the controller's state.
function syncUiState(c) {
  const fresh = ui.controller !== c;
  if (fresh) {
    Object.assign(ui, {
      controller: c, selected: null, handKey: '', picker: null, actionsKey: '', error: null, hoverKey: null, focusKey: null,
      overlay: null, order: null, orderDrawn: null, drag: null, endView: null, save: null, yourDiscards: 0,
    });
  }
  const { state } = c;
  const actions = c.humanActions();
  const handKey = `${state.players[0].hand.join(',')}|${state.lastDraw ?? ''}`;
  if (handKey !== ui.handKey || !actions.some((a) => a.type === 'discard')) ui.selected = null;
  syncOrder(c, handKey !== ui.handKey, fresh);
  ui.handKey = handKey;
  if (ui.selected && displayedHand(state).tiles[ui.selected.index] !== ui.selected.code) ui.selected = null;
  const actionsKey = JSON.stringify(actions);
  if (actionsKey !== ui.actionsKey) {
    // The decision changed or ended: drop the picker and any hover/focus highlight.
    ui.picker = null;
    ui.hoverKey = null;
    ui.focusKey = null;
  }
  ui.actionsKey = actionsKey;
  ui.help = c.settings.claimHelp ? claimHelp(state, actions) : null;
  return actions;
}

// Auto-sort off: keep ui.order in step with the engine's hand (removed tiles go, new tiles
// are appended on the right). A new game starts in the order the tiles were dealt;
// turning auto-sort off mid-game starts from what is on screen now.
function syncOrder(c, handChanged, fresh) {
  const { state } = c;
  if (c.settings.autoSort !== false) {
    ui.order = null;
    ui.orderDrawn = null;
    return;
  }
  const hand = state.players[0].hand;
  if (!ui.order && fresh) {
    ui.order = dealtOrder(hand, state.setupEvents);
    ui.orderDrawn = null;
    return;
  }
  if (!ui.order) {
    const { tiles, drawn } = displayedHand(state); // sorted view while ui.order is null
    ui.order = [...tiles];
    ui.orderDrawn = drawn;
    return;
  }
  if (!handChanged) return;
  const before = ui.order;
  ui.order = reconcileOrder(before, hand);
  const isOurDraw = state.phase === 'turn' && state.turn === 0 && state.lastDraw;
  ui.orderDrawn = isOurDraw ? drawnAfterSync(before, hand, state.lastDraw) : null;
}

export function back(size) {
  return `<span class="tile tile--${size} tile--back${blockCls()}">${BACK_SVG}${blockSides()}</span>`;
}

// --- areas ---

export function meldHtml(meld, size, numbers, hideConcealed, index, extra = '') {
  const tiles = meld.tiles.map((t, i) => {
    const hidden = hideConcealed && meld.concealed && (i === 0 || i === 3);
    return hidden ? back(size) : face(t, size, numbers);
  });
  const cls = ['meld', `meld--${meld.type}`];
  if (meld.concealed) cls.push('meld--concealed');
  if (extra) cls.push(extra);
  return `<div class="${cls.join(' ')}" data-meld="${index}">${tiles.join('')}</div>`;
}

// Claim help: Chi is only possible from the player on your left.
const CHI_FROM = 3;

function seatHead(state, p, isTurn) {
  const wind = seatWind(state, p);
  const count = state.players[p].hand.length;
  return (
    '<div class="seat-head">' +
    `<span class="seat-name">${NAMES[p]}</span>` +
    (p === CHI_FROM && ui.help ? '<span class="chi-from-label">Chi comes only from this player</span>' : '') +
    `<span class="seat-wind" aria-label="Seat wind: ${WIND_NAMES[wind]}">${WIND_NAMES[wind]}</span>` +
    (p === state.dealer ? '<span class="dealer-badge">Dealer</span>' : '') +
    `<span class="seat-count">${count} tile${count === 1 ? '' : 's'}</span>` +
    (isTurn ? '<span class="turn-badge">Turn</span>' : '') +
    '</div>'
  );
}

function humanHand(state, numbers, canDiscard) {
  const { tiles, drawn } = displayedHand(state);
  const html = tiles.map((t, i) => {
    const cls = ['hand-tile'];
    if (canDiscard) cls.push('is-selectable');
    if (ui.selected && ui.selected.index === i) cls.push('is-selected');
    if (drawn && i === tiles.length - 1) cls.push('is-drawn');
    if (ui.order) cls.push('is-draggable');
    return face(t, 'hand', numbers, cls.join(' '), ` data-idx="${i}"`);
  });
  const rest = drawn ? html.slice(0, -1) : html;
  const drawnHtml = drawn ? `<div class="hand-drawn">${html.at(-1)}</div>` : '';
  return `<div class="hand-tiles">${rest.join('')}</div>${drawnHtml}`;
}

function seatHtml(c, p, numbers, actions = []) {
  const { state } = c;
  const pl = state.players[p];
  const isTurn = !c.isOver && state.phase === 'turn' && state.turn === p;
  const human = p === 0;
  const canDiscard = human && actions.some((a) => a.type === 'discard');
  const meldSize = human ? 'discard' : 'small';
  const concealed = human
    ? `<div class="seat-hand seat-hand--you">${humanHand(state, numbers, canDiscard)}</div>`
    : `<div class="seat-hand">${withBlocks(blocks && 'full', () => pl.hand.map(() => back('small')).join(''))}</div>`;
  // Claim help: the Pong a bot is turning into a Kong you can rob.
  const tgt = ui.help && ui.help.target;
  const meldTarget = tgt && tgt.kind === 'meld' && tgt.player === p ? tgt.index : -1;
  const melds = pl.melds.length
    ? `<div class="seat-melds">${pl.melds
      .map((m, i) => meldHtml(m, meldSize, numbers, !human, i, i === meldTarget ? 'is-help-target' : ''))
      .join('')}</div>`
    : '';
  const flowers = pl.flowers.length
    ? `<div class="seat-flowers">${pl.flowers.map((t) => face(t, 'small', numbers)).join('')}</div>`
    : '';
  const cls = ['seat', `seat--${POSITIONS[p]}`];
  if (isTurn) cls.push('is-turn');
  if (human && actions.length) cls.push('is-asked');
  if (p === state.dealer) cls.push('is-dealer');
  return (
    `<section class="${cls.join(' ')}" data-player="${p}" aria-label="${NAMES[p]}">` +
    seatHead(state, p, isTurn) +
    `<div class="seat-body">${concealed}${melds}${flowers}</div>` +
    '</section>'
  );
}

function poolHtml(c, p, numbers) {
  const ld = c.lastDiscard;
  const tgt = ui.help && ui.help.target;
  const tiles = c.state.players[p].discards.map((t, i) => {
    const cls = [];
    if (ld && ld.player === p && ld.index === i) cls.push('is-last');
    if (tgt && tgt.kind === 'discard' && tgt.player === p && tgt.index === i) cls.push('is-help-target');
    return face(t, 'discard', numbers, cls.join(' '));
  });
  return `<div class="pool pool--${POSITIONS[p]}" data-player="${p}" aria-label="${NAMES[p]} discards">${tiles.join('')}</div>`;
}

function centerHtml(c) {
  const { state } = c;
  const active = c.isOver ? null : state.phase === 'turn' ? state.turn : state.claim ? state.claim.from : null;
  const winds = [0, 1, 2, 3]
    .map((p) => {
      const cls = ['compass-wind', `compass-wind--${POSITIONS[p]}`];
      if (p === active) cls.push('is-active');
      return `<span class="${cls.join(' ')}" aria-label="${NAMES[p]}: ${WIND_NAMES[seatWind(state, p)]}">${seatWind(state, p)}</span>`;
    })
    .join('');
  const status =
    state.phase === 'claim' && !c.isOver ? '<span class="center-status">Claims…</span>' : '';
  return (
    '<div class="center">' +
    '<div class="compass">' +
    winds +
    `<div class="wall-count"><span class="wall-num">${state.wall.length}</span><span class="wall-label">tiles left</span></div>` +
    '</div>' +
    status +
    '</div>'
  );
}

// --- ticker ---

function describe(e) {
  const who = NAMES[e.player];
  const you = e.player === 0;
  const verb = (base, third = base + 's') => `${who} ${you ? base : third}`;
  const L = (t) => tileLabel(t);
  switch (e.type) {
    case 'flower':
      return `${verb('reveal')} ${L(e.tile)}`;
    case 'discard':
      return `${verb('discard')} ${L(e.tile)}`;
    case 'chi':
      return `${verb('Chi', 'Chis')} ${L(e.tile)} from ${NAMES[e.from]}`;
    case 'pong':
      return `${verb('Pong', 'Pongs')} ${L(e.tile)}`;
    case 'kong':
      if (e.kind === 'concealed') return `${verb('declare')} a concealed Kong`;
      if (e.kind === 'added') return `${verb('add', 'adds')} a 4th tile: Kong of ${L(e.tile)}`;
      return `${verb('Kong', 'Kongs')} ${L(e.tile)}`;
    case 'hu':
      return winTickerLine(e);
    case 'drawgame':
      return 'The wall is empty: draw game';
    default:
      return null; // deal, draw, pass: too noisy for the ticker
  }
}

function tickerHtml(c) {
  const lines = c.recentEvents
    .map((e) => describe(e))
    .filter(Boolean)
    .slice(-TICKER_LINES);
  const items = lines.map((l, i) => `<li${i === lines.length - 1 ? ' class="is-newest"' : ''}>${esc(l)}</li>`);
  return `<aside class="ticker" aria-label="Recent events" aria-live="polite"><ol>${items.join('')}</ol></aside>`;
}

// --- top bar and end screen ---

function topbarHtml(c, tally, gameNumber) {
  const level = c.settings.botLevel === 'normal' ? 'Normal' : 'Easy';
  const t = tally ?? { played: 0, wins: 0 };
  return (
    '<header class="topbar">' +
    '<span class="brand">Mahjong Trainer</span>' +
    `<span class="topbar-info topbar-game">${esc(gameInfoText(gameNumber ?? 1, c.state.dealer, seatWind(c.state, 0)))}</span>` +
    `<span class="topbar-info topbar-bots">Bots: ${level}</span>` +
    `<span class="topbar-info topbar-tally">Played ${t.played} · Your wins ${t.wins}</span>` +
    (c.settings.autoplayHuman ? '<span class="topbar-info topbar-auto">Autoplay</span>' : '') +
    focusLineHtml() +
    '<span class="topbar-buttons">' +
    quickToggles(appSettings(c)) +
    '<span class="tb-sep" aria-hidden="true"></span>' +
    (ui.opts.onReview ? '<button type="button" class="tb-btn" data-action="review-ask" data-fid="tb-review">Review</button>' : '') +
    (ui.opts.onProgress ? '<button type="button" class="tb-btn" data-action="progress-ask" data-fid="tb-progress">Progress</button>' : '') +
    '<button type="button" class="tb-btn" data-action="new-game-ask" data-fid="tb-new">New game</button>' +
    '<button type="button" class="tb-btn" data-action="open-settings" data-fid="tb-settings">Settings</button>' +
    '</span>' +
    '</header>'
  );
}

// R4b: the player's focus (from the learning loop), hidden with its × until the focus changes.
function focusLineHtml() {
  const line = ui.opts.getFocusLine?.();
  if (!line) return '';
  return (
    `<span class="topbar-focus" title="${esc(line.tip)}"><span class="topbar-focus-text">${esc(line.text)}</span>` +
    '<button type="button" class="topbar-focus-x" data-action="focus-dismiss" data-fid="tb-focus-x" aria-label="Hide the focus line">×</button></span>'
  );
}

// Quick toggles for the settings changed most; each shows its current value.
function quickToggles(s) {
  const toggle = (key, label, value, on, title) =>
    `<button type="button" class="tb-btn tb-toggle${on ? ' is-on' : ''}" data-toggle="${key}" data-fid="tb-${key}"` +
    ` aria-pressed="${on}" title="${esc(title)}"><span class="tb-key">${label}</span> <span class="tb-val">${value}</span></button>`;
  const arabic = s.tileNumbers === 'arabic';
  return (
    toggle('tileNumbers', 'Tiles', arabic ? '123' : '五', arabic, 'Tile numbers: Traditional or 123') +
    toggle('view', 'View', s.view === '3d' ? '3D' : '2D', s.view === '3d', 'Table view: flat 2D or tilted 3D') +
    toggle('claimHelp', 'Help', s.claimHelp ? 'On' : 'Off', s.claimHelp, 'Claim help: highlights the claims you can take') +
    toggle('sound', 'Sound', s.sound ? 'On' : 'Off', s.sound, 'Sound on or off')
  );
}

// --- settings panel (start screen and in-game overlay) ---

const SETTING_ROWS = [
  {
    key: 'botLevel', title: 'Bot level', help: 'Easy bots play loosely; Normal bots play to win.',
    labels: { easy: 'Easy', normal: 'Normal' },
  },
  {
    key: 'tileNumbers', title: 'Tile numbers', help: 'Traditional Chinese numerals, or 123 with plain numbers and letters.',
    labels: { chinese: 'Traditional', arabic: '123' }, preview: ['m6', 'p3', 'we'],
  },
  {
    key: 'view', title: 'Table view', help: 'Flat 2D table, or a 3D table with solid tiles, seen from your seat.',
    labels: { '2d': '2D', '3d': '3D' },
  },
  {
    key: 'claimHelp', title: 'Claim help', help: 'Highlights the Chi, Pong, Kong and Hu you can take.',
    labels: { true: 'On', false: 'Off' },
  },
  { key: 'sound', title: 'Sound', help: 'Short sounds for discards, claims and wins.', labels: { true: 'On', false: 'Off' } },
  {
    key: 'autoSort', title: 'Auto-sort tiles', help: 'Keeps your hand sorted. Off: tiles stay as dealt; drag to arrange them, or press Sort.',
    labels: { true: 'On', false: 'Off' },
  },
  {
    key: 'botSpeed', title: 'Bot speed', help: 'How quickly the bots make their moves.',
    labels: { slow: 'Slow', normal: 'Normal', fast: 'Fast' },
  },
  {
    key: 'claimWindow', title: 'Claim window', help: 'Time to claim a discard before it passes automatically.',
    labels: { 5: '5 s', 7: '7 s', 10: '10 s', 15: '15 s', 20: '20 s', 30: '30 s', 0: 'Off' },
  },
];

function settingRowHtml(row, s, note) {
  const numbers = s.tileNumbers === 'arabic' ? 'arabic' : 'chinese';
  const segs = SETTING_OPTIONS[row.key]
    .map((v) => {
      const on = s[row.key] === v;
      return (
        `<button type="button" class="seg-btn${on ? ' is-on' : ''}" data-set="${row.key}" data-value="${String(v)}"` +
        ` data-fid="set-${row.key}-${String(v)}" aria-pressed="${on}">${row.labels[String(v)]}</button>`
      );
    })
    .join('');
  const preview = row.preview
    ? `<span class="set-preview" aria-label="Preview">${row.preview.map((t) => face(t, 'discard', numbers)).join('')}</span>`
    : '';
  return (
    '<div class="set-row">' +
    `<div class="set-text"><span class="set-title">${row.title}</span><span class="set-help">${esc(row.help)}</span>` +
    (note ? `<span class="set-note">${esc(note)}</span>` : '') +
    '</div>' +
    `<div class="set-control"><span class="seg" role="group" aria-label="${row.title}">${segs}${row.extra ?? ''}</span>${preview}</div>` +
    '</div>'
  );
}

// s: the settings to show. gameLevel: bot level of the game in progress (null on the start screen).
export function settingsRowsHtml(s, gameLevel) {
  return deviceRowHtml(s) + SETTING_ROWS.map((row) => {
    let note = '';
    if (row.key === 'botLevel' && gameLevel) {
      note = s.botLevel === gameLevel ? 'Changes apply from the next game.' : 'Applies from the next game; this game keeps its bots.';
    }
    return settingRowHtml(row, s, note);
  }).join('') + exportRowHtml();
}

// --- device name (phone only): the file-name part of this phone's logs, e.g. ANNA-IPHONE ---

export const DEVICE_MAX = 40;

function deviceRowHtml(s) {
  if (!isLocalMode()) return '';
  return (
    '<div class="set-row set-row--device">' +
    '<div class="set-text"><span class="set-title">Device name</span>' +
    '<span class="set-help">Names this phone\'s log files, like ANNA-IPHONE. Letters, digits and -.</span>' +
    (ui.deviceError ? `<span class="set-note">${esc(ui.deviceError)}</span>` : '') +
    '</div>' +
    '<div class="set-control"><input type="text" class="set-input" data-device-input data-fid="set-device"' +
    ` maxlength="${DEVICE_MAX}" autocomplete="off" autocapitalize="characters" spellcheck="false"` +
    ` aria-label="Device name" placeholder="ANNA-IPHONE" value="${esc(s.device ?? '')}"></div>` +
    '</div>'
  );
}

// --- exporting logs (phone only; the PC saves to the server and does not show this) ---

const isLocalMode = () => globalThis.MAHJONG_APP_MODE === 'local';

// The note shown where Review and Practice would be on the phone (they need the PC's server).
export const LOCAL_LEARN_NOTE = 'Review and practice are on the PC version for now';

// The zip is built as soon as the panel opens, so the tap goes straight to the share sheet.
// prep: { key, promise, pack } for the current logs; key changes when the store's logs do.
let exportStore = null;
let exportStoreDevice = null;
let exportPrep = null;
let exportPrepLoading = false;

function exportStoreFor(device) {
  if (exportStore && exportStoreDevice === device) return exportStore;
  exportStore = pickStore({ device });
  exportStoreDevice = device;
  exportPrep = null;
  return exportStore;
}

function settingsNow() {
  if (ui.mode === 'start' && ui.startOpts?.getSettings) return ui.startOpts.getSettings();
  return appSettings(ui.controller);
}

function exportRowHtml() {
  if (!isLocalMode()) return '';
  const st = ui.exportState;
  const count = st.count;
  const label = typeof count === 'number' ? `Export logs (${count} not exported)` : 'Export logs';
  // 0 unexported still exports a zip of every log; only an empty store has nothing to send.
  const disabled = st.status === 'busy' || st.total === 0 ? ' disabled' : '';
  return (
    '<div class="set-row">' +
    '<div class="set-text"><span class="set-title">Export logs</span>' +
    '<span class="set-help">Packs your games into a zip to send to the PC.</span>' +
    (st.message ? `<span class="set-note">${esc(st.message)}</span>` : '') +
    '</div>' +
    `<div class="set-control"><button type="button" class="big-btn big-btn--quiet set-export" data-action="export-logs"` +
    ` data-fid="export-logs"${disabled}>${esc(label)}</button></div>` +
    '</div>'
  );
}

// The export for the store as it is now: one read gives the count and the zip's input, so the
// zip is built at once and a tap needs no reading at all. With nothing unexported the zip holds
// every log, so the button still sends something.
function prepareExport(store, device) {
  const prep = { device, pack: null, count: null, total: null };
  prep.promise = (async () => {
    const records = await store.readAllLogs();
    prep.total = records.length;
    prep.count = records.filter((r) => !r.exported).length;
    prep.pack = await packRecords(records, { device, all: prep.count === 0 });
    return prep;
  })();
  prep.promise.catch(() => {}); // the caller that awaits it reports the failure
  exportPrep = prep;
  return prep;
}

// Reads the logs once per show (and after an export), preparing the zip, then redraws.
function refreshExportCount() {
  const st = ui.exportState;
  if (!isLocalMode() || st.failed || exportPrepLoading || st.count !== null || st.status === 'busy') return;
  let store;
  try {
    store = exportStoreFor(settingsNow().device);
  } catch {
    return;
  }
  exportPrepLoading = true;
  prepareExport(store, exportStoreDevice).promise.then(
    (prep) => { ui.exportState = { ...ui.exportState, count: prep.count, total: prep.total }; },
    () => { ui.exportState = { ...ui.exportState, failed: true, message: 'Could not count the logs.' }; },
  ).finally(() => {
    exportPrepLoading = false;
    rerender();
  });
}

// Export logs: the zip prepared for the panel goes straight to the share sheet or the download;
// the logs it holds are marked exported afterwards. A cancelled share marks nothing.
async function exportLogs() {
  if (ui.exportState.status === 'busy') return;
  const device = settingsNow().device;
  let store;
  try {
    store = exportStoreFor(device);
  } catch (err) {
    ui.exportState = { ...ui.exportState, status: 'idle', message: err.message };
    rerender();
    return;
  }
  ui.exportState = { ...ui.exportState, status: 'busy', message: '' };
  rerender();
  let message;
  let count = ui.exportState.count;
  let failed = false;
  try {
    // The prepared zip is used as is (it was made when the panel opened, or just after the last
    // export); a missing one is built now.
    const prep = exportPrep && exportPrep.device === exportStoreDevice ? await exportPrep.promise : null;
    const pack = prep?.pack ?? await buildExport(store, { device, all: !count });
    const sent = await shareOrDownload(pack);
    if (!sent) {
      message = 'Export cancelled.';
    } else if (pack.names.length === 0) {
      message = 'There are no logs to send yet.';
    } else {
      try {
        await store.markExported(pack.names);
        message = `Exported ${pack.names.length} log${pack.names.length === 1 ? '' : 's'}.`;
      } catch {
        message = 'The file was sent, but the export count could not be updated.';
      }
      count = await store.unexportedCount().catch(() => null);
      failed = count === null;
    }
    exportPrep = null; // the store changed: the next panel opens with a fresh zip
  } catch (err) {
    message = `Export failed: ${err.message}`;
    failed = true;
  }
  ui.exportState = { ...ui.exportState, count, status: 'idle', message, failed };
  rerender();
}


function appSettings(c) {
  const fromApp = ui.opts.getSettings ? ui.opts.getSettings() : null;
  return fromApp ?? (c ? c.settings : {});
}

function overlayHtml(c) {
  if (ui.overlay === 'settings') {
    const inProgress = !c.isOver;
    return (
      '<div class="overlay" data-overlay>' +
      '<div class="panel panel--overlay" role="dialog" aria-modal="true" aria-label="Settings">' +
      '<div class="panel-head"><h2>Settings</h2>' +
      '<button type="button" class="panel-x" data-action="close-overlay" data-fid="ov-x" aria-label="Close">×</button></div>' +
      (inProgress ? '<p class="panel-sub">The game is paused.</p>' : '') +
      `<div class="set-list">${settingsRowsHtml(appSettings(c), inProgress ? c.settings.botLevel : null)}</div>` +
      '<div class="panel-foot"><button type="button" class="big-btn" data-action="close-overlay" data-fid="ov-back">Back to game</button></div>' +
      '</div></div>'
    );
  }
  if (ui.overlay === 'confirm-new') {
    return (
      '<div class="overlay" data-overlay>' +
      '<div class="panel panel--confirm" role="alertdialog" aria-modal="true" aria-label="New game">' +
      "<p class=\"confirm-text\">Abandon this game? It won't be saved.</p>" +
      '<div class="panel-foot">' +
      '<button type="button" class="big-btn big-btn--quiet" data-action="close-overlay" data-fid="cf-cancel">Keep playing</button>' +
      '<button type="button" class="big-btn" data-action="abandon" data-fid="cf-abandon">Abandon and start new</button>' +
      '</div></div></div>'
    );
  }
  if (ui.overlay === 'confirm-progress') {
    return (
      '<div class="overlay" data-overlay>' +
      '<div class="panel panel--confirm" role="alertdialog" aria-modal="true" aria-label="Progress">' +
      "<p class=\"confirm-text\">Abandon this game to see your progress? It won't be saved.</p>" +
      '<div class="panel-foot">' +
      '<button type="button" class="big-btn big-btn--quiet" data-action="close-overlay" data-fid="cf-cancel">Keep playing</button>' +
      '<button type="button" class="big-btn" data-action="abandon-progress" data-fid="cf-abandon-progress">Abandon and see progress</button>' +
      '</div></div></div>'
    );
  }
  if (ui.overlay === 'confirm-review') {
    return (
      '<div class="overlay" data-overlay>' +
      '<div class="panel panel--confirm" role="alertdialog" aria-modal="true" aria-label="Review games">' +
      "<p class=\"confirm-text\">Abandon this game to review your saved games? It won't be saved.</p>" +
      '<div class="panel-foot">' +
      '<button type="button" class="big-btn big-btn--quiet" data-action="close-overlay" data-fid="cf-cancel">Keep playing</button>' +
      '<button type="button" class="big-btn" data-action="abandon-review" data-fid="cf-abandon-review">Abandon and review</button>' +
      '</div></div></div>'
    );
  }
  return '';
}

// Game over: start the short pause before the end screen, and follow the log save.
function startEnd(c) {
  if (!c.isOver || ui.endView !== null) return;
  ui.endView = 'pending';
  ui.yourDiscards = c.log().events.filter((e) => e.type === 'discard' && e.player === 0).length;
  if (c.settings.autoplayHuman) ui.save = { status: 'autoplay' };
  else if (!c.saved) ui.save = { status: 'none' };
  else {
    ui.save = { status: 'pending' };
    c.saved.then((res) => {
      if (ui.controller !== c) return;
      const err = c.saveError;
      ui.save = err
        ? { status: 'failed', reason: String((err && err.message) || err) }
        : { status: 'saved', file: res && res.file };
      rerender();
    });
  }
  setTimeout(() => {
    if (ui.controller !== c || ui.endView !== 'pending') return;
    showEnd();
  }, END_DELAY);
}

function showEnd() {
  ui.endView = 'shown';
  rerender();
  if (!ui.overlay) ui.root?.querySelector('button[data-fid="end-next"]')?.focus({ preventScroll: true });
}

function endRowHtml(c, p, numbers) {
  const { state } = c;
  const r = state.result;
  const pl = state.players[p];
  const isWinner = r.type === 'win' && r.winner === p;
  const wind = seatWind(state, p);
  const head =
    '<div class="end-who">' +
    `<span class="seat-name">${NAMES[p]}</span>` +
    `<span class="seat-wind">${WIND_NAMES[wind]}</span>` +
    (p === state.dealer ? '<span class="dealer-badge">Dealer</span>' : '') +
    '</div>';
  const melds = pl.melds.map((m, i) => meldHtml(m, 'discard', numbers, false, i)).join('');
  const groups = isWinner ? decomposeWin(pl.hand, pl.melds.length, r.tile) : null;
  const hand = groups
    ? groups
      .map((g) => `<span class="end-group end-group--${g.kind}">${g.tiles
        .map((t, i) => face(t, 'discard', numbers, i === g.winIndex ? 'is-win-tile' : ''))
        .join('')}</span>`)
      .join('')
    : `<span class="end-group">${sortTiles(pl.hand).map((t) => face(t, 'discard', numbers)).join('')}</span>`;
  const flowers = pl.flowers.length
    ? `<div class="end-flowers">${pl.flowers.map((t) => face(t, 'small', numbers)).join('')}</div>`
    : '';
  let status = '';
  if (!isWinner) {
    const st = handStatus(pl.hand, pl.melds.length, visibleTo(state, p));
    status = `<div class="end-status${st.ready ? ' is-ready' : ''}">${p === 0 ? 'Your hand: ' : ''}${esc(st.text)}</div>`;
  }
  const cls = ['end-row'];
  if (isWinner) cls.push('is-winner');
  if (p === 0) cls.push('is-you');
  return (
    `<div class="${cls.join(' ')}" data-player="${p}">` +
    head +
    `<div class="end-tiles">${melds ? `<div class="end-melds">${melds}</div>` : ''}<div class="end-hand">${hand}</div>${flowers}</div>` +
    status +
    '</div>'
  );
}

function endScreenHtml(c, numbers) {
  if (!c.isOver || ui.endView !== 'shown') return '';
  const r = c.state.result;
  const sub = resultSubline(r);
  const youWon = r.type === 'win' && r.winner === 0;
  const stats = statsLine({
    wallLeft: c.state.wall.length, yourDiscards: ui.yourDiscards, gameNumber: ui.opts.gameNumber ?? 1, tally: ui.opts.tally,
  });
  const save = ui.save ?? { status: 'none' };
  const logCls = save.status === 'failed' ? ' is-error' : save.status === 'saved' ? ' is-saved' : '';
  const logTitle = save.status === 'failed' ? ` title="${esc(save.reason)}"` : '';
  const next = ui.opts.onNewGame
    ? '<button type="button" class="big-btn" data-action="new-game" data-fid="end-next">Next game <kbd>Enter</kbd></button>'
    : '';
  return (
    '<div class="end-overlay">' +
    '<div class="panel panel--end" role="dialog" aria-modal="true" aria-label="Game result">' +
    `<div class="end-head"><h2 class="end-title${youWon ? ' is-you' : ''}">${esc(resultHeadline(r))}</h2>` +
    (sub ? `<p class="end-how">${esc(sub)}</p>` : '') +
    '</div>' +
    `<div class="end-rows">${[0, 1, 2, 3].map((p) => endRowHtml(c, p, numbers)).join('')}</div>` +
    (ui.opts.endExtra?.(c, save) ?? '') +
    `<p class="end-stats">${esc(stats)}</p>` +
    `<p class="end-log${logCls}"${logTitle}>${esc(logStatusText(save))}</p>` +
    '<div class="panel-foot">' +
    next +
    reviewGameButton(save) +
    '<button type="button" class="big-btn big-btn--quiet" data-action="view-table" data-fid="end-view">View table</button>' +
    '<button type="button" class="big-btn big-btn--quiet" data-action="open-settings" data-fid="end-settings">Settings</button>' +
    '</div></div></div>'
  );
}

// End screen: opens this game's review once its log is saved.
function reviewGameButton(save) {
  if (!ui.opts.onReview) return '';
  const ready = save.status === 'saved' && save.file;
  const why = save.status === 'autoplay' ? 'Autoplay games are not saved'
    : save.status === 'failed' ? 'The log could not be saved' : 'Available once the log is saved';
  return (
    `<button type="button" class="big-btn big-btn--quiet" data-action="review-game" data-fid="end-review"${ready ? '' : ` disabled title="${esc(why)}"`}>` +
    'Review this game</button>'
  );
}

// --- action bar ---

const BUTTON_DEFS = [
  ['hu', 'Hu', 'H'],
  ['kong', 'Kong', 'K'],
  ['pong', 'Pong', 'P'],
  ['chi', 'Chi', 'C'],
  ['pass', 'Pass', 'Space'],
  ['discard', 'Discard', 'Enter'],
];

// A touch screen (no hover) or a touch pointer: prompts say "tap" rather than "click"/"Enter".
const NO_HOVER_QUERY = '(hover: none)';
const coarsePointer = () => {
  try {
    return Boolean(globalThis.matchMedia && globalThis.matchMedia(NO_HOVER_QUERY).matches);
  } catch {
    return false;
  }
};
let lastPointerWasTouch = false;

export function promptText(c, actions) {
  const { state } = c;
  if (c.isOver) return 'Game over';
  if (c.settings.autoplayHuman) return 'Autoplay: a bot is playing your seat';
  if (actions.some((a) => a.type === 'discard')) {
    const touch = lastPointerWasTouch || coarsePointer();
    if (ui.selected) return touch ? 'Your turn: tap again to discard' : 'Your turn: click again (or Enter) to discard';
    return touch ? 'Your turn: tap a tile to discard' : 'Your turn: pick a tile to discard';
  }
  if (actions.length) return 'Claim or pass';
  if (c.waitingForOthers()) return 'Waiting for other players…';
  if (state.phase === 'turn') return `Waiting for ${NAMES[state.turn]}…`;
  if (state.phase === 'claim') {
    const { options, responses, from } = state.claim;
    for (let k = 1; k <= 3; k++) {
      const p = (from + k) % 4;
      if (options[p] && !(p in responses)) return `Waiting for ${NAMES[p]}…`;
    }
  }
  return '';
}

function claimInfoHtml(c, numbers) {
  const { state } = c;
  if (c.isOver || state.phase !== 'claim' || !state.claim.options[0]) return '';
  const { tile, from, robKong } = state.claim;
  const text = robKong ? `${NAMES[from]} is adding a Kong` : `${NAMES[from]} discarded`;
  return `<div class="ab-claim">${face(tile, 'discard', numbers, 'is-claim-tile')}<span>${esc(text)}</span></div>`;
}

function timerHtml(c) {
  const frozen = c.claimRemainingMs != null; // paused: show the time that is left
  if ((c.claimDeadline == null && !frozen) || !c.claimWindowMs) return '';
  const remain = frozen ? c.claimRemainingMs : Math.max(0, c.claimDeadline - Date.now());
  const frac = Math.min(1, remain / c.claimWindowMs);
  return (
    '<div class="ab-timer" aria-label="Time left to claim">' +
    `<span class="ab-timer-track"><span class="ab-timer-fill" style="transform: scaleX(${frac.toFixed(3)})"></span></span>` +
    `<span class="ab-timer-secs">${Math.ceil(remain / 1000)}s</span>` +
    '</div>'
  );
}

function pickerHtml(c, actions, numbers) {
  if (!ui.picker) return '';
  let title;
  let options;
  if (ui.picker === 'chi') {
    title = 'Choose a Chi';
    options = chiChoices(actions, c.state.claim?.tile).map((ch) =>
      ch.run.map((t, j) => face(t, 'discard', numbers, j === ch.claimedIndex ? 'is-claimed' : '')).join(''),
    );
  } else {
    title = 'Choose a Kong';
    options = kongChoices(actions).map((k) => k.tiles.map((t) => face(t, 'discard', numbers)).join(''));
  }
  return (
    `<div class="ab-picker" role="dialog" aria-label="${title}">` +
    `<span class="ab-picker-title">${title}</span>` +
    options.map((html, i) => `<button type="button" class="ab-pick" data-pick="${i}">${html}</button>`).join('') +
    '<button type="button" class="ab-pick-cancel" data-picker-cancel>Cancel</button>' +
    '</div>'
  );
}

function actionBarHtml(c, actions, numbers) {
  const st = buttonStates(actions);
  st.discard = st.discard && Boolean(ui.selected);
  const help = ui.help;
  const buttons = BUTTON_DEFS.map(([type, label, key]) => {
    const helpCls = help && help.buttons[type] && st[type] ? ' is-help' : '';
    return (
      `<button type="button" class="ab-btn ab-btn--${type}${helpCls}" data-act="${type}"${st[type] ? '' : ' disabled'}>` +
      `<span class="ab-label">${label}</span><kbd>${key}</kbd></button>`
    );
  }).join('');
  const cls = ['actionbar'];
  if (actions.length) cls.push('is-asking');
  const hint = help && help.hint ? `<span class="ab-hint">${esc(help.hint)}</span>` : '';
  return (
    `<div class="${cls.join(' ')}">` +
    '<div class="ab-status">' +
    `<div class="ab-text"><span class="ab-prompt">${esc(promptText(c, actions))}</span>${hint}</div>` +
    claimInfoHtml(c, numbers) +
    timerHtml(c) +
    (c.isOver && ui.endView === 'hidden'
      ? '<button type="button" class="tb-btn ab-show-result" data-action="show-result" data-fid="ab-show-result">Show result</button>'
      : '') +
    '</div>' +
    (ui.order && !c.isOver
      ? '<button type="button" class="ab-btn ab-btn--sort" data-action="sort" data-fid="ab-sort" title="Sort your hand once">' +
        '<span class="ab-label">Sort</span><kbd>S</kbd></button>'
      : '') +
    `<div class="ab-buttons">${buttons}</div>` +
    pickerHtml(c, actions, numbers) +
    (ui.error ? `<div class="ab-error" role="status">${esc(ui.error)}</div>` : '') +
    '</div>'
  );
}

// Claim-window bar: animated from the controller's deadline, outside the render cycle.
let rafId = null;
function tickTimer() {
  const c = ui.controller;
  const root = ui.root;
  if (!c || !root || c.claimDeadline == null || !c.claimWindowMs) {
    rafId = null;
    return;
  }
  const remain = Math.max(0, c.claimDeadline - Date.now());
  const fill = root.querySelector('.ab-timer-fill');
  const secs = root.querySelector('.ab-timer-secs');
  if (fill) fill.style.transform = `scaleX(${Math.min(1, remain / c.claimWindowMs).toFixed(3)})`;
  if (secs) secs.textContent = `${Math.ceil(remain / 1000)}s`;
  root.querySelector('.ab-timer')?.classList.toggle('is-urgent', remain <= 5000);
  rafId = requestAnimationFrame(tickTimer);
}

// --- actions ---

function rerender() {
  if (ui.mode === 'start' && ui.root && ui.startOpts) renderStartScreen(ui.root, ui.startOpts);
  else if (ui.mode === 'table' && ui.root && ui.controller) renderTable(ui.root, ui.controller, ui.opts);
}

// A settings button (data-set/data-value) was pressed: map the text back to the typed value.
function changeSetting(key, text) {
  const value = (SETTING_OPTIONS[key] ?? []).find((v) => String(v) === text);
  if (value === undefined) return;
  const onChange = ui.mode === 'start' ? ui.startOpts?.onChange : ui.opts.onSettingsChange;
  if (onChange) onChange({ [key]: value });
  rerender();
}

// Quick toggle in the top bar: flips between the two values.
function quickToggle(key) {
  const s = appSettings(ui.controller);
  if (key === 'tileNumbers') changeSetting(key, s.tileNumbers === 'arabic' ? 'chinese' : 'arabic');
  else if (key === 'view') changeSetting(key, s.view === '3d' ? '2d' : '3d');
  else if (key === 'claimHelp' || key === 'sound') changeSetting(key, String(!s[key]));
}

// Overlays pause the game; closing one resumes it.
function openOverlay(kind) {
  const c = ui.controller;
  if (!c) return;
  ui.picker = null;
  ui.overlay = kind;
  if (kind === 'settings') ui.exportState = { ...ui.exportState, count: null, failed: false }; // count afresh
  c.pause();
  rerender();
  ui.root?.querySelector('.overlay button:not(:disabled)')?.focus({ preventScroll: true });
}

function closeOverlay() {
  if (!ui.overlay) return;
  ui.overlay = null;
  ui.controller?.resume();
  rerender();
}

function askNewGame() {
  const c = ui.controller;
  if (!c || !ui.opts.onNewGame) return;
  if (c.isOver) ui.opts.onNewGame();
  else openOverlay('confirm-new');
}

// Top bar Review: straight to the saved games when the game is over, else confirm abandoning it.
function askReview() {
  const c = ui.controller;
  if (!c || !ui.opts.onReview) return;
  if (c.isOver) ui.opts.onReview({});
  else openOverlay('confirm-review');
}

// Top bar Progress: like Review.
function askProgress() {
  const c = ui.controller;
  if (!c || !ui.opts.onProgress) return;
  if (c.isOver) ui.opts.onProgress({});
  else openOverlay('confirm-progress');
}

// The review screen takes over the root: the table's re-renders, keys and clicks stand down
// until renderTable or renderStartScreen is called again.
export function suspendUi() {
  ui.mode = 'review';
  ui.picker = null;
  hideTip();
  hideAnn();
}

// Every player-0 action goes through here: an unexpected throw becomes a small error line.
function doAct(action) {
  const c = ui.controller;
  ui.picker = null;
  ui.error = null;
  try {
    c.act(action);
  } catch (err) {
    console.error('Mahjong Trainer: action failed', action, err);
    ui.error = `That move could not be made (${err && err.message ? err.message : err}).`;
    ui.opts.onSound?.('error');
  }
  rerender();
}

// index: display position of the tile; with a custom order that exact copy leaves the hand.
function discardTile(code, index = null) {
  const action = ui.controller.humanActions().find((a) => a.type === 'discard' && a.tile === code);
  if (!action) return;
  if (ui.order && index != null && ui.order[index] === code) {
    ui.order = ui.order.filter((_, i) => i !== index);
    ui.orderDrawn = null;
  }
  doAct(action);
}

function pressButton(type) {
  const c = ui.controller;
  if (!c || c.isOver) return;
  const actions = c.humanActions();
  if (!buttonStates(actions)[type]) return;
  if (type === 'discard') {
    if (ui.selected) discardTile(ui.selected.code, ui.selected.index);
    return;
  }
  if (type === 'kong' || type === 'chi') {
    const choices = type === 'kong' ? kongChoices(actions) : chiChoices(actions, c.state.claim?.tile);
    if (choices.length === 1) doAct(choices[0].action);
    else {
      ui.picker = type;
      rerender();
    }
    return;
  }
  doAct(actions.find((a) => a.type === type));
}

function choosePick(i) {
  const c = ui.controller;
  const actions = c.humanActions();
  const choices = ui.picker === 'chi' ? chiChoices(actions, c.state.claim?.tile) : ui.picker === 'kong' ? kongChoices(actions) : [];
  if (choices[i]) doAct(choices[i].action);
}

function canDiscardNow() {
  const c = ui.controller;
  return Boolean(c && !c.isOver && c.humanActions().some((a) => a.type === 'discard'));
}

function clickTile(index) {
  if (!canDiscardNow()) return;
  const code = displayedHand(ui.controller.state).tiles[index];
  if (code === undefined) return;
  if (ui.selected && ui.selected.index === index) discardTile(code, index);
  else {
    ui.selected = { code, index };
    rerender();
  }
}

function moveSelection(delta) {
  const tiles = displayedHand(ui.controller.state).tiles;
  if (!tiles.length) return;
  let index;
  if (!ui.selected) index = delta > 0 ? 0 : tiles.length - 1;
  else index = Math.min(tiles.length - 1, Math.max(0, ui.selected.index + delta));
  ui.selected = { code: tiles[index], index };
  rerender();
}

// --- claim help highlights: hand tiles and your melds, toggled without a re-render ---

// Help key of a button: its action type, or 'pick:i' for a picker option.
function helpKeyOf(el) {
  const btn = el && el.closest ? el.closest('button[data-act], button[data-pick]') : null;
  if (!btn || btn.disabled || !ui.root || !ui.root.contains(btn)) return null;
  return btn.dataset.act ?? `pick:${btn.dataset.pick}`;
}

// { tiles: [sorted-hand indexes], melds: [your meld indexes] } for a help key, or null.
function helpTargets(help, key) {
  if (!help || !key) return null;
  if (key.startsWith('pick:')) {
    const i = Number(key.slice(5));
    if (ui.picker === 'chi' && help.tilesFor.chi[i]) return { tiles: help.tilesFor.chi[i], melds: [] };
    const k = ui.picker === 'kong' ? help.kongs[i] : null;
    return k ? { tiles: k.indexes, melds: k.meldIndex === null ? [] : [k.meldIndex] } : null;
  }
  if (!help.buttons[key]) return null;
  if (key === 'hu') return { tiles: help.tilesFor.hu, melds: [] };
  if (key === 'pong') return { tiles: help.tilesFor.pong, melds: [] };
  if (key === 'chi') return { tiles: help.tilesFor.chi.flat(), melds: [] };
  if (key === 'kong') {
    return { tiles: help.tilesFor.kong, melds: help.kongs.map((k) => k.meldIndex).filter((m) => m !== null) };
  }
  return null;
}

// Sorted-hand index -> data-idx in the displayed hand (the drawn tile is shown last).
function sortedToDisplay(state) {
  if (ui.order) {
    const map = sortedToOrderIndex(ui.order, state.players[0].hand);
    return (i) => map[i];
  }
  const { drawn } = displayedHand(state);
  if (!drawn) return (i) => i;
  const hand = state.players[0].hand;
  const r = hand.lastIndexOf(drawn);
  return (i) => (i === r ? hand.length - 1 : i > r ? i - 1 : i);
}

// Hovered/focused helpful button: strong highlight of its tiles. Otherwise a light
// highlight of every tile any available Pong/Kong/Chi would use.
function applyHelp(root) {
  const help = ui.help;
  const hot = helpTargets(help, ui.hoverKey ?? ui.focusKey);
  const toDisplay = ui.controller ? sortedToDisplay(ui.controller.state) : (i) => i;
  const hotTiles = new Set((hot ? hot.tiles : []).map(toDisplay));
  const softTiles = new Set((help && !hot ? help.union : []).map(toDisplay));
  const hotMelds = new Set(hot ? hot.melds : []);
  root.querySelectorAll('.seat--bottom .hand-tile[data-idx]').forEach((el) => {
    const i = Number(el.dataset.idx);
    el.classList.toggle('is-help-hot', hotTiles.has(i));
    el.classList.toggle('is-help-soft', softTiles.has(i));
  });
  root.querySelectorAll('.seat--bottom .meld[data-meld]').forEach((el) => {
    el.classList.toggle('is-help-hot', hotMelds.has(Number(el.dataset.meld)));
  });
}

function setHelpKeys(root, { hover = ui.hoverKey, focus = ui.focusKey }) {
  if (hover === ui.hoverKey && focus === ui.focusKey) return;
  ui.hoverKey = hover;
  ui.focusKey = focus;
  applyHelp(root);
}

// Tap-and-hold timing: a press this long, without drifting, shows the tile's name.
export const HOLD_MS = 500;
export const HOLD_SLOP = 8; // px a press may drift and still count as a hold

// --- device name (phone): the two pure bits the start screen's prompt needs ---

// The name the prompt's field shows: the saved device first, then the suggestion offered.
export function devicePromptValue(device, suggestion) {
  return device || suggestion || '';
}

// The suggestion to keep after the field was left with `text`: a valid name becomes the
// suggestion (so the prompt keeps what was typed and cleaned); an invalid one keeps the old.
export function nextDeviceSuggestion(text, suggestion = '') {
  return deviceNameOf(text) ?? suggestion;
}

// Play was pressed. On the phone the game needs a device name for its log files: without one,
// the start screen asks for it first (prefilled with a suggestion) and Play waits. The first
// reveal shows the suggestion with no error: pressing Play again takes it.
function playPressed() {
  if (!isLocalMode()) {
    ui.startOpts?.onPlay?.();
    return;
  }
  const s = settingsNow();
  // The prompt's field when it is showing (it is the current answer), else the settings row's.
  const field = ui.root?.querySelector('[data-device-prompt]') ?? ui.root?.querySelector('[data-device-input]');
  const typed = field ? field.value : undefined;
  const device = deviceNameOf(typed) ?? deviceNameOf(s.device);
  if (!device) {
    const first = !ui.devicePrompt;
    ui.devicePrompt = true;
    ui.deviceError = ''; // the offered name is valid: no error on the first reveal
    if (first) {
      ui.deviceSuggestion = suggestDeviceName();
      rerender();
      return;
    }
    // Asked again with nothing usable typed: say so.
    ui.deviceError = 'Use letters, digits and - only.';
    rerender();
    return;
  }
  ui.devicePrompt = false;
  ui.deviceError = '';
  if (device !== s.device) ui.startOpts?.onChange?.({ device });
  ui.startOpts?.onPlay?.();
}

// A change to the settings, from the start screen (onChange) or the in-game panel
// (onSettingsChange): the same source changeSetting() uses.
function applySettingChange(patch) {
  const onChange = ui.mode === 'start' ? ui.startOpts?.onChange : ui.opts.onSettingsChange;
  onChange?.(patch);
}

// The device field was left (or Enter was pressed in it): clean what was typed, keep what is
// valid, and say what is wrong with the rest. redraw is false when leaving the field, because
// the click that took the focus away (Play) must still land; on Enter the screen is redrawn.
function commitDeviceField(input, redraw) {
  const device = deviceNameOf(input.value);
  const s = settingsNow();
  if (device) {
    ui.deviceError = '';
    input.value = device; // show the cleaned name
    ui.deviceSuggestion = nextDeviceSuggestion(input.value, ui.deviceSuggestion); // keeps what was typed
    if (device !== s.device) applySettingChange({ device });
    return;
  }
  // Invalid: an Enter keeps the typed text in the field (not the older suggestion); leaving the
  // field does not redraw, so what was typed stays on screen until the next render.
  const empty = (input.value ?? '').trim() === '';
  ui.deviceError = empty ? 'Enter a name for this phone first.' : 'Use letters, digits and - only.';
  if (redraw) {
    ui.deviceSuggestion = input.value ?? '';
    rerender();
  }
}

const boundActionRoots = new WeakSet();

function bindActions(root) {
  if (boundActionRoots.has(root)) return;
  boundActionRoots.add(root);
  root.addEventListener('mouseover', (ev) => setHelpKeys(root, { hover: helpKeyOf(ev.target) }));
  root.addEventListener('mouseleave', () => setHelpKeys(root, { hover: null }));
  root.addEventListener('focusin', (ev) => setHelpKeys(root, { focus: helpKeyOf(ev.target) }));
  root.addEventListener('focusout', (ev) => setHelpKeys(root, { focus: helpKeyOf(ev.relatedTarget) }));
  // The device name field (phone): Enter or leaving the field saves the cleaned name. Leaving
  // does not redraw (the click that took the focus must land); Enter does.
  root.addEventListener('focusout', (ev) => {
    if (ev.target && ev.target.hasAttribute && ev.target.hasAttribute('data-device-input')) commitDeviceField(ev.target, false);
  });
  root.addEventListener('keydown', (ev) => {
    if (!ev.target || !ev.target.hasAttribute || !ev.target.hasAttribute('data-device-input')) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commitDeviceField(ev.target, true);
    }
  });
  root.addEventListener('click', (ev) => {
    const t = ev.target;
    const btn = t.closest('button');
    if (btn && root.contains(btn)) {
      if (btn.disabled) return;
      const action = btn.dataset.action;
      if (btn.dataset.set) changeSetting(btn.dataset.set, btn.dataset.value);
      else if (action === 'play') playPressed();
      else if (action === 'review-list' && ui.mode === 'start') ui.startOpts?.onReview?.();
      else if (action === 'export-logs') exportLogs();
      else if (ui.mode !== 'table') return;
      else if (btn.dataset.toggle) quickToggle(btn.dataset.toggle);
      else if (action === 'open-settings') openOverlay('settings');
      else if (action === 'close-overlay') closeOverlay();
      else if (action === 'new-game-ask') askNewGame();
      else if (action === 'review-ask') askReview();
      else if (action === 'abandon-review') {
        ui.overlay = null;
        ui.opts.onReview?.({ abandon: true });
      }
      else if (action === 'progress-ask') askProgress();
      else if (action === 'abandon-progress') {
        ui.overlay = null;
        ui.opts.onProgress?.({ abandon: true });
      }
      else if (action === 'focus-dismiss') {
        ui.opts.onFocusDismiss?.();
        rerender();
      }
      else if (action === 'abandon') {
        ui.overlay = null;
        if (ui.opts.onNewGame) ui.opts.onNewGame({ abandon: true });
      } else if (ui.overlay) return;
      else if (action === 'view-table') {
        ui.endView = 'hidden';
        rerender();
      } else if (action === 'show-result') showEnd();
      else if (action === 'review-game' && ui.save && ui.save.file) ui.opts.onReview?.({ file: ui.save.file });
      else if (action === 'sort') sortHand();
      else if (btn.dataset.act) pressButton(btn.dataset.act);
      else if (btn.dataset.pick !== undefined) choosePick(Number(btn.dataset.pick));
      else if (btn.hasAttribute('data-picker-cancel')) {
        ui.picker = null;
        rerender();
      } else if (action === 'new-game' && ui.opts.onNewGame) ui.opts.onNewGame();
      return;
    }
    if (ui.mode !== 'table' || ui.overlay) return;
    const tile = t.closest('.hand-tile[data-idx]');
    if (tile && root.contains(tile)) clickTile(Number(tile.dataset.idx));
  });
  root.addEventListener('dblclick', (ev) => {
    if (ui.mode !== 'table' || ui.overlay) return;
    const tile = ev.target.closest('.hand-tile[data-idx]');
    if (!tile || !root.contains(tile) || !canDiscardNow()) return;
    const index = Number(tile.dataset.idx);
    const code = displayedHand(ui.controller.state).tiles[index];
    if (code !== undefined) discardTile(code, index);
  });
  bindDrag(root);
}

// Sort button / S key (auto-sort off): sorts the hand once; the just-drawn tile stays last.
function sortHand() {
  const c = ui.controller;
  if (!ui.order || !c || c.isOver || (ui.drag && ui.drag.active)) return;
  ui.order = sortOrder(ui.order, ui.orderDrawn);
  ui.selected = null;
  rerender();
}

// Auto-sort off: drag a hand tile to a new place, any time during the game. Pointer events
// (mouse, pen and touch alike). The drag lives in ui.drag, outside the DOM, and the pointer
// is captured by the root (never replaced), so a re-render caused by a bot move does not
// cancel it: renderTable redraws the drag on the new tile elements (resumeDrag). Moving
// less than DRAG_THRESHOLD px is a plain click. Dropping outside the hand cancels.
const DRAG_THRESHOLD = 6;
// The click (and dblclick) a drag's or a hold's release makes is not a tap: it stays swallowed
// until this long after the release, or until the first click that is swallowed, whichever
// comes first. The next press also ends the window.
const SUPPRESS_MS = 600;
let suppressClick = false;
let suppressClickTimer = null;

function startSuppressClick() {
  suppressClick = true;
  clearTimeout(suppressClickTimer);
  suppressClickTimer = setTimeout(() => {
    suppressClick = false;
    suppressClickTimer = null;
  }, SUPPRESS_MS);
}

// Swallows the click the window covers, and ends the window with it.
function takeSuppressedClick() {
  if (!suppressClick) return false;
  suppressClick = false;
  clearTimeout(suppressClickTimer);
  suppressClickTimer = null;
  return true;
}

const handTileEls = (root) => [...root.querySelectorAll('.seat--bottom .hand-tile[data-idx]')];

// True when the hand's tiles sit on more than one row (a phone in portrait wraps them).
function handHasSeveralRows(root) {
  const els = handTileEls(root);
  if (els.length < 2) return false;
  const top = els[0].getBoundingClientRect().top;
  return els.some((el) => Math.abs(el.getBoundingClientRect().top - top) > 2);
}

// Base positions of the hand tiles (no drag transforms applied yet).
function measureDrag(root) {
  const d = ui.drag;
  const els = handTileEls(root);
  const rects = els.map((el) => el.getBoundingClientRect());
  d.lefts = rects.map((r) => r.left);
  d.width = rects[d.from] ? rects[d.from].width : 0;
  d.height = rects[d.from] ? rects[d.from].height : 0;
  const zone = root.querySelector('.seat-hand--you');
  d.zone = zone ? zone.getBoundingClientRect() : null;
  if (d.grabX == null && rects[d.from]) d.grabX = d.x0 - rects[d.from].left; // pointer offset inside the tile
}

function dragInside(d) {
  const z = d.zone;
  if (!z) return false;
  return d.x >= z.left - d.width && d.x <= z.right + d.width && d.y >= z.top - d.height && d.y <= z.bottom + d.height;
}

// Dragged tile follows the pointer; the others shift to open the gap where it would land.
function drawDrag(root, instant = false) {
  const d = ui.drag;
  const els = handTileEls(root);
  if (!d.lefts || d.lefts.length !== els.length) return;
  const inside = dragInside(d);
  const others = d.lefts.filter((_, i) => i !== d.from).map((l) => l + d.width / 2);
  const left = d.x - d.grabX; // the dragged tile's left edge
  d.to = inside ? insertIndex(others, left + d.width / 2) : d.from;
  els.forEach((el, i) => {
    if (instant) el.style.transition = 'none';
    if (i === d.from) {
      el.classList.add('is-dragging');
      el.classList.toggle('is-drag-outside', !inside);
      el.style.transform = `translate(${left - d.lefts[i]}px, ${d.y - d.y0}px)`;
    } else {
      const dx = d.lefts[movedIndex(i, d.from, d.to)] - d.lefts[i];
      el.style.transform = dx ? `translateX(${dx}px)` : '';
    }
  });
  if (instant) {
    void root.offsetWidth; // apply the shifts before transitions come back
    els.forEach((el) => { el.style.transition = ''; });
  }
}

// After a re-render during a drag: redraw it on the new elements, or drop it if the tile left.
function resumeDrag(root) {
  const d = ui.drag;
  if (!d) return;
  const c = ui.controller;
  if (d.controller !== c || c.isOver || !ui.order || ui.overlay || ui.order[d.from] !== d.code) {
    ui.drag = null;
    try { root.releasePointerCapture(d.pointerId); } catch { /* not captured */ }
    return;
  }
  if (!d.active) return;
  measureDrag(root);
  drawDrag(root, true);
}

function cancelDrag() {
  const d = ui.drag;
  ui.drag = null;
  if (d && d.active) rerender();
}

function endDrag(root, commit) {
  const d = ui.drag;
  ui.drag = null;
  try { root.releasePointerCapture(d.pointerId); } catch { /* not captured */ }
  if (!d.active) return; // a plain click: the click handler takes it from here
  startSuppressClick();
  if (commit && dragInside(d) && d.to !== d.from && ui.order && ui.order[d.from] === d.code) {
    const last = ui.order.length - 1;
    ui.order = moveTile(ui.order, d.from, d.to);
    if (d.from === last || d.to === last) ui.orderDrawn = null; // the drawn tile joined the row
    if (ui.selected) ui.selected = { code: ui.selected.code, index: movedIndex(ui.selected.index, d.from, d.to) };
  }
  rerender();
}

function bindDrag(root) {
  root.addEventListener('pointerdown', (ev) => {
    const c = ui.controller;
    if ((ui.drag && ui.drag.active) || ev.button !== 0 || !ui.order || ui.mode !== 'table' || ui.overlay || !c || c.isOver) return;
    const el = ev.target && ev.target.closest ? ev.target.closest('.seat--bottom .hand-tile[data-idx]') : null;
    if (!el || !root.contains(el)) return;
    // The hand wraps to more than one row on a phone in portrait: the drag below shifts tiles
    // in x only, so a drop would land by column alone and could put the tile in the wrong
    // place. No drag there; tapping and the Sort button still work.
    if (handHasSeveralRows(root)) return;
    const from = Number(el.dataset.idx);
    if (ui.order[from] === undefined) return;
    ui.drag = {
      pointerId: ev.pointerId, controller: c, from, code: ui.order[from], to: from, active: false,
      x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, grabX: null, lefts: null,
    };
  });
  root.addEventListener('pointermove', (ev) => {
    const d = ui.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    d.x = ev.clientX;
    d.y = ev.clientY;
    if (!d.active) {
      if (Math.hypot(d.x - d.x0, d.y - d.y0) < DRAG_THRESHOLD) return;
      d.active = true;
      releaseHold(root); // a drag is not a hold: a pending one ends here
      try { root.setPointerCapture(d.pointerId); } catch { /* pointer already gone */ }
      hideTip();
      measureDrag(root);
    }
    ev.preventDefault();
    drawDrag(root);
  });
  root.addEventListener('pointerup', (ev) => {
    if (ui.drag && ev.pointerId === ui.drag.pointerId) endDrag(root, true);
  });
  root.addEventListener('pointercancel', (ev) => {
    if (ui.drag && ev.pointerId === ui.drag.pointerId) endDrag(root, false);
  });
  root.addEventListener('lostpointercapture', (ev) => {
    if (ui.drag && ui.drag.active && ev.pointerId === ui.drag.pointerId) endDrag(root, false);
  });
  // A drag never selects or discards: swallow the click (and dblclick) its release makes.
  const swallow = (ev) => {
    if (!takeSuppressedClick()) return;
    ev.stopPropagation();
    ev.preventDefault();
  };
  root.addEventListener('click', swallow, true);
  root.addEventListener('dblclick', swallow, true);
}

let keysBound = false;

function onKeyDown(ev) {
  const c = ui.controller;
  if (!c || !ui.root || !ui.root.isConnected || ui.mode !== 'table') return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
  // While an overlay is open the table's shortcuts are off; Escape closes it.
  if (ui.overlay) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeOverlay();
    }
    return;
  }
  const target = ev.target;
  if (c.isOver) {
    // End screen: Enter starts the next game (a focused button handles its own Enter).
    if (ui.endView === 'shown' && ev.key === 'Enter' && ui.opts.onNewGame && !(target && target.tagName === 'BUTTON')) {
      ev.preventDefault();
      ui.opts.onNewGame();
    }
    return;
  }
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  // A focused button handles its own Enter/Space.
  if (target && target.tagName === 'BUTTON' && (ev.key === 'Enter' || ev.key === ' ')) return;
  if (ui.drag && ui.drag.active) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      cancelDrag();
    }
    return; // no moves while a tile is being dragged
  }
  if ((ev.key === 's' || ev.key === 'S') && ui.order) {
    ev.preventDefault();
    sortHand();
    return;
  }
  const actions = c.humanActions();
  if (!actions.length) return;
  const turn = actions.some((a) => a.type === 'discard');
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const letters = { h: 'hu', k: 'kong', p: 'pong', c: 'chi' };
  let handled = true;
  if (ui.picker && key === 'Escape') {
    ui.picker = null;
    rerender();
  } else if (letters[key]) {
    if (!buttonStates(actions)[letters[key]]) ui.opts.onSound?.('error'); // not offered now
    pressButton(letters[key]);
  } else if (turn) {
    if (key === 'ArrowLeft') moveSelection(-1);
    else if (key === 'ArrowRight') moveSelection(1);
    else if (key === 'Enter' || key === ' ') pressButton('discard');
    else if (key === 'Escape') {
      ui.selected = null;
      rerender();
    } else handled = false;
  } else if (key === ' ' || key === 'Escape') {
    pressButton('pass');
  } else handled = false;
  if (handled) ev.preventDefault();
}

function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', onKeyDown);
}

// --- hover infobox (one shared element, event delegation on the root) ---

let tip = null;
let tipAnchor = null;
let lastPointer = null;
const boundRoots = new WeakSet();

function ensureTip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tile-tip';
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);
  }
  return tip;
}

function showTip(el) {
  const t = ensureTip();
  tipAnchor = el;
  t.textContent = el.dataset.label;
  t.classList.add('is-visible');
  const r = el.getBoundingClientRect();
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const margin = 4;
  let top = r.top - h - 6;
  if (top < margin) top = r.bottom + 6;
  const left = Math.min(Math.max(margin, r.left + r.width / 2 - w / 2), window.innerWidth - w - margin);
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

export function hideTip() {
  tipAnchor = null;
  if (tip) tip.classList.remove('is-visible', 'is-held');
}

function bindTip(root) {
  if (boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener('mouseover', (ev) => {
    lastPointer = { x: ev.clientX, y: ev.clientY };
    if (held.key) return; // a finger's hold owns the tip
    const el = ev.target.closest('[data-label]');
    if (el && root.contains(el)) {
      if (el !== tipAnchor) showTip(el);
    } else hideTip();
  });
  root.addEventListener('mousemove', (ev) => {
    lastPointer = { x: ev.clientX, y: ev.clientY };
  });
  root.addEventListener('mouseleave', () => {
    lastPointer = null;
    hideTip();
  });
}

// After a re-render the hovered tile element is new: re-anchor or hide.
function refreshTip(root) {
  if (held.key) return; // a hold survives a re-render; placeHold re-anchors it
  if (!tipAnchor) return;
  const under = lastPointer && document.elementFromPoint(lastPointer.x, lastPointer.y);
  const el = under && under.closest('[data-label]');
  if (el && root.contains(el)) showTip(el);
  else hideTip();
}

// --- tap-and-hold: a tile's name, where a touch screen has no hover ---
// A press on a tile that stays within HOLD_SLOP px for HOLD_MS shows the same tip the mouse
// hover shows, labelled .is-held (the only tip a hover-less screen displays). Releasing hides
// it, and a hold never selects, discards or starts a drag: its click is swallowed and any drag
// in progress is dropped first. Moving further than the slop before the time is up cancels the
// hold and leaves a tap or a drag to happen as usual.

let held = { key: null, timer: null, x: 0, y: 0, downAt: 0, el: null };
const holdRoots = new WeakSet();

function heldKeyOf(el) {
  return el.dataset.idx !== undefined ? `idx:${el.dataset.idx}` : `${el.dataset.tile}|${el.dataset.label}`;
}

function cancelHoldTimer() {
  if (held.timer != null) clearTimeout(held.timer);
  held.timer = null;
}

function releaseHold(root) {
  cancelHoldTimer();
  const had = held.key != null;
  held = { key: null, timer: null, x: 0, y: 0, downAt: 0, el: null };
  if (had) {
    hideTip();
    const tipEl = ensureTip();
    tipEl.classList.remove('is-held');
  }
  // The click that follows a hold's release is not a tap. Swallowed for a short window (the
  // release's own click arrives at once; some browsers are slower), or until the first click
  // that is swallowed. Cleared by the next press.
  if (had) startSuppressClick();
  return had;
}

// Finds the held tile again after a re-render replaced it.
function findHeldTile(root) {
  if (held.el && held.el.isConnected) return held.el;
  return [...root.querySelectorAll('[data-label]')].find((e) => heldKeyOf(e) === held.key) ?? null;
}

// The tile under the finger, or null: hand tiles and table tiles both carry data-label.
function tileUnder(ev, root) {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-label]') : null;
  return el && root.contains(el) ? el : null;
}

function startHold(ev, root) {
  const el = tileUnder(ev, root);
  if (!el || ev.button > 0) return;
  if (dragActive()) return; // a slow drag is a drag, not a hold
  cancelHoldTimer();
  const key = heldKeyOf(el);
  held = { key: null, timer: null, x: ev.clientX, y: ev.clientY, downAt: Date.now(), el };
  held.timer = setTimeout(() => {
    held.timer = null;
    if (ui.overlay || dragActive()) return;
    // A re-render may have replaced the element meanwhile: find the same tile again.
    const tile = el.isConnected ? el : findHeldTile(root);
    if (!tile) return;
    held.key = key;
    held.el = tile;
    const t = ensureTip();
    t.classList.add('is-held'); // before showTip: the tip is display:none until it is held,
    showTip(tile); // so its size is only measurable with the class on
  }, HOLD_MS);
}

// A drag that has passed its threshold (see bindDrag): ui.drag.active.
function dragActive() {
  return Boolean(ui.drag && ui.drag.active);
}

function bindHold(root) {
  if (holdRoots.has(root)) return;
  holdRoots.add(root);
  root.addEventListener('pointerdown', (ev) => {
    lastPointerWasTouch = ev.pointerType === 'touch';
    if (held.key != null || held.timer != null) releaseHold(root); // a stuck hold ends here
    if (suppressClick) {
      // A stale press: the hold's window ends here.
      suppressClick = false;
      clearTimeout(suppressClickTimer);
      suppressClickTimer = null;
    }
    if (ev.pointerType !== 'touch') return; // mouse and pen have hover
    startHold(ev, root);
  }, true);
  root.addEventListener('pointermove', (ev) => {
    if (held.timer == null && held.key == null) return;
    if (dragActive()) {
      // The press became a drag: the hold ends, the drag carries on.
      cancelHoldTimer();
      if (held.key != null) releaseHold(root);
      else held = { key: null, timer: null, x: 0, y: 0, downAt: 0, el: null };
      return;
    }
    if (Math.hypot(ev.clientX - held.x, ev.clientY - held.y) > HOLD_SLOP) {
      if (held.key != null) return; // already a hold: keep the name until the finger lifts
      cancelHoldTimer();
      held = { key: null, timer: null, x: 0, y: 0, downAt: 0, el: null };
    }
  }, true);
  for (const name of ['pointerup', 'pointercancel']) {
    root.addEventListener(name, () => { if (held.key != null || held.timer != null) releaseHold(root); }, true);
  }
  // A context menu must not open over the name, or while a press may still become one.
  root.addEventListener('contextmenu', (ev) => {
    if (held.key != null || held.timer != null) ev.preventDefault();
  });
}

// A re-render replaces the held tile's element: re-anchor the tip on the same tile.
function placeHold(root) {
  if (held.key == null) return;
  const el = findHeldTile(root);
  if (!el) return releaseHold(root);
  held.el = el;
  const t = ensureTip();
  t.classList.add('is-held'); // first: the tip has no size until it is displayed
  showTip(el);
}

// --- centre announcements (Chi, Pong, Kong, Hu, drawn game; announce.js) ---
// One shared element on <body>, like the hover infobox, so the table's re-renders never touch
// it (no restarted animation, one aria-live region). It is fixed, flat (never inside the tilted
// plane), pointer-events none, and placed by measuring the compass after each render, kept
// above the action bar, any picker and your hand. Shown once per event: nextAnnouncement tracks
// the last event number seen for this controller, so re-renders, toggles and overlays never
// replay it and a new game never shows the previous game's.

const ANN_OUT_MS = 150; // fade-out at the end of an announcement's time
const ann = { track: null, el: null, cur: null, timers: [] }; // cur: { a, end, numbers, root }

function ensureAnnEl() {
  if (!ann.el) {
    const el = document.createElement('div');
    el.className = 'announce';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.innerHTML = '<div class="announce-panel" aria-hidden="true"></div><span class="announce-sr"></span>';
    document.body.appendChild(el);
    ann.el = el;
  }
  return ann.el;
}

function annPanelHtml(a, numbers) {
  const tiles = a.tiles
    .map((t, i) => (t.back ? back('discard') : face(t.code, 'discard', numbers, i === a.marked ? 'is-marked' : '')))
    .join('');
  return (
    `<div class="announce-head"><span class="announce-title">${esc(a.title)}</span>` +
    (a.who ? `<span class="announce-who">${esc(a.who)}</span>` : '') +
    '</div>' +
    (tiles ? `<div class="announce-tiles">${tiles}</div>` : '') +
    (a.sub ? `<div class="announce-sub">${esc(a.sub)}</div>` : '')
  );
}

function clearAnnTimers() {
  ann.timers.forEach((t) => clearTimeout(t));
  ann.timers = [];
}

// Hides the announcement at once (overlay opened, end screen shown, left the table).
function hideAnn() {
  clearAnnTimers();
  const cur = ann.cur;
  ann.cur = null;
  if (cur && cur.root) cur.root.querySelectorAll('.meld.is-announced').forEach((m) => m.classList.remove('is-announced'));
  if (!ann.el) return;
  ann.el.classList.remove('is-visible', 'is-in', 'is-out');
  ann.el.querySelector('.announce-panel').innerHTML = '';
  ann.el.querySelector('.announce-sr').textContent = '';
  ann.el.removeAttribute('data-n');
}

function showAnn(a, numbers) {
  clearAnnTimers();
  const el = ensureAnnEl();
  const prev = ann.cur;
  if (prev && prev.root) prev.root.querySelectorAll('.meld.is-announced').forEach((m) => m.classList.remove('is-announced'));
  ann.cur = { a, end: performance.now() + a.ms, numbers, root: null };
  el.querySelector('.announce-panel').innerHTML = annPanelHtml(a, numbers);
  el.querySelector('.announce-sr').textContent = a.text;
  el.className = `announce announce--${a.kind}`;
  el.dataset.n = String(a.n);
  void el.offsetWidth; // restart the entry animation when one replaces another
  el.classList.add('is-visible', 'is-in');
  const cur = ann.cur;
  ann.timers.push(setTimeout(() => {
    if (ann.cur === cur) el.classList.add('is-out');
  }, Math.max(0, a.ms - ANN_OUT_MS)));
  ann.timers.push(setTimeout(() => {
    if (ann.cur === cur) hideAnn();
  }, a.ms));
}

// Index of the set an announcement refers to in that player's melds, or -1.
function annMeldIndex(state, m) {
  const melds = state.players[m.player].melds;
  for (let i = melds.length - 1; i >= 0; i--) {
    const x = melds[i];
    if (x.type !== m.type) continue;
    if (m.type === 'chi' ? x.tiles.join() === m.tiles.join() : x.tiles[0] === m.tile) return i;
  }
  return -1;
}

// Keeps the announcement in the middle of the felt, clear of the action bar, picker and hand.
function placeAnn(root) {
  const el = ann.el;
  if (!el || !ann.cur) return;
  const felt = root.querySelector('.felt');
  const mid = root.querySelector('.compass') ?? felt;
  if (!felt || !mid) return;
  const f = felt.getBoundingClientRect();
  const m = mid.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const margin = 8;
  const below = ['.actionbar', '.ab-picker', '.seat--bottom']
    .map((s) => root.querySelector(s))
    .filter(Boolean)
    .map((x) => x.getBoundingClientRect().top);
  const maxBottom = Math.min(f.bottom, ...below) - margin;
  let left = m.left + m.width / 2 - w / 2;
  left = Math.min(Math.max(f.left + margin, left), f.right - w - margin);
  let top = m.top + m.height / 2 - h / 2;
  top = Math.max(f.top + margin, Math.min(top, maxBottom - h));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

// After every table render: announce new events once, follow the re-render, glow the new set.
function updateAnnouncement(root, c) {
  const r = nextAnnouncement(ann.track, c, c.recentEvents, c.state.eventCount, c.settings.botSpeed);
  ann.track = r.track;
  const numbers = c.settings.tileNumbers === 'arabic' ? 'arabic' : 'chinese';
  // Paused (an overlay is open) or the end screen is up: hidden, and never replayed later.
  if (ui.overlay || ui.endView === 'shown' || c.stopped) {
    hideAnn();
    return;
  }
  if (r.announcement) showAnn(r.announcement, numbers);
  const cur = ann.cur;
  if (!cur) return;
  if (cur.numbers !== numbers) {
    cur.numbers = numbers;
    ann.el.querySelector('.announce-panel').innerHTML = annPanelHtml(cur.a, numbers);
  }
  cur.root = root;
  const m = cur.a.meld;
  if (m) {
    const i = annMeldIndex(c.state, m);
    root.querySelector(`.seat[data-player="${m.player}"] .meld[data-meld="${i}"]`)?.classList.add('is-announced');
  }
  placeAnn(root);
}

let annResizeBound = false;
function bindAnnResize() {
  if (annResizeBound) return;
  annResizeBound = true;
  window.addEventListener('resize', () => {
    if (ann.cur && ui.root && ui.mode === 'table') placeAnn(ui.root);
  });
}

// --- entry point ---

// Selector that finds the focused button again after a re-render, or null.
function focusSelector(root) {
  const a = document.activeElement;
  if (!a || a === root || !root.contains(a) || a.tagName !== 'BUTTON') return null;
  if (a.dataset.fid) return `button[data-fid="${a.dataset.fid}"]`;
  if (a.dataset.act) return `button[data-act="${a.dataset.act}"]`;
  if (a.dataset.pick !== undefined) return `button[data-pick="${a.dataset.pick}"]`;
  return null;
}

/**
 * opts (all optional):
 *   tally: { played, wins }
 *   gameNumber               number of this game in the session (top bar, end screen)
 *   onNewGame({ abandon })   start the next game (abandon: the current one is still running)
 *   getSettings()            the app's settings, shown in the panel and quick toggles
 *   onSettingsChange(patch)  a setting was changed in the panel or a quick toggle
 *   onSound(name)            play a UI sound ('error': a move or shortcut that is not possible)
 *   onReview({ file, abandon }) open the review screen (top bar, end screen); without it there are no Review buttons
 *   onProgress({ abandon })  open the Progress screen (top bar); without it there is no Progress button
 *   getFocusLine()           { text, tip } for the focus line in the top bar, or null
 *   onFocusDismiss()         the focus line's × was clicked
 *   endExtra(c, save)        extra HTML for the end screen (the learning loop's focus block)
 */
export function renderTable(root, controller, opts = {}) {
  bindTip(root);
  bindHold(root);
  bindActions(root);
  bindKeys();
  ui.root = root;
  ui.opts = opts;
  ui.mode = 'table';
  const actions = syncUiState(controller);
  startEnd(controller);
  const numbers = controller.settings.tileNumbers === 'arabic' ? 'arabic' : 'chinese';
  root.classList.remove('mt-start');
  root.classList.add('mt-table');
  const view = controller.settings.view === '3d' ? '3d' : '2d';
  if (ui.view === '2d' && view === '3d') ui.tiltAt = performance.now();
  ui.view = view;
  root.classList.toggle('view-2d', view === '2d');
  root.classList.toggle('view-3d', view === '3d');
  // A re-render during the tilt recreates the table: resume its animation where it was.
  const tiltSince = view === '3d' && ui.tiltAt != null ? performance.now() - ui.tiltAt : Infinity;
  root.classList.toggle('view-tilting', tiltSince < TILT_MS);
  if (tiltSince < TILT_MS) root.style.setProperty('--tilt-delay', `${-Math.round(tiltSince)}ms`);
  // Keep keyboard focus on the same button across the re-render.
  const focusSel = focusSelector(root);
  const solid = view === '3d';
  // The part of the table that tilts in 3D (in 2D its children are the felt's grid items).
  const plane = withBlocks(solid && 'lying', () =>
    [2, 3, 1].map((p) => seatHtml(controller, p, numbers)).join('') +
    [2, 3, 1, 0].map((p) => poolHtml(controller, p, numbers)).join(''));
  const bar = actionBarHtml(controller, actions, numbers);
  const yours = withBlocks(solid && 'full', () => seatHtml(controller, 0, numbers, actions));
  root.innerHTML =
    topbarHtml(controller, opts.tally, opts.gameNumber) +
    '<main class="felt">' +
    tickerHtml(controller) +
    `<div class="table-plane">${plane}${centerHtml(controller)}</div>` +
    bar +
    yours +
    '</main>' +
    endScreenHtml(controller, numbers) +
    overlayHtml(controller);
  const refocus = focusSel && root.querySelector(focusSel);
  if (refocus && !refocus.disabled) refocus.focus({ preventScroll: true });
  // Re-derive hover/focus from the new elements, then draw the claim-help highlights.
  const under = lastPointer && document.elementFromPoint(lastPointer.x, lastPointer.y);
  ui.hoverKey = under && root.contains(under) ? helpKeyOf(under) : null;
  ui.focusKey = helpKeyOf(document.activeElement);
  applyHelp(root);
  placeHold(root);
  refreshTip(root);
  resumeDrag(root);
  if (controller.claimDeadline != null && rafId === null) rafId = requestAnimationFrame(tickTimer);
  bindAnnResize();
  updateAnnouncement(root, controller);
  refreshExportCount();
}

/**
 * Start screen, shown before the first game.
 * opts: { getSettings(), onChange(patch), onPlay(), onReview() (optional: "Review games" button),
 *   learn() (optional: { side, buttons } HTML from the learning loop: the focus card and its buttons) }
 * On the phone (local mode) there is no Review and no learning loop (both read the PC's server);
 * Play asks for a device name first when none is set yet.
 */
export function renderStartScreen(root, opts) {
  bindTip(root);
  bindHold(root);
  bindActions(root);
  bindKeys();
  ui.root = root;
  ui.mode = 'start';
  ui.startOpts = opts;
  hideAnn();
  const s = opts.getSettings();
  root.classList.remove('mt-table', 'view-2d', 'view-3d', 'view-tilting');
  ui.view = null;
  root.classList.add('mt-start');
  const focusSel = focusSelector(root);
  const local = isLocalMode();
  if (!local) {
    ui.devicePrompt = false;
    ui.deviceError = '';
  }
  const learn = !local && opts.learn ? opts.learn() : null;
  root.innerHTML =
    `<main class="start${learn ? ' start--learn' : ''}">` +
    '<div class="panel panel--start">' +
    '<h1 class="start-title">Mahjong Trainer</h1>' +
    '<p class="start-desc">Offline practice against 3 bots. Casual rules: any 4 sets + 1 pair wins.</p>' +
    `<div class="set-list">${settingsRowsHtml(s, null)}</div>` +
    (local && ui.devicePrompt ? devicePromptHtml() : '') +
    '<div class="panel-foot"><button type="button" class="big-btn big-btn--play" data-action="play" data-fid="play">Play</button>' +
    (local
      ? `<span class="start-note">${esc(LOCAL_LEARN_NOTE)}</span>`
      : (opts.onReview ? '<button type="button" class="big-btn big-btn--quiet" data-action="review-list" data-fid="review-list">Review games</button>' : '') +
        (learn ? learn.buttons : '')) +
    '</div>' +
    '</div>' +
    (learn ? learn.side : '') +
    '</main>';
  const refocus = focusSel && root.querySelector(focusSel);
  if (refocus) refocus.focus({ preventScroll: true });
  // The device field opens focused, so the player can just type the name and press Play.
  if (local && ui.devicePrompt) root.querySelector('[data-device-prompt]')?.focus({ preventScroll: true });
  refreshTip(root);
  refreshExportCount();
}

// Phone, no device name yet: the field to type one in, prefilled with the saved name or else
// the suggestion offered (so a name typed and committed once is the one shown again).
function devicePromptHtml() {
  const value = devicePromptValue(settingsNow().device, ui.deviceSuggestion);
  return (
    '<div class="device-ask" data-device-ask>' +
    '<label class="device-ask-label" for="device-ask-input">Name this phone</label>' +
    '<p class="device-ask-help">Your games are saved on this phone and named after it, like ANNA-IPHONE. ' +
    'Letters, digits and -.</p>' +
    '<div class="device-ask-row">' +
    '<input id="device-ask-input" type="text" class="set-input device-ask-input" data-device-input data-device-prompt data-fid="device-ask"' +
    ` maxlength="${DEVICE_MAX}" autocomplete="off" autocapitalize="characters" spellcheck="false"` +
    ` value="${esc(value)}" aria-label="Device name">` +
    '</div>' +
    (ui.deviceError ? `<p class="device-ask-error" role="status">${esc(ui.deviceError)}</p>` : '') +
    '</div>'
  );
}
