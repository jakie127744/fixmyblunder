// Fast checks for the pure logic. Run: npm test
import assert from 'node:assert/strict';
import { winPct, moveAccuracy } from '../public/js/score.js';
import { classify, pvToSan, nonPawnMaterial, materialGain, reclassify, lineLoss } from '../public/js/classify.js';
import { gradeDrill, streak, INTERVALS, buildToday, addDrillsFromGame, extraDrills, puzzleStats } from '../public/js/srs.js';
import { parsePgn } from '../public/js/importer.js';
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
console.log('\nall passed');
