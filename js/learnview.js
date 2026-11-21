// Learning-loop view-model helpers (start-screen focus card, focus line, Progress and Practice
// screens, end-screen block, the Disagree form): pure functions, no DOM; imports under Node.
// Used by learnui.js; tested in test/learnview.test.js. The words come from lessons.js,
// progress.js and quiz.js wherever those modules provide them.
import { lessonById, LESSON_IDS } from './lessons.js';
import { gameNumberOf, listRowText, resultWords } from './reviewview.js';
import { LEARNED_STREAK, CHECK_AFTER_MS } from './quiz.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isAre = (n) => (n === 1 ? 'is' : 'are');

// --- loading ---

/** "Analysing your games… 3 of 12" (or "Loading your games…" before the list is known). */
export function analysingText(done, total) {
  return total > 0 ? `Analysing your games… ${done} of ${total}` : 'Loading your games…';
}

/** "Game 7" from a log file name (or the file name itself). */
export function gameTitle(file) {
  const n = gameNumberOf(file);
  return n === null ? String(file) : `Game ${n}`;
}

/** "Game 1, step 5" for a review step (stepIndex is 0-based). */
export const stepLinkText = (file, stepIndex) => `${gameTitle(file)}, step ${stepIndex + 1}`;

// --- start screen ---

export const NO_GAMES_FOCUS = 'Play a game and your first focus will appear here.';

/**
 * Focus card content from chooseFocus(progress): { empty, text, items }. With no games yet the
 * card is the one-liner; otherwise up to 2 items { lessonId, kind, title, tip, why, link }.
 * link: 'see examples' when the lesson has example slips, else 'about this lesson'.
 */
export function focusCard(focus, gameCount) {
  if (!gameCount || !focus || !focus.length) return { empty: true, text: NO_GAMES_FOCUS, items: [] };
  return {
    empty: false,
    text: 'Focus for this game',
    items: focus.slice(0, 2).map((f) => ({
      lessonId: f.lessonId,
      kind: f.kind,
      title: f.title,
      tip: f.tip,
      why: f.why,
      link: f.examples && f.examples.length ? 'see examples' : 'about this lesson',
    })),
  };
}

/**
 * The slim line shown during play: { key, text: 'Focus: Keep one pair', tip } or null (no games
 * yet). Two items: 'Focus: Keep one pair · Take claims that bring you closer'.
 */
export function focusLine(focus, gameCount) {
  if (!gameCount || !focus || !focus.length) return null;
  const items = focus.slice(0, 2);
  const title = (f) => lessonById(f.lessonId)?.title ?? f.title;
  return {
    key: items.map((f) => f.lessonId).join('+'),
    text: `Focus: ${items.map(title).join(' · ')}`,
    tip: items.map((f) => `${title(f)}: ${lessonById(f.lessonId)?.tip ?? f.tip}`).join('\n'),
  };
}

/**
 * The Practice button: { label: 'Practice (5)', disabled, title }. stats = { total, due } (quizStats),
 * or null while loading; error: the data could not be loaded.
 */
export function practiceButton(stats, { loading = false, error = false } = {}) {
  if (error) return { label: 'Practice', disabled: true, title: "Can't reach the Mahjong Trainer server" };
  if (loading || !stats) return { label: 'Practice', disabled: true, title: 'Analysing your games…' };
  if (!stats.total) return { label: 'Practice', disabled: true, title: 'Nothing to practise yet: play and review a game first' };
  if (!stats.due) return { label: 'Practice', disabled: true, title: 'All caught up: nothing to practise right now' };
  return { label: `Practice (${stats.due})`, disabled: false, title: `${plural(stats.due, 'question')} to practise` };
}

// --- progress: header numbers and series ---

const percent = (x) => `${Math.round(x * 100)}%`;

/** Average of each game's share of decisions best or fine (games with decisions only), or null. */
export function averageShare(rows) {
  const shares = rows.filter((g) => g.allTotal > 0).map((g) => g.allGood / g.allTotal);
  return shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
}

/** The Progress header: [{ label, value, sub }]. */
export function headerStats(progress) {
  const t = progress.totals;
  const of = (k) => `${k} of ${plural(t.games, 'game')}`;
  const avg = averageShare(progress.games);
  return [
    { label: 'Games played', value: String(t.games), sub: '' },
    { label: 'Wins', value: String(t.won), sub: '' },
    { label: 'Got ready', value: of(t.reachedReady), sub: 'one tile from winning' },
    { label: 'Dealt in', value: of(t.dealtIn), sub: 'your discard gave a win' },
    { label: 'Best or fine', value: avg === null ? '–' : percent(avg), sub: 'of your decisions, per game' },
  ];
}

/** Average of the last `window` non-null values up to each point (null while there are none). */
export function rollingAverage(values, window = 5) {
  return values.map((_, i) => {
    const win = values.slice(Math.max(0, i - window + 1), i + 1).filter((v) => v !== null && v !== undefined);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
}

/** The three trend series from buildProgress: { share, mistakes, ready }, each { values, rolling }. */
export function progressSeries(progress) {
  const rows = progress.games;
  const make = (values) => ({ values, rolling: rollingAverage(values) });
  return {
    share: make(rows.map((g) => (g.allTotal > 0 ? g.allGood / g.allTotal : null))),
    mistakes: make(rows.map((g) => g.mistakes)),
    ready: make(rows.map((g) => (g.firstReadyTurn ?? null))),
  };
}

/** Chart titles, the "what good looks like" line, and how values read. */
export const CHARTS = Object.freeze([
  { id: 'share', title: 'Decisions best or fine', good: 'Good: the line climbs toward 100%.', empty: 'No decisions yet.' },
  { id: 'mistakes', title: 'Mistakes per game', good: 'Good: the line falls toward 0.', empty: 'No games yet.' },
  { id: 'ready', title: 'Turns to get ready', good: 'Good: fewer turns, so you get ready sooner. Games where you never got ready are left out.', empty: 'You have not been ready in a game yet.' },
]);

/** How a chart's values read: { min, max, ticks: [values], label(v), point(v) }. */
export function chartScale(kind, values) {
  const vals = values.filter((v) => v !== null && v !== undefined);
  const top = vals.length ? Math.max(...vals) : 0;
  if (kind === 'share') {
    return { min: 0, max: 1, ticks: [0, 0.5, 1], label: percent, point: percent };
  }
  if (kind === 'mistakes') {
    const max = Math.max(3, Math.ceil(top));
    const step = max <= 4 ? 1 : max <= 10 ? 2 : 5;
    const ticks = [];
    for (let v = 0; v <= max; v += step) ticks.push(v);
    if (ticks.at(-1) !== max) ticks.push(max);
    return { min: 0, max, ticks, label: String, point: (v) => plural(v, 'mistake') };
  }
  // turns to get ready
  const max = Math.max(10, Math.ceil(top / 5) * 5);
  const ticks = [];
  for (let v = 0; v <= max; v += max <= 20 ? 5 : 10) ticks.push(v);
  if (ticks.at(-1) !== max) ticks.push(max);
  return { min: 0, max, ticks, label: String, point: (v) => `ready on turn ${v}` };
}

/** The line under a chart about the number of games: '' when there is a trend to read. */
export function trendNote(count) {
  if (count === 0) return 'No games yet.';
  if (count === 1) return 'More games will show a trend.';
  return '';
}

/**
 * Geometry of a small trend chart, one slot per game (oldest left). values may hold nulls
 * (left out). { values, rolling, width, height, pad: { top, right, bottom, left }, scale, labels
 * (x-axis text per game; default 1, 2, 3...) } ->
 * { count, empty, points: [{ i, v, x, y }], rollingPath, ticks: [{ v, y, label }],
 *   xLabels: [{ i, x, label }], r (dot radius) }.
 */
export function trendChart({ values, rolling = null, width, height, pad, scale, labels = null }) {
  const count = values.length;
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const x = (i) => (count <= 1 ? pad.left + plotW / 2 : pad.left + (i * plotW) / (count - 1));
  const span = scale.max - scale.min || 1;
  const y = (v) => pad.top + plotH - ((Math.min(scale.max, Math.max(scale.min, v)) - scale.min) * plotH) / span;
  const r2 = (n) => Math.round(n * 100) / 100;
  const points = [];
  values.forEach((v, i) => { if (v !== null && v !== undefined) points.push({ i, v, x: r2(x(i)), y: r2(y(v)) }); });
  let rollingPath = '';
  if (rolling && count >= 2) {
    let pen = false;
    for (let i = 0; i < count; i++) {
      const v = rolling[i];
      if (v === null || v === undefined) { pen = false; continue; }
      rollingPath += `${pen ? 'L' : 'M'}${r2(x(i))},${r2(y(v))}`;
      pen = true;
    }
  }
  const ticks = scale.ticks.map((v) => ({ v, y: r2(y(v)), label: scale.label(v) }));
  // Game numbers along the axis: every game when there is room, else every 2nd, 5th, 10th...
  const spacing = count <= 1 ? plotW : plotW / (count - 1);
  const step = [1, 2, 5, 10, 20, 50, 100].find((k) => spacing * k >= 22) ?? 100;
  const xLabels = [];
  for (let i = 0; i < count; i++) {
    const wanted = i === 0 || (i + 1) % step === 0 || i === count - 1;
    const prev = xLabels.at(-1);
    if (wanted && (!prev || (i - prev.i) * spacing >= 22)) xLabels.push({ i, x: r2(x(i)), label: String(labels?.[i] ?? i + 1) });
  }
  const r = count > 30 ? 2.5 : count > 12 ? 3.5 : 5;
  return { count, empty: points.length === 0, points, rollingPath, ticks, xLabels, r };
}

// --- progress: lessons ---

/**
 * Dots for the last n games of one lesson, oldest first. perGame: [{ file, totals }] with
 * totals = labels.totals[lessonId] ({ chances, slips, followed }) for each game, oldest first.
 * state: 'slip' (slipped at least once), 'followed', 'ok' (a chance, no slip, nothing followed),
 * 'none' (no chance that game).
 */
export function lastGamesDots(perGame, n = 5) {
  return perGame.slice(-n).map(({ file, totals }) => {
    const t = totals ?? { chances: 0, slips: 0, followed: 0 };
    const game = gameTitle(file);
    if (t.slips > 0) return { state: 'slip', title: `${game}: ${plural(t.slips, 'slip')}` };
    if (t.followed > 0) return { state: 'followed', title: `${game}: followed` };
    if (t.chances > 0) return { state: 'ok', title: `${game}: no slip` };
    return { state: 'none', title: `${game}: no chance` };
  });
}

/**
 * Rows of the lessons table: one per lesson with at least one chance, in catalogue order.
 * labelsByGame: labelGame results aligned with progress.games (oldest first).
 */
export function lessonRows(progress, labelsByGame, focus = []) {
  const focusIds = new Set((focus ?? []).map((f) => f.lessonId));
  return LESSON_IDS.filter((id) => progress.lessons[id].chances > 0).map((id) => {
    const L = progress.lessons[id];
    const perGame = progress.games.map((g, i) => ({ file: g.file, totals: labelsByGame[i]?.totals?.[id] }));
    return {
      id,
      title: lessonById(id).title,
      chances: L.chances,
      slips: L.slips,
      followed: L.followed,
      trend: L.trend,
      focus: focusIds.has(id),
      dots: lastGamesDots(perGame),
    };
  });
}

/** Lessons tested in one game: [{ id, title, tip, chances, slips, followed }] (chances > 0). */
export function lessonsThisGame(labels) {
  if (!labels || !labels.ok) return [];
  return LESSON_IDS.filter((id) => labels.totals[id].chances > 0)
    .map((id) => ({ id, title: lessonById(id).title, tip: lessonById(id).tip, ...labels.totals[id] }));
}

/**
 * Chips for one review step: { slips: [{ id, title, tip }], followed: [...] } (slips with the
 * primary first; followed without the catch-all).
 */
export function lessonChips(stepLabels) {
  const one = (id) => ({ id, title: lessonById(id).title, tip: lessonById(id).tip });
  const slips = stepLabels?.slips ?? [];
  const primary = stepLabels?.primary ?? null;
  return {
    slips: (primary ? [primary, ...slips.filter((id) => id !== primary)] : slips).map(one),
    followed: (stepLabels?.followed ?? []).filter((id) => id !== 'other-speed').map(one),
  };
}

/** The "You fixed" line from positives(): '' when there are none. */
export function fixedLine(pos) {
  if (!pos || !pos.length) return '';
  if (pos.length === 1) return pos[0].words;
  return `You fixed: ${pos.map((p) => p.title).join(' · ')}`;
}

/** A focusReport row with the followed count: "One pair: 2 chances, 0 slips (2 last game) · 2 followed". */
export const focusReportLine = (r) => `${r.words} · ${r.followed} followed`;

/** Games list rows, newest first: { file, title, when, result, score, mistakes }. */
export function gameRows(progress, reviews = {}, locale = undefined) {
  return [...progress.games].reverse().map((g) => {
    const review = reviews[g.file];
    const t = listRowText({ file: g.file, startedAt: g.date, botLevel: g.botLevel, result: review?.meta?.result }, locale);
    return {
      file: g.file,
      title: t.title,
      when: t.when,
      result: review ? resultWords(review.meta.result) : (g.result === 'won' ? 'You won' : g.result === 'draw' ? 'Draw' : 'You lost'),
      score: g.allTotal ? `${g.allGood} of ${g.allTotal} decisions best or fine` : 'No decisions',
      mistakes: plural(g.mistakes, 'mistake'),
    };
  });
}

export const skippedLine = (n) => (n > 0 ? `${plural(n, 'game')} could not be analysed.` : '');

// --- practice ---

/** "Question 3 of 10" and the bar's fill (0..1). */
export function questionProgress(index, total) {
  return { text: `Question ${index + 1} of ${total}`, fill: total ? (index + 1) / total : 0 };
}

const withStop = (s) => (s && !/[.!?]$/.test(s) ? `${s}.` : s ?? '');

/**
 * Feedback words after an answer, from gradeAnswer: { lead, right }. A wrong answer reads
 * "Not quite: <the review's words>." and never scolds; the accepted answer is in `right`.
 */
export function answerWords(item, grade) {
  if (grade.correct) {
    const tied = /either was right/.test(grade.words ?? '') ? ' These were equal; either was right.' : '';
    return { lead: `${withStop(item.explain.right)}${tied}`, right: '' };
  }
  return { lead: `Not quite: ${withStop(grade.words)}`, right: withStop(item.explain.right) };
}

/** Earliest time (ms) a learned item comes back for its check, or null. */
export function nextCheckAt(items, state) {
  let best = null;
  for (const it of items) {
    const e = state?.items?.[it.id];
    if (e && e.correctStreak === LEARNED_STREAK && Number.isFinite(e.lastSeen)) {
      const at = e.lastSeen + CHECK_AFTER_MS;
      if (best === null || at < best) best = at;
    }
  }
  return best;
}

const dayWords = (ms, locale) => new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' });

/**
 * End-of-practice summary: { headline, lessons: [line], learned, rest }.
 * answers: [{ id, correct }]; items: the questions asked; stats: quizStats over the practice pool
 * after the answers; nextCheck: nextCheckAt(...) or null.
 */
export function quizSummary({ answers, items, stats, nextCheck = null, locale = undefined }) {
  const right = answers.filter((a) => a.correct).length;
  const byLesson = new Map();
  for (const a of answers) {
    const it = items.find((x) => x.id === a.id);
    for (const id of it?.lessonIds ?? []) byLesson.set(id, (byLesson.get(id) ?? 0) + 1);
  }
  const lessons = LESSON_IDS.filter((id) => byLesson.has(id))
    .map((id) => `${lessonById(id).title} (${plural(byLesson.get(id), 'question')})`);
  const learned = `${stats.learned} of ${plural(stats.total, 'question')} ${stats.learned === 1 ? 'is' : 'are'} now learned (right twice in a row).`;
  let rest;
  if (stats.due > 0) rest = `${plural(stats.due, 'question')} ${isAre(stats.due)} ready to practise again now.`;
  else if (stats.learned === stats.total) rest = 'All caught up.';
  else rest = 'Nothing is due right now.';
  if (nextCheck !== null) rest += ` Learned questions come back once for a check; the next one on ${dayWords(nextCheck, locale)}.`;
  return { headline: `You got ${right} of ${answers.length} right.`, lessons, learned, rest };
}

/** The "All caught up" empty state's second line. */
export function caughtUpText(nextCheck, locale = undefined) {
  return nextCheck === null
    ? 'Every question from your games is learned.'
    : `Every question from your games is learned. Learned questions come back once for a check; the next one on ${dayWords(nextCheck, locale)}.`;
}

// --- Disagree form ---

export const NOTE_MAX = 500;
export const FEEDBACK_VERDICTS = Object.freeze([['best', 'Best'], ['fine', 'Fine'], ['inaccuracy', 'Inaccuracy'], ['mistake', 'Mistake']]);
const VERDICT_SET = new Set(FEEDBACK_VERDICTS.map(([v]) => v));
const LOG_NAME = /^\d{4}-\d{2}-\d{2}_\d{4}_game-\d{2,}(?:_[A-Za-z0-9-]+)?\.json$/; // with or without _<DEVICE>

/** Key of one step's feedback: "<file>#<stepIndex>". */
export const feedbackKey = (file, stepIndex) => `${file}#${stepIndex}`;

/**
 * Validates the Disagree form and builds the POST /api/feedback body.
 * ctx: { file, stepIndex, verdict, reviewVersion }; form: { expected ('' or a verdict), note }.
 * -> { ok: true, payload } or { ok: false, error } (plain words for the player).
 */
export function feedbackPayload(ctx, form) {
  const note = String(form?.note ?? '').trim();
  const expected = form?.expected ? String(form.expected) : null;
  if (!ctx || !LOG_NAME.test(String(ctx.file)) || !Number.isInteger(ctx.stepIndex) || ctx.stepIndex < 0 ||
    !VERDICT_SET.has(ctx.verdict) || !Number.isInteger(ctx.reviewVersion) || ctx.reviewVersion < 1) {
    return { ok: false, error: 'This step cannot be sent to your coach.' };
  }
  if (note.length > NOTE_MAX) return { ok: false, error: `Your note is too long: keep it to ${NOTE_MAX} characters.` };
  if (expected !== null && !VERDICT_SET.has(expected)) return { ok: false, error: 'Pick Best, Fine, Inaccuracy or Mistake, or leave it empty.' };
  if (expected !== null && expected === ctx.verdict) return { ok: false, error: 'That is the verdict it already has: pick another one, or leave it empty.' };
  return {
    ok: true,
    payload: { file: ctx.file, stepIndex: ctx.stepIndex, verdict: ctx.verdict, reviewVersion: ctx.reviewVersion, note, expected },
  };
}

/** The newest stored feedback entry for a step, or null. */
export function latestFeedback(entries, file, stepIndex) {
  let found = null;
  for (const e of entries ?? []) {
    if (e && e.file === file && e.stepIndex === stepIndex && (!found || String(e.createdAt) >= String(found.createdAt))) found = e;
  }
  return found;
}

/** Hover text of a stored disagreement: the note, or a plain line without one. */
export function feedbackTitle(entry) {
  const want = entry.expected ? `You said it should be ${FEEDBACK_VERDICTS.find(([v]) => v === entry.expected)[1]}. ` : '';
  return `${want}${entry.note ? `Your note: ${entry.note}` : 'No note.'}`.trim();
}

// --- screen navigation (shared by Review, Progress and Practice) ---

const SCREENS = [['review', 'Review games'], ['progress', 'Progress'], ['practice', 'Practice']];

/** The links between the three screens, `current` highlighted. attr: the data attribute the screen listens to. */
export function screenNavHtml(current, attr) {
  return (
    '<nav class="lf-screens" aria-label="Screens">' +
    SCREENS.map(([id, label]) =>
      `<button type="button" class="lf-screen-btn${id === current ? ' is-on' : ''}" data-${attr}="nav" data-to="${id}"` +
      `${id === current ? ' aria-current="page"' : ''}>${label}</button>`).join('') +
    '</nav>'
  );
}
