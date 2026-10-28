// Weekly and all-time reports, computed from analysed games and drill attempts.
import { weekStart, addDays, DAY, dayKey, fmtDay, startOfDay } from './util.js';
import { PATTERN_ORDER, pat } from './patterns.js';
import { themeName } from './puzzles.js';
import { mean, round1 } from './score.js';
import { gamesByDate, patternStats, minutesTrained, streak, isMastered, puzzleStats } from './srs.js';

const perGame = (games) => {
  const out = Object.fromEntries(PATTERN_ORDER.map((p) => [p, 0]));
  for (const g of games) for (const m of g.mistakes) out[m.pattern]++;
  if (games.length) for (const p of PATTERN_ORDER) out[p] = out[p] / games.length;
  return out;
};

export function weekly(s, anyTs = Date.now()) {
  const from = weekStart(anyTs), to = addDays(from, 7);
  const all = gamesByDate(s);
  const inWeek = all.filter((g) => g.date >= from && g.date < to);
  const prevWeek = all.filter((g) => g.date >= addDays(from, -7) && g.date < from);
  const acc = inWeek.length ? round1(mean(inWeek.map((g) => g.accuracy))) : null;
  const prevAcc = prevWeek.length ? round1(mean(prevWeek.map((g) => g.accuracy))) : null;
  const trend = [];
  for (let k = 5; k >= 0; k--) {
    const a = addDays(from, -7 * k), b = addDays(a, 7);
    const gs = all.filter((g) => g.date >= a && g.date < b);
    trend.push({ ts: a, acc: gs.length ? round1(mean(gs.map((g) => g.accuracy))) : null, n: gs.length });
  }
  const attempts = s.attempts.filter((a) => a.t >= from && a.t < to && a.kind !== 'puzzle');
  const puzzles = s.attempts.filter((a) => a.t >= from && a.t < to && a.kind === 'puzzle');
  const days = new Set(attempts.map((a) => dayKey(a.t)));
  const drillsPassed = attempts.filter((a) => a.ok).length;
  // top pattern this week (fall back to latest 25 games when no games were played)
  const pool = inWeek.length ? inWeek : all.slice(0, 25);
  const counts = Object.fromEntries(PATTERN_ORDER.map((p) => [p, 0]));
  for (const g of pool) for (const m of g.mistakes) counts[m.pattern] += m.wpLoss;
  const top = PATTERN_ORDER.slice().sort((a, b) => counts[b] - counts[a])[0];
  const now = perGame(pool), before = perGame(all.filter((g) => g.date < from).slice(0, 25));
  const improving = all.filter((g) => g.date < from).length >= 5 && now[top] < before[top];
  const focus = patternStats(s).list[0];
  const hasData = pool.length > 0 || attempts.length > 0;
  return {
    from, to: to - DAY, isCurrent: weekStart(Date.now()) === from, hasData, games: inWeek.length, acc, prevAcc,
    delta: acc != null && prevAcc != null ? round1(acc - prevAcc) : null, trend,
    minutes: minutesTrained(s, from, to), daysTrained: days.size, drillsPassed, drillsTried: attempts.length, puzzlesSolved: puzzles.filter((a) => a.ok).length, puzzlesTried: puzzles.length,
    topPattern: top, topCount: Math.round(now[top] * 10) / 10, improving, focus: focus ? focus.id : top,
    streak: streak(s),
  };
}

export function allTime(s) {
  const all = gamesByDate(s).slice().reverse(); // oldest first
  const n = all.length;
  const firstTs = n ? all[0].date : Date.now();
  const spanDays = n ? Math.round((all[n - 1].date - firstTs) / DAY) : 0;
  const weeks = [];
  if (n) {
    for (let w = weekStart(firstTs); w <= Date.now(); w = addDays(w, 7)) {
      const gs = all.filter((g) => g.date >= w && g.date < addDays(w, 7));
      weeks.push({ ts: w, acc: gs.length ? round1(mean(gs.map((g) => g.accuracy))) : null, n: gs.length });
    }
  }
  const withData = weeks.filter((w) => w.acc != null);
  // Improvement means games played after training began against games played before it.
  // Imported history alone is a baseline, not progress.
  const firstDrill = s.attempts.find((a) => a.kind !== 'puzzle');
  const trainStart = firstDrill ? firstDrill.t : null;
  const before = trainStart ? all.filter((g) => g.date < trainStart).slice(-25) : all.slice(-25);
  const after = trainStart ? all.filter((g) => g.date >= trainStart) : [];
  const trainedDays = trainStart ? Math.round((Date.now() - trainStart) / DAY) : 0;
  const enough = before.length >= 10 && after.length >= 10 && trainedDays >= 14;
  const slice = enough ? Math.min(before.length, after.length, 25) : n;
  const early = enough ? before.slice(-slice) : all, late = enough ? after.slice(-slice) : all;
  const eAcc = n ? round1(mean(early.map((g) => g.accuracy))) : null;
  const lAcc = n ? round1(mean(late.map((g) => g.accuracy))) : null;
  const markerIdx = trainStart ? weeks.findIndex((w) => w.ts <= trainStart && trainStart < addDays(w.ts, 7)) : -1;
  const pe = perGame(early), pl = perGame(late);
  const patterns = PATTERN_ORDER.map((p) => ({ id: p, then: round1(pe[p] * 25), now: round1(pl[p] * 25) }))
    .filter((p) => p.then > 0 || p.now > 0)
    .sort((a, b) => b.then - a.then);
  const drills = Object.values(s.drills);
  const mastered = drills.filter(isMastered).length;
  const solved = s.attempts.filter((a) => a.ok && a.kind !== 'puzzle').length;
  const pz = puzzleStats(s);
  const st = streak(s);
  const milestones = [];
  if (n) milestones.push({ ts: firstTs, text: `Baseline set from ${n} analysed games` });
  const firstAtt = s.attempts.find((a) => a.kind !== 'puzzle');
  if (firstAtt) milestones.push({ ts: firstAtt.t, text: 'First drill solved' });
  let c = 0;
  for (const a of s.attempts) { if (a.kind !== 'puzzle' && a.ok && ++c === 100) { milestones.push({ ts: a.t, text: '100 drills solved' }); break; } }
  const firstMastered = drills.filter(isMastered).map((d) => d.history[d.history.length - 1].t).sort()[0];
  if (firstMastered) milestones.push({ ts: firstMastered, text: 'First mistake mastered, it stopped coming back' });
  if (withData.length > 1) {
    const base = withData[0].acc;
    const hit = withData.find((w) => w.acc >= base + 5);
    if (hit) milestones.push({ ts: hit.ts, text: `Weekly accuracy passed ${Math.round(base + 5)}%` });
  }
  milestones.sort((a, b) => b.ts - a.ts);
  return {
    games: n, spanDays, enough, firstTs, weeks, markerIdx, trainStart, trainedDays, beforeN: before.length, afterN: after.length, withData: withData.length, eAcc, lAcc,
    accDelta: eAcc != null && lAcc != null ? round1(lAcc - eAcc) : null, slice, patterns,
    solved, puzzlesSolved: pz.solved, mastered, minutes: minutesTrained(s), streak: st, milestones: milestones.slice(0, 5),
    totalMistakes: all.reduce((t, g) => t + g.mistakes.length, 0),
  };
}
export { fmtDay };

const pct = (ok, n) => (n ? Math.round((ok / n) * 100) : null);

/**
 * Puzzle practice report, separate from drills built from your own games.
 * period filters the theme table: day | week | month | all. sort: count | acc | name.
 */
export function puzzleReport(s, period = 'week', sort = 'count') {
  const att = s.attempts.filter((a) => a.kind === 'puzzle');
  const now = Date.now(), d = new Date(now);
  const starts = { day: startOfDay(now), week: weekStart(now), month: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), all: 0 };
  const sum = (list) => { const ok = list.filter((a) => a.ok).length; return { tried: list.length, solved: ok, acc: pct(ok, list.length) }; };
  const totals = Object.fromEntries(Object.entries(starts).map(([k, from]) => [k, sum(att.filter((a) => a.t >= from))]));
  const days = [];
  for (let k = 13; k >= 0; k--) {
    const a = startOfDay(addDays(now, -k)), b = addDays(a, 1);
    days.push({ ts: a, ...sum(att.filter((x) => x.t >= a && x.t < b)) });
  }
  const inPeriod = att.filter((a) => a.t >= starts[period]);
  const by = {};
  for (const a of inPeriod) (by[a.theme || '?'] ||= []).push(a);
  const themes = Object.entries(by).map(([id, list]) => ({ id, ...sum(list) }));
  const nm = (t) => (t.id === '?' ? 'zzz' : themeName(t.id).toLowerCase());
  const cmp = { count: (a, b) => b.tried - a.tried || nm(a).localeCompare(nm(b)), acc: (a, b) => b.acc - a.acc || b.tried - a.tried, name: (a, b) => nm(a).localeCompare(nm(b)) }[sort] || (() => 0);
  themes.sort(cmp);
  return { totals, days, themes, period, sort, hasData: att.length > 0 };
}
