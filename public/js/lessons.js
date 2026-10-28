// Turns an engine line into plain English: why a move fails (or works) and what happens next.
// Stockfish supplies the lines; this file only describes them. No language model is involved.
import { Chess } from '../vendor/chess/chess.js';
import { uciMove } from './classify.js';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const SIDE = { w: 'White', b: 'Black' };
const other = (c) => (c === 'w' ? 'b' : 'w');

/** Material (pawn=1 ... queen=9) of `color` minus the other side, read straight from a FEN. */
function balance(fen, color) {
  let d = 0;
  for (const ch of fen.split(' ')[0]) {
    const l = ch.toLowerCase();
    if (!/[a-z]/i.test(ch) || l === 'k') continue;
    d += (ch === l ? 'b' : 'w') === color ? VAL[l] : -VAL[l];
  }
  return d;
}

/** "3 points (a minor piece)" so a beginner can read the size of a loss. */
export function points(n) {
  const note = { 1: ' (a pawn)', 3: ' (a minor piece)', 5: ' (a rook)', 9: ' (a queen)' }[n] || '';
  return `${n} ${n === 1 ? 'point' : 'points'}${note}`;
}

const flipTurn = (fen, color) => { const p = fen.split(' '); p[1] = color; p[3] = '-'; return p.join(' '); };

/** Captures `color` could make if it were their turn. Used to ask "what was already attacked?". */
function capturesBy(fen, color) {
  try { return new Chess(flipTurn(fen, color)).moves({ verbose: true }).filter((m) => m.captured); } catch { return []; }
}

/** Pieces worth winning that the piece on `sq` attacks: undefended, or worth more than the attacker. */
function winningThreats(fen, sq, color) {
  const out = [];
  try {
    const base = flipTurn(fen, color);
    for (const m of new Chess(base).moves({ square: sq, verbose: true })) {
      if (!m.captured || m.captured === 'k' || VAL[m.captured] < 3) continue;
      const c = new Chess(base);
      c.move({ from: m.from, to: m.to, promotion: m.promotion });
      const recapture = c.moves({ verbose: true }).some((x) => x.to === m.to && x.captured);
      if (!recapture || VAL[m.captured] > VAL[m.piece]) out.push({ sq: m.to, type: m.captured });
    }
  } catch { /* an unusual position: say nothing rather than guess */ }
  return out;
}

/** Play a UCI line from a FEN and record what each move did. Stops quietly at an illegal move. */
export function walkLine(fen, uciList, max = 9) {
  const c = new Chess(fen);
  const steps = [];
  for (const u of (uciList || []).slice(0, max)) {
    let m;
    try { m = c.move(uciMove(u)); } catch { break; }
    steps.push({
      uci: u, san: m.san, color: m.color, piece: m.piece, captured: m.captured || null, promotion: m.promotion || null,
      from: m.from, to: m.to, check: m.san.includes('+'), mate: m.san.includes('#'),
      castle: m.flags.includes('k') || m.flags.includes('q'), fenAfter: c.fen(),
    });
  }
  return steps;
}

/** Keep the part of a line that matters: up to the last capture, check or promotion, but at least `min` moves. */
function trim(steps, min, max) {
  const end = Math.min(steps.length, max);
  let last = -1;
  for (let i = 0; i < end; i++) if (steps[i].captured || steps[i].check || steps[i].mate || steps[i].promotion) last = i;
  return steps.slice(0, Math.min(end, Math.max(min, last + 1)));
}

/** "12. Bxf7+ Kxf7 13. Qh5+" (or "12... Qxd4 13. Nc3" when Black starts). */
export function lineText(fen, steps) {
  let n = +fen.split(' ')[5] || 1;
  const out = [];
  steps.forEach((s, i) => {
    if (s.color === 'w') out.push(`${n}. ${s.san}`);
    else { out.push(i === 0 ? `${n}... ${s.san}` : s.san); n++; }
  });
  return out.join(' ');
}

/** One sentence on what a single move does, from the point of view of the player who is learning (`mover`). */
function note(s, i, steps, mover) {
  const mine = s.color === mover, prev = steps[i - 1];
  const who = mine ? 'You' : SIDE[s.color];
  const v = (base) => base + (mine ? '' : 's');
  if (s.mate) return mine ? 'Checkmate. The game ends here and you win.' : 'Checkmate. The game ends here and you lose.';
  if (s.captured) {
    const back = prev && prev.captured && prev.to === s.to;
    const free = !capturesBy(s.fenAfter, other(s.color)).some((m) => m.to === s.to);
    let t = `${who} ${v('take')} ${mine ? "the opponent's" : 'your'} ${NAME[s.captured]} on ${s.to} with the ${NAME[s.piece]}${back ? ', winning the piece back' : ''}.`;
    if (free && !back) t += mine ? ' Nothing can take it back.' : ' You have nothing to take it back with.';
    if (s.check) t += ' It also gives check.';
    return t;
  }
  if (s.promotion) return `${who} ${v('promote')} the pawn on ${s.to} to a ${NAME[s.promotion]}.${s.check ? ' It gives check.' : ''}`;
  if (s.castle) return `${who} ${v('castle')}. The king gets safe and the rook joins the game.`;
  if (s.check && steps[i - 2] && steps[i - 2].check) return mine ? 'Another check. The king keeps getting driven.' : `${SIDE[s.color]} checks again. You still have to answer it.`;
  if (s.check) return mine ? 'You give check, so the opponent has to answer it first.' : `${SIDE[s.color]} checks your king. You have to deal with that before anything else.`;
  const th = winningThreats(s.fenAfter, s.to, s.color);
  if (th.length >= 2) {
    const [a, b] = th;
    return mine
      ? `This attacks the opponent's ${NAME[a.type]} on ${a.sq} and ${NAME[b.type]} on ${b.sq} at the same time.`
      : `This attacks your ${NAME[a.type]} on ${a.sq} and your ${NAME[b.type]} on ${b.sq} at the same time.`;
  }
  if (th.length === 1) return mine ? `This threatens to win the opponent's ${NAME[th[0].type]} on ${th[0].sq}.` : `This attacks your ${NAME[th[0].type]} on ${th[0].sq}.`;
  return `${mine ? 'Your' : `${SIDE[s.color]}'s`} ${NAME[s.piece]} goes to ${s.to}.`;
}

function buildSteps(fen, uciList, mover, min, max) {
  const steps = trim(walkLine(fen, uciList), min, max);
  let n = +fen.split(' ')[5] || 1;
  return steps.map((s, i) => {
    const label = s.color === 'w' ? `${n}.` : `${n}...`;
    if (s.color === 'b') n++;
    return { ...s, label, mine: s.color === mover, note: note(s, i, steps, mover) };
  });
}

const netOf = (fen, steps, mover) => (steps.length ? balance(steps[steps.length - 1].fenAfter, mover) - balance(fen, mover) : 0);

/** Why the move the player chose fails (or holds up). */
function playedPoints(c) {
  const { fen, mover, opp, OPP, steps, san, bestSan, bestMate, refMate, wpBefore, wpLoss, net, verdict } = c;
  const pts = [];
  const pl = steps[0], rp = steps[1];
  if (!pl) return pts;
  if (verdict === 'good') {
    pts.push(`${san} is a sound alternative. ${OPP}${rp ? `'s best answer is ${rp.san}, and` : ' has nothing that'} wins nothing${net > 0 ? ', while you pick up material' : ''}.`);
    return pts;
  }
  const mated = refMate > 0 || steps.some((s) => s.mate && s.color !== mover);
  if (mated) {
    pts.push(`${san} allows a forced checkmate. ${rp ? `${OPP} starts with ${rp.san}` : `${OPP} has a forced mate`}${refMate > 0 && !steps.some((s) => s.mate) ? ` and mates in ${refMate}` : ''}.`);
    return pts;
  }
  if (bestMate > 0 && net > -1) {
    pts.push(`You had checkmate in ${bestMate}. ${san} lets it slip, and ${bestSan} ${bestMate === 1 ? 'ends the game at once' : 'wins by force'}.`);
    if (wpLoss != null && wpBefore != null) pts.push(`Your win chance falls from ${Math.round(wpBefore)}% to ${Math.round(wpBefore - wpLoss)}%.`);
    return pts;
  }
  if (rp && rp.captured && rp.color === opp) {
    if (rp.to === pl.to) pts.push(`${san} puts your ${NAME[pl.piece]} on ${pl.to}, where ${OPP}'s ${NAME[rp.piece]} can take it with ${rp.san}.`);
    else if (capturesBy(fen, opp).some((m) => m.to === rp.to)) pts.push(`Your ${NAME[rp.captured]} on ${rp.to} was already under attack, and ${san} did not deal with it. ${OPP} plays ${rp.san}.`);
    else pts.push(`After ${san}, ${OPP} can play ${rp.san} and take your ${NAME[rp.captured]} on ${rp.to}.`);
    const back = steps.slice(2).find((s) => s.mine && s.captured);
    if (!back) pts.push('You have no good way to take material back.');
  } else if (rp && rp.check) {
    pts.push(`${OPP} answers ${rp.san} with check and gains time.`);
  } else if (rp) {
    pts.push(`${OPP}'s best answer is ${rp.san}.`);
  }
  if (net <= -1) pts.push(`Once the captures settle, you are ${points(-net)} down.`);
  else pts.push('No material is lost straight away, but it gives your opponent the better position.');
  if (wpLoss != null && wpBefore != null) pts.push(`Your win chance falls from ${Math.round(wpBefore)}% to ${Math.round(wpBefore - wpLoss)}%.`);
  return pts;
}

/** Why the best move is best, and what it stops. */
function bestPoints(c) {
  const { fen, mover, opp, OPP, steps, san, playedSan, playedSteps, bestMate, net } = c;
  const pts = [];
  const b = steps[0];
  if (!b) return pts;
  if (b.mate) pts.push(`${san} is checkmate.`);
  else if (bestMate > 0) pts.push(`${san} forces checkmate in ${bestMate}.`);
  else {
    if (b.captured) pts.push(`${san} takes the ${NAME[b.captured]} on ${b.to}.`);
    else if (b.promotion) pts.push(`${san} promotes the pawn to a ${NAME[b.promotion]}.`);
    else if (b.check) pts.push(`${san} gives check, so ${OPP} has to respond.`);
    else if (b.castle) pts.push(`${san} castles. The king gets safe and the rook joins the game.`);
    else if (capturesBy(fen, opp).some((m) => m.to === b.from)) pts.push(`${san} moves your ${NAME[b.piece]} out of danger.`);
    else {
      const th = winningThreats(b.fenAfter, b.to, mover);
      pts.push(th.length ? `${san} threatens to win the ${NAME[th[0].type]} on ${th[0].sq}.` : `${san} is the most accurate move here.`);
    }
    const rp = playedSteps && playedSteps[1], pl = playedSteps && playedSteps[0];
    if (rp && rp.captured && pl && rp.to !== pl.to && !capturesBy(b.fenAfter, opp).some((m) => m.to === rp.to)) {
      pts.push(`Unlike ${playedSan}, it leaves ${OPP} no way to take your ${NAME[rp.captured]} on ${rp.to}.`);
    }
    if (net >= 1) pts.push(`Along this line you come out ${points(net)} ahead.`);
    else if (net <= -1) pts.push(`The position is already difficult, and this line limits the loss to ${points(-net)}.`);
    else pts.push('Material stays level and you keep a safe position.');
  }
  return pts;
}

/**
 * ctx: { fen, playedUci, bestUci, refPv:[uci after the played move], bestRest:[uci after the best move],
 *        wpBefore, wpLoss, refMate (opponent mates in n, positive), bestMate (you mate in n, positive),
 *        verdict:'bad'|'good'|'best' }
 * returns { fen, mover, played:{title,san,steps,text,points}, best:{...} }
 * Each step: { uci, san, mine, note, color, to, from, ... }
 */
export function buildLesson(ctx) {
  const { fen, playedUci, bestUci, refPv = [], bestRest = [], wpBefore, wpLoss, refMate, bestMate } = ctx;
  const verdict = ctx.verdict || (playedUci === bestUci ? 'best' : 'bad');
  const mover = fen.split(' ')[1], opp = other(mover), OPP = SIDE[opp];
  const sanOf = (u) => walkLine(fen, [u])[0]?.san || u;

  const bestSteps = buildSteps(fen, [bestUci, ...bestRest], mover, 3, 7);
  const bestSan = bestSteps[0]?.san || sanOf(bestUci);
  const playedSteps = verdict === 'best' ? bestSteps : buildSteps(fen, [playedUci, ...refPv], mover, 2, 7);
  const playedSan = playedSteps[0]?.san || sanOf(playedUci);

  const playedNet = netOf(fen, playedSteps, mover), bestNet = netOf(fen, bestSteps, mover);
  const best = {
    title: verdict === 'best' ? `Why ${bestSan} is the best move` : `What to play instead: ${bestSan}`,
    san: bestSan, steps: bestSteps, text: lineText(fen, bestSteps), net: bestNet,
    points: bestPoints({ fen, mover, opp, OPP, steps: bestSteps, san: bestSan, playedSan, playedSteps, bestMate, net: bestNet }),
  };
  const played = verdict === 'best' ? best : {
    title: verdict === 'good' ? `Why ${playedSan} is fine` : `Why ${playedSan} does not work`,
    san: playedSan, steps: playedSteps, text: lineText(fen, playedSteps), net: playedNet, verdict,
    points: playedPoints({ fen, mover, opp, OPP, steps: playedSteps, san: playedSan, bestSan, bestMate, refMate, wpBefore, wpLoss, net: playedNet, verdict }),
  };
  return { fen, mover, verdict, played, best };
}
