// Progress across games: one metrics row per game, trends, per-lesson slip rates, the focus for
// the next game and the end-of-game focus report. Pure, no DOM; imports under Node.
// See docs/contract.md "progress.js".
import { LESSONS, LESSON_IDS, lessonById, labelGame } from './lessons.js';

const WINDOW = 5; // games in a rolling average / "recent" window
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * gameMetrics(review, labels, ids) -> one row (see the contract). `ids` (e.g. { file }) is copied
 * into the row as given; nothing in the row depends on a file name otherwise.
 */
export function gameMetrics(review, labels, ids = {}) {
  const s = review.summary;
  const r = review.meta.result;
  const steps = review.steps;
  const lessons = {};
  for (const id of LESSON_IDS) lessons[id] = { chances: labels.totals[id].chances, slips: labels.totals[id].slips };
  return {
    ...ids,
    date: review.meta.startedAt ?? null,
    botLevel: review.meta.botLevel ?? null,
    result: r.type === 'win' ? (r.winner === 0 ? 'won' : 'lost') : 'draw',
    scoreGood: s.scoreGood,
    scoreTotal: s.scoreTotal,
    claimsGood: s.scoreClaimsGood,
    claimsTotal: s.scoreClaimsTotal,
    allGood: s.scoreAllGood,
    allTotal: s.scoreAllTotal,
    mistakes: steps.filter((x) => x.verdict === 'mistake').length,
    inaccuracies: steps.filter((x) => x.verdict === 'inaccuracy').length,
    reckless: s.safety.reckless,
    risky: s.safety.risky,
    reachedReady: labels.facts.reachedReady,
    firstReadyTurn: labels.facts.firstReadyTurn,
    turns: review.meta.humanTurns,
    dealtIn: labels.facts.dealtIn,
    thinkMsMedian: s.thinkMsMedian,
    lessons,
  };
}

// Sort key: the start time, else the stamp in the file name, else ''.
function dateKey(row) {
  const t = Date.parse(row.date);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_/.exec(String(row.file ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : '';
}

function series(values) {
  const rolling = values.map((_, i) => {
    const win = values.slice(Math.max(0, i - WINDOW + 1), i + 1).filter((v) => v !== null);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
  return { series: values, rolling };
}

const rate = (slips, chances) => (chances > 0 ? slips / chances : null);

function lessonTrend(id, rows, slipEvents) {
  const withChance = rows.filter((g) => g.lessons[id].chances > 0);
  const slips = rows.reduce((n, g) => n + g.lessons[id].slips, 0);
  if (slips > 0 && rows.length && slipEvents.every((e) => e.gameIndex === rows.length - 1)) return 'new';
  if (withChance.length < 4) return 'not enough games';
  const recentN = Math.min(WINDOW, Math.floor(withChance.length / 2));
  const recent = withChance.slice(-recentN);
  const earlier = withChance.slice(0, -recentN);
  const sum = (gs, k) => gs.reduce((n, g) => n + g.lessons[id][k], 0);
  const rR = sum(recent, 'slips') / sum(recent, 'chances');
  const rE = sum(earlier, 'slips') / sum(earlier, 'chances');
  if (rR < rE - 0.1) return 'improving';
  if (rR > rE + 0.1) return 'worse';
  return 'steady';
}

/**
 * buildProgress(games) with games = [{ file, review, labels? }] in any order -> { games, skipped,
 * totals, trends, lessons } (see the contract). Unreviewable games (review.ok false) are skipped.
 */
export function buildProgress(games) {
  let skipped = 0;
  const entries = [];
  for (const g of games ?? []) {
    if (!g || !g.review || g.review.ok !== true) { skipped += 1; continue; }
    const labels = g.labels && g.labels.ok ? g.labels : labelGame(g.review);
    const row = gameMetrics(g.review, labels, { file: g.file ?? null });
    entries.push({ row, labels });
  }
  entries.sort((a, b) => {
    const ka = dateKey(a.row);
    const kb = dateKey(b.row);
    return ka < kb ? -1 : ka > kb ? 1 : String(a.row.file) < String(b.row.file) ? -1 : 1;
  });
  const rows = entries.map((e) => e.row);

  const n = rows.length;
  const count = (f) => rows.filter(f).length;
  const sum = (k) => rows.reduce((a, g) => a + g[k], 0);
  const totals = {
    games: n,
    won: count((g) => g.result === 'won'),
    lost: count((g) => g.result === 'lost'),
    draw: count((g) => g.result === 'draw'),
    scoreGood: sum('scoreGood'),
    scoreTotal: sum('scoreTotal'),
    allGood: sum('allGood'),
    allTotal: sum('allTotal'),
    mistakes: sum('mistakes'),
    inaccuracies: sum('inaccuracies'),
    reckless: sum('reckless'),
    risky: sum('risky'),
    reachedReady: count((g) => g.reachedReady),
    dealtIn: count((g) => g.dealtIn),
  };

  const trends = {
    score: series(rows.map((g) => (g.scoreTotal ? g.scoreGood / g.scoreTotal : null))),
    mistakes: series(rows.map((g) => g.mistakes)),
    readyRate: series(rows.map((g) => (g.reachedReady ? 1 : 0))),
    winRate: series(rows.map((g) => (g.result === 'won' ? 1 : 0))),
    dealInRate: series(rows.map((g) => (g.dealtIn ? 1 : 0))),
  };

  const lessons = {};
  for (const id of LESSON_IDS) {
    const slipEvents = [];
    let followed = 0;
    let lastFollowedGame = null;
    entries.forEach((e, gi) => {
      e.labels.steps.forEach((s, si) => { if (s.slips.includes(id)) slipEvents.push({ gameIndex: gi, file: e.row.file, stepIndex: si }); });
      if (id === 'keep-a-pair' && e.labels.endPair === 'slip') slipEvents.push({ gameIndex: gi, file: e.row.file, stepIndex: null });
      followed += e.labels.totals[id].followed;
      if (e.labels.totals[id].followed > 0) lastFollowedGame = gi;
    });
    const chances = rows.reduce((a, g) => a + g.lessons[id].chances, 0);
    const slips = rows.reduce((a, g) => a + g.lessons[id].slips, 0);
    const recent = rows.filter((g) => g.lessons[id].chances > 0).slice(-WINDOW);
    const rc = recent.reduce((a, g) => a + g.lessons[id].chances, 0);
    const rs = recent.reduce((a, g) => a + g.lessons[id].slips, 0);
    const lastSlipGame = slipEvents.length ? slipEvents.at(-1).gameIndex : null;
    lessons[id] = {
      chances,
      slips,
      followed,
      slipRate: rate(slips, chances),
      recentSlipRate: rate(rs, rc),
      trend: lessonTrend(id, rows, slipEvents),
      lastSlipGame,
      lastFollowedGame,
      // Step slips only (the game-level "finished with no pair" has no step to show).
      examples: slipEvents.filter((e) => e.stepIndex !== null).reverse().slice(0, 5)
        .map(({ file, stepIndex }) => ({ file, stepIndex })),
    };
  }
  return { games: rows, skipped, totals, trends, lessons };
}

// "2 slips in your last 2 games", "1 slip in your last game", "3 slips in 7 games so far".
function whyWords(id, progress) {
  const rows = progress.games;
  const k = Math.min(WINDOW, rows.length);
  const recentSlips = rows.slice(-k).reduce((a, g) => a + g.lessons[id].slips, 0);
  const lastSlips = rows.length ? rows.at(-1).lessons[id].slips : 0;
  if (lastSlips > 0 && (k === 1 || recentSlips === lastSlips)) return `${plural(lastSlips, 'slip')} in your last game.`;
  if (recentSlips > 0) return `${plural(recentSlips, 'slip')} in your last ${k} games.`;
  return `${plural(progress.lessons[id].slips, 'slip')} in ${plural(rows.length, 'game')} so far.`;
}

/**
 * chooseFocus(progress) -> up to 2 focus items { lessonId, kind: 'fix' | 'keep', title, tip, why, examples }.
 * See the contract for the rule. Always returns at least one item.
 * A lesson qualifies with a chance and either 2+ slips so far or a slip in the latest game; it
 * drops out when the latest game where it had a chance had no slip, unless it slipped in 2 of
 * the last 3 games where it had a chance. Order: most slips in the last 5 games, then the recent
 * slip rate, then the most recent slip, then catalogue order.
 */
export function chooseFocus(progress) {
  const rows = progress.games;
  const last = rows.length - 1;
  const qualifies = (id) => {
    const L = progress.lessons[id];
    if (!(L.chances > 0 && (L.slips >= 2 || (last >= 0 && rows[last].lessons[id].slips >= 1)))) return false;
    // Drops out after a clean game: zero slips in the latest game where it had a chance, unless
    // it slipped in 2 of the last 3 games where it had a chance.
    const withChance = rows.filter((g) => g.lessons[id].chances > 0);
    if (withChance.at(-1).lessons[id].slips > 0) return true;
    return withChance.slice(-3).filter((g) => g.lessons[id].slips > 0).length >= 2;
  };
  // Most slips in the recent games first (a lesson tested on every throw has a low rate even
  // when it slipped often), then the recent slip rate.
  const recentSlips = (id) => rows.slice(-WINDOW).reduce((n, g) => n + g.lessons[id].slips, 0);
  const order = (a, b) => recentSlips(b) - recentSlips(a) ||
    (progress.lessons[b].recentSlipRate ?? 0) - (progress.lessons[a].recentSlipRate ?? 0) ||
    (progress.lessons[b].lastSlipGame ?? -1) - (progress.lessons[a].lastSlipGame ?? -1) ||
    LESSON_IDS.indexOf(a) - LESSON_IDS.indexOf(b);
  // The catch-all "other-speed" is used only when fewer than 2 specific lessons qualify.
  const specific = LESSON_IDS.filter((id) => id !== 'other-speed' && qualifies(id)).sort(order);
  const picked = specific.slice(0, 2);
  if (picked.length < 2 && qualifies('other-speed')) picked.push('other-speed');
  if (picked.length) {
    return picked.map((id) => {
      const l = lessonById(id);
      return { lessonId: id, kind: 'fix', title: l.title, tip: l.tip, why: whyWords(id, progress), examples: progress.lessons[id].examples };
    });
  }
  // Nothing to fix: keep doing what works (the lesson followed most recently, most often then).
  let best = null;
  if (last >= 0) {
    const cands = LESSON_IDS.filter((id) => id !== 'other-speed' && progress.lessons[id].lastFollowedGame !== null);
    cands.sort((a, b) => progress.lessons[b].lastFollowedGame - progress.lessons[a].lastFollowedGame ||
      progress.lessons[b].followed - progress.lessons[a].followed || LESSON_IDS.indexOf(a) - LESSON_IDS.indexOf(b));
    best = cands[0] ?? null;
  }
  const l = lessonById(best ?? LESSONS[0].id);
  const why = best === null
    ? 'A good first habit for a new player.'
    : `You followed it ${plural(progress.lessons[best].followed, 'time')} so far with no recent slips.`;
  return [{ lessonId: l.id, kind: 'keep', title: 'Keep doing what works', tip: `${l.title}: ${l.tip}`, why, examples: [] }];
}

/**
 * focusReport(focus, labelsOfThisGame, progressBeforeThisGame) -> [{ lessonId, title, chances,
 * slips, followed, words }], e.g. words "Lone tiles first: 3 chances, 0 slips (2 last game)".
 */
export function focusReport(focus, labels, progressBefore) {
  const prev = progressBefore && progressBefore.games.length ? progressBefore.games.at(-1) : null;
  return (focus ?? []).map((f) => {
    const l = lessonById(f.lessonId);
    const t = labels && labels.ok ? labels.totals[f.lessonId] : { chances: 0, slips: 0, followed: 0 };
    let words = `${l.short}: ${plural(t.chances, 'chance')}, ${plural(t.slips, 'slip')}`;
    if (prev) words += ` (${prev.lessons[f.lessonId].slips} last game)`;
    return { lessonId: f.lessonId, title: l.title, chances: t.chances, slips: t.slips, followed: t.followed, words };
  });
}

const MAX_FIXED = 2; // U3: "You fixed" names at most this many lessons

/**
 * positives(labelsOfThisGame, progressBeforeThisGame) -> [{ lessonId, title, words }]: lessons
 * slipped in an earlier game and followed with no slip this game ("You fixed: Keep one pair").
 * At most 2: the most chances this game first, then the most followed, then catalogue order.
 */
export function positives(labels, progressBefore) {
  if (!labels || !labels.ok || !progressBefore) return [];
  const t = labels.totals;
  return LESSON_IDS
    .filter((id) => id !== 'other-speed')
    .filter((id) => progressBefore.lessons[id].slips > 0 && t[id].followed > 0 && t[id].slips === 0)
    .sort((a, b) => t[b].chances - t[a].chances || t[b].followed - t[a].followed || LESSON_IDS.indexOf(a) - LESSON_IDS.indexOf(b))
    .slice(0, MAX_FIXED)
    .map((id) => ({ lessonId: id, title: lessonById(id).title, words: `You fixed: ${lessonById(id).title}` }));
}
