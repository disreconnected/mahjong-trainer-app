// Review screen view-model helpers: pure functions, no DOM; imports under Node.
// Used by reviewui.js; tested in test/reviewview.test.js.
import { suitOf, rankOf, isSuit, sortTiles } from './tiles.js';
import { shanten, waits as waitsOf } from './rules.js';
import { tileLabel } from './tileart.js';
import { NAMES } from './endscreen.js';
import { verdictLabel, distanceWords, GRADING } from './review.js';
import { riskLevelOf } from './safety.js';

// --- HTML escaping and the coach-notes Markdown renderer ---

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Escaped text with **bold** turned into <strong>. Unpaired ** stay as typed.
function inline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Tiny Markdown renderer for coach notes. Supports only: # and ## headings, paragraphs,
 * bullet lists (- or *), numbered lists (1. or 1)) and **bold**. Everything else is plain
 * text; all HTML in the input is escaped. Indented list items are treated as items of the
 * same flat list (no nesting).
 */
export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul'|'ol', items: [] }
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((t) => `<li>${inline(t)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,2})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const num = /^\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const tag = h[1].length === 1 ? 'h2' : 'h3';
      out.push(`<${tag}>${inline(h[2])}</${tag}>`);
    } else if (bullet || num) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet || num)[1]);
    } else if (list && /^\s/.test(raw)) {
      // An indented continuation line belongs to the last list item.
      list.items[list.items.length - 1] += ` ${line}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

// --- game list ---

const LEVELS = { easy: 'Easy bots', normal: 'Normal bots' };
const who = (p) => (p === 0 ? 'you' : NAMES[p]);
const whose = (p) => (p === 0 ? 'your' : `${NAMES[p]}'s`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// A log's result in plain words: "Bot 3 won by self-draw", "You won on Bot 1's discard", "Draw".
export function resultWords(result) {
  if (!result || !result.type) return 'Result unknown';
  if (result.type === 'draw') return 'Draw';
  const w = result.winner;
  if (![0, 1, 2, 3].includes(w)) return 'Result unknown';
  const verb = `${cap(who(w))} won`;
  if (result.kind === 'selfdraw') return `${verb} by self-draw`;
  if (result.kind === 'robkong') return `${verb} by robbing ${whose(result.from)} Kong`;
  if ([0, 1, 2, 3].includes(result.from)) return `${verb} on ${whose(result.from)} discard`;
  return verb;
}

// Game number from a log file name ("..._game-07.json" -> 7), or null.
export function gameNumberOf(file) {
  const m = /_game-(\d+)(?:_[A-Za-z0-9-]+)?\.json$/.exec(String(file));
  return m ? Number(m[1]) : null;
}

// Start time of a details entry: startedAt, else the stamp in the file name (local time).
export function startDateOf(entry) {
  const t = Date.parse(entry && entry.startedAt);
  if (Number.isFinite(t)) return new Date(t);
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_/.exec(String(entry && entry.file));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/**
 * Text of one row in the game list, from a GET /api/logs?details=1 entry:
 * { title: 'Game 1', when: '18 Nov 2026, 17:30' (local), level: 'Easy bots', result, notes: bool }.
 */
export function listRowText(entry, locale = undefined) {
  const n = gameNumberOf(entry.file);
  const d = startDateOf(entry);
  const when = d
    ? `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}, ` +
      `${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`
    : '';
  return {
    title: n === null ? String(entry.file) : `Game ${n}`,
    when,
    level: LEVELS[entry.botLevel] ?? 'Bot level unknown',
    result: resultWords(entry.result),
    notes: Boolean(entry.hasNotes),
  };
}

// Newest first (file names start with the date and time, then the game number).
export function sortNewestFirst(entries) {
  return [...entries].sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
}

// --- verdicts ---

const VERDICT_STYLE = {
  best: { cls: 'v-best', color: '#3fb56b' },
  fine: { cls: 'v-fine', color: '#9aa6b5' },
  inaccuracy: { cls: 'v-inaccuracy', color: '#f0a530' },
  mistake: { cls: 'v-mistake', color: '#e5533d' },
};

// { label, cls, color } for a verdict; colour is never used alone, the label goes with it.
// With gapSize 'large' an inaccuracy reads "Inaccuracy (large)".
export function verdictStyle(verdict, gapSize = null) {
  const s = VERDICT_STYLE[verdict];
  return s ? { label: verdictLabel(verdict, gapSize), ...s } : { label: '', cls: 'v-none', color: '#6b7685' };
}

export const isFlagged = (step) => step.verdict === 'mistake' || step.verdict === 'inaccuracy';

// Step indexes in the order the "Only mistakes and inaccuracies" filter visits them.
export function flaggedOrder(steps) {
  return steps.filter(isFlagged).map((s) => s.index);
}

// The step to go to from `current` in direction dir (+1 / -1), or null at the end.
// onlyFlagged: skip steps that are not mistakes or inaccuracies.
export function nextStep(steps, current, dir, onlyFlagged = false) {
  const order = onlyFlagged ? flaggedOrder(steps) : steps.map((s) => s.index);
  if (dir > 0) return order.find((i) => i > current) ?? null;
  for (let k = order.length - 1; k >= 0; k--) if (order[k] < current) return order[k];
  return null;
}

// --- distances ---

const SUIT_NAMES = { m: 'Characters', p: 'Circles', s: 'Bamboo' };

// "6, 8, 9 of Bamboo", "2 of Circles and East wind": suited tiles grouped by suit.
export function tileListWords(codes) {
  const groups = [];
  const bySuit = new Map();
  for (const c of sortTiles([...new Set(codes)])) {
    if (isSuit(c)) {
      const s = suitOf(c);
      if (!bySuit.has(s)) {
        bySuit.set(s, []);
        groups.push({ suit: s });
      }
      bySuit.get(s).push(rankOf(c));
    } else groups.push({ label: tileLabel(c) });
  }
  const parts = groups.map((g) => (g.label ? g.label : `${bySuit.get(g.suit).join(', ')} of ${SUIT_NAMES[g.suit]}`));
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// A player's distance in words from their concealed hand and meld count (hidden information
// for opponents): "2 tiles from ready", "Ready: waiting on 6, 8, 9 of Bamboo".
export function opponentStatus(hand, meldCount) {
  const s = shanten(hand, meldCount);
  if (s < 0) return { shanten: s, text: 'A winning hand', ready: true, waits: [] };
  if (s === 0) {
    const ws = hand.length % 3 === 1 ? waitsOf(hand, meldCount) : [];
    return { shanten: 0, text: ws.length ? `Ready: waiting on ${tileListWords(ws)}` : 'Ready', ready: true, waits: ws };
  }
  return { shanten: s, text: `${s} tile${s === 1 ? '' : 's'} from ready`, ready: false, waits: [] };
}

// Timeline point that holds the state when a step was asked: the latest with n below step.n.
export function pointAtStep(timeline, n) {
  let at = timeline[0] ?? null;
  for (const p of timeline) {
    if (p.n < n) at = p;
    else break;
  }
  return at;
}

// --- chart ---

// y-axis label for a shanten value.
export function shantenAxisLabel(s) {
  if (s < 0) return 'won';
  if (s === 0) return 'ready';
  return `${s} away`;
}

/**
 * Geometry of the step chart. x: one slot per step (a single step is centred); y: distance
 * from winning, with the lowest shanten (closest to winning) at the top.
 * { count, minS, maxS, width, height, pad: { top, right, bottom, left } } ->
 * { x(i), y(s), ticks: [{ s, label, y }], xLabels: [i] }.
 */
export function chartGeometry({ count, minS, maxS, width, height, pad }) {
  const top = Math.min(minS, maxS);
  const bottom = Math.max(minS, maxS);
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const x = (i) => (count <= 1 ? pad.left + plotW / 2 : pad.left + (i * plotW) / (count - 1));
  const y = (s) => (bottom === top ? pad.top + plotH / 2 : pad.top + ((s - top) * plotH) / (bottom - top));
  const ticks = [];
  for (let s = top; s <= bottom; s++) ticks.push({ s, label: shantenAxisLabel(s), y: y(s) });
  // Step numbers along the axis: every step when there is room, else every 5th (and the last).
  const spacing = count <= 1 ? plotW : plotW / (count - 1);
  const every = spacing >= 22 ? 1 : 5;
  const xLabels = [];
  for (let i = 0; i < count; i++) if (i === 0 || i === count - 1 || (i + 1) % every === 0) xLabels.push(i);
  return { x, y, ticks, xLabels };
}

// --- small formatting ---

// 20066 -> "20.1 s", 246069 -> "4 min 6 s"
export function secondsWords(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

// --- step wording ---

const ACTION_NAMES = { chi: 'Chi', pong: 'Pong', kong: 'Kong', hu: 'Hu' };

// "Chi with 7, 9 of Characters", "Pong of 3 of Characters", "Hu (win)".
export function offerWords(action, claimTile) {
  if (action.type === 'chi') return `Chi with ${tileListWords(action.tiles)}`;
  if (action.type === 'hu') return 'Hu (win)';
  if (action.type === 'pass') return 'Pass';
  const tile = action.tile ?? claimTile;
  return `${ACTION_NAMES[action.type]}${tile ? ` of ${tileLabel(tile)}` : ''}`;
}

// Side-panel heading of a step: "Turn 5 of 15 · you drew 2 of Characters",
// "Claim offered: 8 of Characters from Bot 3".
export function stepHeading(step, steps, humanTurns) {
  if (step.kind === 'claim') {
    const what = step.robKong ? 'Rob the Kong offered' : 'Claim offered';
    return `${what}: ${tileLabel(step.claimTile)} from ${NAMES[step.claimFrom]}`;
  }
  const head = `Turn ${step.turn} of ${humanTurns}`;
  let how = '';
  const prev = steps[step.index - 1];
  if (step.drew) how = `you drew ${tileLabel(step.drew)}`;
  else if (prev && prev.kind === 'claim' && ['chi', 'pong'].includes(prev.chosen.type) && !prev.outranked) {
    how = `after your ${ACTION_NAMES[prev.chosen.type]}`;
  } else if (step.index === 0) how = 'your dealt hand';
  return how ? `${head} · ${how}` : head;
}

// What player 0 did, in words.
export function choiceWords(step) {
  const a = step.chosen;
  let text;
  if (a.type === 'discard') text = `You threw ${tileLabel(a.tile)}`;
  else if (a.type === 'pass') text = step.timedOut ? 'The claim window ran out, so you passed' : 'You passed';
  else if (a.type === 'hu') text = 'You declared Hu (a win)';
  else text = `You took ${offerWords(a, step.claimTile)}`;
  if (step.robbed) text += `, but ${NAMES[step.robbedBy]} robbed your Kong and won`;
  else if (step.outranked) text += ", but another player's claim came first";
  return text;
}

// The "Your hand" line of a step: "3 tiles from ready → 2 tiles from ready".
export function handLineWords(step) {
  if (step.missedWin) return `Complete (Hu was offered) → ${distanceWords(step.shantenAfter)} after your choice`;
  return `${distanceWords(step.shantenBefore)} → ${distanceWords(step.shantenAfter)}`;
}

// --- a game with no decisions (e.g. a bot won before player 0 was ever asked) ---

export const NO_DECISIONS_TEXT = 'You had no decisions in this game: it ended before your first turn.';

// Score shown in the game list.
export function rowScoreText(review) {
  return review.steps.length ? review.summary.score : 'No decisions';
}

// Think-time line of the summary: "12.0 s in total, 0.7 s per decision (median)", or "none".
export function thinkTimeWords(summary, stepCount) {
  if (!stepCount) return 'none';
  const median = summary.thinkMsMedian === null ? 'no' : secondsWords(summary.thinkMsMedian);
  return `${secondsWords(summary.thinkMsTotal)} in total, ${median} per decision (median)`;
}

// --- R3: safety and the extra step lines ---

const RISK_LABELS = { safe: 'Safe', low: 'Low', medium: 'Medium', high: 'High' };

export const CALM_RISK_TITLE = 'No opponent is close to winning, so risk matters little here';

// Chip for a discard option's risk: { label, cls, title }, or null without a known level.
// threatened false (no opponent close to winning): a muted chip, never the alarming colours.
export function riskChip(level, threatened = true) {
  if (!RISK_LABELS[level]) return null;
  if (!threatened) return { label: RISK_LABELS[level], cls: 'rv-risk rv-risk--muted', title: CALM_RISK_TITLE };
  return { label: RISK_LABELS[level], cls: `rv-risk rv-risk--${level}`, title: `${RISK_LABELS[level]} risk of dealing in` };
}

// U5: whom an option's risk is against, for the chip tooltip: "Against Bot 2 (high threat): Medium;
// Bot 3 (watch): Low". Only opponents at threat watch or high; '' when none.
export function riskAgainstWords(risk) {
  const list = (risk?.against || []).filter((a) => a.threat !== 'none');
  if (!list.length) return '';
  const one = (a) => `${NAMES[a.player]} (${a.threat === 'high' ? 'high threat' : 'watch'}): ${RISK_LABELS[riskLevelOf(a.weighted)]}`;
  return `Against ${list.map(one).join('; ')}`;
}

export const SAFEST_TITLE = 'Two or more opponents are a high threat: of these options, this one is the least likely to deal in against all of them together';

// "You spent a while on 2 choices where the options were equal or nearly equal: steps 1 and 5", or null.
export function longThinksLine(summary) {
  const list = summary.longEqualThinks ?? [];
  if (!list.length) return null;
  const nums = list.map((i) => String(i + 1));
  const which = nums.length === 1 ? `step ${nums[0]}` : `steps ${nums.slice(0, -1).join(', ')} and ${nums.at(-1)}`;
  return `You spent a while on ${list.length === 1 ? '1 choice' : `${list.length} choices`} where the options were equal or nearly equal: ${which}`;
}

// V2: the pace line is shown only from this many decisions over GRADING.slowThinkMs (30 s): one or
// two slow decisions are normal, three or more make pace worth a look.
export const PACE_MIN_SLOW = 3;

// "You spent 90% of the game thinking (5 min 14 s of 5 min 48 s); 4 decisions took over 30 s", or null
// with fewer than PACE_MIN_SLOW slow decisions. Without a game duration only the count is given.
export function paceLine(summary, durationMs) {
  const n = (summary.slowThinks ?? []).length;
  if (n < PACE_MIN_SLOW) return null;
  const slow = `${n} decisions took over ${Math.round(GRADING.slowThinkMs / 1000)} s`;
  if (summary.thinkShare === null || summary.thinkShare === undefined || !Number.isFinite(durationMs)) return cap(slow);
  return `You spent ${Math.round(summary.thinkShare * 100)}% of the game thinking ` +
    `(${secondsWords(summary.thinkMsTotal)} of ${secondsWords(durationMs)}); ${slow}`;
}

// U4 summary lines. Visible: "You were ready for 12 turns", or null when never ready.
export function readyTurnsLine(summary) {
  const n = summary.readyTurns;
  if (n === null || n === undefined) return null;
  return `You were ready for ${n === 1 ? '1 turn' : `${n} turns`}`;
}

// AA1, visible: one line per summary.drawThrowRuns entry: "From turn 9 to turn 16 you threw every tile
// you drew, as if ready, but you were 1 tile from ready. Count your sets before throwing the draw".
export function drawThrowLines(summary) {
  return (summary.drawThrowRuns ?? []).map((r) => {
    const away = r.shanten === r.shantenMax ? distanceWords(r.shanten) : `${r.shanten} to ${r.shantenMax} tiles from ready`;
    return `From turn ${r.fromTurn} to turn ${r.toTurn} you threw every tile you drew, as if ready, ` +
      `but you were ${away}. Count your sets before throwing the draw`;
  });
}

// Hidden information: "When you got ready you could count 5 winning tiles; 1 was really in the wall
// and 4 in opponents' hands, which they could still throw. At your last ready step: 3 you could
// count, 1 in the wall, 2 in opponents' hands", or null when never ready. W3: the copies in
// opponents' hands are not dead (Easy bots throw what they do not need); a count of 0 is left out.
export function readyWallLine(summary) {
  const w = summary.readyWall;
  if (!w) return null;
  const inHands = (n) => (n ? `${n} in opponents' hands` : null);
  const start = inHands(w.start.inOpponentHands);
  const text = `When you got ready you could count ${w.start.live} winning tiles; ${w.start.inWall} ${w.start.inWall === 1 ? 'was' : 'were'} really in the wall` +
    (start ? ` and ${start}, which they could still throw` : '');
  if (w.end.step === w.start.step) return text;
  const end = inHands(w.end.inOpponentHands);
  return `${text}. At your last ready step: ${w.end.live} you could count, ${w.end.inWall} in the wall${end ? `, ${end}` : ''}`;
}

// Hidden information: "1 near miss: step 23, the 3 of Bamboo while Bot 2 waited on the 4 of Bamboo", or null.
export function nearMissLine(summary) {
  const list = summary.nearMisses ?? [];
  if (!list.length) return null;
  const items = list.map((m) => `step ${m.step + 1}, ${tileLabel(m.tile)} while ${NAMES[m.player]} waited on ${tileLabel(m.wait)}`);
  return `${list.length === 1 ? '1 near miss' : `${list.length} near misses`} (you threw a tile next to a ready opponent's winning tile): ${items.join('; ')}`;
}

// X2, hidden information: one line per opponent who was ready with no sets showing, e.g. "Bot 3 was
// ready from 62 tiles left with no sets showing (waiting on the 1 of Characters or the Red dragon)".
// Y2: each later change of its waits while it stayed ready, e.g. ", then showed a set and from 59
// tiles left waited on the 2 of Characters or the 6 of Bamboo".
export function hiddenReadyLines(summary) {
  const on = (waits) => waits.map((t) => `the ${tileLabel(t)}`).join(' or ');
  return (summary.hiddenReady ?? []).map((h) => {
    let sets = 0;
    const later = (h.later ?? []).map((c) => {
      const showed = c.sets > sets ? `showed ${c.sets === 1 ? 'a set' : `${c.sets} sets`} and ` : '';
      sets = c.sets;
      return `, then ${showed}from ${c.wallLeft} tiles left waited on ${on(c.waits)}`;
    });
    return `${NAMES[h.player]} was ready from ${h.wallLeft} tiles left with no sets showing (waiting on ${on(h.waits)})${later.join('')}`;
  });
}

// "Bot 3 shows 3 sets (high threat) · Bot 1 shows 2 sets (watch)", or '' when nobody shows a threat.
export function threatLine(step) {
  const list = (step.threat || []).filter((t) => t.level !== 'none');
  return list.map((t) => `${t.reasons[0] ?? `${NAMES[t.player]} shows ${t.sets} sets`} (${t.level === 'high' ? 'high threat' : 'watch'})`).join(' · ');
}

const SAFETY_LABELS = { ok: 'OK', risky: 'Risky', reckless: 'Reckless', defensive: 'Defensive' };

// Speed and safety sub-labels under the combined verdict, when safety changed or qualified it:
// { speed: 'Best', safety: 'Reckless' }, else null.
export function subVerdicts(step) {
  if (!step.safetyVerdict || step.safetyVerdict === 'ok' || !step.speedVerdict) return null;
  return { speed: verdictLabel(step.speedVerdict), safety: SAFETY_LABELS[step.safetyVerdict] };
}

export const TIED_TEXT = 'These were equal; either was right.';

// V4: a neutral note when an opponent claimed player 0's discard: "Bot 2 Ponged this tile.", or null.
// A fact, not a criticism: it never changes a verdict or a lesson.
const CLAIMED_WORDS = { chi: 'took this tile for a Chi', pong: 'Ponged this tile', kong: 'took this tile for a Kong', hu: 'won on this tile' };
export function claimedNote(step) {
  const c = step.claimedBy;
  if (!c || !CLAIMED_WORDS[c.type]) return null;
  return `${NAMES[c.player]} ${CLAIMED_WORDS[c.type]}.`;
}

// Entries of the "What do these mean?" box on the Steps tab.
export const LEGEND_ENTRIES = Object.freeze([
  ['Best', 'The choice that keeps you closest to winning (or, when an opponent looks close, the fastest reasonably safe throw).'],
  ['Fine', 'Close enough to the best: up to 3 useful tiles or a fifth of them less, or a fair alternative.'],
  ['Inaccuracy', 'Noticeably slower than the best, or the same speed when a much safer tile was available.'],
  ['Inaccuracy (large)', 'At the same distance from ready, but more than 40% of the best throw\'s useful tiles lost.'],
  ['Mistake', 'Left you further from winning, missed a win, or a reckless throw.'],
  ['Useful tiles', 'Copies you could still draw that would bring your hand one step closer.'],
  ['Ready', 'One tile from winning.'],
  ['Threat', 'Easy bots: High at 3 or more face-up sets; Watch at 2 sets with 59 or fewer tiles left, or 1 set with 19 or fewer. ' +
    'Normal bots get ready sooner: High at 3 sets, 2 sets with 79 or fewer tiles left, or 1 set with 59 or fewer; Watch at 2 sets, or 1 set with 79 or fewer.'],
  ['Safe · Low · Medium · High', 'How likely the tile is to be a threatening opponent\'s winning tile, from what you could see. There is no furiten rule: a tile they threw earlier is not fully safe. ' +
    'Shown in grey when no opponent is close to winning.'],
  ['Reckless', 'A high-risk throw with your hand still 2 or more tiles from ready while a safe or low-risk tile was available.'],
  ['Risky', 'A high-risk throw when a tile just as fast was much safer.'],
  ['Defensive', 'You gave up some speed to throw a safer tile: never worse than Fine.'],
  ['Hindsight', 'What happened next. Shown only with hidden hands revealed; it never changes the grade.'],
]);
