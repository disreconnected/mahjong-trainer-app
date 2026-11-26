// Learning loop (DOM): the shared loader, the start-screen focus card and buttons, the focus
// line during play, the end-screen focus block, the Progress and Practice screens, and the
// Disagree control and lesson chips used by the review screen.
// Logic comes from review.js, lessons.js, progress.js and quiz.js; words from learnview.js.
import { analyzeLog, REVIEW_VERSION } from './review.js';
import { labelGame, lessonById } from './lessons.js';
import { buildProgress, chooseFocus, focusReport, positives } from './progress.js';
import {
  buildQuizItems, gradeAnswer, emptyQuizState, nextItems, recordAnswer, quizStats, pruneState,
} from './quiz.js';
import { disguiseWithRetry, DISGUISE_NOTE } from './disguise.js';
import { face, back, meldHtml, hideTip } from './ui.js';
import { escapeHtml as esc, sortNewestFirst, verdictStyle, gameNumberOf } from './reviewview.js';
import { NAMES, WIND_NAMES } from './endscreen.js';
import * as V from './learnview.js';

const cfg = { root: null, getSettings: null, onNav: null };
const numbers = () => (cfg.getSettings?.()?.tileNumbers === 'arabic' ? 'arabic' : 'chinese');
const tile = (code, size, extra = '', attrs = '') => face(code, size, numbers(), extra, attrs);
const errText = (err) => String(err && err.message ? err.message : err);

async function fetchJson(url, init) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return res.json();
}

// --- the shared loader ---

const cache = new Map(); // `${REVIEW_VERSION}:${file}` -> { file, review, labels }
const cacheKey = (file) => `${REVIEW_VERSION}:${file}`;

const store = {
  status: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  error: null,
  done: 0,
  total: 0,
  files: [],
  failed: 0, // logs that could not be fetched this time
  progress: null,
  labelsByGame: [],
  focus: [],
  items: [],
  quizState: null,
  quizDirty: false, // an answer could not be saved: keep this page's state
  stats: null,
  dismissedFocus: null,
};

let running = null;
let rerun = false;

/** Loads the saved games and derives progress, focus and practice questions (incremental, cached). */
export function refreshLearning() {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    do {
      rerun = false;
      await loadAll();
    } while (rerun);
    running = null;
  })();
  return running;
}

async function analyseFile(file) {
  const log = await fetchJson(`/api/logs/${encodeURIComponent(file)}`);
  await new Promise((r) => setTimeout(r, 0)); // let the page paint between analyses
  addToCache(file, log);
}

function addToCache(file, log) {
  let review;
  try {
    review = analyzeLog(log);
  } catch (err) {
    review = { ok: false, error: errText(err) };
  }
  const labels = review.ok ? labelGame(review) : null;
  const entry = { file, review, labels };
  cache.set(cacheKey(file), entry);
  return entry;
}

async function loadAll() {
  store.status = store.progress ? 'ready' : 'loading';
  store.error = null;
  let details;
  try {
    details = await fetchJson('/api/logs?details=1');
  } catch (err) {
    store.status = 'error';
    store.error = errText(err);
    emit();
    return;
  }
  const files = sortNewestFirst(Array.isArray(details) ? details : []).map((d) => d.file).reverse();
  store.total = files.length;
  store.done = files.filter((f) => cache.has(cacheKey(f))).length;
  store.loading = store.done < store.total;
  emit();
  let failed = 0;
  for (const file of files) {
    if (cache.has(cacheKey(file))) continue;
    try {
      await analyseFile(file);
    } catch {
      failed += 1;
    }
    store.done += 1;
    emit();
  }
  if (!store.quizDirty) {
    try {
      const res = await fetch('/api/data/quiz-state', { cache: 'no-store' });
      if (res.status === 404) store.quizState = emptyQuizState();
      else if (!res.ok) throw new Error(`the server answered ${res.status}`);
      else store.quizState = pruneState(await res.json(), files);
    } catch {
      store.quizState = store.quizState ?? emptyQuizState();
    }
  }
  store.files = files;
  store.failed = failed;
  derive();
  // Drop answers for steps that are no longer quiz items (a grading change stopped flagging them).
  if (!failed && store.quizState) store.quizState = pruneState(store.quizState, files, store.items.map((it) => it.id));
  store.loading = false;
  store.status = 'ready';
  emit();
}

function derive() {
  const games = store.files.map((f) => cache.get(cacheKey(f))).filter(Boolean);
  store.progress = buildProgress(games.map((g) => ({ file: g.file, review: g.review, labels: g.labels ?? undefined })));
  store.labelsByGame = store.progress.games.map((row) => cache.get(cacheKey(row.file))?.labels ?? null);
  store.focus = store.progress.games.length ? chooseFocus(store.progress) : [];
  store.items = buildQuizItems(games.filter((g) => g.review.ok));
  store.stats = quizStats(store.items, store.quizState ?? emptyQuizState(), Date.now());
}

const ready = () => store.status === 'ready' && store.progress;
const gameCount = () => (store.progress ? store.progress.games.length : 0);
const skippedCount = () => (store.progress ? store.progress.skipped : 0) + store.failed;

// Called whenever the store changes: refresh the slots on screen and the open learning screen.
function emit() {
  updateSlots();
  if (lf.open && lf.screen === 'progress') renderProgress();
  if (lf.open && lf.screen === 'practice' && pr.waiting && ready()) startRound();
  else if (lf.open && lf.screen === 'practice' && pr.waiting) renderPractice();
}

function updateSlots() {
  const root = cfg.root;
  if (!root) return;
  for (const el of root.querySelectorAll('[data-learn-slot]')) {
    const slot = el.dataset.learnSlot;
    let html = null;
    if (slot === 'start-card') html = startCardInner();
    else if (slot === 'start-buttons') html = startButtonsInner();
    else if (slot === 'review-fixed') html = reviewFixedInner(el.dataset.file);
    else if (slot === 'end') html = endInner(el.dataset.key);
    if (html !== null && el.innerHTML !== html) el.innerHTML = html;
  }
}

// --- start screen ---

function startCardInner() {
  if (store.status === 'error' && !store.progress) {
    return (
      '<h2 class="lf-card-title">Your focus</h2>' +
      '<p class="lf-dim">Can\'t reach the Mahjong Trainer server, so your focus can\'t be shown. You can still play.</p>' +
      '<button type="button" class="tb-btn" data-learn="retry">Try again</button>'
    );
  }
  if (!ready()) return `<h2 class="lf-card-title">Your focus</h2><p class="lf-dim">${esc(V.analysingText(store.done, store.total))}</p>`;
  const card = V.focusCard(store.focus, gameCount());
  if (card.empty) return `<h2 class="lf-card-title">Your focus</h2><p class="lf-dim">${esc(card.text)}</p>`;
  const items = card.items.map((it) =>
    '<li class="lf-focus-item">' +
    `<h3 class="lf-focus-title">${esc(it.title)}</h3>` +
    `<p class="lf-focus-tip">${esc(it.tip)}</p>` +
    `<p class="lf-dim">${esc(it.why)}</p>` +
    `<button type="button" class="rv-link" data-learn="focus-lesson" data-lesson="${esc(it.lessonId)}">${esc(it.link)}</button>` +
    '</li>').join('');
  const skipped = V.skippedLine(skippedCount());
  return (
    `<h2 class="lf-card-title">${esc(card.text)}</h2><ul class="lf-focus-list">${items}</ul>` +
    (skipped ? `<p class="lf-dim lf-small">${esc(skipped)}</p>` : '')
  );
}

function practiceBtn() {
  return V.practiceButton(ready() ? store.stats : null, { loading: !ready() && store.status !== 'error', error: store.status === 'error' && !store.progress });
}

function startButtonsInner() {
  const p = practiceBtn();
  return (
    '<button type="button" class="big-btn big-btn--quiet" data-learn="go" data-to="progress" data-fid="start-progress">Progress</button>' +
    `<button type="button" class="big-btn big-btn--quiet${p.disabled ? ' is-off' : ''}" data-learn="go" data-to="practice" data-fid="start-practice"` +
    `${p.disabled ? ' aria-disabled="true"' : ''} title="${esc(p.title)}">${esc(p.label)}</button>`
  );
}

/** For renderStartScreen: { side (the focus card), buttons (Progress, Practice) }. */
export function startExtras() {
  return {
    side: `<aside class="panel lf-card" aria-label="Your focus" data-learn-slot="start-card">${startCardInner()}</aside>`,
    buttons: `<span class="lf-slot" data-learn-slot="start-buttons">${startButtonsInner()}</span>`,
  };
}

// --- the focus line during play ---

/** The focus line for the top bar, or null (no games yet, or hidden by the player). */
export function currentFocusLine() {
  if (!ready()) return null;
  const line = V.focusLine(store.focus, gameCount());
  return line && line.key !== store.dismissedFocus ? line : null;
}

/** Hides the focus line until the focus changes. */
export function dismissFocusLine() {
  const line = ready() ? V.focusLine(store.focus, gameCount()) : null;
  if (line) store.dismissedFocus = line.key;
}

// --- end screen ---

const ends = new Map(); // key -> { status: 'pending' | 'done', html }
let endSeq = 0;
const endKeys = new WeakMap(); // controller -> key

/** For the end screen: "Your focus this game", "You fixed" and "Practice your slips" once ready. */
export function endExtra(c, save) {
  if (!save || save.status === 'autoplay' || save.status === 'none') return '';
  let key = endKeys.get(c);
  if (!key) {
    key = `end-${++endSeq}`;
    endKeys.set(c, key);
  }
  if (!ends.has(key) && (save.status === 'saved' || save.status === 'failed')) {
    ends.set(key, { status: 'pending', html: '' });
    computeEnd(key, c, save.status === 'saved' ? save.file : null);
  }
  return `<div class="lf-end" data-learn-slot="end" data-key="${key}">${endInner(key)}</div>`;
}

function endInner(key) {
  return ends.get(key)?.html ?? '';
}

// Rows of progress before `file` (by the progress sort order), for focusReport and positives.
function progressBefore(file, extraEntry = null) {
  const games = store.files.filter((f) => f !== file).map((f) => cache.get(cacheKey(f))).filter(Boolean);
  const self = extraEntry ?? cache.get(cacheKey(file));
  if (self) games.push(self);
  const all = buildProgress(games.map((g) => ({ file: g.file, review: g.review, labels: g.labels ?? undefined })));
  const at = all.games.findIndex((g) => g.file === file);
  const before = at < 0 ? all.games : all.games.slice(0, at);
  const files = new Set(before.map((g) => g.file));
  const kept = games.filter((g) => files.has(g.file));
  return { count: kept.length, progress: buildProgress(kept.map((g) => ({ file: g.file, review: g.review, labels: g.labels ?? undefined }))) };
}

async function computeEnd(key, c, file) {
  let log = null;
  if (file) {
    try {
      log = await fetchJson(`/api/logs/${encodeURIComponent(file)}`);
    } catch {
      log = null;
    }
  }
  if (!log) log = c.log();
  if (running) await running.catch(() => {});
  else if (store.status === 'idle') await refreshLearning();
  await new Promise((r) => setTimeout(r, 0));
  let html = '';
  try {
    const name = file ?? '(this game)';
    const entry = file ? addToCache(file, log) : { file: name, review: analyzeLog(log), labels: null };
    if (!entry.labels && entry.review.ok) entry.labels = labelGame(entry.review);
    // Without the earlier games (server unreachable) the block would be wrong: leave it out.
    if (entry.review.ok && ready()) html = endHtml(entry, file);
  } catch (err) {
    console.error('Mahjong Trainer: end-screen focus failed', err);
    html = '';
  }
  ends.set(key, { status: 'done', html });
  updateSlots();
  if (file) refreshLearning();
}

function endHtml(entry, file) {
  const { count, progress } = progressBefore(entry.file, entry);
  const items = file ? buildQuizItems([{ file, review: entry.review }]) : [];
  const practise = items.length
    ? `<button type="button" class="big-btn big-btn--quiet lf-end-practice" data-learn="end-practice" data-file="${esc(file)}">Practice your slips (${items.length})</button>`
    : '';
  if (!count) {
    const first = chooseFocus(buildProgress([{ file: entry.file, review: entry.review, labels: entry.labels }]))[0];
    return (
      '<div class="lf-end-box">' +
      `<p class="lf-end-head">Your first focus is ready: <b>${esc(first.title)}</b></p>` +
      `<p class="lf-dim">${esc(first.tip)}</p>` +
      practise +
      '</div>'
    );
  }
  const focus = chooseFocus(progress);
  const report = focusReport(focus, entry.labels, progress);
  const fixed = V.fixedLine(positives(entry.labels, progress));
  return (
    '<div class="lf-end-box">' +
    '<p class="lf-end-head">Your focus this game</p>' +
    `<ul class="lf-end-list">${report.map((r) => `<li title="${esc(lessonById(r.lessonId)?.tip ?? '')}">${esc(V.focusReportLine(r))}</li>`).join('')}</ul>` +
    (fixed ? `<p class="lf-fixed">${esc(fixed)}</p>` : '') +
    practise +
    '</div>'
  );
}

// --- review: lesson chips, "Lessons this game", "You fixed", Disagree ---

const labelsOf = new WeakMap(); // review -> labelGame(review)
function reviewLabels(review) {
  if (!review || !review.ok) return null;
  if (!labelsOf.has(review)) labelsOf.set(review, labelGame(review));
  return labelsOf.get(review);
}

/** Chips under a step's verdict: lessons slipped (flagged steps) and followed. */
export function lessonChipsHtml(review, stepIndex) {
  const labels = reviewLabels(review);
  if (!labels || !labels.ok) return '';
  const chips = V.lessonChips(labels.steps[stepIndex]);
  const step = review.steps[stepIndex];
  const flagged = step && (step.verdict === 'mistake' || step.verdict === 'inaccuracy');
  const slips = flagged ? chips.slips.map((c) => `<span class="lf-chip lf-chip--slip" title="${esc(c.tip)}">${esc(c.title)}</span>`) : [];
  const ok = chips.followed.map((c) => `<span class="lf-chip lf-chip--ok" title="${esc(c.tip)}">Followed: ${esc(c.title)}</span>`);
  return slips.length || ok.length ? `<div class="lf-chips">${slips.join('')}${ok.join('')}</div>` : '';
}

/** The Summary tab's "Lessons this game" block and the "You fixed" line (once progress is loaded). */
export function reviewLessonsHtml(review, file) {
  const rows = V.lessonsThisGame(reviewLabels(review));
  if (!rows.length) return '';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    '<h3 class="rv-h">Lessons this game</h3><ul class="lf-game-lessons">' +
    rows.map((r) =>
      `<li title="${esc(r.tip)}"><span class="lf-gl-title">${esc(r.title)}</span>` +
      `<span class="lf-dim">${plural(r.chances, 'chance')}, ${plural(r.slips, 'slip')}, ${r.followed} followed</span></li>`).join('') +
    '</ul>' +
    `<div data-learn-slot="review-fixed" data-file="${esc(file)}">${reviewFixedInner(file)}</div>`
  );
}

function reviewFixedInner(file) {
  if (!ready()) return '';
  const entry = cache.get(cacheKey(file));
  if (!entry || !entry.labels || !entry.labels.ok) return '';
  const { count, progress } = progressBefore(file);
  if (!count) return '';
  const fixed = V.fixedLine(positives(entry.labels, progress));
  return fixed ? `<p class="lf-fixed">${esc(fixed)}</p>` : '';
}

const dis = { entries: null, loading: null, forms: new Map() };

/** Forgets the stored feedback so the next Disagree control asks the server again (once per review). */
export function resetFeedback() {
  dis.entries = null;
  dis.loading = null;
}

function loadFeedback() {
  if (!dis.loading) {
    dis.loading = fetchJson('/api/feedback')
      .then((list) => { dis.entries = Array.isArray(list) ? list : []; })
      .catch(() => { dis.entries = []; })
      .then(() => renderAllDis());
  }
  return dis.loading;
}

const formOf = (key) => {
  if (!dis.forms.has(key)) dis.forms.set(key, { open: false, expected: '', note: '', busy: false, error: null, sentId: null });
  return dis.forms.get(key);
};

/**
 * The Disagree control for one step. ctx: { file, stepIndex, verdict (the verdict shown),
 * reviewVersion }.
 */
export function disagreeHtml(ctx) {
  if (!ctx || !ctx.file || !ctx.verdict) return '';
  loadFeedback();
  return (
    `<div class="lf-dis" data-file="${esc(ctx.file)}" data-step="${ctx.stepIndex}" data-verdict="${esc(ctx.verdict)}" data-version="${ctx.reviewVersion}">` +
    disInner(ctx) +
    '</div>'
  );
}

const disCtx = (el) => ({
  file: el.dataset.file, stepIndex: Number(el.dataset.step), verdict: el.dataset.verdict, reviewVersion: Number(el.dataset.version),
});

function disInner(ctx) {
  const key = V.feedbackKey(ctx.file, ctx.stepIndex);
  const f = formOf(key);
  const err = f.error ? `<p class="lf-dis-error" role="alert">${esc(f.error)}</p>` : '';
  if (f.open) {
    const opts = [['', 'Not sure'], ...V.FEEDBACK_VERDICTS]
      .map(([v, label]) => `<option value="${v}"${f.expected === v ? ' selected' : ''}>${label}</option>`).join('');
    return (
      '<div class="lf-dis-form">' +
      `<label class="lf-dis-row"><span>What should it be?</span> <select data-dis="expected">${opts}</select></label>` +
      `<textarea data-dis="note" rows="3" maxlength="${V.NOTE_MAX}" placeholder="Tell your coach why">${esc(f.note)}</textarea>` +
      `<div class="lf-dis-row"><span class="lf-dim lf-small" data-dis-count>${f.note.length} / ${V.NOTE_MAX}</span>` +
      `<button type="button" class="tb-btn" data-dis="cancel">Cancel</button>` +
      `<button type="button" class="tb-btn lf-btn-main" data-dis="send"${f.busy ? ' disabled' : ''}>${f.busy ? 'Sending…' : 'Send'}</button></div>` +
      err +
      '</div>'
    );
  }
  if (f.sentId) {
    return `<span class="lf-dis-done">Sent to your coach</span> <button type="button" class="rv-link" data-dis="undo"${f.busy ? ' disabled' : ''}>Undo</button>${err}`;
  }
  const entry = dis.entries ? V.latestFeedback(dis.entries, ctx.file, ctx.stepIndex) : null;
  if (entry) {
    return (
      `<span class="lf-dis-done" title="${esc(V.feedbackTitle(entry))}">You disagreed</span> ` +
      `<button type="button" class="rv-link" data-dis="remove" data-id="${esc(entry.id)}"${f.busy ? ' disabled' : ''}>Remove</button>${err}`
    );
  }
  return `<button type="button" class="tb-btn lf-dis-btn" data-dis="open" title="Tell your coach this verdict looks wrong">Disagree</button>${err}`;
}

function renderDis(el, focusSel = null) {
  el.innerHTML = disInner(disCtx(el));
  if (focusSel) el.querySelector(focusSel)?.focus({ preventScroll: true });
}

function renderAllDis() {
  cfg.root?.querySelectorAll('.lf-dis').forEach((el) => {
    if (!el.contains(document.activeElement) || !formOf(V.feedbackKey(el.dataset.file, Number(el.dataset.step))).open) renderDis(el);
  });
}

async function disAction(el, action, btn) {
  const ctx = disCtx(el);
  const f = formOf(V.feedbackKey(ctx.file, ctx.stepIndex));
  if (f.busy) return;
  if (action === 'open') {
    f.open = true;
    f.error = null;
    renderDis(el, 'textarea');
  } else if (action === 'cancel') {
    f.open = false;
    f.error = null;
    renderDis(el, '[data-dis="open"]');
  } else if (action === 'send') {
    const v = V.feedbackPayload(ctx, f);
    if (!v.ok) {
      f.error = v.error;
      renderDis(el, 'textarea');
      return;
    }
    f.busy = true;
    f.error = null;
    renderDis(el);
    try {
      const entry = await fetchJson('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v.payload),
      });
      (dis.entries ??= []).push(entry);
      Object.assign(f, { open: false, busy: false, sentId: entry.id, sent: { note: f.note, expected: f.expected }, note: '', expected: '' });
      renderDisFor(ctx, '[data-dis="undo"]');
    } catch (err) {
      Object.assign(f, { busy: false, error: `Could not send it (${errText(err)}). Your note is kept; try again.` });
      renderDisFor(ctx, 'textarea');
    }
  } else if (action === 'undo' || action === 'remove') {
    const id = action === 'undo' ? f.sentId : btn.dataset.id;
    f.busy = true;
    f.error = null;
    renderDis(el);
    try {
      const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`the server answered ${res.status}`);
      dis.entries = (dis.entries ?? []).filter((e) => e.id !== id);
      if (action === 'undo' && f.sent) Object.assign(f, { note: f.sent.note, expected: f.sent.expected });
      Object.assign(f, { busy: false, sentId: null });
      renderDisFor(ctx, '[data-dis="open"]');
    } catch (err) {
      Object.assign(f, { busy: false, error: `Could not remove it (${errText(err)}).` });
      renderDisFor(ctx);
    }
  }
}

// The control may have been re-rendered while a request was out: find it again.
function renderDisFor(ctx, focusSel = null) {
  cfg.root?.querySelectorAll('.lf-dis').forEach((el) => {
    if (el.dataset.file === ctx.file && Number(el.dataset.step) === ctx.stepIndex) renderDis(el, focusSel);
  });
}

// --- learning screens (Progress, Practice) ---

const lf = { open: false, screen: null, opts: null };

function openScreen(screen, opts) {
  lf.open = true;
  lf.screen = screen;
  lf.opts = opts;
  hideTip();
  const root = cfg.root;
  root.classList.remove('mt-start', 'mt-table', 'view-2d', 'view-3d', 'view-tilting');
  root.classList.add('mt-review', 'mt-learn');
}

// Closes the open screen (no Back callback): before another screen takes the root.
function leave() {
  lf.open = false;
  lf.screen = null;
  hideTip();
  cfg.root?.classList.remove('mt-review', 'mt-learn');
  lf.opts?.onUrl?.(null);
}

function goBack() {
  const opts = lf.opts;
  leave();
  opts?.onBack?.();
}

// To another screen; Back from a review opened here returns to this screen.
function navFrom(nav) {
  const opts = lf.opts;
  const screen = lf.screen;
  leave();
  if (nav.to === 'review' && nav.file) {
    const again = () => cfg.onNav({ to: screen, resume: true, file: screen === 'practice' ? pr.file : null, back: opts.onBack });
    cfg.onNav({ ...nav, back: again });
  } else cfg.onNav({ ...nav, back: opts.onBack });
}

function headerHtml(screen, title, sub) {
  return (
    '<header class="rv-bar lf-bar">' +
    '<button type="button" class="tb-btn rv-back" data-learn="back">← Back</button>' +
    `<h1 class="rv-title">${esc(title)}</h1>` +
    `<span class="rv-bar-sub">${sub}</span>` +
    V.screenNavHtml(screen, 'learn') +
    '</header>'
  );
}

function messageHtml(inner, isError = false) {
  return `<main class="rv-list-main"><div class="rv-empty${isError ? ' is-error' : ''}"${isError ? ' role="alert"' : ''}>${inner}</div></main>`;
}

const serverDown = () =>
  '<p>Can\'t reach the Mahjong Trainer server, so your games can\'t be loaded.</p>' +
  `<p class="rv-dim">Make sure the server is running (start.bat), then try again. (${esc(store.error ?? '')})</p>` +
  '<button type="button" class="big-btn" data-learn="retry">Try again</button>';

// --- Progress ---

const pg = { lesson: null, side: 'games' };

/** Opens the Progress screen. opts: { lesson, resume, onBack(), onUrl(param) }. */
export function openProgress(opts = {}) {
  openScreen('progress', opts);
  if (!opts.resume) {
    pg.lesson = opts.lesson ?? null;
    pg.side = pg.lesson ? 'lesson' : 'games';
  }
  setProgressUrl();
  renderProgress();
  refreshLearning();
}

function setProgressUrl() {
  lf.opts?.onUrl?.(pg.lesson ?? '1');
}

function renderProgress() {
  if (!lf.open || lf.screen !== 'progress') return;
  const root = cfg.root;
  const focusSel = focusSelector(document.activeElement);
  const scrollTop = root.querySelector('.lf-table-wrap')?.scrollTop ?? 0;
  const loadingSub = store.loading || store.status === 'loading' ? esc(V.analysingText(store.done, store.total)) : '';
  let body;
  if (store.status === 'error' && !store.progress) body = messageHtml(serverDown(), true);
  else if (!ready()) body = messageHtml(`<p>${esc(V.analysingText(store.done, store.total))}</p>`);
  else if (!gameCount()) {
    const skipped = V.skippedLine(skippedCount());
    body = messageHtml(`<p>No games yet. Play a game and your progress will appear here.</p>${skipped ? `<p class="rv-dim">${esc(skipped)}</p>` : ''}`);
  } else body = progressMainHtml();
  const sub = loadingSub || (ready() ? `${gameCount()} game${gameCount() === 1 ? '' : 's'} analysed` : '');
  root.innerHTML = `<div class="rv-screen rv-list lf-screen lf-progress">${headerHtml('progress', 'Progress', sub)}${body}</div>`;
  const wrap = root.querySelector('.lf-table-wrap');
  if (wrap) wrap.scrollTop = scrollTop;
  drawCharts();
  if (focusSel) root.querySelector(focusSel)?.focus({ preventScroll: true });
}

function focusSelector(el) {
  if (!el || !cfg.root || !cfg.root.contains(el) || !el.dataset) return null;
  const d = el.dataset;
  if (d.learn === 'lesson') return `[data-learn="lesson"][data-lesson="${d.lesson}"]`;
  if (d.learn === 'side') return `[data-learn="side"][data-side="${d.side}"]`;
  if (d.learn === 'nav') return `[data-learn="nav"][data-to="${d.to}"]`;
  if (d.learn) return `[data-learn="${d.learn}"]`;
  return null;
}

function progressMainHtml() {
  const p = store.progress;
  const stats = V.headerStats(p).map((s) =>
    `<div class="lf-stat"><span class="lf-stat-label">${esc(s.label)}</span><span class="lf-stat-value">${esc(s.value)}</span>` +
    `${s.sub ? `<span class="lf-stat-sub">${esc(s.sub)}</span>` : ''}</div>`).join('');
  const skipped = V.skippedLine(skippedCount());
  const note = V.trendNote(gameCount());
  const charts = V.CHARTS.map((c) =>
    '<figure class="lf-fig">' +
    `<figcaption><span class="lf-fig-title">${esc(c.title)}</span><span class="lf-fig-good">${esc(c.good)}</span></figcaption>` +
    `<div class="lf-chart" data-chart="${c.id}"></div>` +
    '</figure>').join('');
  return (
    '<main class="lf-progress-main">' +
    '<div class="lf-col">' +
    `<section class="lf-stats" aria-label="Your numbers">${stats}</section>` +
    (skipped ? `<p class="lf-dim lf-small lf-skipped">${esc(skipped)}</p>` : '') +
    '<section class="lf-charts-box" aria-label="Trends">' +
    `<div class="lf-charts">${charts}</div>` +
    `<p class="lf-dim lf-small lf-legend">${note ? esc(note) : 'Each dot is one game; the line is the average of your last 5 games.'}</p>` +
    '</section>' +
    lessonsTableHtml() +
    '</div>' +
    sidePanelHtml() +
    '</main>'
  );
}

const TREND_WORDS = { new: 'New', 'not enough games': 'Too early to tell', improving: 'Improving', worse: 'Slipping more', steady: 'Steady' };

function lessonsTableHtml() {
  const rows = V.lessonRows(store.progress, store.labelsByGame, store.focus);
  const body = rows.length
    ? rows.map((r) =>
      `<tr class="lf-lesson-row${pg.lesson === r.id ? ' is-on' : ''}" data-learn="lesson" data-lesson="${r.id}" tabindex="0">` +
      `<th scope="row">${esc(r.title)}${r.focus ? ' <span class="lf-badge-focus">Focus</span>' : ''}</th>` +
      `<td class="lf-num">${r.chances}</td><td class="lf-num">${r.slips}</td>` +
      `<td><span class="lf-dots">${r.dots.map((d) => `<span class="lf-dot lf-dot--${d.state}" title="${esc(d.title)}"></span>`).join('')}</span></td>` +
      `<td>${esc(TREND_WORDS[r.trend] ?? r.trend)}</td>` +
      '</tr>').join('')
    : '<tr><td colspan="5" class="lf-dim">No lesson came up in your games yet.</td></tr>';
  return (
    '<section class="lf-lessons" aria-label="Lessons">' +
    '<h2 class="lf-h">Lessons</h2>' +
    '<div class="lf-table-wrap"><table class="lf-table">' +
    '<thead><tr><th scope="col">Lesson</th><th scope="col" class="lf-num">Chances</th><th scope="col" class="lf-num">Slips</th>' +
    '<th scope="col" title="Red: slipped. Green: followed. Grey: no slip. Hollow: did not come up.">Last 5 games</th><th scope="col">Trend</th></tr></thead>' +
    `<tbody>${body}</tbody></table></div>` +
    '</section>'
  );
}

function sidePanelHtml() {
  const tab = (id, label) =>
    `<button type="button" class="rv-tab${pg.side === id ? ' is-on' : ''}" role="tab" aria-selected="${pg.side === id}" data-learn="side" data-side="${id}">${label}</button>`;
  const inner = pg.side === 'lesson' ? lessonPanelHtml() : gamesListHtml();
  return (
    '<aside class="rv-panel lf-side" aria-label="Details">' +
    `<nav class="rv-tabs lf-side-tabs" role="tablist">${tab('lesson', 'Lesson')}${tab('games', 'Games')}</nav>` +
    inner +
    '</aside>'
  );
}

function lessonPanelHtml() {
  const l = pg.lesson ? lessonById(pg.lesson) : null;
  if (!l) return '<p class="lf-dim">Pick a lesson in the table to see what it means and your example slips.</p>';
  const s = store.progress.lessons[l.id];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const examples = s.examples.length
    ? '<ul class="lf-examples">' + s.examples.map((e) =>
      `<li><button type="button" class="rv-link" data-learn="example" data-file="${esc(e.file)}" data-step="${e.stepIndex}">${esc(V.stepLinkText(e.file, e.stepIndex))}</button></li>`).join('') + '</ul>'
    : '<p class="lf-dim">No example slips: you have not slipped on this one.</p>';
  return (
    '<article class="lf-lesson">' +
    `<h2 class="rv-step-title">${esc(l.title)}</h2>` +
    `<p class="lf-tip">${esc(l.tip)}</p>` +
    `<p>${esc(l.explain)}</p>` +
    `<p class="lf-dim">${plural(s.chances, 'chance')}, ${plural(s.slips, 'slip')}, ${s.followed} followed. ${esc(TREND_WORDS[s.trend] ?? s.trend)}.</p>` +
    '<h3 class="rv-h">Example slips</h3>' +
    examples +
    '</article>'
  );
}

function gamesListHtml() {
  const reviews = {};
  for (const g of store.progress.games) reviews[g.file] = cache.get(cacheKey(g.file))?.review;
  const rows = V.gameRows(store.progress, reviews);
  return (
    '<ul class="lf-games">' +
    rows.map((r) =>
      `<li><button type="button" class="lf-game" data-learn="open-game" data-file="${esc(r.file)}">` +
      `<span class="lf-game-title">${esc(r.title)}</span><span class="lf-dim">${esc(r.when)}</span>` +
      `<span>${esc(r.result)}</span><span class="lf-dim">${esc(r.score)} · ${esc(r.mistakes)}</span></button></li>`).join('') +
    '</ul>'
  );
}

const CHART_PAD = { top: 8, right: 12, bottom: 18, left: 36 };

function drawCharts() {
  if (!lf.open || lf.screen !== 'progress' || !ready()) return;
  const series = V.progressSeries(store.progress);
  const labels = store.progress.games.map((g, i) => gameNumberOf(g.file) ?? i + 1);
  for (const box of cfg.root.querySelectorAll('.lf-chart[data-chart]')) {
    const id = box.dataset.chart;
    const s = series[id];
    const w = Math.max(160, Math.floor(box.clientWidth));
    const h = Math.max(80, Math.floor(box.clientHeight));
    const scale = V.chartScale(id, s.values);
    const g = V.trendChart({ values: s.values, rolling: s.rolling, width: w, height: h, pad: CHART_PAD, scale, labels });
    if (g.empty) {
      box.innerHTML = `<p class="lf-chart-empty">${esc(V.CHARTS.find((c) => c.id === id).empty)}</p>`;
      continue;
    }
    const grid = g.ticks.map((t) =>
      `<line class="lf-grid" x1="${CHART_PAD.left}" x2="${w - CHART_PAD.right}" y1="${t.y}" y2="${t.y}"/>` +
      `<text class="lf-axis" x="${CHART_PAD.left - 5}" y="${t.y + 3.5}" text-anchor="end">${esc(t.label)}</text>`).join('');
    const xs = g.xLabels.map((l) => `<text class="lf-axis" x="${l.x}" y="${h - 4}" text-anchor="middle">${esc(l.label)}</text>`).join('');
    const line = g.rollingPath ? `<path class="lf-roll" d="${g.rollingPath}"/>` : '';
    const dots = g.points.map((p) =>
      `<circle class="lf-pt" cx="${p.x}" cy="${p.y}" r="${g.r}"><title>Game ${esc(labels[p.i])}: ${esc(scale.point(p.v))}</title></circle>`).join('');
    const one = g.count === 1 ? `<text class="lf-axis lf-axis-note" x="${(w + CHART_PAD.left) / 2}" y="${CHART_PAD.top + 10}" text-anchor="middle">More games will show a trend.</text>` : '';
    box.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(V.CHARTS.find((c) => c.id === id).title)}">${grid}${xs}${line}${dots}${one}</svg>`;
  }
}

// --- Practice ---

const pr = {
  file: null, // only this game's questions (end screen), else all
  pool: [],
  items: [], // the round's questions; each is replaced by its disguised version when it is prepared (a repeat)
  round: 0, // counts rounds, so a late preparation for an earlier one is dropped
  prep: {}, // index -> the promise preparing that question
  ready: new Set(), // indexes of the questions ready to show
  index: 0,
  answers: [], // [{ id, correct }]
  answer: null, // { choice, grade } for the current question
  selected: null, // hand index picked (discard questions)
  saveError: false,
  waiting: false, // waiting for the loader
  summary: false,
};

/** Opens the Practice screen. opts: { file, resume, onBack(), onUrl(param) }. */
export function openPractice(opts = {}) {
  openScreen('practice', opts);
  lf.opts.onUrl?.(opts.file ?? '1');
  if (opts.resume && pr.items.length) {
    renderPractice();
    return;
  }
  Object.assign(pr, { file: opts.file ?? null, pool: [], items: [], round: pr.round + 1, prep: {}, ready: new Set(), index: 0, answers: [], answer: null, selected: null, saveError: false, summary: false });
  pr.waiting = true;
  renderPractice();
  refreshLearning();
}

function practicePool() {
  if (!pr.file) return store.items;
  const entry = cache.get(cacheKey(pr.file));
  return entry && entry.review.ok ? buildQuizItems([{ file: pr.file, review: entry.review }]) : [];
}

function startRound() {
  pr.waiting = false;
  pr.pool = practicePool();
  pr.items = nextItems(pr.pool, store.quizState ?? emptyQuizState(), Date.now(), 10);
  Object.assign(pr, { round: pr.round + 1, prep: {}, ready: new Set(), index: 0, answers: [], answer: null, selected: null, summary: false });
  showQuestion();
}

// --- disguised repeats (disguise.js) ---
// A question seen before is asked as the same position with every tile relabelled, so the player has to
// solve it again instead of remembering the hand. Its game is analysed again under the disguise (the real
// grading, tens of ms on a PC; a few more disguises are tried if the first does not pose the same
// decision) only when the question is about to be shown: the next one is prepared while the current one
// is answered. The first showing is as played, and the schedule stays keyed to the original item (the
// disguised item keeps its id).

const LOGS_KEPT = 8;
const logsByFile = new Map(); // file -> its log, fetched for a disguise (the least recently used are dropped)
const shownItems = new Map(); // `${item.id}:${seen}` -> the item as shown: disguised, or as played if no disguise fits

async function logOf(file) {
  let log = logsByFile.get(file);
  if (log) logsByFile.delete(file);
  else log = await fetchJson(`/api/logs/${encodeURIComponent(file)}`);
  logsByFile.set(file, log);
  if (logsByFile.size > LOGS_KEPT) logsByFile.delete(logsByFile.keys().next().value);
  return log;
}

async function disguisedItem(item, seen) {
  const key = `${item.id}:${seen}`;
  if (shownItems.has(key)) return shownItems.get(key);
  const log = await logOf(item.file);
  await new Promise((r) => setTimeout(r, 0)); // let the page paint first
  const shown = disguiseWithRetry(item, log, seen).item ?? item; // no disguise fits: as played
  shownItems.set(key, shown);
  return shown;
}

// Makes question i ready to show. Returns null when it is ready now, else the promise preparing it.
function prepare(i) {
  const item = pr.items[i];
  if (!item || pr.ready.has(i)) return null;
  const seen = store.quizState?.items?.[item.id]?.seen ?? 0;
  if (!seen) {
    pr.ready.add(i);
    return null;
  }
  const round = pr.round;
  pr.prep[i] ??= disguisedItem(item, seen).catch(() => item).then((shown) => {
    if (pr.round !== round) return;
    pr.items[i] = shown;
    pr.ready.add(i);
  });
  return pr.prep[i];
}

const currentItem = () => (pr.ready.has(pr.index) ? pr.items[pr.index] : null);

// Shows the question at pr.index once it is ready, and prepares the one after it.
function showQuestion() {
  const round = pr.round;
  const i = pr.index;
  const wait = prepare(i);
  renderPractice();
  const after = () => { if (pr.round === round) prepare(i + 1); };
  if (!wait) {
    after();
    return;
  }
  wait.then(() => {
    if (pr.round === round && pr.index === i) renderPractice();
    after();
  });
}

function renderPractice() {
  if (!lf.open || lf.screen !== 'practice') return;
  const root = cfg.root;
  hideTip();
  const focusSel = focusSelector(document.activeElement);
  let body;
  let sub = '';
  if (store.status === 'error' && !store.progress) body = messageHtml(serverDown(), true);
  else if (pr.waiting || !ready()) body = messageHtml(`<p>${esc(V.analysingText(store.done, store.total))}</p>`);
  else if (!pr.pool.length) body = messageHtml('<p>Nothing to practise yet: play and review a game first.</p>');
  else if (!pr.items.length) {
    const next = V.nextCheckAt(pr.pool, store.quizState);
    body = messageHtml(`<p>All caught up.</p><p class="rv-dim">${esc(V.caughtUpText(next))}</p>`);
  } else if (pr.summary) body = summaryHtml();
  else {
    const q = V.questionProgress(pr.index, pr.items.length);
    sub = `${esc(q.text)}<span class="lf-bar-track" aria-hidden="true"><span class="lf-bar-fill" style="width:${Math.round(q.fill * 100)}%"></span></span>`;
    body = pr.ready.has(pr.index) ? questionHtml(pr.items[pr.index]) : messageHtml('<p>Getting the question ready…</p>');
  }
  const notice = pr.saveError ? '<p class="lf-notice" role="alert">Progress not saved: the server could not be reached. Your answers count on this page only.</p>' : '';
  root.innerHTML = `<div class="rv-screen rv-list lf-screen lf-practice">${headerHtml('practice', pr.file ? `Practice: ${V.gameTitle(pr.file)}` : 'Practice', sub)}${notice}${body}</div>`;
  if (notice) root.querySelector('.lf-practice').classList.add('has-notice');
  const target = (focusSel && root.querySelector(focusSel)) || root.querySelector('[data-learn="q-next"], [data-learn="q-again"]');
  target?.focus({ preventScroll: true });
}

// The table of a question: opponents face down, your hand, pools with the offered tile marked.
const POSITIONS = ['bottom', 'right', 'top', 'left'];
const WIND_LETTERS = ['E', 'S', 'W', 'N'];

function qSeatHead(t, p, item) {
  const wind = WIND_LETTERS[(p - t.dealer + 4) % 4];
  return (
    '<div class="rv-seat-head">' +
    `<span class="seat-name">${NAMES[p]}</span><span class="seat-wind">${WIND_NAMES[wind]}</span>` +
    (p === t.dealer ? '<span class="dealer-badge">Dealer</span>' : '') +
    (item.kind !== 'discard' && item.table.offer && item.table.offer.from === p ? '<span class="rv-seat-flag">Discarded</span>' : '') +
    '</div>'
  );
}

function qMelds(pl, p, size) {
  const melds = pl.melds.map((m, i) => meldHtml(m, size, numbers(), p !== 0, i)).join('');
  const flowers = pl.flowers.map((f) => tile(f, 'small')).join('');
  return (melds ? `<div class="rv-melds">${melds}</div>` : '') + (flowers ? `<div class="rv-flowers">${flowers}</div>` : '');
}

function qOpponent(item, p) {
  const t = item.table;
  const pl = t.players[p];
  const hand = `<div class="rv-opp-hand" aria-label="${pl.concealedCount} hidden tiles">${Array.from({ length: pl.concealedCount }, () => back('small')).join('')}</div>`;
  return (
    `<section class="rv-seat rv-seat--${POSITIONS[p]}${t.turnPlayer === p ? ' is-turn' : ''}" aria-label="${NAMES[p]}">` +
    qSeatHead(t, p, item) +
    `<div class="rv-seat-body">${hand}${qMelds(pl, p, 'small')}</div></section>`
  );
}

function qMarks(item) {
  const marks = {};
  if (!pr.answer || item.kind !== 'discard') return marks;
  const hand = item.table.hand;
  for (const code of item.answers) {
    const i = hand.indexOf(code);
    if (i >= 0) marks[i] = { cls: 'rv-mark-best', label: code === pr.answer.choice ? 'your choice · best' : 'best' };
  }
  if (!pr.answer.grade.correct) {
    const i = pr.selected ?? hand.indexOf(pr.answer.choice);
    if (i >= 0 && !(i in marks)) marks[i] = { cls: 'rv-mark-threw', label: 'your choice' };
  }
  return marks;
}

function qHuman(item) {
  const t = item.table;
  const hand = t.hand;
  const pickable = item.kind === 'discard' && !pr.answer;
  const marks = qMarks(item);
  const drawnApart = item.kind !== 'claim' && t.drew && hand.at(-1) === t.drew;
  const tiles = hand.map((c, i) => {
    const cls = ['rv-hand-tile'];
    const m = marks[i];
    if (m) cls.push('rv-mark', m.cls);
    if (pickable) cls.push('lf-pick');
    if (pickable && pr.selected === i) cls.push('is-selected');
    return tile(c, 'hand', cls.join(' '), `${m ? ` data-mark="${esc(m.label)}"` : ''}${pickable ? ` data-qi="${i}"` : ''}`);
  });
  const row = drawnApart ? tiles.slice(0, -1) : tiles;
  const drawn = drawnApart ? `<div class="rv-drawn" title="Just drawn">${tiles.at(-1)}</div>` : '';
  return (
    '<section class="rv-seat rv-seat--bottom" aria-label="You">' +
    qSeatHead(t, 0, item) +
    `<div class="rv-seat-body"><div class="rv-hand">${row.join('')}</div>${drawn}${qMelds(t.players[0], 0, 'discard')}</div></section>`
  );
}

function qPool(item, p) {
  const t = item.table;
  const ds = t.players[p].discards;
  const ld = t.lastDiscard;
  const offer = t.offer;
  return (
    `<div class="rv-pool rv-pool--${POSITIONS[p]}" aria-label="${NAMES[p]} discards">` +
    ds.map((c, i) => {
      const latest = ld && ld.player === p && i === ds.length - 1 && ld.tile === c;
      const offered = latest && offer && !offer.robKong && offer.tile === c;
      return tile(c, 'discard', [latest ? 'is-last' : '', offered ? 'rv-mark rv-mark-claim' : ''].filter(Boolean).join(' '), offered ? ' data-mark="offered"' : '');
    }).join('') +
    '</div>'
  );
}

function qCompass(t) {
  const winds = [0, 1, 2, 3].map((p) =>
    `<span class="compass-wind compass-wind--${POSITIONS[p]}${t.turnPlayer === p ? ' is-active' : ''}">${WIND_LETTERS[(p - t.dealer + 4) % 4]}</span>`).join('');
  return `<div class="rv-center"><div class="compass">${winds}<div class="wall-count"><span class="wall-num">${t.wallCount}</span><span class="wall-label">tiles left</span></div></div></div>`;
}

function qTableHtml(item) {
  return (
    '<section class="rv-table" aria-label="The table">' +
    qOpponent(item, 2) + qOpponent(item, 3) +
    `<div class="rv-pools">${[2, 3, 1, 0].map((p) => qPool(item, p)).join('')}${qCompass(item.table)}</div>` +
    qOpponent(item, 1) + qHuman(item) +
    '</section>'
  );
}

function badge(verdict) {
  const v = verdictStyle(verdict);
  return `<span class="rv-badge rv-badge--big ${v.cls}">${esc(v.label)}</span>`;
}

function questionHtml(item) {
  const chips = item.lessonIds.map((id) => lessonById(id)).filter(Boolean);
  let controls;
  if (!pr.answer) {
    if (item.kind === 'discard') {
      const sel = pr.selected !== null ? item.table.hand[pr.selected] : null;
      const label = sel ? item.choices.find((c) => c.id === sel)?.label : null;
      controls =
        '<p class="lf-dim">Click a tile in your hand to pick it, then click it again or press Enter to throw it. Arrow keys move the pick.</p>' +
        (label ? `<button type="button" class="big-btn lf-throw" data-learn="q-throw">${esc(label)}</button>` : '');
    } else {
      controls = `<div class="lf-choices">${item.choices.map((c) =>
        `<button type="button" class="big-btn big-btn--quiet lf-choice" data-learn="q-choice" data-choice="${esc(c.id)}">${esc(c.label)}</button>`).join('')}</div>`;
    }
  } else {
    const g = pr.answer.grade;
    const words = V.answerWords(item, g);
    const yours = item.choices.find((c) => c.id === pr.answer.choice)?.label ?? pr.answer.choice;
    const choiceRow = item.kind === 'discard' ? '' : `<div class="lf-choices">${item.choices.map((c) => {
      const cls = ['big-btn', 'big-btn--quiet', 'lf-choice'];
      if (item.answers.includes(c.id)) cls.push('is-right');
      if (c.id === pr.answer.choice && !g.correct) cls.push('is-yours');
      return `<button type="button" class="${cls.join(' ')}" disabled>${esc(c.label)}</button>`;
    }).join('')}</div>`;
    const last = pr.index === pr.items.length - 1;
    controls =
      choiceRow +
      `<div class="rv-verdict lf-answer">${badge(g.verdict)} <span class="lf-dim">Your answer: ${esc(yours)}</span>` +
      `<p class="lf-lead">${esc(words.lead)}</p>${words.right ? `<p class="lf-right">${esc(words.right)}</p>` : ''}</div>` +
      chips.map((l) => `<p class="lf-q-lesson"><span class="lf-chip lf-chip--slip">${esc(l.title)}</span> ${esc(l.tip)}</p>`).join('') +
      `<p><button type="button" class="rv-link" data-learn="q-review">See this moment in the review</button></p>` +
      disagreeHtml({ file: item.file, stepIndex: item.stepIndex, verdict: item.original.verdict, reviewVersion: item.reviewVersion }) +
      `<div class="lf-q-foot"><button type="button" class="big-btn" data-learn="q-next">${last ? 'See results' : 'Next'} <kbd>Enter</kbd></button></div>`;
  }
  return (
    '<div class="rv-main lf-q-main">' +
    qTableHtml(item) +
    '<aside class="rv-panel lf-q-panel" aria-label="Question">' +
    `<div class="rv-step-kicker">From ${item.disguised && !pr.answer ? 'a past game' : esc(V.stepLinkText(item.file, item.stepIndex))}</div>` +
    `<h2 class="rv-step-title">${esc(item.prompt)}</h2>` +
    (item.disguised ? `<p class="lf-dim lf-small lf-disguise">${esc(DISGUISE_NOTE)}</p>` : '') +
    controls +
    '</aside></div>'
  );
}

function summaryHtml() {
  const now = Date.now();
  const stats = quizStats(pr.pool, store.quizState, now);
  const s = V.quizSummary({ answers: pr.answers, items: pr.items, stats, nextCheck: V.nextCheckAt(pr.pool, store.quizState) });
  return (
    '<main class="rv-list-main"><div class="rv-empty lf-summary">' +
    `<h2 class="lf-summary-head">${esc(s.headline)}</h2>` +
    (s.lessons.length ? `<p class="lf-dim">Lessons practised:</p><ul class="lf-summary-lessons">${s.lessons.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '') +
    `<p>${esc(s.learned)}</p><p class="lf-dim">${esc(s.rest)}</p>` +
    '<div class="panel-foot">' +
    (stats.due > 0 ? '<button type="button" class="big-btn" data-learn="q-again">Practice again</button>' : '') +
    `<button type="button" class="big-btn${stats.due > 0 ? ' big-btn--quiet' : ''}" data-learn="back">Back</button>` +
    '</div></div></main>'
  );
}

let saveChain = Promise.resolve();

function answer(choice) {
  const item = currentItem();
  if (!item || pr.answer) return;
  const grade = gradeAnswer(item, choice);
  if (grade.verdict === null) return;
  pr.answer = { choice, grade };
  pr.answers.push({ id: item.id, correct: grade.correct });
  store.quizState = recordAnswer(store.quizState ?? emptyQuizState(), item.id, grade.correct, Date.now());
  store.stats = quizStats(store.items, store.quizState, Date.now());
  const state = store.quizState;
  saveChain = saveChain.then(async () => {
    try {
      const res = await fetch('/api/data/quiz-state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      if (pr.saveError) {
        pr.saveError = false;
        store.quizDirty = false;
        renderPractice();
      }
    } catch {
      pr.saveError = true;
      store.quizDirty = true;
      renderPractice();
    }
  });
  renderPractice();
}

function nextQuestion() {
  if (!pr.answer) return;
  pr.answer = null;
  pr.selected = null;
  if (pr.index < pr.items.length - 1) pr.index += 1;
  else pr.summary = true;
  if (pr.summary) renderPractice();
  else showQuestion();
}

function pickTile(i) {
  const item = currentItem();
  if (!item || pr.answer || item.kind !== 'discard') return;
  if (pr.selected === i) answer(item.table.hand[i]);
  else {
    pr.selected = i;
    renderPractice();
  }
}

// --- events ---

function onClick(ev) {
  const t = ev.target;
  const d = t.closest && t.closest('[data-dis]');
  if (d && d.tagName === 'BUTTON' && !d.disabled) {
    const el = d.closest('.lf-dis');
    if (el) disAction(el, d.dataset.dis, d);
    return;
  }
  const q = t.closest && t.closest('[data-qi]');
  if (q && lf.open && lf.screen === 'practice') {
    pickTile(Number(q.dataset.qi));
    return;
  }
  const el = t.closest && t.closest('[data-learn]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const a = el.dataset.learn;
  if (a === 'retry') {
    if (store.status === 'error') { store.status = 'idle'; updateSlots(); }
    refreshLearning();
    return;
  }
  if (a === 'go') {
    cfg.onNav?.({ to: el.dataset.to, from: 'start' });
    return;
  }
  if (a === 'focus-lesson') {
    cfg.onNav?.({ to: 'progress', lesson: el.dataset.lesson, from: 'start' });
    return;
  }
  if (a === 'end-practice') {
    cfg.onNav?.({ to: 'practice', file: el.dataset.file, from: 'table' });
    return;
  }
  if (!lf.open) return;
  switch (a) {
    case 'back': goBack(); break;
    case 'nav':
      if (el.dataset.to !== lf.screen) navFrom({ to: el.dataset.to });
      break;
    case 'lesson':
      pg.lesson = el.dataset.lesson;
      pg.side = 'lesson';
      setProgressUrl();
      renderProgress();
      break;
    case 'side':
      pg.side = el.dataset.side;
      renderProgress();
      break;
    case 'example':
      navFrom({ to: 'review', file: el.dataset.file, step: Number(el.dataset.step) });
      break;
    case 'open-game':
      navFrom({ to: 'review', file: el.dataset.file });
      break;
    case 'q-choice': answer(el.dataset.choice); break;
    case 'q-throw':
      if (pr.selected !== null) answer(currentItem()?.table.hand[pr.selected]);
      break;
    case 'q-next': nextQuestion(); break;
    case 'q-again': startRound(); break;
    case 'q-review': {
      const item = pr.items[pr.index];
      navFrom({ to: 'review', file: item.file, step: item.stepIndex });
      break;
    }
    default: break;
  }
}

function onDblClick(ev) {
  const q = ev.target.closest && ev.target.closest('[data-qi]');
  if (!q || !lf.open || lf.screen !== 'practice' || pr.answer) return;
  const item = currentItem();
  if (item && item.kind === 'discard') answer(item.table.hand[Number(q.dataset.qi)]);
}

function onInput(ev) {
  const t = ev.target;
  if (!t.dataset || !t.dataset.dis) return;
  const el = t.closest('.lf-dis');
  if (!el) return;
  const f = formOf(V.feedbackKey(el.dataset.file, Number(el.dataset.step)));
  if (t.dataset.dis === 'note') {
    f.note = t.value;
    const count = el.querySelector('[data-dis-count]');
    if (count) count.textContent = `${t.value.length} / ${V.NOTE_MAX}`;
  } else if (t.dataset.dis === 'expected') f.expected = t.value;
}

function onKey(ev) {
  if (!lf.open || !cfg.root || !cfg.root.isConnected) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  const typing = t && (t.isContentEditable || ['TEXTAREA', 'SELECT', 'INPUT'].includes(t.tagName));
  if (typing) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    goBack();
    return;
  }
  if (ev.key === 'Enter' && lf.screen === 'progress' && t && t.dataset && t.dataset.learn === 'lesson') {
    ev.preventDefault();
    t.click();
    return;
  }
  if (lf.screen !== 'practice' || pr.summary || !pr.items.length) return;
  const item = currentItem();
  if (!item) return;
  if (pr.answer) {
    if (ev.key === 'Enter' && !(t && t.tagName === 'BUTTON')) {
      ev.preventDefault();
      nextQuestion();
    }
    return;
  }
  if (item.kind !== 'discard') return;
  const n = item.table.hand.length;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    const d = ev.key === 'ArrowLeft' ? -1 : 1;
    pr.selected = pr.selected === null ? (d > 0 ? 0 : n - 1) : (pr.selected + d + n) % n;
    renderPractice();
  } else if (ev.key === 'Enter' && pr.selected !== null && !(t && t.tagName === 'BUTTON')) {
    ev.preventDefault();
    answer(item.table.hand[pr.selected]);
  }
}

/**
 * Binds the learning loop to the app root. opts: { root, getSettings(), onNav(nav) } where nav =
 * { to: 'review'|'progress'|'practice', from: 'start'|'table' (sets where Back leads), back (a
 * Back function to use instead), file, step, lesson, resume }.
 */
export function configureLearn({ root, getSettings, onNav }) {
  Object.assign(cfg, { root, getSettings, onNav });
  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDblClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => drawCharts());
}

/** Closes a learning screen without its Back callback (another screen is taking the root). */
export function closeLearn() {
  if (lf.open) leave();
}
