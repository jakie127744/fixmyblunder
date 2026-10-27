// Turns engine facts into one of five named patterns and one plain sentence.
// Stockfish judges; this file only labels. No language model is involved.
import { Chess } from '../vendor/chess/chess.js';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export const uciMove = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

/** Convert a UCI line to SAN from a FEN. Stops quietly at the first illegal move. */
export function pvToSan(fen, uciList, max = 5) {
  const c = new Chess(fen);
  const out = [];
  for (const u of (uciList || []).slice(0, max)) {
    try { out.push(c.move(uciMove(u)).san); } catch { break; }
  }
  return out;
}

/** Total value of queens, rooks, bishops and knights for both sides. */
export function nonPawnMaterial(fen) {
  let t = 0;
  for (const ch of fen.split(' ')[0]) {
    const l = ch.toLowerCase();
    if (/[a-z]/i.test(ch) && l !== 'p' && l !== 'k') t += VAL[l] || 0;
  }
  return t;
}

function hangingInfo(fenBefore, playedUci, replyUci) {
  if (!replyUci) return null;
  const c = new Chess(fenBefore);
  let mv, reply;
  try { mv = c.move(uciMove(playedUci)); reply = c.move(uciMove(replyUci)); } catch { return null; }
  if (!reply.captured) return null;
  const vc = VAL[reply.captured], vk = VAL[reply.piece];
  const recapture = c.moves({ verbose: true }).some((m) => m.to === reply.to && m.captured);
  const gained = mv.captured ? VAL[mv.captured] : 0;
  const net = vc - (recapture ? vk : 0) - gained;
  if (vc < 3 || net < 2) return null;
  return { piece: reply.captured, sq: reply.to, reply: reply.san, net, recapture };
}

function bestKind(fenBefore, bestUci) {
  try {
    const m = new Chess(fenBefore).move(uciMove(bestUci));
    if (m.san.includes('#')) return 'mate';
    if (m.san.includes('+')) return 'check';
    if (m.captured) return 'capture';
    if (m.promotion) return 'promotion';
  } catch { /* ignore */ }
  return 'quiet';
}

function replyGivesCheck(fenBefore, playedUci, replyUci) {
  if (!replyUci) return false;
  try {
    const c = new Chess(fenBefore);
    c.move(uciMove(playedUci));
    return c.move(uciMove(replyUci)).san.includes('+');
  } catch { return false; }
}

/**
 * m: { fenBefore, playedUci, playedSan, bestUci, bestSan, wpBefore, wpAfter, wpLoss,
 *      before:{mate}, after:{mate, pv}, clock, baseTime }
 * returns { pattern, explain }
 */
export function classify(m) {
  const replyUci = m.after?.pv?.[0];
  const opp = m.fenBefore.split(' ')[1] === 'w' ? 'Black' : 'White';

  const hang = hangingInfo(m.fenBefore, m.playedUci, replyUci);
  if (hang) {
    return { pattern: 'hanging', explain: `Your ${NAME[hang.piece]} on ${hang.sq} could be taken${hang.recapture ? ' for too little in return' : ' for free'}. ${opp} played ${hang.reply}. ${m.bestSan} was safer.` };
  }
  if (m.before.mate > 0 && !(m.after.mate != null && m.after.mate < 0)) {
    return { pattern: 'tactic', explain: `You had checkmate in ${m.before.mate}. ${m.bestSan} was the move.` };
  }
  if (m.after.mate != null && m.after.mate > 0) {
    return { pattern: 'king', explain: `${m.playedSan} let ${opp} force checkmate. ${m.bestSan} kept your king safe.` };
  }
  if (nonPawnMaterial(m.fenBefore) <= 20) {
    const state = m.wpBefore >= 65 ? 'winning' : m.wpBefore >= 40 ? 'equal' : 'difficult';
    return { pattern: 'endgame', explain: `In this ending, ${m.playedSan} let a ${state} position slip. ${m.bestSan} keeps it.` };
  }
  if (replyGivesCheck(m.fenBefore, m.playedUci, replyUci) && m.wpLoss >= 15) {
    return { pattern: 'king', explain: `${m.playedSan} weakened your king and ${opp} answered with check. ${m.bestSan} was safer.` };
  }
  if (m.clock != null && m.clock <= Math.max(10, (m.baseTime || 0) * 0.08)) {
    return { pattern: 'time', explain: `You had ${Math.round(m.clock)} seconds left. ${m.playedSan} lost ground. ${m.bestSan} was better.` };
  }
  // Tactic only when the better move is forcing or the engine line actually wins material.
  const kind = bestKind(m.fenBefore, m.bestUci);
  const gain = materialGain(m.fenBefore, m.bestPv || [m.bestUci]);
  if (kind === 'mate' || kind === 'promotion' || gain >= 2 || ((kind === 'check' || kind === 'capture') && m.wpLoss >= 20)) {
    const what = kind === 'mate' ? 'mates' : gain >= 2 ? 'wins material' : kind === 'check' ? 'gives a strong check' : kind === 'promotion' ? 'promotes' : 'was a strong capture';
    return { pattern: 'tactic', explain: `${m.bestSan} ${what}. You played ${m.playedSan}.` };
  }
  if (m.wpBefore >= 70) {
    return { pattern: 'advantage', explain: `You were clearly better, and ${m.playedSan} let it slip. ${m.bestSan} kept the advantage.` };
  }
  return { pattern: 'positional', explain: `${m.bestSan} was the better move here, with no tactic involved. You played ${m.playedSan}.` };
}

/** Material the mover gains along an engine line (pawn=1 ... queen=9), over at most 4 plies. */
export function materialGain(fen, uciList) {
  const c = new Chess(fen);
  const me = c.turn();
  const diff = () => {
    let d = 0;
    for (const row of c.board()) for (const sq of row) if (sq && sq.type !== 'k') d += (sq.color === me ? 1 : -1) * VAL[sq.type];
    return d;
  };
  const start = diff();
  let plies = Math.min(4, (uciList || []).length);
  if (plies > 1 && plies % 2 === 1) plies--;
  for (let i = 0; i < plies; i++) { try { c.move(uciMove(uciList[i])); } catch { break; } }
  return diff() - start;
}

/** Re-run classification on a stored mistake (no engine needed). */
export function reclassify(m, baseTime) {
  return classify({
    fenBefore: m.fen, playedUci: m.playedUci, playedSan: m.playedSan, bestUci: m.bestUci, bestSan: m.bestSan,
    bestPv: m.bestPvUci || [m.bestUci], wpBefore: m.wpBefore, wpAfter: m.wpBefore - m.wpLoss, wpLoss: m.wpLoss,
    before: { mate: m.bestMate }, after: { mate: m.afterMate ?? null, pv: m.replyUci ? [m.replyUci] : [] },
    clock: m.clock ?? null, baseTime,
  });
}
export const CLASSIFIER_VERSION = 2;
