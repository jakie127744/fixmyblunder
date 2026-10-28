// Drill creation, daily set, spaced repetition and streak. Pure functions over the stored state.
import { dayKey, parseDayKey, addDays, startOfDay, DAY } from './util.js';
import { PATTERN_ORDER } from './patterns.js';

export const INTERVALS = [1, 3, 7, 16, 35];   // days after a pass, by box
export const MASTERED_BOX = INTERVALS.length;  // passing the last box retires the drill
const MAX_PER_GAME = 3;
const MAX_ATTEMPT_MS = 120000;

/** Create a drill for each of a game's biggest mistakes. Existing drills keep their schedule. */
export function addDrillsFromGame(s, game) {
  const seen = new Set(Object.values(s.drills).map((d) => d.fen));
  let added = 0;
  for (const m of game.mistakes.slice(0, MAX_PER_GAME)) {
    if (s.drills[m.id] || seen.has(m.fen)) continue;
    s.drills[m.id] = { ...m, box: null, due: null, history: [], createdAt: Date.now() };
    seen.add(m.fen);
    added++;
  }
  return added;
}

export const gamesByDate = (s) => Object.values(s.games).sort((a, b) => b.date - a.date);

/**
 * The one aggregation behind Diagnose, Report and the week card. Every pattern figure in the app comes from here.
 *   count   = mistakes of that pattern in the given games
 *   cost    = sum of their win-chance losses (points)
 *   perGame = count / games, and costPerGame = cost / games
 *   per25   = count * 25 / games, the "per 25 games" normalisation (equals count when games is 25)
 */
export function tally(games) {
  const n = games.length;
  const by = Object.fromEntries(PATTERN_ORDER.map((p) => [p, { id: p, count: 0, cost: 0, perGame: 0, costPerGame: 0, per25: 0 }]));
  for (const g of games) for (const m of g.mistakes) { const t = by[m.pattern]; if (t) { t.count++; t.cost += m.wpLoss; } }
  for (const p of PATTERN_ORDER) {
    const t = by[p];
    t.perGame = n ? t.count / n : 0;
    t.costPerGame = n ? t.cost / n : 0;
    t.per25 = n ? (t.count * 25) / n : 0;
  }
  return { games: n, byPattern: by, list: PATTERN_ORDER.map((p) => by[p]).sort((a, b) => b.cost - a.cost) };
}

/** Per-pattern totals over the latest n games. cost = win-percentage points lost. */
export function patternStats(s, n = 25) {
  return tally(gamesByDate(s).slice(0, n));
}

/**
 * meta (optional): { hint, retried } from the drill screen. A solve is "deliberate" when it was right,
 * first try, with no hint, and at least MIN_THINK_MS passed since the position appeared. A fast solve never counts.
 */
export const MIN_THINK_MS = 5000;
export const isDeliberate = (ok, ms, meta = {}) => !!ok && !meta.hint && !meta.retried && ms >= MIN_THINK_MS;

export function gradeDrill(s, id, ok, ms, meta = {}) {
  const d = s.drills[id];
  if (!d) return;
  const now = Date.now();
  const early = d.box != null && d.due && d.due > dayKey(now);
  if (ok && early) {
    // practised ahead of schedule: counts as practice, leaves the schedule alone
  } else if (ok) {
    const next = (d.box ?? -1) + 1;
    d.box = Math.min(next, MASTERED_BOX);
    d.due = d.box >= MASTERED_BOX ? null : dayKey(addDays(now, INTERVALS[d.box]));
  } else {
    d.box = 0;
    d.due = dayKey(addDays(now, 1));
  }
  d.history.push({ t: now, ok });
  s.attempts.push({ t: now, id, ok, ms: Math.min(ms || 0, MAX_ATTEMPT_MS), deliberate: isDeliberate(ok, ms, meta) });
}

/**
 * Deliberate streak: drills in a row that were deliberate solves. A hint, a wrong or retried answer, a skip
 * or a rushed solve ends the run. Taking longer never does: the lock is a floor, not a timer that runs out.
 */
export function deliberateStreak(s) {
  let run = 0, best = 0;
  for (const a of s.attempts) {
    if (a.kind === 'puzzle') continue;
    if (a.deliberate) { run++; if (run > best) best = run; } else run = 0;
  }
  return { current: run, best };
}

export const isMastered = (d) => d.box != null && d.box >= MASTERED_BOX;

/** Today's set: a few reviews that are due, then new drills from the costliest pattern first. */
export function buildToday(s) {
  const key = dayKey();
  if (s.today && s.today.date === key && s.today.ids.length) return s.today;
  const size = s.settings.setSize;
  const all = Object.values(s.drills);
  const due = all.filter((d) => d.box != null && !isMastered(d) && d.due <= key).sort((a, b) => (a.due < b.due ? -1 : 1));
  const fresh = all.filter((d) => d.box == null);
  const rank = Object.fromEntries(patternStats(s).list.map((p, i) => [p.id, i]));
  fresh.sort((a, b) => rank[a.pattern] - rank[b.pattern] || b.wpLoss - a.wpLoss);
  const ids = due.slice(0, Math.ceil(size * 0.4)).map((d) => d.id);
  // new drills: up to 3 from the costliest pattern, then one at a time from each other pattern
  const groups = [];
  for (const d of fresh) { let g = groups.find((x) => x.p === d.pattern); if (!g) groups.push(g = { p: d.pattern, list: [] }); g.list.push(d); }
  const room = () => size - ids.length;
  if (groups[0]) for (const d of groups[0].list.slice(0, Math.min(3, room()))) ids.push(d.id);
  for (let round = 0; room() > 0 && groups.slice(1).some((g) => g.list.length > round); round++) {
    for (const g of groups.slice(1)) { if (room() > 0 && g.list[round]) ids.push(g.list[round].id); }
  }
  for (const d of fresh) { if (room() <= 0) break; if (!ids.includes(d.id)) ids.push(d.id); }
  for (const d of due) { if (room() <= 0) break; if (!ids.includes(d.id)) ids.push(d.id); }
  s.today = { date: key, ids };
  return s.today;
}

export function dueCount(s) {
  const key = dayKey();
  return Object.values(s.drills).filter((d) => d.box != null && !isMastered(d) && d.due <= key).length;
}

/** Missed or skipped drills come back the next day; reviews not yet due are unaffected. */
export function dueTomorrowCount(s) {
  const key = dayKey(addDays(Date.now(), 1));
  return Object.values(s.drills).filter((d) => d.box != null && !isMastered(d) && d.due === key).length;
}

/** Attempts logged today per drill id. */
export function todayResults(s) {
  const start = startOfDay(Date.now());
  const r = {};
  for (const a of s.attempts) if (a.t >= start) r[a.id] = a;
  return r;
}

/** Days that count toward the streak: at least `goal` drills attempted. */
export function activeDays(s, goal = 3) {
  const per = {};
  for (const a of s.attempts) { if (a.kind === 'puzzle') continue; const k = dayKey(a.t); (per[k] ||= new Set()).add(a.id); }
  return new Set(Object.keys(per).filter((k) => per[k].size >= goal));
}

/**
 * Streak with one rest day per week: a single missed day does not break it,
 * two misses within seven days do. Returns { current, longest, restUsedThisWeek, doneToday }.
 */
export function streak(s) {
  const days = activeDays(s, Math.min(3, s.settings.setSize));
  const todayTs = startOfDay(Date.now());
  const doneToday = days.has(dayKey(todayTs));
  const walk = (fromTs, lowest) => {
    let count = 0, lastGap = -99, ts = fromTs, i = 0;
    while (ts >= lowest) {
      if (days.has(dayKey(ts))) count++;
      else if (i - lastGap >= 7 && days.size) lastGap = i;
      else break;
      ts = addDays(ts, -1); i++;
    }
    return count;
  };
  const first = days.size ? Math.min(...[...days].map(parseDayKey)) : todayTs;
  const current = days.size ? walk(doneToday ? todayTs : addDays(todayTs, -1), first) : 0;
  // longest: replay forward
  let longest = 0, run = 0, lastGap = -99, i = 0;
  for (let ts = first; ts <= todayTs; ts = addDays(ts, 1), i++) {
    if (days.has(dayKey(ts))) { run++; longest = Math.max(longest, run); }
    else if (i - lastGap >= 7 && run > 0) lastGap = i;
    else { run = 0; }
  }
  const week = [];
  for (let k = 6; k >= 0; k--) { const ts = addDays(todayTs, -k); week.push({ ts, done: days.has(dayKey(ts)), today: k === 0 }); }
  return { current, longest: Math.max(longest, current), doneToday, week };
}

/** Whole minutes trained; any training at all counts as at least one minute. */
export const minutesTrained = (s, fromTs = 0, toTs = Infinity) => {
  const ms = s.attempts.filter((a) => a.t >= fromTs && a.t < toTs).reduce((t, a) => t + a.ms, 0);
  return ms > 0 ? Math.max(1, Math.round(ms / 60000)) : 0;
};
export { DAY };

/** Puzzle practice from Lichess, kept apart from drills built from your own games. */
export const puzzleAttempts = (s) => s.attempts.filter((a) => a.kind === 'puzzle');
export function puzzleStats(s) {
  const all = puzzleAttempts(s), start = startOfDay(Date.now());
  const today = all.filter((a) => a.t >= start);
  return { total: all.length, solved: all.filter((a) => a.ok).length, todayTried: today.length, todaySolved: today.filter((a) => a.ok).length };
}

/**
 * Extra drills from your own games beyond today's set. Due reviews first, then new drills spread
 * across patterns (or one pattern), then reviews that are not due yet. Skips anything tried today.
 */
export function extraDrills(s, n, pattern = 'all') {
  const key = dayKey();
  const res = todayResults(s);
  const pool = Object.values(s.drills).filter((d) => !isMastered(d) && !res[d.id] && (pattern === 'all' || d.pattern === pattern));
  const due = pool.filter((d) => d.box != null && d.due <= key).sort((a, b) => (a.due < b.due ? -1 : 1));
  const fresh = pool.filter((d) => d.box == null);
  const later = pool.filter((d) => d.box != null && d.due > key).sort((a, b) => (a.due < b.due ? -1 : 1));
  const rank = Object.fromEntries(patternStats(s).list.map((p, i) => [p.id, i]));
  const groups = {};
  for (const d of fresh.sort((a, b) => b.wpLoss - a.wpLoss)) (groups[d.pattern] ||= []).push(d);
  const order = Object.keys(groups).sort((a, b) => rank[a] - rank[b]);
  const mixed = [];
  for (let i = 0; mixed.length < fresh.length; i++) for (const p of order) if (groups[p][i]) mixed.push(groups[p][i]);
  return [...due, ...mixed, ...later].slice(0, n).map((d) => d.id);
}
