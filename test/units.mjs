// Fast checks for the pure logic. Run: npm test
import assert from 'node:assert/strict';
import { winPct, moveAccuracy } from '../public/js/score.js';
import { classify, pvToSan, nonPawnMaterial, materialGain, reclassify, lineLoss } from '../public/js/classify.js';
import { gradeDrill, streak, INTERVALS, buildToday, addDrillsFromGame, extraDrills, puzzleStats, tally, patternStats, deliberateStreak, isDeliberate, dueTomorrowCount } from '../public/js/srs.js';
import { parsePgn, readPgn, fromPgnText, MIN_PLIES, skipText } from '../public/js/importer.js';
import { allTime, weekly } from '../public/js/report.js';
import { clearAccountData, state } from '../public/js/store.js';
import { SAMPLE_DRILLS } from '../public/js/samples.js';
import { Chess } from '../public/vendor/chess/chess.js';
import { dayKey, addDays } from '../public/js/util.js';
import { reminderIcs, validTime } from '../public/js/reminder.js';
import { buildLesson, walkLine, lineText, points } from '../public/js/lessons.js';
import { Engine } from '../public/js/engine.js';

const t = (name, fn) => { fn(); console.log('ok  ', name); };
const blank = () => ({ games: {}, drills: {}, attempts: [], today: null, settings: { setSize: 5 } });

t('win percentage is symmetric and bounded', () => {
  assert.equal(Math.round(winPct(0)), 50);
  assert.ok(winPct(1000) > 95 && winPct(-1000) < 5);
  assert.ok(Math.abs(winPct(300) + winPct(-300) - 100) < 1e-9);
});
t('accuracy is 100 for no loss and falls with loss', () => {
  assert.ok(moveAccuracy(0) > 99);
  assert.ok(moveAccuracy(30) < moveAccuracy(10));
});
t('pvToSan converts and stops at illegal moves', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.deepEqual(pvToSan(start, ['e2e4', 'e7e5', 'g1f3']), ['e4', 'e5', 'Nf3']);
  assert.deepEqual(pvToSan(start, ['e2e4', 'e2e4']), ['e4']);
});
t('hanging a queen to a pawn is classified as hanging', () => {
  // White queen d4 moves to d5 where the black pawn on e6 takes it.
  const fen = '4k3/8/4p3/8/3Q4/8/8/4K3 w - - 0 1';
  const r = classify({ fenBefore: fen, playedUci: 'd4d5', playedSan: 'Qd5', bestUci: 'd4a4', bestSan: 'Qa4+', wpBefore: 90, wpAfter: 10, wpLoss: 80, before: { mate: null }, after: { mate: null, pv: ['e6d5'] }, clock: null });
  assert.equal(r.pattern, 'hanging');
  assert.match(r.explain, /queen on d5/);
});
t('missed mate in one is a tactic', () => {
  const fen = '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1';
  const r = classify({ fenBefore: fen, playedUci: 'g1h1', playedSan: 'Kh1', bestUci: 'e1e8', bestSan: 'Re8#', wpBefore: 99, wpAfter: 60, wpLoss: 39, before: { mate: 1 }, after: { mate: null, pv: ['g8h8'] }, clock: null });
  assert.equal(r.pattern, 'tactic');
  assert.match(r.explain, /checkmate in 1/);
});
t('few pieces on the board means endgame', () => {
  assert.ok(nonPawnMaterial('4k3/8/8/8/8/8/4P3/R3K2R w - - 0 1') <= 20);
  assert.ok(nonPawnMaterial('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') > 20);
});
t('spaced repetition: pass climbs a box, miss resets to tomorrow', () => {
  const s = blank();
  s.drills.a = { id: 'a', box: null, due: null, history: [], pattern: 'tactic', wpLoss: 20, fen: 'x' };
  gradeDrill(s, 'a', true, 5000);
  assert.equal(s.drills.a.box, 0);
  assert.equal(s.drills.a.due, dayKey(addDays(Date.now(), INTERVALS[0])));
  gradeDrill(s, 'a', true, 5000);               // practised early: schedule unchanged
  assert.equal(s.drills.a.box, 0);
  s.drills.a.due = dayKey();                    // now due
  gradeDrill(s, 'a', true, 5000);
  assert.equal(s.drills.a.box, 1);
  gradeDrill(s, 'a', false, 5000);
  assert.equal(s.drills.a.box, 0);
  assert.equal(s.drills.a.due, dayKey(addDays(Date.now(), 1)));
});
t('streak survives one rest day a week but not two', () => {
  const s = blank();
  const day = (n, k) => { for (let i = 0; i < 3; i++) s.attempts.push({ t: addDays(Date.now(), -n) + i * 1000, id: `d${n}-${i}`, ok: true, ms: 1000 }); };
  [0, 1, 3, 4].forEach(day); // gap on day 2 only
  assert.equal(streak(s).current, 4);
  const s2 = blank();
  const day2 = (n) => { for (let i = 0; i < 3; i++) s2.attempts.push({ t: addDays(Date.now(), -n) + i * 1000, id: `e${n}-${i}`, ok: true, ms: 1000 }); };
  [0, 1, 4, 5].forEach(day2); // two missed days in a row
  assert.equal(streak(s2).current, 2);
});
t("today's set mixes patterns instead of five of one kind", () => {
  const s = blank();
  const mk = (p, i) => { s.drills[`${p}${i}`] = { id: `${p}${i}`, pattern: p, box: null, due: null, history: [], wpLoss: 30 - i, fen: p + i, ply: 20 }; };
  for (let i = 0; i < 6; i++) mk('tactic', i);
  for (let i = 0; i < 3; i++) mk('endgame', i);
  mk('king', 0);
  s.games.g = { id: 'g', date: Date.now(), mistakes: Object.values(s.drills).map((d) => ({ pattern: d.pattern, wpLoss: d.wpLoss })) };
  const ids = buildToday(s).ids;
  assert.equal(ids.length, 5);
  assert.ok(new Set(ids.map((i) => s.drills[i].pattern)).size >= 3);
});
t('PGN with clock comments parses to the common shape', () => {
  const pgn = '[Event "x"]\n[White "me"]\n[Black "you"]\n[Result "1-0"]\n[TimeControl "300"]\n\n1. e4 {[%clk 0:04:58]} e5 {[%clk 0:04:57]} 2. Nf3 {[%clk 0:04:50]} Nc6 {[%clk 0:04:55]} 3. Bb5 {[%clk 0:04:40]} a6 {[%clk 0:04:50]} 4. Ba4 {[%clk 0:04:30]} Nf6 {[%clk 0:04:45]} 5. O-O {[%clk 0:04:20]} Be7 {[%clk 0:04:40]} 6. Re1 {[%clk 0:04:10]} b5 {[%clk 0:04:35]} 1-0';
  const g = parsePgn(pgn, 'ME');
  assert.equal(g.color, 'white');
  assert.equal(g.result, 'win');
  assert.equal(g.moves.length, 12);
  assert.equal(g.baseTime, 300);
  assert.equal(g.clocks[0], 298);
});
t('lesson explains a hanging queen and shows the continuation', () => {
  const L = buildLesson({ fen: '4k3/8/4p3/8/3Q4/8/8/4K3 w - - 0 1', playedUci: 'd4d5', bestUci: 'd4a4', refPv: ['e6d5'], bestRest: ['e8e7'], wpBefore: 90, wpLoss: 80 });
  assert.equal(L.played.steps.length, 2);
  assert.equal(L.played.text, '1. Qd5 exd5');
  assert.match(L.played.points.join(' '), /where Black's pawn can take it/);
  assert.match(L.played.points.join(' '), /9 points \(a queen\) down/);
  assert.match(L.played.steps[1].note, /takes your queen on d5/);
  assert.equal(L.best.steps[0].san, 'Qa4+');
  assert.match(L.best.points[0], /gives check/);
});
t('lesson names a missed mate instead of calling the move merely worse', () => {
  const L = buildLesson({ fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', playedUci: 'g1h1', bestUci: 'e1e8', refPv: ['g8h8'], bestRest: [], bestMate: 1, wpBefore: 99, wpLoss: 39 });
  assert.match(L.played.points[0], /checkmate in 1/);
  assert.match(L.best.points[0], /is checkmate/);
});
t('lesson stops quietly at an illegal engine move', () => {
  const L = buildLesson({ fen: '4k3/8/4p3/8/3Q4/8/8/4K3 w - - 0 1', playedUci: 'd4d5', bestUci: 'd4a4', refPv: ['a1a2', 'e6d5'], bestRest: [], wpBefore: 90, wpLoss: 80 });
  assert.equal(L.played.steps.length, 1);
});
t('lesson for the best move explains why it is best', () => {
  const L = buildLesson({ fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', playedUci: 'e1e8', bestUci: 'e1e8', bestMate: 1 });
  assert.equal(L.verdict, 'best');
  assert.match(L.played.title, /best move/);
});
t('allowing a forced mate is labelled king safety (mate score is you-mated when negative)', () => {
  const r = classify({ fenBefore: '7k/8/8/8/8/8/5PPP/6K1 w - - 0 1', playedUci: 'g1h1', playedSan: 'Kh1', bestUci: 'f2f3', bestSan: 'f3', wpBefore: 50, wpAfter: 0, wpLoss: 50, before: { mate: null }, after: { mate: -2, pv: ['h8g8'] }, clock: null });
  assert.equal(r.pattern, 'king');
  assert.match(r.explain, /force checkmate/);
});
t('walking into a fork is a tactic against you, not a positional slip', () => {
  const fen = 'k7/8/8/8/3n4/8/P2Q4/6K1 w - - 0 1';
  const r = classify({ fenBefore: fen, playedUci: 'a2a3', playedSan: 'a3', bestUci: 'd2d4', bestSan: 'Qxd4', bestPv: ['d2d4'], wpBefore: 90, wpAfter: 20, wpLoss: 70, before: { mate: null }, after: { mate: null, pv: ['d4f3', 'g1h1', 'f3d2', 'h1g1'] }, clock: null });
  assert.equal(r.pattern, 'tactic');
  assert.match(r.explain, /walked into a tactic/);
  assert.match(r.explain, /9 points/);
});
t('a check reply only means king safety when the move was near the king', () => {
  const fen = 'rn2k2r/8/8/8/8/8/Q7/R3K3 w - - 0 1';
  const r = classify({ fenBefore: fen, playedUci: 'a2b2', playedSan: 'Qb2', bestUci: 'a1a8', bestSan: 'Rxa8', wpBefore: 50, wpAfter: 25, wpLoss: 25, before: { mate: null }, after: { mate: null, pv: ['h8h1'] }, clock: null });
  assert.notEqual(r.pattern, 'king');
});
t('very little time is time trouble even in an ending', () => {
  const r = classify({ fenBefore: '4k3/8/8/8/8/8/4P3/R3K2R w - - 0 1', playedUci: 'e2e3', playedSan: 'e3', bestUci: 'a1a8', bestSan: 'Ra8+', wpBefore: 60, wpAfter: 40, wpLoss: 20, before: { mate: null }, after: { mate: null, pv: ['e8d7'] }, clock: 5, baseTime: 300 });
  assert.equal(r.pattern, 'time');
});

const game = (pgnMoves, { white = 'me', black = 'you', result = '1-0' } = {}) => `[Event "x"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n${pgnMoves} ${result}`;
const SHORT = game('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6', { black: 'Opp' });                        // 8 plies
const LONG = game('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5');                      // 12 plies
t('a short game is skipped for being short, not for the username (B1, B2)', () => {
  const r = readPgn(SHORT, 'me');
  assert.equal(r.reason, 'short');
  assert.equal(r.plies, 8);
  assert.match(skipText(r), new RegExp(`${MIN_PLIES} minimum`));
});
t('a real name mismatch is reported as a name mismatch', () => {
  assert.equal(readPgn(LONG, 'someone else').reason, 'name');
});
t('pasting 3 games returns counts and a reason for the skipped one (B1)', () => {
  const r = fromPgnText([LONG, SHORT, LONG.replace('b5 1-0', 'b5 7. Bb3 d6 1-0')].join('\n\n'), 'me');
  assert.equal(r.pasted, 3);
  assert.equal(r.games.length, 2);
  assert.deepEqual(r.skipped.map((x) => x.reason), ['short']);
});
t('unfinished games are not called draws (B5)', () => {
  const mv = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5';
  assert.equal(parsePgn(game(mv, { result: '*' }), 'me').result, 'unfinished');
  assert.equal(parsePgn(game(mv, { result: '1/2-1/2' }), 'me').result, 'draw');
});
const mk = (id, date, ms) => ({ id, date, accuracy: 80, mistakes: ms.map((p, i) => ({ id: `${id}:${i}`, pattern: p, wpLoss: 10 + i, ply: 20 + i, fen: `${id}${i}` })) });
t('Report all-time figures equal the Diagnose figures (A2)', () => {
  const s = blank();
  const pats = ['hanging', 'tactic', 'advantage', 'positional', 'king', 'endgame', 'time'];
  for (let i = 0; i < 25; i++) s.games['g' + i] = mk('g' + i, Date.now() - i * 86400000, pats.slice(0, (i % 4) + 1));
  const dg = patternStats(s), a = allTime(s);
  assert.equal(a.lateGames, 25);
  for (const p of a.patterns) {
    const d = dg.list.find((x) => x.id === p.id);
    assert.equal(p.nowCount, d.count);
    assert.equal(p.now, Math.round(d.count * 10) / 10);                         // per 25 games with 25 games = the count itself
    assert.equal(p.nowCost, Math.round(d.cost / 25 * 10) / 10);
  }
  assert.equal(weekly(s).topPattern, dg.list[0].id);                            // week card ranks patterns the way Diagnose does
});
t('Report uses the same latest-25 window as Diagnose when more games are stored (A2)', () => {
  const s = blank();
  for (let i = 0; i < 40; i++) s.games['g' + i] = mk('g' + i, Date.now() - i * 86400000, i % 2 ? ['tactic'] : ['tactic', 'hanging']);
  const a = allTime(s), dg = patternStats(s);
  assert.equal(a.lateGames, 25);
  assert.equal(a.patterns.find((p) => p.id === 'hanging').nowCount, dg.byPattern.hanging.count);
});
t('account switch leaves no data behind (A1)', () => {
  const s = state();
  s.profile = { source: 'pgn', username: 'a' }; s.games.x = mk('x', 1, ['tactic']); s.drills.y = { id: 'y' }; s.attempts.push({ t: 1, id: 'y', ok: true, ms: 1 }); s.today = { date: 'd', ids: ['y'] }; s.lastSync = 5; s.puzzleSeen = ['p'];
  clearAccountData();
  assert.equal(Object.keys(s.games).length + Object.keys(s.drills).length + s.attempts.length, 0);
  assert.equal(s.profile, null); assert.equal(s.today, null); assert.equal(s.lastSync, null); assert.equal(s.puzzleSeen, undefined);
  assert.equal(s.settings.thinkSecs, 5);                                        // device settings stay, and Think first defaults to 5 s (E1)
});
t('a capture is never called "no tactic involved" (C4)', () => {
  const base = { playedUci: 'a2a3', playedSan: 'a3', wpBefore: 55, wpAfter: 40, wpLoss: 15, before: { mate: null }, after: { mate: null, pv: ['e8e7'] }, clock: null };
  const fen = 'r3k2r/pppqbppp/2n1pn2/3p4/3P4/2N1PN2/PPP2PPP/R2QKB1R w KQkq - 0 1';
  const cap = classify({ ...base, fenBefore: fen, bestUci: 'c3d5', bestSan: 'Nxd5' });
  assert.equal(cap.pattern, 'positional');
  assert.doesNotMatch(cap.explain, /no tactic/);
  const quiet = classify({ ...base, fenBefore: fen, bestUci: 'f1e2', bestSan: 'Be2' });
  assert.match(quiet.explain, /no tactic involved/);
});
t('deliberate streak: only first-try, no-hint, post-5s solves advance it (E2)', () => {
  assert.equal(isDeliberate(true, 6000, {}), true);
  assert.equal(isDeliberate(true, 2000, {}), false);                            // fast
  assert.equal(isDeliberate(true, 9000, { hint: true }), false);
  assert.equal(isDeliberate(true, 9000, { retried: true }), false);
  assert.equal(isDeliberate(false, 9000, {}), false);
  const s = blank();
  const add = (id, ok, ms, meta) => { s.drills[id] = { id, box: null, due: null, history: [] }; gradeDrill(s, id, ok, ms, meta); };
  add('a', true, 8000, {}); add('b', true, 8000, {});
  assert.equal(deliberateStreak(s).current, 2);
  add('c', true, 1500, {});                                                    // rushed: does not count
  assert.equal(deliberateStreak(s).current, 0);
  add('d', true, 30000, {});                                                   // taking longer never hurts
  assert.equal(deliberateStreak(s).current, 1);
});
t('a missed drill shows as due tomorrow, not due today (C2)', () => {
  const s = blank();
  s.drills.a = { id: 'a', box: null, due: null, history: [] };
  gradeDrill(s, 'a', false, 3000, {});
  assert.equal(dueTomorrowCount(s), 1);
});
t('built-in sample drills are legal positions whose best move is legal', () => {
  for (const d of SAMPLE_DRILLS) {
    const c = new Chess(d.fen);
    assert.ok(c.move({ from: d.bestUci.slice(0, 2), to: d.bestUci.slice(2, 4) }), d.id);
    assert.equal(c.history()[0], d.bestSan);
  }
});
console.log('\nall passed');
