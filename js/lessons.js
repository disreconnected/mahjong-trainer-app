// Lesson labels for the learning loop: which habits a review step tested, and whether player 0
// slipped or followed them. Pure, no DOM; imports under Node. See docs/contract.md "lessons.js".
import { isSuit, rankOf, suitOf } from './tiles.js';
import { SAFETY } from './safety.js';
import {
  gradeDiscardChoice, gradeClaimChoice, addsSomethingNew, isSpare, isConnected, inSet, realPairs, slipReasonOf,
} from './review.js';

export { isConnected };

const lesson = (id, title, short, tip, explain, slip) => Object.freeze({ id, title, short, tip, explain, slip });

// U2: the face-up sets that make an opponent a high threat, from safety.js, e.g. "3 sets",
// "2 sets with 79 or fewer tiles left"; X3: a 0-set rule reads "even no sets with 39 or fewer tiles left".
const highThreatWords = (level) => SAFETY.threat[level].filter((r) => r.level === 'high')
  .map((r) => `${r.sets ? `${r.sets} set${r.sets === 1 ? '' : 's'}` : 'even no sets'}${r.wall === Infinity ? '' : ` with ${r.wall} or fewer tiles left`}`);
const orWords = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list.join(''));
const easyHigh = highThreatWords('easy');
const normalOnly = highThreatWords('normal').filter((w) => !easyHigh.includes(w));
const SAFETY_TIP = `When an opponent shows ${orWords(easyHigh)}` +
  (normalOnly.length ? `, or against Normal bots ${orWords(normalOnly)}` : '') +
  ', prefer tiles that are already in the discards.';

/** The fixed lesson catalogue, in display order. */
export const LESSONS = Object.freeze([
  lesson('lone-tile-first', 'Throw lone tiles before connected ones', 'Lone tiles first',
    'Before you throw a tile, check whether it has a neighbour; throw a tile with no neighbour first.',
    'A tile works with another when it is the same tile or in the same suit within 2 ranks, like 3 and 5 of Circles. ' +
      'Two tiles that work together can become a set with one more tile. A tile with no neighbour needs two more, so it should go first.',
    'You threw a tile that worked with another one and kept a lone tile.'),
  lesson('keep-a-pair', 'Keep one pair', 'One pair',
    'When your hand has only one pair, keep it unless breaking it brings you closer.',
    'A winning hand is 4 sets and 1 pair. When your sets are mostly runs, the pair is the hardest part to find late in the game. ' +
      'Protect the pair you have.',
    'You broke your only pair.'),
  lesson('keep-your-pairs', 'Keep your pairs', 'Keep pairs',
    'When you hold several pairs, throw a single tile that adds nothing before you break a pair.',
    'A pair can become a set with one more copy, or be the pair a winning hand needs. ' +
      'Breaking one gives that up. A single tile whose useful draws already help your other tiles costs you nothing to throw.',
    'You broke a pair while a single tile was there to throw.'),
  lesson('spare-tile', 'Throw the spare tile', 'Spare tiles',
    'When a tile only waits for tiles your other tiles already want, it is spare: throw it first.',
    'Some tiles look useful because they have a neighbour, but every draw they help with already helps your hand. ' +
      'Throwing a spare tile loses no useful tiles. Keep the tiles that add something new.',
    'You kept a spare tile and threw one that added something new.'),
  lesson('claim-for-a-new-set', 'Claim only when it gains something', 'Useful claims only',
    'Before you Chi or Pong, ask whether it brings you closer or gives you more useful tiles.',
    'A Chi or Pong makes a face-up set, but it also uses tiles from your hand. ' +
      'If those tiles were already part of a set, the claim swaps one set for another and gains nothing.',
    'You took a claim that did not bring you closer or add useful tiles.'),
  lesson('take-helpful-claims', 'Take claims that bring you closer', 'Helpful claims',
    'When a Chi or Pong brings you closer, or clearly adds useful tiles, take it.',
    'A claim gives you a set without waiting for a draw. ' +
      'When it brings you closer to ready, or gives you many more useful tiles, it is usually the faster way to win.',
    'You passed a claim that would have helped your hand.'),
  lesson('safety-under-threat', 'Check the discards when someone shows sets', 'Safe throws under threat',
    SAFETY_TIP,
    'An opponent with 3 face-up sets is often one tile from winning. ' +
      'If your hand is still far from ready, throw a tile that is unlikely to be the one they need.',
    'You threw a risky tile while an opponent looked close to winning.'),
  lesson('take-the-win', 'Press Hu when it is offered', 'Take the win',
    'When the Hu button lights up, press it.',
    'Hu means your hand is complete. There is no bigger hand to wait for in these rules, so a win is always the best choice.',
    'You missed a win.'),
  lesson('widest-wait', 'Choose the wait with the most tiles', 'Widest wait',
    'When two throws both make you ready, keep the one that waits on more tiles.',
    'Once you are ready (one tile from winning), what matters is how many winning tiles are still out there. ' +
      'A wait on two different tiles usually wins more often than a wait on one.',
    'Another throw would also have made you ready, with more winning tiles.'),
  lesson('build-near-your-group', 'Keep tiles near your biggest group', 'Near your biggest group',
    'When two tiles look equally useless, keep the one in the suit where you already hold several tiles.',
    'A tile next to a suit where you hold many tiles can join a set there in many ways. ' +
      'A tile in a suit you barely hold usually stays useless.',
    'You threw a tile next to your biggest group and kept one that added nothing new.'),
  lesson('other-speed', 'Find the faster throw', 'Faster throws',
    'Compare your choices: keep the tiles that bring you closer or give you more useful tiles.',
    'Sometimes one throw keeps more ways to improve than another. ' +
      'The review lists every throw with its distance from ready and its useful tiles, so you can compare them.',
    'A faster throw was available.'),
]);

export const LESSON_IDS = Object.freeze(LESSONS.map((l) => l.id));
const BY_ID = new Map(LESSONS.map((l) => [l.id, l]));

/** The catalogue entry for an id, or null. */
export const lessonById = (id) => BY_ID.get(id) ?? null;

// --- hand helpers (player 0's own concealed tiles: no hidden information) ---

const countIn = (tiles, code) => tiles.reduce((n, t) => n + (t === code), 0);

function without(hand, tile) {
  const out = [...hand];
  const i = out.indexOf(tile);
  if (i >= 0) out.splice(i, 1);
  return out;
}

const near = (a, b) => isSuit(a) && isSuit(b) && suitOf(a) === suitOf(b) && Math.abs(rankOf(a) - rankOf(b)) <= 2;

/**
 * True when `tile` sits next to the player's biggest group: its suit holds 3 or more other
 * concealed tiles and at least one of them is within 2 ranks of it.
 */
export function isNearGroup(hand, tile) {
  if (!isSuit(tile)) return false;
  const others = without(hand, tile).filter((p) => isSuit(p) && suitOf(p) === suitOf(tile));
  return others.length >= 3 && others.some((p) => near(p, tile));
}

/**
 * The hand's only pair: the code held exactly twice when exactly one code is; else null.
 * With meldCount, only real pairs count (review.js realPairs: some best arrangement uses them).
 */
export function onlyPair(hand, meldCount = null) {
  const counts = new Map();
  for (const t of hand) counts.set(t, (counts.get(t) || 0) + 1);
  let pairs = [...counts].filter(([, n]) => n === 2).map(([c]) => c);
  if (meldCount !== null) {
    const real = new Set(realPairs(hand, meldCount));
    pairs = pairs.filter((c) => real.has(c));
  }
  return pairs.length === 1 ? pairs[0] : null;
}

const SLOW = new Set(['inaccuracy', 'mistake']);

// Which speed slip is the primary label when several apply: the most specific first. A step
// keeps at most two labels (a primary and a secondary); other-speed only when none applies.
// The pair lessons come first: a pair tile also counts as connected, and "you broke your pair"
// is the more specific reason.
const SPEED_PRIORITY = ['keep-a-pair', 'keep-your-pairs', 'lone-tile-first', 'spare-tile', 'build-near-your-group', 'widest-wait'];

// --- per-step rules ---

// Per discard lesson: { chance, slip, followed, wrong }. `wrong` holds the lesson's wrong options:
// throws the lesson warns against that were graded worse than the best by more than the fine
// band (and are not recommended). A chance needs a good alternative and a plausible wrong option:
// one at the best throw's distance from ready (U1: a throw that moves the hand further away is
// not one a player would plausibly pick), unless the player threw a wrong option (a slip).
function discardFacts(step) {
  const hand = step.table.players[0].hand;
  const meldCount = step.table.players[0].melds?.length ?? 0;
  const opts = step.options;
  const top = opts[0];
  const speedOf = (o) => gradeDiscardChoice(opts, o.tile, false).speedVerdict;
  const best = new Set(step.best);
  const good = opts.filter((o) => !SLOW.has(speedOf(o))); // speed best or fine
  const poor = opts.filter((o) => SLOW.has(speedOf(o)) && !best.has(o.tile));
  const speedBest = opts.filter((o) => o.shanten === top.shanten && o.acceptance === top.acceptance);
  const thrown = opts.find((o) => o.tile === step.chosen.tile);
  const slow = SLOW.has(step.speedVerdict);
  const adds = (o) => addsSomethingNew(opts, o.tile);
  const out = {};
  const plausible = (wrongOpts) => wrongOpts.some((o) => o.shanten === top.shanten);
  const put = (id, wrongOpts, alternative, slipWhen) => {
    const wrong = wrongOpts.map((o) => o.tile);
    const inWrong = wrong.includes(thrown.tile);
    const slip = Boolean(alternative && slow && inWrong && slipWhen);
    const chance = Boolean(alternative && (plausible(wrongOpts) || slip));
    out[id] = { chance, slip, followed: chance && !slow && !inWrong, wrong };
  };

  // lone-tile-first: wrong = connected tiles (not inside a complete set); alternative = a lone tile.
  {
    const lone = (o) => !isConnected(hand, o.tile);
    const wrong = poor.filter((o) => !lone(o) && !inSet(hand, o.tile));
    put('lone-tile-first', wrong, good.some(lone), speedBest.some(lone));
  }

  // keep-a-pair: wrong = a tile of the only (real) pair.
  {
    const pair = onlyPair(hand, meldCount);
    put('keep-a-pair', poor.filter((o) => o.tile === pair), true, true);
  }

  // keep-your-pairs: 2+ real pairs; wrong = a tile of one; alternative = a single tile.
  {
    const pairs = realPairs(hand, meldCount).filter((c) => countIn(hand, c) === 2);
    const single = (o) => countIn(hand, o.tile) < 2;
    const wrong = pairs.length >= 2 ? poor.filter((o) => pairs.includes(o.tile)) : [];
    put('keep-your-pairs', wrong, good.some(single), speedBest.some(single));
  }

  // spare-tile: alternative = a spare tile (connected, adds nothing new); wrong = a tile that adds something.
  {
    const spare = (o) => isSpare(opts, hand, o.tile);
    put('spare-tile', poor.filter(adds), good.some(spare), speedBest.some(spare));
  }

  // build-near-your-group: wrong = a near-group tile that looks lone (no free partner) yet adds
  // something new; alternative = a tile outside the group that adds nothing new.
  {
    const wrong = poor.filter((o) => isNearGroup(hand, o.tile) && !isConnected(hand, o.tile) && adds(o));
    const idle = (o) => !isNearGroup(hand, o.tile) && !adds(o);
    put('build-near-your-group', wrong, good.some(idle), speedBest.some(idle));
  }

  // widest-wait: wrong = a throw that is ready with clearly fewer winning tiles.
  {
    put('widest-wait', poor.filter((o) => o.shanten === 0), true, true);
  }

  // safety-under-threat: wrong = a throw that would be graded risky or reckless.
  if (step.threatened) {
    const unsafe = (o) => ['risky', 'reckless'].includes(gradeDiscardChoice(opts, o.tile, true).safetyVerdict);
    const wrongOpts = opts.filter((o) => unsafe(o) && !best.has(o.tile));
    const mine = step.safetyVerdict === 'risky' || step.safetyVerdict === 'reckless';
    const chance = plausible(wrongOpts) || mine;
    out['safety-under-threat'] = { chance, slip: mine, followed: chance && !mine, wrong: wrongOpts.map((o) => o.tile) };
  }

  // other-speed: any throw graded worse than fine; a slip only when no other lesson explains it.
  put('other-speed', poor, true, true);
  return out;
}

function discardRules(step, add) {
  const facts = discardFacts(step);
  // The speed slips, most specific first. keep-your-pairs and spare-tile use the same helpers as
  // review.js's costReason, so a cost reason always names one of the step's slips.
  let speed = SPEED_PRIORITY.filter((id) => facts[id].slip);
  if (!speed.length && facts['other-speed'].slip) speed = ['other-speed'];
  const safety = facts['safety-under-threat'];
  const safetySlip = Boolean(safety && safety.slip);
  // The primary label: the reason behind the step's cost (safety when the safety grading set it).
  const safetyDrives = safetySlip && step.cost !== step.speedCost;
  const ordered = safetyDrives ? ['safety-under-threat', ...speed] : [...speed, ...(safetySlip ? ['safety-under-threat'] : [])];
  // The secondary label is the lesson named by the cost reason, when the primary is another one.
  const reason = step.costReason
    ? slipReasonOf(step.options, step.table.players[0].hand, step.table.players[0].melds?.length ?? 0, step.chosen.tile) : null;
  const kept = ordered.slice(0, 1);
  if (reason && ordered.includes(reason.lesson) && !kept.includes(reason.lesson)) kept.push(reason.lesson);
  else if (ordered.length > 1) kept.push(ordered[1]);
  for (const [id, f] of Object.entries(facts)) {
    const slip = kept.includes(id);
    add(id, f.chance || slip, slip, f.followed && !slip);
  }
  return kept[0] ?? null;
}

function claimRules(step, add) {
  const chosen = step.chosen;
  const takes = chosen.type === 'chi' || chosen.type === 'pong';
  const g = { offers: step.offers, shantenIfPassed: step.shantenIfPassed, acceptanceIfPassed: step.acceptanceIfPassed };
  const offers = step.offers.filter((o) => o.action.type === 'chi' || o.action.type === 'pong');
  const poorTake = (o) => gradeClaimChoice(g, o.action).verdict === 'inaccuracy';
  const slips = [];

  // keep-a-pair: a Chi or Pong graded inaccuracy that would use a tile of the only pair.
  {
    const hand = step.table.players[0].hand;
    const pair = onlyPair(hand, step.table.players[0].melds?.length ?? 0);
    const uses = (a) => pair !== null && (a.type === 'pong' ? step.claimTile === pair : a.tiles.includes(pair));
    const chance = offers.some((o) => uses(o.action) && poorTake(o));
    const slip = chance && takes && uses(chosen) && step.verdict === 'inaccuracy';
    if (slip) slips.push('keep-a-pair');
    add('keep-a-pair', chance, slip, chance && !slip);
  }
  // claim-for-a-new-set: some Chi or Pong would be graded inaccuracy if taken.
  {
    const chance = offers.some(poorTake);
    const slip = chance && takes && step.verdict === 'inaccuracy';
    if (slip) slips.push('claim-for-a-new-set');
    add('claim-for-a-new-set', chance, slip, chance && !slip);
  }
  // take-helpful-claims: passing would be graded inaccuracy.
  {
    const chance = gradeClaimChoice(g, { type: 'pass' }).verdict === 'inaccuracy';
    const slip = chance && chosen.type === 'pass';
    if (slip) slips.push('take-helpful-claims');
    add('take-helpful-claims', chance, slip, chance && takes && !SLOW.has(step.verdict));
  }
  if (chosen.type === 'kong' && SLOW.has(step.speedVerdict)) {
    add('other-speed', true, true, false);
    slips.push('other-speed');
  }
  // The primary label names the cost: a claim that did not help, before the pair it used.
  return slips.includes('claim-for-a-new-set') ? 'claim-for-a-new-set' : slips[0] ?? null;
}

/**
 * labelStep(review, stepIndex) -> { slips, followed, chances, primary }: lesson ids (catalogue
 * order). Every slip is also a chance; a chance can be neither slipped nor followed. A discard
 * keeps at most 2 slips; primary is the slip that explains the step's cost (null with no slip).
 */
export function labelStep(review, stepIndex) {
  const step = review.steps[stepIndex];
  const found = new Map(); // id -> { slip, followed }
  const add = (id, chance, slip, followed) => {
    if (!chance && !slip) return;
    found.set(id, { slip, followed: followed && !slip });
  };
  let primary = null;
  const huOffered = step.table.offered.some((a) => a.type === 'hu');
  if (huOffered) {
    add('take-the-win', true, Boolean(step.missedWin), step.chosen.type === 'hu');
    if (step.missedWin) primary = 'take-the-win';
  } else if (step.chosen.type === 'discard') {
    primary = discardRules(step, add);
  } else if (step.kind === 'claim') {
    primary = claimRules(step, add);
  } else if (step.chosen.type === 'kong' && SLOW.has(step.speedVerdict)) {
    add('other-speed', true, true, false);
    primary = 'other-speed';
  }
  const pick = (f) => LESSON_IDS.filter((id) => found.has(id) && f(found.get(id)));
  return { slips: pick((x) => x.slip), followed: pick((x) => x.followed), chances: pick(() => true), primary };
}

const SPEED_LESSONS = new Set([...SPEED_PRIORITY, 'other-speed']);

/**
 * labelInvariantErrors(review, stepIndex, labels?) -> [strings]: what is wrong with a step's labels
 * (empty when they are sound). Checked over every study game in the tests:
 * slips and followed are chances and never both; at most 2 slips, the primary among them;
 * a followed speed lesson needs a speed verdict of best or fine, a followed safety lesson no
 * risky or reckless throw; a claim graded inaccuracy or mistake with followed lessons has a slip;
 * a followed lesson's wrong options never include a recommended (best) tile or the throw.
 */
export function labelInvariantErrors(review, stepIndex, labels = labelStep(review, stepIndex)) {
  const step = review.steps[stepIndex];
  const errs = [];
  const { slips, followed, chances, primary } = labels;
  for (const id of slips) if (!chances.includes(id)) errs.push(`slip ${id} is not a chance`);
  for (const id of followed) {
    if (!chances.includes(id)) errs.push(`followed ${id} is not a chance`);
    if (slips.includes(id)) errs.push(`${id} is both slipped and followed`);
  }
  if (slips.length > 2) errs.push(`${slips.length} slips`);
  if (slips.length ? !slips.includes(primary) : primary !== null) errs.push(`primary ${primary} does not match the slips`);
  const huOffered = step.table.offered.some((a) => a.type === 'hu');
  if (step.chosen.type === 'discard' && !huOffered) {
    const facts = discardFacts(step);
    for (const id of followed) {
      if (SPEED_LESSONS.has(id) && SLOW.has(step.speedVerdict)) errs.push(`followed ${id} on a speed ${step.speedVerdict}`);
      if (id === 'safety-under-threat' && ['risky', 'reckless'].includes(step.safetyVerdict)) errs.push(`followed safety on a ${step.safetyVerdict} throw`);
      const w = facts[id]?.wrong ?? [];
      if (w.some((t) => step.best.includes(t))) errs.push(`followed ${id} warns against a best tile`);
      if (w.includes(step.chosen.tile)) errs.push(`followed ${id} but threw one of its wrong options`);
    }
  } else if (step.kind === 'claim' && SLOW.has(step.verdict) && followed.length && !slips.length) {
    errs.push(`followed ${followed.join(', ')} on a claim graded ${step.verdict} with no slip to explain it`);
  }
  return errs;
}

const zeroTotals = () => Object.fromEntries(LESSON_IDS.map((id) => [id, { chances: 0, slips: 0, followed: 0 }]));

/**
 * labelGame(review) -> { ok: true, steps: [labels], facts, endPair, totals } (see the contract),
 * or { ok: false, error } for an unreviewable game.
 */
export function labelGame(review) {
  if (!review || review.ok !== true) return { ok: false, error: review?.error ?? 'no review' };
  const steps = review.steps.map((_, i) => labelStep(review, i));
  const r = review.meta.result;
  const won = r.type === 'win' && r.winner === 0;
  const finalShanten = review.timeline.length ? review.timeline.at(-1).shanten[0] : null;
  const first = review.summary.firstReadyStep;
  const facts = {
    finishedWithoutPair: !won && !review.summary.heldPairAtEnd && finalShanten !== null && finalShanten >= 0 && finalShanten <= 2,
    reachedReady: won || first !== null,
    firstReadyTurn: first !== null ? review.steps[first].turn : null,
    won,
    dealtIn: Boolean(review.summary.dealtIn),
    kongRobbed: review.summary.kongRobbedStep !== null,
  };
  // Game-level keep-a-pair: the end of a game that got close (won, or 0-2 from ready).
  let endPair = null;
  if (won || (finalShanten !== null && finalShanten >= 0 && finalShanten <= 2)) {
    endPair = facts.finishedWithoutPair ? 'slip' : 'followed';
  }
  const totals = zeroTotals();
  for (const s of steps) {
    for (const id of s.chances) totals[id].chances += 1;
    for (const id of s.slips) totals[id].slips += 1;
    for (const id of s.followed) totals[id].followed += 1;
  }
  if (endPair) {
    totals['keep-a-pair'].chances += 1;
    totals['keep-a-pair'][endPair === 'slip' ? 'slips' : 'followed'] += 1;
  }
  return { ok: true, steps, facts, endPair, totals };
}
