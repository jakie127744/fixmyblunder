// Plays a game through the engine on this device and returns accuracy plus the user's mistakes.
import { Chess } from '../vendor/chess/chess.js';
import { winPct, moveAccuracy, mean, round1 } from './score.js';
import { classify, pvToSan } from './classify.js';
import { MIN_PLIES } from './importer.js';

const BOOK_PLIES = 8;        // opening moves are not judged
export const MISTAKE_WP = 10;       // percentage points of win chance lost

export async function analyzeGame(game, engine, { movetime = 70, onProgress } = {}) {
  const chess = new Chess();
  const fens = [chess.fen()];
  const ucis = [], sans = [];
  for (const san of game.moves) {
    let m;
    try { m = chess.move(san); } catch { break; }
    ucis.push(m.from + m.to + (m.promotion || ''));
    sans.push(m.san);
    fens.push(chess.fen());
  }
  const n = sans.length;
  if (n < MIN_PLIES) return null;   // same minimum the importer enforces
  const finalOver = chess.isGameOver();
  const finalMate = chess.isCheckmate();

  const evals = new Array(n + 1);
  engine.newGame();
  for (let i = BOOK_PLIES; i <= n; i++) {
    if (i === n && finalOver) evals[i] = { cp: finalMate ? -1000 : 0, cpc: finalMate ? -1000 : 0, mate: finalMate ? 0 : null, best: null, pv: [] };
    else evals[i] = await engine.evaluate(fens[i], { movetime });
    if (onProgress) onProgress(i - BOOK_PLIES + 1, n - BOOK_PLIES + 1);
  }

  const userIsWhite = game.color === 'white';
  const accs = [], found = [];
  for (let i = BOOK_PLIES; i < n; i++) {
    if ((i % 2 === 0) !== userIsWhite) continue;
    const before = evals[i], after = evals[i + 1];
    const wpBefore = winPct(before.cpc), wpAfter = winPct(-after.cpc);
    const played = ucis[i];
    const wpLoss = played === before.best ? 0 : Math.max(0, wpBefore - wpAfter);
    accs.push(moveAccuracy(wpLoss));
    if (wpLoss < MISTAKE_WP || wpBefore < 12 || !before.best) continue;
    const bestSan = pvToSan(fens[i], [before.best], 1)[0] || before.best;
    const clock = game.clocks ? game.clocks[i] ?? null : null;
    const { pattern, explain } = classify({
      fenBefore: fens[i], playedUci: played, playedSan: sans[i], bestUci: before.best, bestSan,
      wpBefore, wpAfter, wpLoss, before: { mate: before.mate }, bestPv: before.pv,
      after: { mate: after.mate == null ? null : -after.mate, pv: after.pv }, clock, baseTime: game.baseTime,
    });
    found.push({
      id: `${game.id}:${i}`, gameId: game.id, ply: i, fen: fens[i], side: userIsWhite ? 'w' : 'b',
      playedSan: sans[i], playedUci: played, bestUci: before.best, bestSan,
      bestPv: pvToSan(fens[i], before.pv, 5), bestCp: before.cpc, bestMate: before.mate,
      cpAfter: -after.cpc, wpLoss: round1(wpLoss), wpBefore: round1(wpBefore), pattern, explain, clock,
      // kept so the classifier can be re-run later without the engine
      bestPvUci: before.pv.slice(0, 4), replyUci: after.pv[0] || null, afterPvUci: after.pv.slice(0, 6), afterMate: after.mate == null ? null : -after.mate,
    });
  }
  found.sort((a, b) => b.wpLoss - a.wpLoss);
  // your win chance after each position, for the game review graph
  const curve = Array.from(evals, (e, i) => {
    if (!e) return null;
    const stm = winPct(e.cpc), white = i % 2 === 0 ? stm : 100 - stm;
    return Math.round(userIsWhite ? white : 100 - white);
  });
  return {
    id: game.id, source: game.source, url: game.url, date: game.date, color: game.color, result: game.result,
    opponent: game.opponent, userRating: game.userRating, oppRating: game.oppRating, speed: game.speed,
    baseTime: game.baseTime ?? null, sans, curve, plies: n, moves: Math.ceil(n / 2), accuracy: round1(mean(accs)), mistakes: found, analysedAt: Date.now(), movetime,
  };
}
