// Review screen: the list of saved games and the step-by-step review of one game.
// Analysis comes from review.js; text and geometry from reviewview.js; tiles from ui.js.
// The screen owns the app root while open (ui.js stands down via suspendUi in index.html).
import { analyzeLog, distanceWords, usefulTiles, REVIEW_VERSION } from './review.js';
import { face, back, meldHtml, hideTip } from './ui.js';
import { tileLabel } from './tileart.js';
import { NAMES, WIND_NAMES } from './endscreen.js';
import {
  escapeHtml as esc, renderMarkdown, listRowText, sortNewestFirst, verdictStyle, isFlagged, nextStep,
  chartGeometry, opponentStatus, pointAtStep, secondsWords, stepHeading, choiceWords, offerWords, tileListWords,
  handLineWords, NO_DECISIONS_TEXT, rowScoreText, thinkTimeWords,
  riskChip, threatLine, subVerdicts, TIED_TEXT, LEGEND_ENTRIES, longThinksLine,
  readyTurnsLine, drawThrowLines, readyWallLine, nearMissLine, hiddenReadyLines, paceLine, claimedNote, riskAgainstWords, SAFEST_TITLE,
} from './reviewview.js';
import { safestOptions } from './safety.js';
import { screenNavHtml } from './learnview.js';
import { lessonChipsHtml, disagreeHtml, reviewLessonsHtml, resetFeedback } from './learnui.js';

const POSITIONS = ['bottom', 'right', 'top', 'left'];
const WIND_LETTERS = ['E', 'S', 'W', 'N'];
const REVEAL_KEY = 'mahjong-review-reveal';
const HIDDEN_TAG = '<span class="rv-hidden-tag" title="Hidden information: you could not see this during play">hidden info</span>';

const rv = {
  open: false,
  root: null,
  opts: null, // { getSettings(), onBack(), onUrl(param), onNav(to) }
  view: 'list', // 'list' | 'game'
  entries: null, // details from the server, newest first
  listError: null,
  analyses: new Map(), // file -> { status: 'pending'|'done', review, promise }
  queue: [],
  observer: null,
  file: null,
  fromList: false, // the game was opened from the list: Back returns to it
  tab: 'summary', // 'summary' | 'steps' | 'notes'
  step: 0,
  onlyFlagged: false,
  reveal: loadReveal(),
  notes: new Map(), // file -> { status: 'pending'|'none'|'done'|'error', html }
  optionPick: null, // discard option shown in the useful-tiles box (tile code)
  optionHover: null,
  glossary: false, // the "What do these mean?" box on the Steps tab is open
};

function loadReveal() {
  try {
    return window.sessionStorage.getItem(REVEAL_KEY) === '1';
  } catch {
    return false;
  }
}

function saveReveal() {
  try {
    window.sessionStorage.setItem(REVEAL_KEY, rv.reveal ? '1' : '0');
  } catch { /* storage blocked: remembered for this page only */ }
}

const numbers = () => (rv.opts?.getSettings?.()?.tileNumbers === 'arabic' ? 'arabic' : 'chinese');
const tile = (code, size, extra = '', attrs = '') => face(code, size, numbers(), extra, attrs);

// --- data ---

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return res.json();
}

async function loadList() {
  rv.entries = null;
  rv.listError = null;
  render();
  try {
    const details = await fetchJson('/api/logs?details=1');
    rv.entries = sortNewestFirst(Array.isArray(details) ? details : []);
  } catch (err) {
    rv.listError = String(err && err.message ? err.message : err);
  }
  if (rv.open && rv.view === 'list') render();
}

// Analyses one log (once); resolves to the review object or { ok: false, error }.
function analyse(file) {
  const known = rv.analyses.get(file);
  if (known) return known.promise;
  const entry = { status: 'pending', review: null, promise: null };
  entry.promise = (async () => {
    let review;
    try {
      const log = await fetchJson(`/api/logs/${encodeURIComponent(file)}`);
      // Let the list paint between analyses.
      await new Promise((r) => setTimeout(r, 0));
      review = analyzeLog(log);
    } catch (err) {
      review = { ok: false, error: `the log could not be loaded (${err && err.message ? err.message : err})` };
    }
    entry.status = 'done';
    entry.review = review;
    updateRow(file);
    return review;
  })();
  rv.analyses.set(file, entry);
  return entry.promise;
}

// List rows are analysed one at a time as they scroll into view.
let queueBusy = false;
function enqueue(file) {
  if (rv.analyses.has(file) || rv.queue.includes(file)) return;
  rv.queue.push(file);
  pump();
}

async function pump() {
  if (queueBusy) return;
  queueBusy = true;
  while (rv.queue.length) {
    const file = rv.queue.shift();
    await analyse(file);
  }
  queueBusy = false;
}

async function loadNotes(file) {
  if (rv.notes.has(file)) return;
  rv.notes.set(file, { status: 'pending' });
  let state;
  try {
    // Ask for notes only when the details say there are some (no 404 in the console).
    if (!rv.entries) rv.entries = sortNewestFirst(await fetchJson('/api/logs?details=1'));
    const entry = rv.entries.find((e) => e.file === file);
    const res = entry && !entry.hasNotes ? null : await fetch(`/api/notes/${encodeURIComponent(file)}`, { cache: 'no-store' });
    if (!res || res.status === 404) state = { status: 'none' };
    else if (!res.ok) state = { status: 'error', error: `the server answered ${res.status}` };
    else state = { status: 'done', html: renderMarkdown(await res.text()) };
  } catch (err) {
    state = { status: 'error', error: String(err && err.message ? err.message : err) };
  }
  rv.notes.set(file, state);
  if (rv.open && rv.view === 'game' && rv.file === file) render();
}

const currentReview = () => {
  const a = rv.analyses.get(rv.file);
  return a && a.status === 'done' ? a.review : null;
};

// --- list view ---

function rowScoreHtml(file) {
  const a = rv.analyses.get(file);
  if (!a || a.status !== 'done') return '<span class="rv-row-score is-pending">Analysing…</span>';
  if (!a.review.ok) return `<span class="rv-row-score is-error" title="${esc(a.review.error)}">Can't be reviewed</span>`;
  return `<span class="rv-row-score">${esc(rowScoreText(a.review))}</span>`;
}

function rowHtml(entry) {
  const t = listRowText(entry);
  const a = rv.analyses.get(entry.file);
  const broken = a && a.status === 'done' && !a.review.ok;
  return (
    `<li><button type="button" class="rv-row${broken ? ' is-broken' : ''}" data-rv="open-game" data-file="${esc(entry.file)}"` +
    `${broken ? ` aria-disabled="true" title="${esc(a.review.error)}"` : ''}>` +
    `<span class="rv-row-title">${esc(t.title)}</span>` +
    `<span class="rv-row-when">${esc(t.when)}</span>` +
    `<span class="rv-row-level">${esc(t.level)}</span>` +
    `<span class="rv-row-result">${esc(t.result)}</span>` +
    `<span class="rv-row-notes">${t.notes ? '<span class="rv-badge-notes">Notes</span>' : ''}</span>` +
    rowScoreHtml(entry.file) +
    '</button></li>'
  );
}

function updateRow(file) {
  if (!rv.open || rv.view !== 'list' || !rv.root) return;
  const btn = [...rv.root.querySelectorAll('.rv-row')].find((b) => b.dataset.file === file);
  const entry = rv.entries && rv.entries.find((e) => e.file === file);
  if (!btn || !entry) return;
  const holder = document.createElement('ul');
  holder.innerHTML = rowHtml(entry);
  btn.parentElement.replaceWith(holder.firstElementChild);
}

function listHtml() {
  let body;
  if (rv.listError) {
    body =
      '<div class="rv-empty is-error" role="alert"><p>Can\'t reach the Mahjong Trainer server, so your saved games can\'t be listed.</p>' +
      `<p class="rv-dim">Make sure the server is running (start.bat), then try again. (${esc(rv.listError)})</p>` +
      '<button type="button" class="big-btn" data-rv="retry">Try again</button></div>';
  } else if (!rv.entries) {
    body = '<div class="rv-empty"><p>Loading your saved games…</p></div>';
  } else if (!rv.entries.length) {
    body = '<div class="rv-empty"><p>No saved games yet. Finish a game and it will appear here.</p></div>';
  } else {
    body = `<ul class="rv-rows" aria-label="Saved games, newest first">${rv.entries.map(rowHtml).join('')}</ul>`;
  }
  return (
    '<div class="rv-screen rv-list">' +
    '<header class="rv-bar">' +
    '<button type="button" class="tb-btn rv-back" data-rv="back">← Back</button>' +
    '<h1 class="rv-title">Review games</h1>' +
    '<span class="rv-bar-sub">Pick a game to step through your decisions.</span>' +
    screensNav() +
    '</header>' +
    `<main class="rv-list-main">${body}</main>` +
    '</div>'
  );
}

// R4b: links to Progress and Practice (when the app gives onNav).
const screensNav = () => (rv.opts?.onNav ? screenNavHtml('review', 'rv') : '');

function observeRows() {
  rv.observer?.disconnect();
  rv.observer = null;
  const rows = [...rv.root.querySelectorAll('.rv-row')];
  if (!rows.length) return;
  if (typeof IntersectionObserver !== 'function') {
    rows.forEach((r) => enqueue(r.dataset.file));
    return;
  }
  rv.observer = new IntersectionObserver((items) => {
    for (const it of items) if (it.isIntersecting) enqueue(it.target.dataset.file);
  }, { root: rv.root.querySelector('.rv-list-main') });
  rows.forEach((r) => rv.observer.observe(r));
}

async function openFromList(file) {
  const review = await analyse(file);
  if (!rv.open || rv.view !== 'list' || !review.ok) return;
  showGame(file, true);
}

// --- game view: table ---

// Display index of each hand tile to mark: { index: { cls, label } }.
function handMarks(step) {
  const hand = step.table.humanHand;
  const marks = {};
  const firstIndex = (code, taken) => hand.findIndex((t, i) => t === code && !(i in taken));
  const a = step.chosen;
  if (a.type === 'discard') {
    // The thrown copy: the drawn tile if that is what went, else the first copy in the row.
    const last = hand.length - 1;
    const ci = step.drew && hand[last] === a.tile ? last : hand.indexOf(a.tile);
    const good = step.best.includes(a.tile);
    marks[ci] = good ? { cls: 'rv-mark-best', label: 'you threw · best' } : { cls: 'rv-mark-threw', label: 'you threw' };
    if (!good) {
      for (const b of step.best) {
        const i = firstIndex(b, marks);
        if (i >= 0) marks[i] = { cls: 'rv-mark-best', label: 'best' };
      }
    }
  } else if (step.kind === 'claim') {
    const taken = a.type !== 'pass' && a.type !== 'hu';
    const used = [];
    if (taken) used.push(usedTiles(a, step.claimTile));
    else for (const o of step.offers) if (o.action.type !== 'hu') used.push(usedTiles(o.action, step.claimTile));
    const label = taken ? 'used' : 'could use';
    for (const group of used) {
      const seen = {};
      for (const code of group) {
        const i = firstIndex(code, { ...marks, ...seen });
        if (i >= 0 && !(i in marks)) marks[i] = { cls: taken ? 'rv-mark-used' : 'rv-mark-could', label };
        if (i >= 0) seen[i] = true;
      }
    }
  } else if (a.type === 'kong') {
    hand.forEach((t, i) => { if (t === a.tile) marks[i] = { cls: 'rv-mark-used', label: 'Kong' }; });
  }
  return marks;
}

function usedTiles(action, claimTile) {
  if (action.type === 'chi') return action.tiles;
  if (action.type === 'pong') return [claimTile, claimTile];
  if (action.type === 'kong') return [claimTile, claimTile, claimTile];
  return [];
}

function seatHeadHtml(step, p) {
  const t = step.table;
  const wind = WIND_LETTERS[(p - t.dealer + 4) % 4];
  let status = '';
  if (p !== 0 && rv.reveal) {
    const st = opponentStatus(t.players[p].hand, t.players[p].melds.length);
    status = `<span class="rv-seat-status${st.ready ? ' is-ready' : ''}">${esc(st.text)}</span>${HIDDEN_TAG}`;
  }
  const isTurn = t.turnPlayer === p;
  return (
    '<div class="rv-seat-head">' +
    `<span class="seat-name">${NAMES[p]}</span>` +
    `<span class="seat-wind">${WIND_NAMES[wind]}</span>` +
    (p === t.dealer ? '<span class="dealer-badge">Dealer</span>' : '') +
    (isTurn && step.kind === 'claim' ? '<span class="rv-seat-flag">Discarded</span>' : '') +
    status +
    '</div>'
  );
}

function meldsHtml(pl, p, size) {
  const melds = pl.melds.map((m, i) => meldHtml(m, size, numbers(), p !== 0 && !rv.reveal, i)).join('');
  const flowers = pl.flowers.map((f) => tile(f, 'small')).join('');
  return (melds ? `<div class="rv-melds">${melds}</div>` : '') + (flowers ? `<div class="rv-flowers">${flowers}</div>` : '');
}

function opponentSeatHtml(step, p) {
  const pl = step.table.players[p];
  const hand = rv.reveal
    ? `<div class="rv-opp-hand is-revealed">${pl.hand.map((c) => tile(c, 'small')).join('')}</div>`
    : `<div class="rv-opp-hand" aria-label="${pl.hand.length} hidden tiles">${pl.hand.map(() => back('small')).join('')}</div>`;
  const cls = ['rv-seat', `rv-seat--${POSITIONS[p]}`];
  if (step.table.turnPlayer === p) cls.push('is-turn');
  return (
    `<section class="${cls.join(' ')}" aria-label="${NAMES[p]}">` +
    seatHeadHtml(step, p) +
    `<div class="rv-seat-body">${hand}${meldsHtml(pl, p, 'small')}</div>` +
    '</section>'
  );
}

function humanSeatHtml(step) {
  const t = step.table;
  const hand = t.humanHand;
  const marks = handMarks(step);
  const drawnApart = step.kind === 'turn' && step.drew && hand.at(-1) === step.drew;
  const tiles = hand.map((c, i) => {
    const m = marks[i];
    const cls = ['rv-hand-tile'];
    if (m) cls.push('rv-mark', m.cls);
    return tile(c, 'hand', cls.join(' '), m ? ` data-mark="${esc(m.label)}"` : '');
  });
  const row = drawnApart ? tiles.slice(0, -1) : tiles;
  const drawn = drawnApart ? `<div class="rv-drawn" title="Just drawn">${tiles.at(-1)}</div>` : '';
  return (
    '<section class="rv-seat rv-seat--bottom" aria-label="You">' +
    seatHeadHtml(step, 0) +
    `<div class="rv-seat-body"><div class="rv-hand">${row.join('')}</div>${drawn}${meldsHtml(t.players[0], 0, 'discard')}</div>` +
    '</section>'
  );
}

function poolHtml(step, p) {
  const t = step.table;
  const ds = t.players[p].discards;
  const ld = t.lastDiscard;
  const tiles = ds.map((c, i) => {
    const latest = ld && ld.player === p && i === ds.length - 1 && ld.tile === c;
    const offered = latest && step.kind === 'claim' && !step.robKong;
    return tile(c, 'discard', [latest ? 'is-last' : '', offered ? 'rv-mark rv-mark-claim' : ''].filter(Boolean).join(' '),
      offered ? ' data-mark="offered"' : '');
  });
  return `<div class="rv-pool rv-pool--${POSITIONS[p]}" aria-label="${NAMES[p]} discards">${tiles.join('')}</div>`;
}

function compassHtml(step) {
  const t = step.table;
  const winds = [0, 1, 2, 3].map((p) => {
    const w = WIND_LETTERS[(p - t.dealer + 4) % 4];
    return `<span class="compass-wind compass-wind--${POSITIONS[p]}${t.turnPlayer === p ? ' is-active' : ''}">${w}</span>`;
  }).join('');
  return (
    `<div class="rv-center"><div class="compass">${winds}` +
    `<div class="wall-count"><span class="wall-num">${t.wallCount}</span><span class="wall-label">tiles left</span></div>` +
    '</div></div>'
  );
}

function tableHtml(step) {
  return (
    '<section class="rv-table" aria-label="The table at this step">' +
    opponentSeatHtml(step, 2) +
    opponentSeatHtml(step, 3) +
    `<div class="rv-pools">${[2, 3, 1, 0].map((p) => poolHtml(step, p)).join('')}${compassHtml(step)}</div>` +
    opponentSeatHtml(step, 1) +
    humanSeatHtml(step) +
    '</section>'
  );
}

// --- game view: side panel ---

function badgeHtml(verdict, big = false, gapSize = null) {
  const v = verdictStyle(verdict, gapSize);
  return `<span class="rv-badge ${v.cls}${big ? ' rv-badge--big' : ''}">${esc(v.label)}</span>`;
}

function acceptsHtml(opt) {
  if (!opt) return '';
  const list = opt.accepts.length
    ? opt.accepts.map((a) => `<span class="rv-accept${a.live ? '' : ' is-dead'}">${tile(a.tile, 'small')}<span class="rv-live">${a.live}</span></span>`).join('')
    : '<span class="rv-dim">No tile would bring you closer.</span>';
  return (
    `<div class="rv-accepts-head">Throwing ${esc(tileLabel(opt.tile))} leaves ${usefulTiles(opt.acceptance)}:` +
    ' <span class="rv-dim">(copies you could still draw)</span></div>' +
    `<div class="rv-accepts-list">${list}</div>`
  );
}

function shownOption(step) {
  const code = rv.optionHover ?? rv.optionPick ?? step.chosen.tile;
  return step.options.find((o) => o.tile === code) ?? step.options[0];
}

function discardPanelHtml(step) {
  const shown = shownOption(step);
  const safest = safestOptions(step.options, step.threat);
  const rows = step.options.map((o) => {
    const mine = o.tile === step.chosen.tile;
    const best = step.best.includes(o.tile);
    const tags = (best ? '<span class="rv-tag rv-tag--best">best</span>' : '') +
      (safest.includes(o.tile) ? `<span class="rv-tag rv-tag--safest" title="${esc(SAFEST_TITLE)}">safest here</span>` : '') +
      (mine ? '<span class="rv-tag rv-tag--you">you</span>' : '');
    const cls = ['rv-opt'];
    if (mine) cls.push('is-mine');
    if (best) cls.push('is-best');
    if (shown && shown.tile === o.tile) cls.push('is-shown');
    const chip = o.risk && riskChip(o.risk.level, Boolean(step.threatened));
    const against = step.threatened ? riskAgainstWords(o.risk) : '';
    const why = (step.threatened && o.risk.reasons.length ? ': ' + o.risk.reasons.join('; ') : '') + (against ? `. ${against}` : '');
    const chipHtml = chip ? `<span class="${chip.cls}" title="${esc(chip.title + why)}">${chip.label}</span>` : '';
    return (
      `<tr class="${cls.join(' ')}" data-opt="${o.tile}" tabindex="0">` +
      `<td class="rv-opt-tile">${tile(o.tile, 'small')}</td>` +
      `<td>${esc(distanceWords(o.shanten))}</td>` +
      `<td class="rv-num">${o.acceptance}</td>` +
      `<td class="rv-opt-risk">${chipHtml}</td>` +
      `<td class="rv-opt-tags">${tags}</td></tr>`
    );
  }).join('');
  return (
    (step.missedWin
      ? '<h3 class="rv-h">The best move was Hu: your hand was complete</h3><p class="rv-dim">The throws you could have made instead:</p>'
      : '<h3 class="rv-h">Your options</h3>') +
    '<div class="rv-options-wrap"><table class="rv-options">' +
    '<thead><tr><th>Throw</th><th>Leaves you</th><th class="rv-num">Useful</th><th>Risk</th><th></th></tr></thead>' +
    `<tbody>${rows}</tbody></table></div>` +
    `<div class="rv-accepts">${acceptsHtml(shown)}</div>`
  );
}

function claimPanelHtml(step) {
  const offers = step.offers.map((o) => {
    const taken = o.action.type === step.chosen.type && (o.action.type !== 'chi' || String(o.action.tiles) === String(step.chosen.tiles));
    const tiles = usedTiles(o.action, step.claimTile).map((c) => tile(c, 'small')).join('') +
      (o.action.type !== 'hu' ? tile(step.claimTile, 'small', 'rv-claimed-tile') : '');
    return (
      `<li class="rv-offer${taken ? ' is-mine' : ''}"><span class="rv-offer-tiles">${tiles}</span>` +
      `<span class="rv-offer-text"><b>${esc(offerWords(o.action, step.claimTile))}</b>${taken ? ' <span class="rv-tag rv-tag--you">you</span>' : ''}<br>` +
      `If taken: ${esc(distanceWords(o.shantenIfTaken))}${o.action.type === 'hu' ? '' : `, ${usefulTiles(o.acceptanceIfTaken)}`}</span></li>`
    );
  }).join('');
  const passed = step.chosen.type === 'pass';
  return (
    '<h3 class="rv-h">Your options</h3>' +
    `<ul class="rv-offers">${offers}` +
    `<li class="rv-offer${passed ? ' is-mine' : ''}"><span class="rv-offer-tiles"></span><span class="rv-offer-text"><b>Pass</b>` +
    `${passed ? ' <span class="rv-tag rv-tag--you">you</span>' : ''}<br>` +
    `If passed: ${esc(distanceWords(step.shantenIfPassed))}, ${usefulTiles(step.acceptanceIfPassed)}</span></li></ul>`
  );
}

function waitsPanelHtml(step) {
  if (!step.waits.length) return '';
  const items = step.waits.map((w) => {
    const where = rv.reveal
      ? `<span class="rv-where">${w.inWall} in the wall · ${w.inOpponentHands} in opponents' hands · ${w.dead} already gone</span>`
      : '';
    return `<li>${tile(w.tile, 'small')}<span><b>${esc(tileLabel(w.tile))}</b>: ${w.live} left${where ? '<br>' + where : ''}</span></li>`;
  }).join('');
  const shape = step.waitWords ? `<p class="rv-wait-shape">${esc(step.waitWords[0].toUpperCase() + step.waitWords.slice(1))}.</p>` : '';
  const wider = step.widerWaitAvailable ? `<p class="rv-wait-wider">${esc(step.widerWaitAvailable.words)}.</p>` : '';
  return (
    `<h3 class="rv-h">You are ready: your winning tiles${rv.reveal ? ` ${HIDDEN_TAG}` : ''}</h3>` +
    shape +
    `<ul class="rv-waits">${items}</ul>` +
    wider
  );
}

function dangerPanelHtml(step) {
  if (!rv.reveal) return '';
  const t = step.table;
  const ready = [1, 2, 3].map((p) => ({ p, st: opponentStatus(t.players[p].hand, t.players[p].melds.length) }))
    .filter((x) => x.st.ready);
  let body;
  if (!ready.length) body = '<p>No opponent was ready (one tile from winning) at this moment.</p>';
  else {
    body = '<ul class="rv-danger">' + ready.map(({ p, st }) =>
      `<li><b>${NAMES[p]}</b> was ready: waiting on ${esc(tileListWords(st.waits))}.</li>`).join('') + '</ul>';
  }
  if (step.danger) {
    const hit = step.danger.ready.filter((r) => r.dealtIn);
    if (hit.length) {
      body += `<p class="rv-danger-line is-hit">This tile was one of ${hit.map((r) => `${NAMES[r.player]}'s`).join(' and ')} winning tiles.</p>`;
    } else if (step.danger.opponentsReady.length) {
      body += '<p class="rv-danger-line is-safe">Safe this time: your discard was not one of their winning tiles.</p>';
    }
  }
  if (step.hindsight) {
    body += '<p class="rv-hindsight"><span class="rv-hindsight-tag" title="What happened next: you could not know this when you chose, and it does not change the grade">hindsight</span> ' +
      `${esc(step.hindsight.words)}</p>`;
  }
  return `<h3 class="rv-h">What was really going on ${HIDDEN_TAG}</h3><div class="rv-hidden-box">${body}</div>`;
}

function glossaryHtml() {
  return (
    '<div class="rv-glossary" role="region" aria-label="What do these mean?">' +
    '<button type="button" class="tb-btn rv-glossary-close" data-rv="glossary">Close</button>' +
    `<dl>${LEGEND_ENTRIES.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` +
    '</div>'
  );
}

function panelHtml(review, step) {
  const steps = review.steps;
  const facts = [
    ['Your hand', esc(handLineWords(step))],
    ['Your choice', esc(choiceWords(step))],
  ];
  if (step.thinkMs != null) facts.push(['Think time', esc(secondsWords(step.thinkMs)) + (step.timedOut ? ' <span class="rv-tag rv-tag--warn">timed out</span>' : '')]);
  else if (step.timedOut) facts.push(['Think time', '<span class="rv-tag rv-tag--warn">timed out</span>']);
  const threat = threatLine(step);
  if (threat) facts.push(['Threat', `<span class="rv-threat${step.threatened ? ' is-threatened' : ''}">${esc(threat)}</span>`]);
  let detail = '';
  if (step.chosen.type === 'discard') detail = discardPanelHtml(step);
  else if (step.kind === 'claim') detail = claimPanelHtml(step);
  const sub = subVerdicts(step);
  const subHtml = sub
    ? `<span class="rv-subverdicts"><span>Speed: <b>${esc(sub.speed)}</b></span><span>Safety: <b>${esc(sub.safety)}</b></span></span>`
    : '';
  const extra = [
    step.safetyNote && step.safetyNote !== step.cost ? step.safetyNote : null,
    step.tiedBest ? TIED_TEXT : null,
    step.note,
    claimedNote(step),
  ].filter(Boolean).map((t) => `<p class="rv-step-note">${esc(t)}</p>`).join('');
  return (
    '<aside class="rv-panel" aria-label="This step">' +
    `<div class="rv-step-kicker">Step ${step.index + 1} of ${steps.length}` +
    `<button type="button" class="rv-link rv-glossary-btn" data-rv="glossary" aria-expanded="${rv.glossary}">What do these mean?</button></div>` +
    (rv.glossary ? glossaryHtml() : '') +
    `<h2 class="rv-step-title">${esc(stepHeading(step, steps, review.meta.humanTurns))}</h2>` +
    `<div class="rv-verdict">${badgeHtml(step.verdict, true, step.gapSize)}${subHtml}` +
    `<p class="rv-cost">${esc(step.cost ?? (step.verdict === 'best' ? 'The best choice here.' : ''))}</p>${extra}` +
    lessonChipsHtml(review, step.index) +
    disagreeHtml({ file: rv.file, stepIndex: step.index, verdict: step.verdict, reviewVersion: review.reviewVersion ?? REVIEW_VERSION }) +
    '</div>' +
    `<dl class="rv-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` +
    detail +
    waitsPanelHtml(step) +
    dangerPanelHtml(step) +
    '</aside>'
  );
}

// --- game view: summary and notes ---

function countsRow(title, c) {
  const total = c.best + c.fine + c.inaccuracy + c.mistake;
  if (!total) return '';
  return (
    `<tr><th>${title}</th>` +
    ['best', 'fine', 'inaccuracy', 'mistake'].map((v) => `<td>${badgeHtml(v)} <b>${c[v]}</b></td>`).join('') +
    '</tr>'
  );
}

// "You spent a while on 2 choices where the options were equal or nearly equal: steps 1 and 5", with step links.
function longThinksHtml(s, stepLink) {
  const line = longThinksLine(s);
  if (!line) return '';
  const head = line.slice(0, line.lastIndexOf(': ') + 2);
  const list = s.longEqualThinks;
  const links = list.map((i) => stepLink(i, String(i + 1)));
  const which = links.length === 1 ? links[0] : `${links.slice(0, -1).join(', ')} and ${links.at(-1)}`;
  return `<li class="rv-long-thinks">${esc(head)}${list.length === 1 ? 'step' : 'steps'} ${which}.</li>`;
}

function summaryHtml(review) {
  const s = review.summary;
  const m = review.meta;
  const steps = review.steps;
  const stepLink = (i, text) => `<button type="button" class="rv-link" data-rv="goto" data-step="${i}">${text}</button>`;
  const none = !steps.length;
  const costly = s.costliest.length
    ? '<ol class="rv-costly">' + s.costliest.map((i) => {
      const st = steps[i];
      return `<li>${badgeHtml(st.verdict, false, st.gapSize)} ${stepLink(i, `Step ${i + 1}: ${esc(stepHeading(st, steps, m.humanTurns))}`)}` +
        `<div class="rv-dim">${esc(st.cost ?? '')}</div></li>`;
    }).join('') + '</ol>'
    : none ? `<p>${esc(NO_DECISIONS_TEXT)}</p>` : '<p>No mistakes or inaccuracies this game. Well played.</p>';
  const ready = s.firstReadyStep === null
    ? 'You never got ready (one tile from winning).'
    : `You first got ready at ${stepLink(s.firstReadyStep, `step ${s.firstReadyStep + 1}`)} (turn ${steps[s.firstReadyStep].turn}).`;
  let dealt;
  if (s.kongRobbedStep !== null) {
    dealt = `${NAMES[m.result.winner]} won by robbing your Kong at ${stepLink(s.kongRobbedStep, `step ${s.kongRobbedStep + 1}`)}.`;
  } else if (s.dealtIn) {
    dealt = `You dealt in: your ${s.dealtInStep !== null ? stepLink(s.dealtInStep, `discard at step ${s.dealtInStep + 1}`) : 'discard'} gave ${NAMES[m.result.winner]} the win.`;
  } else dealt = 'You did not deal in (no opponent won on your discard).';
  const level = m.botLevel === 'normal' ? 'Normal' : m.botLevel === 'easy' ? 'Easy' : 'Unknown';
  return (
    '<article class="rv-doc rv-summary">' +
    `<h2 class="rv-headline">${esc(m.result.headline)}</h2>` +
    (m.result.sub ? `<p class="rv-subline">${esc(m.result.sub)}</p>` : '') +
    (none
      ? '<p class="rv-score"><span class="rv-score-big">No decisions</span></p>'
      : `<p class="rv-score"><span class="rv-score-big">${s.scoreGood} of ${s.scoreTotal}</span> discards best or fine</p>`) +
    '<table class="rv-counts"><tbody>' +
    countsRow('Discards', s.discards) + countsRow('Claims', s.claims) + countsRow('Other (Hu, Kong)', s.other) +
    '</tbody></table>' +
    `<h3 class="rv-h">Costliest decisions</h3>${costly}` +
    reviewLessonsHtml(review, rv.file) +
    '<h3 class="rv-h">How the game went</h3><ul class="rv-facts-list">' +
    `<li>${ready}</li>` +
    (readyTurnsLine(s) ? `<li>${esc(readyTurnsLine(s))}.</li>` : '') +
    drawThrowLines(s).map((l, j) => `<li>${esc(l)}. ${stepLink(s.drawThrowRuns[j].fromStep, `See step ${s.drawThrowRuns[j].fromStep + 1}`)}</li>`).join('') +
    (rv.reveal && readyWallLine(s) ? `<li>${esc(readyWallLine(s))}. ${HIDDEN_TAG}</li>` : '') +
    (rv.reveal && nearMissLine(s) ? `<li>${esc(nearMissLine(s))}. ${HIDDEN_TAG}</li>` : '') +
    (rv.reveal ? hiddenReadyLines(s).map((l) => `<li>${esc(l)}. ${HIDDEN_TAG}</li>`).join('') : '') +
    `<li>${dealt}</li>` +
    `<li>${s.heldPairAtEnd ? 'You held a pair at the end.' : 'You had no usable pair at the end (a win needs one).'}</li>` +
    `<li>Think time: ${esc(thinkTimeWords(s, steps.length))}.</li>` +
    (paceLine(s, m.durationMs) ? `<li>${esc(paceLine(s, m.durationMs))}.</li>` : '') +
    longThinksHtml(s, stepLink) +
    `<li>Bots: ${level}. You were ${WIND_NAMES[m.humanWind]}; dealer: ${NAMES[m.dealer]}. ${steps.length} decisions over ${m.humanTurns} turns.</li>` +
    '</ul>' +
    (none ? '' : `<p class="rv-foot">${stepLink(0, 'Step through the game from the start →')}</p>`) +
    '</article>'
  );
}

function notesHtml() {
  const n = rv.notes.get(rv.file);
  let body;
  if (!n || n.status === 'pending') body = '<p class="rv-dim">Loading coach notes…</p>';
  else if (n.status === 'none') body = '<p>No coach notes for this game yet. Ask your coach for a review and they will appear here.</p>';
  else if (n.status === 'error') body = `<p class="rv-error">Coach notes could not be loaded (${esc(n.error)}).</p>`;
  else body = `<div class="rv-notes">${n.html}</div>`;
  return `<article class="rv-doc">${body}</article>`;
}

// --- game view: navigation strip and chart ---

function stripHtml(review) {
  const steps = review.steps;
  const flagged = steps.some(isFlagged);
  const firstMistake = steps.find((s) => s.verdict === 'mistake');
  const prev = nextStep(steps, rv.step, -1, rv.onlyFlagged);
  const next = nextStep(steps, rv.step, 1, rv.onlyFlagged);
  const legend = [
    '<span class="rv-leg rv-leg--you">You</span>',
    ...(rv.reveal ? [1, 2, 3].map((p) => `<span class="rv-leg rv-leg--bot${p}">${NAMES[p]}</span>`) : []),
    rv.reveal ? HIDDEN_TAG : '<span class="rv-dim">Reveal hidden hands to see the bots\' lines</span>',
  ].join('');
  return (
    '<footer class="rv-strip">' +
    '<div class="rv-nav">' +
    `<button type="button" class="tb-btn" data-rv="prev"${prev === null ? ' disabled' : ''} title="Previous step (Left arrow)">← Previous</button>` +
    (steps.length
      ? `<span class="rv-nav-pos">Step <b>${rv.step + 1}</b> of ${steps.length}</span>`
      : '<span class="rv-nav-pos">No steps</span>') +
    `<button type="button" class="tb-btn" data-rv="next"${next === null ? ' disabled' : ''} title="Next step (Right arrow)">Next →</button>` +
    `<label class="rv-check${flagged ? '' : ' is-disabled'}"><input type="checkbox" data-rv="only-flagged"${rv.onlyFlagged ? ' checked' : ''}${flagged ? '' : ' disabled'}>` +
    ' Only mistakes and inaccuracies</label>' +
    (firstMistake ? `<button type="button" class="tb-btn" data-rv="first-mistake">Jump to first mistake</button>` : '') +
    `<span class="rv-legend">${legend}</span>` +
    '</div>' +
    '<div class="rv-chart" aria-label="Distance from winning at each step"></div>' +
    '</footer>'
  );
}

const CHART_PAD = { top: 10, right: 16, bottom: 22, left: 64 };

function chartSvg(review, width, height) {
  const steps = review.steps;
  const tl = review.timeline;
  const you = steps.map((s) => s.shantenAfter);
  const bots = [1, 2, 3].map((p) => steps.map((s) => pointAtStep(tl, s.n)?.shanten[p] ?? null));
  const values = [...you, ...(rv.reveal ? bots.flat() : [])].filter((v) => v !== null);
  const minS = Math.min(0, ...values);
  const maxS = Math.max(1, ...values);
  const g = chartGeometry({ count: steps.length, minS, maxS, width, height, pad: CHART_PAD });
  const path = (vals) => vals.map((v, i) => (v === null ? '' : `${i ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(v).toFixed(1)}`)).join('');
  const grid = g.ticks.map((t) =>
    `<line class="rv-grid" x1="${CHART_PAD.left}" x2="${width - CHART_PAD.right}" y1="${t.y}" y2="${t.y}"/>` +
    `<text class="rv-axis" x="${CHART_PAD.left - 8}" y="${t.y + 4}" text-anchor="end">${t.label}</text>`).join('');
  const xl = g.xLabels.map((i) => `<text class="rv-axis" x="${g.x(i)}" y="${height - 4}" text-anchor="middle">${i + 1}</text>`).join('');
  const botLines = rv.reveal ? bots.map((b, k) => `<path class="rv-line rv-line--bot${k + 1}" d="${path(b)}"/>`).join('') : '';
  const sel = !steps.length ? '' : `<line class="rv-sel" x1="${g.x(rv.step)}" x2="${g.x(rv.step)}" y1="${CHART_PAD.top - 6}" y2="${height - CHART_PAD.bottom + 2}"/>`;
  const dots = steps.map((s, i) => {
    const v = verdictStyle(s.verdict, s.gapSize);
    const cx = g.x(i);
    const cy = g.y(s.shantenAfter);
    const dim = rv.onlyFlagged && !isFlagged(s) ? ' is-dim' : '';
    const selected = i === rv.step ? ' is-selected' : '';
    const r = i === rv.step ? 7 : 5;
    const shape = s.kind === 'claim'
      ? `<rect class="rv-dot ${v.cls}${dim}${selected}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" rx="2"/>`
      : `<circle class="rv-dot ${v.cls}${dim}${selected}" cx="${cx}" cy="${cy}" r="${r}"/>`;
    return (
      `<g class="rv-step-hit" data-step="${i}" role="button" tabindex="-1" aria-label="Step ${i + 1}: ${v.label}">` +
      `<title>Step ${i + 1}: ${v.label}${s.kind === 'claim' ? ' (claim)' : ''}. ${distanceWords(s.shantenAfter)}</title>` +
      `<rect class="rv-hit" x="${cx - 9}" y="${CHART_PAD.top - 8}" width="18" height="${height - CHART_PAD.top - CHART_PAD.bottom + 12}"/>` +
      shape + '</g>'
    );
  }).join('');
  return (
    `<svg class="rv-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">` +
    grid + xl + sel + botLines + `<path class="rv-line rv-line--you" d="${path(you)}"/>` + dots +
    '</svg>'
  );
}

function drawChart() {
  const review = currentReview();
  const box = rv.root?.querySelector('.rv-chart');
  if (!review || !review.ok || !box) return;
  const w = Math.max(240, Math.floor(box.clientWidth));
  const h = Math.max(80, Math.floor(box.clientHeight));
  box.innerHTML = chartSvg(review, w, h);
}

// --- game view ---

function gameHtml(review) {
  const entry = rv.entries?.find((e) => e.file === rv.file);
  const row = listRowText(entry ?? { file: rv.file, startedAt: review.meta.startedAt, botLevel: review.meta.botLevel });
  const tab = (id, label) =>
    `<button type="button" class="rv-tab${rv.tab === id ? ' is-on' : ''}" role="tab" aria-selected="${rv.tab === id}" data-rv="tab" data-tab="${id}">${label}</button>`;
  const step = review.steps[rv.step];
  let main;
  if (rv.tab === 'summary') main = `<div class="rv-main rv-main--doc">${summaryHtml(review)}</div>`;
  else if (rv.tab === 'notes') main = `<div class="rv-main rv-main--doc">${notesHtml()}</div>`;
  else if (!step) main = `<div class="rv-main rv-main--doc"><article class="rv-doc"><p>${esc(NO_DECISIONS_TEXT)}</p></article></div>`;
  else main = `<div class="rv-main">${tableHtml(step)}${panelHtml(review, step)}</div>`;
  return (
    '<div class="rv-screen rv-game">' +
    '<header class="rv-bar">' +
    `<button type="button" class="tb-btn rv-back" data-rv="back">← ${rv.fromList ? 'All games' : 'Back'}</button>` +
    `<h1 class="rv-title">${esc(row.title)}</h1>` +
    `<span class="rv-bar-sub">${esc(row.when)} · ${esc(review.meta.result.headline)}</span>` +
    `<nav class="rv-tabs" role="tablist">${tab('summary', 'Summary')}${tab('steps', 'Steps')}${tab('notes', 'Coach notes')}</nav>` +
    (rv.fromList || rv.opts?.onNav ? '' : '<button type="button" class="tb-btn" data-rv="to-list">All games</button>') +
    `<button type="button" class="tb-btn tb-toggle rv-reveal${rv.reveal ? ' is-on' : ''}" data-rv="reveal" aria-pressed="${rv.reveal}"` +
    ' title="Show the bots\' concealed tiles and what you could not know during play">' +
    `<span class="tb-key">Reveal hidden hands</span> <span class="tb-val">${rv.reveal ? 'On' : 'Off'}</span></button>` +
    screensNav() +
    '</header>' +
    main +
    stripHtml(review) +
    '</div>'
  );
}

function gameMessageHtml(text, isError) {
  return (
    '<div class="rv-screen rv-list">' +
    '<header class="rv-bar"><button type="button" class="tb-btn rv-back" data-rv="back">← Back</button>' +
    '<h1 class="rv-title">Game review</h1>' +
    '<button type="button" class="tb-btn" data-rv="to-list">All games</button>' + screensNav() + '</header>' +
    `<main class="rv-list-main"><div class="rv-empty${isError ? ' is-error' : ''}"${isError ? ' role="alert"' : ''}>${text}</div></main>` +
    '</div>'
  );
}

// --- rendering and actions ---

function render() {
  if (!rv.open || !rv.root) return;
  hideTip();
  const root = rv.root;
  const focusKey = document.activeElement && root.contains(document.activeElement) ? focusId(document.activeElement) : null;
  if (rv.view === 'list') {
    root.innerHTML = listHtml();
    observeRows();
  } else {
    const a = rv.analyses.get(rv.file);
    if (!a || a.status !== 'done') root.innerHTML = gameMessageHtml('<p>Analysing the game…</p>', false);
    else if (!a.review.ok) {
      root.innerHTML = gameMessageHtml(
        `<p>This game can't be reviewed.</p><p class="rv-dim">${esc(a.review.error)}</p>`, true);
    } else {
      root.innerHTML = gameHtml(a.review);
      drawChart();
    }
  }
  if (focusKey) root.querySelector(focusKey)?.focus({ preventScroll: true });
}

// Selector to find the focused control again after a re-render.
function focusId(el) {
  const d = el.dataset || {};
  if (d.rv === 'tab') return `[data-rv="tab"][data-tab="${d.tab}"]`;
  if (d.rv && !d.file && !d.step) return `[data-rv="${d.rv}"]`;
  if (d.opt) return `[data-opt="${d.opt}"]`;
  return null;
}

function setUrl() {
  const param = rv.view === 'game' && rv.file ? rv.file : '1';
  rv.opts?.onUrl?.(param);
}

function showGame(file, fromList, step = null) {
  rv.view = 'game';
  rv.file = file;
  rv.fromList = fromList;
  rv.tab = step === null ? 'summary' : 'steps';
  rv.step = step ?? 0;
  rv.onlyFlagged = false;
  rv.optionPick = null;
  rv.optionHover = null;
  setUrl();
  render();
  analyse(file).then((review) => {
    // A step asked for from outside (Progress, Practice) that this game does not have.
    if (review && review.ok && rv.step >= review.steps.length) rv.step = Math.max(0, review.steps.length - 1);
    if (rv.open && rv.file === file) render();
  });
  loadNotes(file);
}

function showList() {
  rv.view = 'list';
  rv.file = null;
  setUrl();
  render();
  if (!rv.entries || rv.listError) loadList();
}

function goStep(i) {
  const review = currentReview();
  if (!review || !review.ok || !review.steps.length || i === null || i === undefined) return;
  const n = Math.max(0, Math.min(review.steps.length - 1, i));
  if (n !== rv.step || rv.tab !== 'steps') {
    rv.step = n;
    rv.tab = 'steps';
    rv.optionPick = null;
    rv.optionHover = null;
    render();
  }
}

function goBack() {
  if (rv.view === 'game' && rv.fromList) {
    showList();
    return;
  }
  closeReview();
  rv.opts?.onBack?.();
}

function onClick(ev) {
  if (!rv.open) return;
  const t = ev.target;
  const hit = t.closest && t.closest('.rv-step-hit');
  if (hit && rv.root.contains(hit)) {
    goStep(Number(hit.dataset.step));
    return;
  }
  const opt = t.closest && t.closest('tr[data-opt]');
  if (opt && rv.root.contains(opt)) {
    rv.optionPick = opt.dataset.opt;
    rv.optionHover = null;
    updateOptions();
    return;
  }
  const el = t.closest && t.closest('[data-rv]');
  if (!el || !rv.root.contains(el) || el.disabled) return;
  const review = currentReview();
  switch (el.dataset.rv) {
    case 'back': goBack(); break;
    case 'retry': loadList(); break;
    case 'to-list': showList(); break;
    case 'nav':
      if (el.dataset.to === 'review') {
        if (rv.view !== 'list') showList();
      } else {
        closeReview();
        rv.opts?.onNav?.(el.dataset.to);
      }
      break;
    case 'open-game':
      if (el.getAttribute('aria-disabled') !== 'true') openFromList(el.dataset.file);
      break;
    case 'tab':
      rv.tab = el.dataset.tab;
      if (rv.tab === 'notes') loadNotes(rv.file);
      render();
      break;
    case 'reveal':
      rv.reveal = !rv.reveal;
      saveReveal();
      render();
      break;
    case 'prev': goStep(nextStep(review.steps, rv.step, -1, rv.onlyFlagged)); break;
    case 'next': goStep(nextStep(review.steps, rv.step, 1, rv.onlyFlagged)); break;
    case 'first-mistake': goStep(review.steps.find((s) => s.verdict === 'mistake')?.index); break;
    case 'goto': goStep(Number(el.dataset.step)); break;
    case 'glossary':
      rv.glossary = !rv.glossary;
      render();
      break;
    default: break;
  }
}

function onChange(ev) {
  if (!rv.open || !ev.target.matches('[data-rv="only-flagged"]')) return;
  rv.onlyFlagged = ev.target.checked;
  const review = currentReview();
  if (rv.onlyFlagged && review && !isFlagged(review.steps[rv.step])) {
    const to = nextStep(review.steps, rv.step, 1, true) ?? nextStep(review.steps, rv.step, -1, true);
    if (to !== null) {
      rv.step = to;
      rv.tab = 'steps';
    }
  }
  render();
}

// Hovering an option row previews its useful tiles; without re-rendering the table.
function updateOptions() {
  const review = currentReview();
  if (!review || rv.tab !== 'steps') return;
  const step = review.steps[rv.step];
  if (!step.options) return;
  const shown = shownOption(step);
  rv.root.querySelectorAll('tr[data-opt]').forEach((tr) => tr.classList.toggle('is-shown', tr.dataset.opt === shown.tile));
  const box = rv.root.querySelector('.rv-accepts');
  if (box) box.innerHTML = acceptsHtml(shown);
}

function onOver(ev) {
  if (!rv.open) return;
  const opt = ev.target.closest && ev.target.closest('tr[data-opt]');
  const code = opt && rv.root.contains(opt) ? opt.dataset.opt : null;
  if (code !== rv.optionHover) {
    rv.optionHover = code;
    updateOptions();
  }
}

function onKey(ev) {
  if (!rv.open || !rv.root || !rv.root.isConnected) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const target = ev.target;
  if (target && (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName) ||
    (target.tagName === 'INPUT' && target.type !== 'checkbox'))) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    goBack();
    return;
  }
  const review = currentReview();
  if (rv.view !== 'game' || !review || !review.ok) return;
  const steps = review.steps;
  let to;
  if (ev.key === 'ArrowLeft') to = rv.tab === 'steps' ? nextStep(steps, rv.step, -1, rv.onlyFlagged) : rv.step;
  else if (ev.key === 'ArrowRight') to = rv.tab === 'steps' ? nextStep(steps, rv.step, 1, rv.onlyFlagged) : rv.step;
  else if (ev.key === 'Home') to = rv.onlyFlagged ? (steps.find(isFlagged)?.index ?? 0) : 0;
  else if (ev.key === 'End') to = rv.onlyFlagged ? (steps.findLast(isFlagged)?.index ?? steps.length - 1) : steps.length - 1;
  else if ((ev.key === 'Enter' || ev.key === ' ') && target && target.matches && target.matches('tr[data-opt]')) {
    ev.preventDefault();
    rv.optionPick = target.dataset.opt;
    updateOptions();
    return;
  } else return;
  ev.preventDefault();
  goStep(to);
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => { if (rv.open && rv.view === 'game') drawChart(); });
}

const boundRoots = new WeakSet();
function bindRoot(root) {
  if (boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('mouseover', onOver);
}

function closeReview() {
  rv.open = false;
  rv.observer?.disconnect();
  rv.observer = null;
  rv.queue = [];
  hideTip();
  if (rv.root) rv.root.classList.remove('mt-review');
  rv.opts?.onUrl?.(null);
}

/**
 * Opens the review screen in root (which the caller has taken from the table: suspendUi()).
 * opts: { file (open this game; else the list), step (open the Steps tab at this step),
 * getSettings(), onBack() (called after the screen closed), onUrl(param) (the ?review= value
 * to show: a file name, '1', or null), onNav(to) (the review screen closed for 'progress' or
 * 'practice'; optional) }.
 */
export function openReview(root, opts = {}) {
  bindOnce();
  bindRoot(root);
  rv.root = root;
  rv.opts = opts;
  rv.open = true;
  rv.reveal = loadReveal();
  root.classList.remove('mt-start', 'mt-table', 'view-2d', 'view-3d', 'view-tilting');
  root.classList.add('mt-review');
  // Logs and notes may have changed since the screen was last open.
  rv.entries = null;
  rv.notes.clear();
  resetFeedback();
  for (const [file, a] of rv.analyses) if (a.status === 'done' && !a.review.ok) rv.analyses.delete(file);
  if (opts.file) showGame(opts.file, false, Number.isInteger(opts.step) ? opts.step : null);
  else showList();
}
