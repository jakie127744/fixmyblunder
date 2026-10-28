// Play tab: a game against Buddy Trainer or Stockfish. No clocks. "Think first" is an optional
// self-imposed delay that keeps the board locked, so you slow down instead of rushing.
import { Chess } from '../vendor/chess/chess.js';
import { Board } from './board.js';
import { esc } from './util.js';
import { winPct } from './score.js';
import { pvToSan } from './classify.js';
import { MISTAKE_WP } from './analyze.js';
import { PlayEngine, OPPONENTS, levelOf } from './playengine.js';

const THINK = [[0, 'Off'], [5, '5 sec'], [15, '15 sec'], [30, '30 sec'], [60, '1 min']];
// Coaching is for training games against Buddy Trainer or Stockfish only. A rated or competitive mode,
// if one is ever added, must leave g.training false so no coach line or engine verdict is shown mid-game.
const BIG_LOSS_WP = 15;        // a single move this costly gets a coach line even when nothing was captured
const FAST_MOVE_SECS = 5;      // post-game list: every move you played faster than this
const JUDGE_MS = 100;          // engine time per position when judging your moves
const PIECE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const MIN_REPLY_MS = 350;      // so an instant book move does not feel like a glitch
const engines = {};            // kind -> PlayEngine, created on first use and kept
const $ = (s) => document.querySelector(s);

let host = null;               // { ui, render, toast, announce, state, save, review }
let thinkTimer = null;

const cfgOf = () => {
  const s = host.state().settings;
  return (s.play ||= { engine: 'buddy', level: OPPONENTS.buddy.defaultLevel, color: 'r', think: 0 });
};
const P = () => host.ui.play;
const oppName = (g) => OPPONENTS[g.engine].name;

function getEngine(kind) {
  if (!engines[kind]) {
    const e = new PlayEngine(kind);
    e.onFail = () => { if (engines[kind] === e) { delete engines[kind]; e.close(); } };
    engines[kind] = e;
  }
  return engines[kind];
}

/* ------------------------------------------------------------------ game state */
function newGame(cfg) {
  const me = cfg.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : cfg.color;
  return { engine: cfg.engine, level: cfg.level, think: cfg.think, me, ucis: [], sans: [], status: 'ask', result: null, reason: '', takebacks: 0, started: Date.now(), thinkAt: Date.now(), token: 0, training: true, log: [], coach: null, confirmResign: false, reviewing: false, reviewedId: null };
}

const chessOf = (g) => {
  const c = new Chess();
  for (const u of g.ucis) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return c;
};

function persist() {
  const s = host.state(), p = P();
  s.playGame = p && p.g && p.g.status !== 'over' ? { engine: p.g.engine, level: p.g.level, think: p.g.think, me: p.g.me, ucis: p.g.ucis, takebacks: p.g.takebacks, started: p.g.started } : null;
  host.save();
}

function restore() {
  const sv = host.state().playGame;
  if (!sv || !OPPONENTS[sv.engine]) return null;
  try {
    const g = { ...newGame({ ...sv, color: sv.me }), me: sv.me, ucis: sv.ucis.slice(), takebacks: sv.takebacks || 0, started: sv.started || Date.now() };
    const c = chessOf(g);
    g.sans = c.history();
    if (c.isGameOver()) return null;
    g.status = c.turn() === g.me ? 'ask' : 'think';
    return g;
  } catch { return null; }
}

function ensure() {
  const ui = host.ui;
  if (!ui.play) { const g = restore(); ui.play = { g, cfg: { ...cfgOf() } }; }
  return ui.play;
}

function finish(g, c, resign) {
  g.status = 'over';
  if (resign) { g.result = 'loss'; g.reason = 'You resigned.'; }
  else if (c.isCheckmate()) { const loser = c.turn(); g.result = loser === g.me ? 'loss' : 'win'; g.reason = 'Checkmate.'; }
  else {
    g.result = 'draw';
    g.reason = c.isStalemate() ? 'Stalemate.' : c.isThreefoldRepetition() ? 'Draw by repetition.' : c.isInsufficientMaterial() ? 'Draw: not enough material to mate.' : 'Draw by the 50-move rule.';
  }
  clearInterval(thinkTimer);
  persist();
}

/* ------------------------------------------------------------------ moves */
function liveBoard(g) { return g.board && document.contains(g.board.el) ? g.board : null; }

function applyMove(g, uci) {
  const c = chessOf(g);
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  g.ucis.push(m.from + m.to + (m.promotion || ''));
  g.sans.push(m.san);
  const b = liveBoard(g);
  if (b) b.play(g.ucis[g.ucis.length - 1]);
  if (c.isGameOver()) finish(g, c, false);
  return m;
}

function onUserMove(uci) {
  const g = P() && P().g;
  if (!g || g.status !== 'ask') return;
  g.confirmResign = false;
  const fenBefore = chessOf(g).fen(), secs = (Date.now() - g.thinkAt) / 1000;
  g.coach = null;                                   // a coach line belongs to the move it judged
  const m = applyMove(g, uci);
  const e = { ply: g.ucis.length - 1, san: m.san, uci: g.ucis[g.ucis.length - 1], secs, fenBefore, fenAfter: chessOf(g).fen(), over: g.status === 'over', loss: null, bestSan: null, bestUci: null, wpBefore: null, wpAfter: null, reply: null, failed: false };
  g.log.push(e);
  judgeMove(g, e);
  host.announce(`You played ${m.san}.`);
  if (g.status !== 'over') { g.status = 'think'; persist(); refresh(); engineReply(g); }
  else { liveBoard(g) && liveBoard(g).setEnabled(false); refresh(); host.announce(`${g.reason}`); }
}

async function engineReply(g) {
  const tok = ++g.token, t0 = Date.now();
  liveBoard(g) && liveBoard(g).setEnabled(false);
  try {
    const e = getEngine(g.engine);
    const r = await e.bestMove(g.ucis, g.level);
    const wait = MIN_REPLY_MS - (Date.now() - t0);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    if (g.token !== tok || g.status !== 'think') return;       // taken back, resigned or replaced meanwhile
    if (!r.uci) { finish(g, chessOf(g), false); refresh(); return; }
    const m = applyMove(g, r.uci);
    const mine = g.log[g.log.length - 1];
    if (mine && mine.ply === g.ucis.length - 2) { mine.reply = { san: m.san, captured: m.captured || null, to: m.to }; coachCheck(g, mine); }
    if (g.status !== 'over') {
      g.status = 'ask'; g.thinkAt = Date.now();
      liveBoard(g) && liveBoard(g).setEnabled(true);
      persist();
    }
    host.announce(`${oppName(g)} played ${m.san}.${g.status === 'over' ? ' ' + g.reason : ''}`);
    refresh(); lockForThinking(g);
  } catch (err) {
    if (g.token !== tok) return;
    g.status = 'error'; g.error = err && err.message || 'The engine failed to load.';
    host.logError && host.logError('play-engine', err);
    refresh();
  }
}

function takeback(g) {
  if (g.status !== 'ask' || g.ucis.length < 2) return;   // undo your move and the reply to it
  g.ucis.splice(-2); g.sans.splice(-2);
  g.log = g.log.filter((e) => e.ply < g.ucis.length); g.coach = null;
  g.takebacks++; g.confirmResign = false; g.token++;
  const b = liveBoard(g);
  if (b) {
    b.setPosition(chessOf(g).fen(), g.me);
    const last = g.ucis[g.ucis.length - 1];
    if (last) b.marks = { [last.slice(0, 2)]: 'last', [last.slice(2, 4)]: 'last' };
    b.setEnabled(true);
  }
  g.thinkAt = Date.now();
  persist(); refresh(); lockForThinking(g);
}

/* ------------------------------------------------------------------ think-first lock */
function lockForThinking(g) {
  clearInterval(thinkTimer); thinkTimer = null;
  const el = $('#think'), secs = g.think || 0, b = liveBoard(g);
  if (!el) return;
  const left = () => (g.thinkAt + secs * 1000 - Date.now()) / 1000;
  el.classList.remove('on');
  if (!secs || g.status !== 'ask' || left() <= 0) return;
  host.announce(`Think first for ${secs} seconds.`);
  if (b) b.setEnabled(false);
  const draw = () => {
    const l = left(), now = P() && P().g;
    if (now !== g || !$('#think') || g.status !== 'ask') { clearInterval(thinkTimer); return; }
    if (l <= 0) { clearInterval(thinkTimer); el.classList.remove('on'); liveBoard(g) && liveBoard(g).setEnabled(true); host.announce('Your move'); return; }
    el.classList.add('on');
    el.innerHTML = `<span>${Math.ceil(l)}s</span><span class="tbar"><i style="width:${Math.round((1 - l / secs) * 100)}%"></i></span>`;
  };
  draw(); thinkTimer = setInterval(draw, 250);
}

/* ------------------------------------------------------------------ judging your moves (training games only) */
/**
 * Scores one of your moves with the on-device engine: how many win-chance points it gave up compared with the
 * engine's best move. Runs in the background and never blocks the game. Results feed the coach line and the
 * post-game "Fast moves" list.
 */
async function judgeMove(g, e) {
  if (!g.training || !host.evaluate) { e.failed = true; return; }
  try {
    const before = await host.evaluate(e.fenBefore, JUDGE_MS);
    let wpAfter;
    if (e.over) wpAfter = winPct(1000);                       // you ended the game with that move
    else wpAfter = winPct(-(await host.evaluate(e.fenAfter, JUDGE_MS)).cpc);
    e.wpBefore = winPct(before.cpc); e.wpAfter = wpAfter; e.bestUci = before.best;
    e.loss = e.uci === before.best ? 0 : Math.max(0, e.wpBefore - wpAfter);
    e.bestSan = (before.best && pvToSan(e.fenBefore, [before.best], 1)[0]) || null;
  } catch (err) {
    e.failed = true;
    host.logError && host.logError('play-judge', err);
  }
  coachCheck(g, e);
  if (P() && P().g === g) refresh();
}

/** Writes one coach line when a move cost a lot. Needs both your move's cost and the opponent's reply. */
function coachCheck(g, e) {
  if (!g.training || e.coached || e.loss == null || (e.reply === null && !e.over)) return;
  e.coached = true;
  if (g.log.indexOf(e) < 0 || e.ply >= g.ucis.length) return;      // taken back meanwhile
  const cost = Math.round(e.loss);
  const taken = e.reply && e.reply.captured;
  const habit = taken ? 'Before every move, name each of your pieces that nobody defends, and check whether your opponent can attack one.' : 'Before a quiet move, check every capture, check and threat, theirs as well as yours.';
  let title, text;
  if (taken && e.loss >= MISTAKE_WP) {
    title = 'Piece lost';
    text = `Your ${PIECE[taken]} on ${e.reply.to} was taken. ${e.san} cost about ${cost} win-chance points.`;
  } else if (e.loss >= BIG_LOSS_WP) {
    title = 'Costly move';
    text = `${e.san} cost about ${cost} win-chance points.`;
  } else return;
  const why = `Before ${e.san} your win chance was about ${Math.round(e.wpBefore)}%. After it, about ${Math.round(e.wpAfter)}%.${e.bestSan ? ` The engine preferred ${e.bestSan}.` : ''}${e.reply ? ` Your opponent answered ${e.reply.san}.` : ''} ${habit}`;
  g.coach = { ply: e.ply, title, text, why };
  host.announce(`${title}. ${text}`);
}

const coachHtml = (g) => (g.coach ? `<div class="fb bad" role="status"><b>${esc(g.coach.title)}</b><p>${esc(g.coach.text)}</p><details class="eng"><summary>Why</summary><p>${esc(g.coach.why)}</p></details></div>` : '');

const verdictOf = (e) => {
  if (e.loss == null) return e.failed ? 'not checked' : 'checking…';
  if (e.loss === 0) return 'best move';
  const pts = `−${Math.round(e.loss)} pts`;
  return e.loss < 3 ? `fine, ${pts}` : e.loss < 10 ? `inaccuracy, ${pts}` : e.loss < 20 ? `mistake, ${pts}` : `blunder, ${pts}`;
};

/** After the game: every move you played in under FAST_MOVE_SECS, with the engine's verdict. */
function fastHtml(g) {
  if (g.status !== 'over' || !g.training) return '';
  const fast = g.log.filter((e) => e.secs < FAST_MOVE_SECS);
  if (!fast.length) return '';
  const num = (e) => `${Math.floor(e.ply / 2) + 1}${e.ply % 2 === 0 ? '.' : '...'}`;
  return `<section class="card" style="margin-top:12px"><h2 class="h2">Fast moves</h2><p class="sub small" style="margin:2px 0 8px">Moves you played in under ${FAST_MOVE_SECS} seconds, with the engine's verdict. Quick is fine when it is right. This only lists them.</p>
    <ul class="fastlist">${fast.map((e) => `<li><b class="mono">${num(e)} ${esc(e.san)}</b> <span>${e.secs.toFixed(1)}s</span> <span class="${e.loss != null && e.loss >= 10 ? 'bad' : ''}">${esc(verdictOf(e))}</span></li>`).join('')}</ul></section>`;
}

/* ------------------------------------------------------------------ views */
const chip = (act, v, label, on, extra = '') => `<button data-act="${act}" data-v="${v}" aria-pressed="${on}" ${extra}>${label}</button>`;

function viewSetup(c) {
  const o = OPPONENTS[c.engine];
  const lv = levelOf(c.engine, c.level);
  return `<section class="view"><p class="eyebrow">Play</p><h1 class="h1">Play a game</h1>
    <p class="sub">No clock. Take the time you need, or set a think-first delay below to stop yourself rushing.</p>
    <div class="stack" style="margin-top:12px">
      <section class="card">
        <p class="group-title">Opponent</p>
        <div class="chips" role="group" aria-label="Opponent">${Object.entries(OPPONENTS).map(([k, v]) => chip('pl-engine', k, esc(v.name), c.engine === k)).join('')}</div>
        <p class="sub small" style="margin:8px 0 0">${esc(o.blurb)}</p>
        <p class="group-title">${c.engine === 'buddy' ? 'Thinking time' : 'Strength'}</p>
        <div class="chips" role="group" aria-label="Strength">${o.levels.map((l) => chip('pl-level', l.id, esc(l.label), lv.id === l.id)).join('')}</div>
        <p class="sub small" style="margin:8px 0 0">${esc(lv.note)}</p>
        <p class="group-title">You play</p>
        <div class="chips" role="group" aria-label="Colour">${[['w', 'White'], ['b', 'Black'], ['r', 'Random']].map(([k, n]) => chip('pl-color', k, n, c.color === k)).join('')}</div>
        <p class="group-title">Think first</p>
        <p class="sub small" style="margin:0 0 8px">The board stays locked for this long on each of your turns.</p>
        <div class="chips" role="group" aria-label="Think first">${THINK.map(([n, l]) => chip('pl-think', n, l, (c.think || 0) === n)).join('')}</div>
      </section>
    </div>
    <div class="cta"><button class="btn" data-act="pl-start">Start game</button></div></section>`;
}

function movesHtml(g) {
  if (!g.sans.length) return '<span class="sub small">No moves yet.</span>';
  let h = '';
  for (let i = 0; i < g.sans.length; i += 2) h += `<span class="plm"><i>${i / 2 + 1}.</i> ${esc(g.sans[i])}${g.sans[i + 1] ? ' ' + esc(g.sans[i + 1]) : ''}</span>`;
  return h;
}

function statusText(g) {
  if (g.status === 'over') return g.result === 'win' ? 'You won' : g.result === 'loss' ? 'You lost' : 'Draw';
  if (g.status === 'error') return 'Engine problem';
  return g.status === 'think' ? `${oppName(g)} is thinking` : 'Your move';
}
function subText(g) {
  if (g.status === 'over') return g.reason;
  if (g.status === 'error') return g.error;
  return `You are ${g.me === 'w' ? 'White' : 'Black'} against ${oppName(g)} (${levelOf(g.engine, g.level).label}).`;
}

function actionsHtml(g) {
  if (g.status === 'over') {
    const n = g.ucis.length;
    const rev = g.reviewedId ? '<button class="btn" data-act="pl-open">Open the review</button>'
      : n < 12 ? '<p class="sub small">Games under 6 moves each are too short to review.</p>'
      : `<button class="btn" data-act="pl-review" ${g.reviewing ? 'disabled' : ''}>${g.reviewing ? 'Analysing…' : 'Review this game'}</button>`;
    return `${rev}<button class="btn ghost" data-act="pl-rematch">Rematch, swap colours</button><button class="btn ghost" data-act="pl-new">New game</button>`;
  }
  if (g.status === 'error') return '<button class="btn" data-act="pl-retry">Try again</button><button class="btn ghost" data-act="pl-new">Back</button>';
  const canTake = g.status === 'ask' && g.ucis.length >= 2;
  return `<div class="row" style="gap:8px"><button class="btn ghost sm" data-act="pl-takeback" ${canTake ? '' : 'disabled'} style="flex:1">Take back</button>
    <button class="btn ghost sm" data-act="pl-resign" style="flex:1">${g.confirmResign ? 'Tap again to resign' : 'Resign'}</button></div>`;
}

function viewGame(g) {
  return `<section class="view"><div class="row"><p class="eyebrow">Play · ${esc(oppName(g))}</p><button class="link" data-act="pl-new" style="min-height:36px;padding:4px 8px">${g.status === 'over' ? 'Done' : 'Leave game'}</button></div>
    <h1 class="h1" id="plTitle">${statusText(g)}${g.status === 'think' ? '<span class="thinking"><i></i><i></i><i></i></span>' : ''}</h1>
    <p class="sub" id="plSub">${esc(subText(g))}</p>
    <div id="think" class="thinkmini" aria-hidden="true"></div>
    <div class="board-wrap"><div id="board"></div></div>
    <div id="plCoach">${coachHtml(g)}</div>
    <div class="plmoves" id="plMoves" aria-label="Moves">${movesHtml(g)}</div>
    <div id="plFast">${fastHtml(g)}</div>
    <div class="stack" style="margin-top:12px" id="plActions">${actionsHtml(g)}</div></section>`;
}

export function viewPlay(h) {
  host = h;
  const p = ensure();
  return p.g ? viewGame(p.g) : viewSetup(p.cfg);
}

export function mountPlay(h) {
  host = h;
  const p = P(), g = p && p.g;
  if (!g || !$('#board')) return;
  const c = chessOf(g);
  const b = new Board($('#board'), { fen: c.fen(), orientation: g.me, canMove: g.status === 'ask', onMove: onUserMove });
  const last = g.ucis[g.ucis.length - 1];
  if (last) b.marks = { [last.slice(0, 2)]: 'last', [last.slice(2, 4)]: 'last' }, b.render();
  g.board = b;
  host.ui.board = b;
  if (g.status === 'ask') lockForThinking(g);
  else if (g.status === 'think' && !g.busy) { g.busy = true; engineReply(g).finally(() => { g.busy = false; }); }
}

function refresh() {
  const g = P() && P().g;
  if (!g || !$('#plTitle') || !$('#plCoach')) return;
  $('#plTitle').innerHTML = statusText(g) + (g.status === 'think' ? '<span class="thinking"><i></i><i></i><i></i></span>' : '');
  $('#plSub').textContent = subText(g);
  $('#plMoves').innerHTML = movesHtml(g);
  $('#plActions').innerHTML = actionsHtml(g);
  if (g.coachShown !== g.coach) { g.coachShown = g.coach; $('#plCoach').innerHTML = coachHtml(g); }   // only redraw when it changes, so "Why" stays open
  $('#plFast').innerHTML = fastHtml(g);
  const mv = $('#plMoves'); if (mv) mv.scrollLeft = mv.scrollWidth;
}

/* ------------------------------------------------------------------ actions */
export async function playAct(act, v, h) {
  host = h;
  const p = ensure(), c = p.cfg;
  const keep = () => { Object.assign(cfgOf(), c); host.save(); };
  switch (act) {
    case 'pl-engine': c.engine = v; c.level = OPPONENTS[v].defaultLevel; keep(); host.render(); break;
    case 'pl-level': c.level = v; keep(); host.render(); break;
    case 'pl-color': c.color = v; keep(); host.render(); break;
    case 'pl-think': c.think = +v; keep(); host.render(); break;
    case 'pl-start': startFrom(p, c); break;
    case 'pl-rematch': { const g = p.g; startFrom(p, { ...c, engine: g.engine, level: g.level, think: g.think, color: g.me === 'w' ? 'b' : 'w' }); break; }
    case 'pl-retry': { const g = p.g; g.status = g.ucis.length && chessOf(g).turn() === g.me ? 'ask' : 'think'; host.render(); break; }
    case 'pl-new': { const g = p.g; if (g) g.token++; clearInterval(thinkTimer); p.g = null; p.cfg = { ...cfgOf() }; persist(); host.render(); break; }
    case 'pl-takeback': takeback(p.g); break;
    case 'pl-resign': {
      const g = p.g;
      if (!g || g.status === 'over') break;
      if (!g.confirmResign) { g.confirmResign = true; refresh(); setTimeout(() => { if (g.confirmResign) { g.confirmResign = false; refresh(); } }, 3000); break; }
      g.token++; finish(g, chessOf(g), true);
      liveBoard(g) && liveBoard(g).setEnabled(false);
      refresh(); host.announce('You resigned.'); break;
    }
    case 'pl-review': {
      const g = p.g;
      if (g.reviewing || g.reviewedId) break;
      g.reviewing = true; refresh();
      try { g.reviewedId = await host.review(gameRecord(g)); }
      catch (err) { host.toast(err.message || 'Could not analyse that game.'); }
      g.reviewing = false; refresh();
      if (g.reviewedId) host.openReview(g.reviewedId);
      break;
    }
    case 'pl-open': host.openReview(p.g.reviewedId); break;
  }
}

async function startFrom(p, c) {
  const g = newGame(c);
  p.g = g; p.cfg = { ...c, color: c.color === 'w' || c.color === 'b' ? c.color : 'r' };
  Object.assign(cfgOf(), { engine: c.engine, level: c.level, think: c.think, color: p.cfg.color === 'r' ? 'r' : p.cfg.color });
  const e = getEngine(g.engine);
  e.newGame(g.level).catch(() => {});      // errors surface on the first move
  g.status = g.me === 'w' ? 'ask' : 'think';
  persist();
  host.render();
}

/** The same record the importer produces, so the normal analysis pipeline accepts it. */
function gameRecord(g) {
  return {
    id: `play:${g.started}`, source: 'play', url: '', date: g.started,
    color: g.me === 'w' ? 'white' : 'black', result: g.result,
    opponent: oppName(g), userRating: null, oppRating: null, speed: null, baseTime: null,
    moves: g.sans.slice(), clocks: null,
  };
}
