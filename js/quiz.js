// Practice quiz built from the player's own flagged decisions, with simple spaced repetition.
// Pure, no DOM; imports under Node. See docs/contract.md "quiz.js".
import { tileLabel } from './tileart.js';
import { NAMES } from './endscreen.js';
import { gradeDiscardChoice, gradeClaimChoice, distanceWords, usefulTiles, REVIEW_VERSION } from './review.js';
import { labelStep, lessonById } from './lessons.js';

export const QUIZ_STATE_VERSION = 1;
export const LEARNED_STREAK = 2;           // correct answers in a row that make an item learned
export const CHECK_AFTER_MS = 14 * 86400000; // a learned item comes back once after 14 days
const TIED = 'These were equal; either was right.';
// An item's lessons: the step's slips with the primary first (its tip is the one shown).
const slipsOf = (l) => (l.primary ? [l.primary, ...l.slips.filter((id) => id !== l.primary)] : [...l.slips]);

const the = (code) => `the ${tileLabel(code)}`;
const SUIT_NAMES = { m: 'Characters', p: 'Circles', s: 'Bamboo' };

// "the 2 and 3 of Characters"
function pairWords(tiles) {
  const [a, b] = tiles;
  if (a[0] === b[0] && SUIT_NAMES[a[0]]) return `the ${a[1]} and ${b[1]} of ${SUIT_NAMES[a[0]]}`;
  return `${the(a)} and ${the(b)}`;
}

// --- choices ---

/** Stable id of a claim or turn action as a quiz choice: 'pass', 'pong', 'kong', 'hu', 'chi:m2-m3'. */
export function choiceIdOf(action) {
  if (action.type === 'discard') return action.tile;
  if (action.type === 'chi') return `chi:${action.tiles.join('-')}`;
  return action.type;
}

function claimLabel(action) {
  if (action.type === 'chi') return `Chi with ${pairWords(action.tiles)}`;
  if (action.type === 'hu') return 'Hu (win)';
  if (action.type === 'pass') return 'Pass';
  return action.type === 'pong' ? 'Pong' : 'Kong';
}

// --- claim grading: review.js gradeClaimChoice (the same rules as its gradeClaim) ---

export { gradeClaimChoice };

// --- the position, without hidden information ---

function quizTable(step, review) {
  const t = step.table;
  return {
    dealer: t.dealer,
    humanWind: review.meta.humanWind,
    turnPlayer: t.turnPlayer,
    wallCount: t.wallCount,
    hand: [...t.humanHand],            // player 0's concealed tiles (drawn tile last)
    drew: step.drew,
    players: t.players.map((p) => ({   // face-up information only: never another player's concealed tiles
      melds: JSON.parse(JSON.stringify(p.melds)),
      flowers: [...p.flowers],
      discards: [...p.discards],
      concealedCount: p.hand.length,
    })),
    lastDiscard: t.lastDiscard ? { ...t.lastDiscard } : null,
    offer: step.kind === 'claim' ? { tile: step.claimTile, from: step.claimFrom, robKong: step.robKong } : null,
  };
}

// The accepted throws: the review's best tiles (review.js keeps only tiles its grading calls best).
const discardAnswers = (step) => [...step.best];

function discardRight(step, answers) {
  const opt = step.options.find((o) => o.tile === answers[0]);
  const names = answers.map(the);
  const which = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
  const why = step.bestReason === 'safety'
    ? 'it was the fastest throw that was not high risk while an opponent looked close to winning'
    : `it kept you ${distanceWords(opt.shanten)} with ${usefulTiles(opt.acceptance)}`;
  return `Best: throw ${which}; ${why}.`;
}

/**
 * buildQuizItems(games) with games = [{ file, review }] -> quiz items (see the contract): flagged
 * discard steps, missed wins, and claim steps graded inaccuracy. Unreviewable games are skipped.
 */
export function buildQuizItems(games) {
  const items = [];
  for (const g of games ?? []) {
    const review = g && g.review;
    if (!review || review.ok !== true) continue;
    for (const step of review.steps) {
      const flagged = step.verdict === 'mistake' || step.verdict === 'inaccuracy';
      if (!flagged) continue;
      const base = {
        id: `${g.file}#${step.index}`,
        file: g.file,
        date: review.meta.startedAt ?? null,
        stepIndex: step.index,
        reviewVersion: review.reviewVersion ?? REVIEW_VERSION,
        lessonIds: slipsOf(labelStep(review, step.index)),
        table: quizTable(step, review),
        original: { choice: choiceIdOf(step.chosen), verdict: step.verdict, cost: step.cost },
      };
      const tipId = base.lessonIds[0] ?? null; // the primary lesson
      const tipOf = () => (tipId ? lessonById(tipId).tip : null);
      let item = null;
      if (step.missedWin) {
        let other;
        if (step.chosen.type === 'discard') other = { id: step.options[0].tile, label: `Throw ${the(step.options[0].tile)}` };
        else if (step.kind === 'claim') other = { id: 'pass', label: 'Pass' };
        else other = { id: choiceIdOf(step.chosen), label: `Kong of ${the(step.chosen.tile)}` };
        const lead = step.kind === 'claim'
          ? `${NAMES[step.claimFrom]} ${step.robKong ? 'added' : 'threw'} ${the(step.claimTile)}.`
          : 'Your hand is complete.';
        item = {
          ...base, kind: 'hu',
          prompt: `${lead} Hu, or ${other.label.charAt(0).toLowerCase()}${other.label.slice(1)}?`,
          choices: [{ id: 'hu', label: 'Hu (win)' }, other],
          answers: ['hu'],
          grading: { huOffered: true },
          explain: { wrong: 'Missed a win', right: 'Best: Hu. Your hand was complete, so Hu wins the game.', tip: tipOf() },
        };
      } else if (step.chosen.type === 'discard') {
        item = {
          ...base, kind: 'discard',
          prompt: 'Which tile would you throw?',
          choices: step.options.map((o) => o.tile).sort((a, b) => step.table.humanHand.indexOf(a) - step.table.humanHand.indexOf(b))
            .map((tile) => ({ id: tile, label: `Throw ${the(tile)}` })),
          answers: discardAnswers(step),
          grading: { options: JSON.parse(JSON.stringify(step.options)), threatened: Boolean(step.threatened) },
          explain: { wrong: step.cost, right: discardRight(step, discardAnswers(step)), tip: tipOf() },
        };
      } else if (step.kind === 'claim' && step.verdict === 'inaccuracy') {
        const grading = {
          offers: JSON.parse(JSON.stringify(step.offers)),
          shantenIfPassed: step.shantenIfPassed,
          acceptanceIfPassed: step.acceptanceIfPassed,
        };
        const actions = [...step.offers.map((o) => o.action), { type: 'pass', player: 0 }];
        const choices = actions.map((a) => ({ id: choiceIdOf(a), label: claimLabel(a), action: a }));
        const answers = choices.filter((c) => gradeClaimChoice(grading, c.action).verdict === 'best').map((c) => c.id);
        const names = choices.map((c) => c.label);
        const right = choices.filter((c) => answers.includes(c.id)).map((c) => c.label).join(' or ');
        item = {
          ...base, kind: 'claim',
          prompt: `${NAMES[step.claimFrom]} threw ${the(step.claimTile)}. ${names.slice(0, -1).join(', ')}, or pass?`,
          choices,
          answers,
          grading,
          explain: { wrong: step.cost, right: `Best: ${right}.`, tip: tipOf() },
        };
      }
      if (item) items.push(item);
    }
  }
  return items;
}

/**
 * gradeAnswer(item, choiceId) -> { correct, verdict, words }: the verdict the review would give
 * that choice in that position.
 */
export function gradeAnswer(item, choiceId) {
  const correct = item.answers.includes(choiceId);
  if (!item.choices.some((c) => c.id === choiceId)) return { correct: false, verdict: null, words: 'That is not one of the choices.' };
  if (item.kind === 'hu') {
    return correct
      ? { correct, verdict: 'best', words: item.explain.right }
      : { correct, verdict: 'mistake', words: 'Missed a win' };
  }
  if (item.kind === 'discard') {
    const g = gradeDiscardChoice(item.grading.options, choiceId, item.grading.threatened);
    if (g.verdict === 'best') return { correct, verdict: 'best', words: g.tiedBest ? `Best. ${TIED}` : 'Best.' };
    return { correct, verdict: g.verdict, words: g.cost };
  }
  const g = gradeClaimChoice(item.grading, item.choices.find((c) => c.id === choiceId).action);
  return { correct, verdict: g.verdict, words: g.verdict === 'best' ? 'Best.' : g.cost };
}

// --- scheduling ---

/** A fresh quiz state. */
export const emptyQuizState = () => ({ version: QUIZ_STATE_VERSION, items: {} });

function validState(state) {
  return state && typeof state === 'object' && state.version === QUIZ_STATE_VERSION &&
    state.items && typeof state.items === 'object' && !Array.isArray(state.items);
}

const ms = (now) => (now instanceof Date ? now.getTime() : Number(now));

function bucketOf(entry, now) {
  if (!entry || !entry.seen) return 0;                            // never seen
  if (entry.correctStreak >= LEARNED_STREAK) {
    return entry.correctStreak === LEARNED_STREAK && now - entry.lastSeen >= CHECK_AFTER_MS ? 3 : null; // check / learned
  }
  return entry.lastResult === false ? 1 : 2;                      // wrong last time / correct once
}

/**
 * nextItems(items, state, now, n) -> up to n items to ask: never seen (newest game first), then
 * wrong last time, then correct once (oldest answer first), then due 14-day checks.
 */
export function nextItems(items, state, now, n) {
  const st = validState(state) ? state : emptyQuizState();
  const t = ms(now);
  const ranked = [];
  for (const item of items) {
    const entry = st.items[item.id];
    const bucket = bucketOf(entry, t);
    if (bucket !== null) ranked.push({ item, bucket, lastSeen: entry?.lastSeen ?? 0 });
  }
  const key = (x) => String(x.item.date ?? '') + String(x.item.file);
  ranked.sort((a, b) => a.bucket - b.bucket ||
    (a.bucket === 0 ? (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : a.item.stepIndex - b.item.stepIndex)
      : a.lastSeen - b.lastSeen || (a.item.id < b.item.id ? -1 : 1)));
  return ranked.slice(0, Math.max(0, n)).map((x) => x.item);
}

/** recordAnswer(state, id, correct, now) -> a new state (the input is not changed). */
export function recordAnswer(state, id, correct, now) {
  const st = validState(state) ? state : emptyQuizState();
  const prev = st.items[id] ?? { seen: 0, correctStreak: 0, lastSeen: null, lastResult: null };
  return {
    version: QUIZ_STATE_VERSION,
    items: {
      ...st.items,
      [id]: { seen: prev.seen + 1, correctStreak: correct ? prev.correctStreak + 1 : 0, lastSeen: ms(now), lastResult: Boolean(correct) },
    },
  };
}

/** quizStats(items, state, now) -> { total, learned, due, byLesson: { [lessonId]: { total, learned } } }. */
export function quizStats(items, state, now = Date.now()) {
  const st = validState(state) ? state : emptyQuizState();
  const isLearned = (it) => (st.items[it.id]?.correctStreak ?? 0) >= LEARNED_STREAK;
  const byLesson = {};
  for (const it of items) {
    for (const id of it.lessonIds) {
      byLesson[id] ??= { total: 0, learned: 0 };
      byLesson[id].total += 1;
      if (isLearned(it)) byLesson[id].learned += 1;
    }
  }
  return {
    total: items.length,
    learned: items.filter(isLearned).length,
    due: nextItems(items, st, now, Infinity).length,
    byLesson,
  };
}

/**
 * pruneState(state, files, itemIds?) -> a new state without entries whose game log is not in
 * `files` (log file names) and, when itemIds (the current quiz item ids) is given, without
 * entries for steps that are no longer quiz items (a grading change stopped flagging them).
 * An invalid state becomes an empty one.
 */
export function pruneState(state, files, itemIds = null) {
  if (!validState(state)) return emptyQuizState();
  const keep = new Set(files);
  const ids = itemIds ? new Set(itemIds) : null;
  const items = {};
  for (const [id, entry] of Object.entries(state.items)) {
    const file = id.slice(0, id.lastIndexOf('#'));
    if (keep.has(file) && (!ids || ids.has(id)) && entry && typeof entry === 'object') items[id] = entry;
  }
  return { version: QUIZ_STATE_VERSION, items };
}
