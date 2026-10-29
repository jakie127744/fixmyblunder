// FixMyBlunder app shell: onboarding, Today, Diagnose, Retry, Report, Settings.
import { state, save, onChange, exportJson, importJson, reset, clearAccountData } from './store.js';
import { Engine, workerTransport } from './engine.js';
import { analyzeGame } from './analyze.js';
import { fetchLichess, fetchChessCom, fromPgnText, skipText, MIN_PLIES } from './importer.js';
import { SAMPLE_DRILLS, sampleById } from './samples.js';
import { PATTERNS, PATTERN_ORDER, pat } from './patterns.js';
import { addDrillsFromGame, patternStats, buildToday, dueCount, todayResults, gradeDrill, streak, gamesByDate, isMastered, minutesTrained, extraDrills, puzzleStats, dueTomorrowCount, deliberateStreak, isDeliberate } from './srs.js';
import { nextPuzzle, countMatching, downloadAll, THEME_GROUPS, MIXED, DIFFICULTY, MOVE_COUNTS, PATTERN_THEME, themeName } from './puzzles.js';
import { weekly, allTime, puzzleReport } from './report.js';
import { winPct } from './score.js';
import { pvToSan, reclassify, CLASSIFIER_VERSION } from './classify.js';
import { buildLesson } from './lessons.js';
import { Board } from './board.js';
import { Chess } from '../vendor/chess/chess.js';
import { esc, plural, fmtDay, fmtRange, addDays, weekStart, DAY, dayKey } from './util.js';
import { logError, watchGlobalErrors, buildReport, mailtoLink, getErrors, clearErrors } from './diag.js';
import { FEEDBACK_EMAIL, FEEDBACK_FORM_URL } from './config.js';
import { reminderIcs, validTime } from './reminder.js';
import { viewPlay, mountPlay, playAct } from './play.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');

const ui = {
  tab: 'today', report: 'week', weekOffset: 0, pzPeriod: 'week', pzSort: 'count', board: null, session: null, drill: null,
  onboard: { step: 'form', source: 'lichess', username: '', pgn: '', error: '', counts: { games: 0, mistakes: 0, drills: 0 }, live: '', progress: 0 },
  syncing: false, review: null, importNote: null,
  practice: { mode: 'games', pattern: 'all', n: 10, theme: 'mix', difficulty: 'any', moves: 'any' }, puzzle: null,
};

/* ------------------------------------------------------------------ engine */
let engine = null;
function getEngine() {
  if (!engine) {
    const e = new Engine(workerTransport('vendor/stockfish/stockfish-19-lite-single.js'));
    e.onFail = (err) => { logError('engine', err); if (engine === e) engine = null; };
    engine = e;
  }
  return engine;
}

/* ------------------------------------------------------------------ engine lines for explanations */
const LINES_V = 1;
const fenAfterMove = (fen, uci) => { const c = new Chess(fen); c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return c.fen(); };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('The engine took too long.')), ms))]);

/**
 * The lines behind an explanation: what follows the best move, and what follows the move that was played.
 * Searched a little deeper than the game analysis, once, then kept on the mistake (and its drill copy).
 * Falls back to the short lines stored at analysis time if the engine is busy or unavailable.
 */
async function ensureLines(m, needRef) {
  const have = m.lines && m.lines.v === LINES_V ? m.lines : { v: LINES_V };
  const todo = [];
  if (!have.bestRest) todo.push('best');
  if (needRef && !have.ref) todo.push('ref');
  if (todo.length) {
    try {
      const eng = getEngine();
      const run = (uci) => eng.evaluate(fenAfterMove(m.fen, uci), { movetime: 350 });
      const res = await withTimeout(Promise.all(todo.map((k) => run(k === 'best' ? m.bestUci : m.playedUci))), 8000);
      todo.forEach((k, i) => {
        if (k === 'best') have.bestRest = res[i].pv.slice(0, 8);
        else { have.ref = res[i].pv.slice(0, 8); have.refMate = res[i].mate; }
      });
      m.lines = have;
      const s = state(), twin = s.drills[m.id] || (s.games[m.gameId] && s.games[m.gameId].mistakes.find((x) => x.id === m.id));
      if (twin) twin.lines = have;
      save();
    } catch (e) { logError('lesson-lines', e); }
  }
  return {
    bestRest: have.bestRest || (m.bestPvUci || []).slice(1),
    ref: have.ref || m.afterPvUci || (m.replyUci ? [m.replyUci] : []),
    refMate: have.ref ? have.refMate : (m.afterMate != null && m.afterMate < 0 ? -m.afterMate : null),
  };
}

/* ------------------------------------------------------------------ helpers */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hide'), 2800);
}
/** Speaks a short message to screen readers without moving focus. */
let sayTimer;
function announce(msg) {
  const el = $('#sr');
  if (!el || !msg) return;
  el.textContent = '';
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => { el.textContent = msg; }, 60);
}
const setBackdrop = (on) => $$('.app, #tabs').forEach((el) => { el.inert = on; });
let sheetOpener = null;
function openSheet(html) {
  if ($('#scrim').classList.contains('hide')) sheetOpener = document.activeElement;
  $('#sheet').innerHTML = html;
  const title = $('#sheet .h2'); if (title) title.id = 'sheetTitle';
  $('#scrim').classList.remove('hide'); setBackdrop(true);
  const f = $('#sheet button, #sheet input, #sheet select, #sheet textarea'); if (f) f.focus();
}
function closeSheet() {
  $('#scrim').classList.add('hide'); $('#sheet').innerHTML = ''; setBackdrop(false);
  if (sheetOpener && document.contains(sheetOpener)) sheetOpener.focus({ preventScroll: true });
  sheetOpener = null;
}
const WCP_LINE = 'Win-chance points: how much a move cut your chance of winning. Dropping from 60% to 50% costs 10 points.';
const nameOf = (id) => PATTERNS[id].name;
const setSize = () => state().settings.setSize;
const sourceLabel = (s) => ({ lichess: 'Lichess', chesscom: 'Chess.com', pgn: 'PGN', play: 'Played here' }[s] || s);
const accClass = (a) => (a >= 85 ? 'hi' : a < 65 ? 'lo' : '');
const RESULT_WORD = { win: 'Won', loss: 'Lost', draw: 'Drew', unfinished: 'Unfinished' };
/** The result exactly as recorded. Only a real draw is called "Drew"; a game with no result is "Unfinished". */
const resultWord = (r) => RESULT_WORD[r] || 'Unfinished';
const gameTitle = (g) => `${resultWord(g.result)} as ${g.color} vs ${g.opponent}`;
/** Hint shown under "Show the idea first". The positional hint never claims there is no tactic. */
const ideaText = (d) => pat(d.pattern).idea;
const arrow = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);

function line(points, opts = {}) {
  // points: [{label?, v}], v may be null (gap). Draws one line scaled to its own values.
  const vals = points.filter((p) => p.v != null).map((p) => p.v);
  if (vals.length < 2) return '<p class="sub small">Not enough weeks of games yet to draw a line.</p>';
  const W = 320, H = 150, pl = 34, pr = 10, pt = 10, pb = 24;
  const min = Math.floor(Math.min(...vals) / 5) * 5 - 0, max = Math.max(min + 10, Math.ceil(Math.max(...vals) / 5) * 5);
  const X = (i) => pl + ((W - pl - pr) * i) / (points.length - 1);
  const Y = (v) => pt + (H - pt - pb) * (1 - (v - min) / (max - min));
  let g = '';
  const step = max - min > 30 ? 10 : 5;
  for (let t = min; t <= max; t += step) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pl - 6}" y="${Y(t) + 3}" text-anchor="end">${t}%</text>`;
  const pts = points.map((p, i) => (p.v == null ? null : [X(i), Y(p.v)])).filter(Boolean);
  const idx = points.map((p, i) => (p.v == null ? -1 : i)).filter((i) => i >= 0);
  let path = '';
  for (let k = 1; k < pts.length; k++) {
    const gap = idx[k] - idx[k - 1] > 1;
    path += `<line x1="${pts[k - 1][0]}" y1="${pts[k - 1][1]}" x2="${pts[k][0]}" y2="${pts[k][1]}" stroke="var(--accent)" stroke-width="${gap ? 1.5 : 2.5}" ${gap ? 'stroke-dasharray="4 4" opacity=".6"' : ''} stroke-linecap="round"/>`;
  }
  const dots = pts.map((q) => `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" fill="var(--accent)"/>`).join('');
  const f0 = idx[0], fx = X(f0), fy = Y(points[f0].v);
  const first = idx.length > 1 ? `<text x="${fx + 8}" y="${fy - 10}" text-anchor="start" style="fill:var(--ink-2)">${points[f0].v}%</text>` : '';
  const lastIdx = points.map((p) => p.v != null).lastIndexOf(true);
  const lx = X(lastIdx), ly = Y(points[lastIdx].v);
  const labs = (opts.labels || []).map(([i, t]) => `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${esc(t)}</text>`).join('');
  const mk = opts.marker >= 0 && opts.marker != null ? `<line x1="${X(opts.marker)}" x2="${X(opts.marker)}" y1="${pt}" y2="${H - pb}" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="4 3"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.alt || 'Accuracy over time')}">${g}${mk}${path}${dots}${first}<circle cx="${lx}" cy="${ly}" r="5" fill="var(--accent)"/><text x="${lx - 8}" y="${ly - 10}" text-anchor="end" style="fill:var(--ink);font-weight:600">${points[lastIdx].v}%</text>${labs}</svg>`;
}

/* ------------------------------------------------------------------ background progress banner */
function setBg(text, frac) {
  const el = $('#bgbar');
  if (!el) return;
  if (text == null) { el.hidden = true; return; }
  el.hidden = false;
  el.querySelector('span').textContent = text;
  el.querySelector('i').style.width = Math.round((frac || 0) * 100) + '%';
}

/* ------------------------------------------------------------------ sync */
/** Why nothing could be imported, in words that name the real reason. */
function explainNoGames(source, username, skipped, pasted) {
  if (source === 'pgn' && !pasted) return 'No games found in that text. Each game needs its tag lines, starting with [Event "..."], then [White "..."] and [Black "..."].';
  if (!skipped.length) return 'No standard games found for that account.';
  const kinds = {};
  for (const s of skipped) kinds[s.reason] = (kinds[s.reason] || 0) + 1;
  const reasons = Object.keys(kinds);
  const n = skipped.length;
  if (reasons.length === 1) {
    const r = reasons[0];
    if (r === 'short') return n === 1 ? `${skipText(skipped[0])} Paste a longer game.` : `All ${n} games are too short to analyze: each needs at least ${MIN_PLIES} half-moves (${MIN_PLIES / 2} moves each).`;
    if (r === 'name') return `"${username}" is not White or Black in ${n === 1 ? 'that game' : `any of those ${n} games`}. Check the name matches the PGN exactly.`;
    if (r === 'variant') return `${n === 1 ? 'That game is' : 'Those games are'} not standard chess from the starting position.`;
    return `${n === 1 ? 'That game' : 'Those games'} could not be read as PGN.`;
  }
  const label = { short: 'too short', name: 'name not found', variant: 'not standard chess', unreadable: 'unreadable' };
  return `None of the ${n} games could be used: ${reasons.map((r) => `${kinds[r]} ${label[r]}`).join(', ')}.`;
}

/** "3 pasted, 2 analyzed, 1 skipped" plus one line per skipped game. */
function importSummary(r, source) {
  const seen = r.pasted != null ? r.pasted : r.found + r.skipped.length;
  const head = `${seen} ${source === 'pgn' ? 'pasted' : 'found'}, ${r.analysed} analyzed${r.existing ? `, ${r.existing} already analyzed` : ''}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`;
  return { head, lines: r.skipped.map(skipText) };
}

async function sync({ count, pgn, onStatus }) {
  const s = state();
  const { source, username } = s.profile;
  onStatus({ phase: 'fetch' });
  let games, skipped = [], pasted = null;
  if (source === 'lichess') games = await fetchLichess(username, count);
  else if (source === 'chesscom') { games = await fetchChessCom(username, count); skipped = games.skipped || []; }
  else { const r = fromPgnText(pgn || '', username); games = r.games; skipped = r.skipped.slice(); pasted = r.pasted; }
  if (!games.length) throw new Error(explainNoGames(source, username, skipped, pasted));
  for (const g of games) { const ex = s.games[g.id]; if (ex && !ex.sans) ex.sans = g.moves.slice(); }
  const fresh = games.filter((g) => !s.games[g.id]);
  let mistakes = 0, drills = 0, done = 0, analysed = 0;
  for (const g of fresh) {
    const rec = await analyzeGame(g, getEngine(), {
      movetime: s.settings.engineMs,
      onProgress: (i, n) => onStatus({ phase: 'analyse', game: done + 1, games: fresh.length, frac: i / n }),
    });
    done++;
    if (!rec) {
      skipped.push({ reason: 'short', label: `Game vs ${g.opponent}`, plies: g.moves.length });
      onStatus({ phase: 'analyse', game: done, games: fresh.length, frac: 1, skipped: true });
      continue;
    }
    analysed++;
    s.games[rec.id] = rec;
    drills += addDrillsFromGame(s, rec);
    mistakes += rec.mistakes.length;
    save();
    onStatus({ phase: 'game', game: done, games: fresh.length, rec, mistakes, drills });
  }
  if (!analysed && !Object.keys(s.games).length) throw new Error(explainNoGames(source, username, skipped, pasted));
  s.lastSync = Date.now();
  if (!Object.keys(todayResults(s)).length) s.today = null; // rebuild today's set, unless drilling has started
  save();
  return { pasted, found: games.length, existing: games.length - fresh.length, analysed, skipped, mistakes, drills };
}

/** Analyze a game played in the Play tab with the normal pipeline, so its mistakes become drills. */
async function reviewPlayed(game) {
  const s = state();
  if (s.games[game.id]) return game.id;
  setBg('Analyzing your game', 0);
  try {
    const rec = await analyzeGame(game, getEngine(), {
      movetime: s.settings.engineMs,
      onProgress: (i, n) => setBg('Analyzing your game', i / n),
    });
    if (!rec) throw new Error('That game is too short to review.');
    s.games[rec.id] = rec;
    const drills = addDrillsFromGame(s, rec);
    if (!Object.keys(todayResults(s)).length) s.today = null;
    save();
    toast(drills ? `Added ${plural(drills, 'drill')} from this game.` : 'No big mistakes found.');
    return rec.id;
  } finally { setBg(null); }
}
const playHost = { ui, render: () => render(), toast, announce, state, save, logError, review: reviewPlayed, evaluate: (fen, ms = 100) => getEngine().evaluate(fen, { movetime: ms }), openReview: (id) => { ui.tab = 'diagnose'; history.replaceState(null, '', '#diagnose'); openReview(id); } };

/* ------------------------------------------------------------------ onboarding */
const GAME_COUNTS = [25, 50, 75, 100];
const AUTO_SYNC_COUNT = 100;

/** The first time Diagnose opens in a session, fetch the active account's latest games (up to 100) and analyze only the ones not seen before. */
async function autoSync() {
  const s = state(), p = s.profile;
  if (!p || p.source === 'pgn' || ui.syncing || !navigator.onLine) return;
  const label = sourceLabel(p.source);
  ui.syncing = true;
  setBg(`Checking ${label} for new games`, 0);
  try {
    const r = await sync({
      count: AUTO_SYNC_COUNT, pgn: '',
      onStatus: (st) => { if (st.phase === 'analyse') setBg(`Analyzing new game ${st.game} of ${st.games} · ${Math.round((((st.game - 1) + st.frac) / st.games) * 100)}%`, ((st.game - 1) + st.frac) / st.games); },
    });
    ui.syncing = false; setBg(null);
    if (r.analysed) {
      toast(`${plural(r.analysed, 'new game')} analyzed, ${plural(r.drills, 'new drill')} added.`);
      if (['today', 'diagnose', 'report'].includes(ui.tab) && !ui.review) render();
    }
  } catch (e) {
    logError('autosync', e);
    ui.syncing = false; setBg(null);
    toast(`Could not check ${label} for new games. ${e.message || ''}`.trim());
  }
}
function viewOnboard() {
  const o = ui.onboard;
  if (o.step === 'form') {
    return `<section class="view welcome">
      <p class="eyebrow">Free, no account</p>
      <h1 class="h1">Find the three mistakes costing you the most</h1>
      <p class="sub">Connect the account where you already play. In about a minute you will see the patterns behind your lost points, then drill them for ten minutes a day.</p>
      <p class="small sub" style="margin-top:8px">${WCP_LINE}</p>
      <div class="steps">
        <div><b>1</b><span><strong>Connect</strong><br><span class="sub small">We read your public games. No password.</span></span></div>
        <div><b>2</b><span><strong>Diagnose</strong><br><span class="sub small">Stockfish runs on this device. Nothing is sent anywhere.</span></span></div>
        <div><b>3</b><span><strong>Drill</strong><br><span class="sub small">Positions from your own games, repeated until they stick.</span></span></div>
      </div>
      <div class="card" style="margin-top:22px">
        <div class="sources" role="group" aria-label="Where do you play">
          ${['lichess', 'chesscom', 'pgn'].map((k) => `<button data-act="src" data-v="${k}" aria-pressed="${o.source === k}">${{ lichess: 'Lichess', chesscom: 'Chess.com', pgn: 'Paste PGN' }[k]}</button>`).join('')}
        </div>
        <label class="fl" for="uname">${o.source === 'pgn' ? 'Your name in the PGN' : 'Your username'}</label>
        <input type="text" id="uname" value="${esc(o.username)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${o.source === 'pgn' ? 'Name as it appears as White or Black' : 'e.g. your username'}">
        ${o.source === 'pgn' ? `<label class="fl" for="pgn">Games (PGN)</label><textarea id="pgn" placeholder="Paste one or more games">${esc(o.pgn)}</textarea>` : ''}
        ${o.error ? `<div class="err" role="alert">${esc(o.error)}${o.reportable ? ' <button class="link" data-act="feedback" style="color:inherit;padding:0 4px">Send a report</button>' : ''}</div>` : ''}
        ${o.source === 'pgn' ? '' : `<p class="group-title" style="margin-top:14px">How many recent games</p><div class="chips" role="group" aria-label="How many recent games to analyze">${GAME_COUNTS.map((n) => `<button data-act="gcount" data-v="${n}" aria-pressed="${state().settings.gamesToImport === n}">${n}</button>`).join('')}</div><p class="small sub" style="margin-top:6px">More games find your patterns more reliably but take longer to analyze.</p>`}
        <button class="btn" style="margin-top:14px" data-act="start">${o.source === 'pgn' ? 'Analyze these games' : `Analyze my last ${state().settings.gamesToImport} games`}</button>
        <p class="small sub" style="margin-top:10px">Fewer than five games? That still works, but patterns are rough guesses until you have played more. Add games later from Settings and they sharpen.</p>
      </div>
    </section>`;
  }
  if (o.step === 'analyse') {
    return `<section class="view welcome">
      <p class="eyebrow">Analyzing on your device</p>
      <h1 class="h1">Looking for the mistakes you repeat</h1>
      <div class="card" style="margin-top:18px">
        <div class="bar"><i style="width:${Math.round(o.progress * 100)}%"></i></div>
        <p class="live" aria-live="polite">${esc(o.live || 'Fetching your games')}</p>
        <div class="counts"><div><b>${o.counts.games}</b><span>games</span></div><div><b>${o.counts.mistakes}</b><span>mistakes</span></div><div><b>${o.counts.drills}</b><span>drills ready</span></div></div>
      </div>
      <button class="btn" id="earlyBtn" data-act="start-early" style="margin-top:14px" ${o.canStart ? '' : 'hidden'}>See my patterns now</button>
      <p class="sub small" style="margin-top:14px">First time takes a minute or two. Once five games are done you can start, and the rest keep analyzing in the background.</p>
    </section>`;
  }
  // reveal
  const ps = patternStats(state());
  const max = Math.max(1, ...ps.list.map((p) => p.cost));
  return `<section class="view welcome">
    <p class="eyebrow">${plural(ps.games, 'game')} analyzed</p>
    <h1 class="h1">Your top three patterns</h1>
    <p class="sub">Ranked by how many win-chance points each one cost you. ${WCP_LINE.replace('Win-chance points: h', 'H')}</p>
    ${ps.games < 5 ? `<div class="card" style="margin-top:12px;background:var(--amber-soft);border-color:transparent"><p><b>Only ${plural(ps.games, 'game')} to go on.</b> These patterns are early guesses. Play more, then tap Sync games in Settings and they will sharpen.</p></div>` : ''}
    ${ui.syncing && o.early ? `<div class="card" style="margin-top:12px;background:var(--amber-soft);border-color:transparent"><p><b>Still analyzing.</b> ${esc(o.live || '')} These numbers will keep updating.</p></div>` : ''}
    ${importNoteHtml()}
    <div class="stack reveal">${ps.list.filter((p) => p.count).slice(0, 3).map((p, i) => patCard(p, max, i + 1, false)).join('') || '<div class="card"><p>No clear mistakes found in these games, so there is nothing to drill from them yet. Try a few sample positions now, and add more games later to find patterns.</p></div>'}</div>
    ${Object.keys(state().drills).length
      ? '<button class="btn" style="margin-top:18px" data-act="finish-onboard">See today\'s set</button>'
      : '<button class="btn" style="margin-top:18px" data-act="start-sample">Try a sample set</button><button class="btn ghost" style="margin-top:8px" data-act="finish-onboard">Go to Today</button>'}
  </section>`;
}

async function runOnboard() {
  const o = ui.onboard;
  o.username = ($('#uname')?.value || o.username).trim();
  if ($('#pgn')) o.pgn = $('#pgn').value;
  if (!o.username) { o.error = 'Enter your username first.'; render(); return; }
  if (o.source === 'pgn' && !o.pgn.trim()) { o.error = 'Paste at least one game.'; render(); return; }
  const s = state();
  // Data left behind by an earlier account must never be counted for this one.
  if (!s.profile && Object.keys(s.games).length) clearAccountData();
  s.profile = { source: o.source, username: o.username, createdAt: Date.now() };
  o.step = 'analyse'; o.error = ''; o.reportable = false; o.counts = { games: 0, mistakes: 0, drills: 0 }; o.live = 'Fetching your games'; o.progress = 0.02; o.early = false; o.canStart = false;
  ui.syncing = true;
  render();
  ui.importNote = null;
  try {
    const result = await sync({
      count: s.settings.gamesToImport, pgn: o.pgn,
      onStatus: (st) => {
        if (st.phase === 'fetch') o.live = `Fetching your ${sourceLabel(o.source)} games`;
        if (st.phase === 'analyse') { o.progress = ((st.game - 1) + st.frac) / st.games; o.live = `Analyzing game ${st.game} of ${st.games}`; }
        if (st.phase === 'game') {
          o.counts = { games: st.game, mistakes: st.mistakes, drills: st.drills };
          const top = st.rec.mistakes[0];
          o.live = top ? `Game ${st.game} of ${st.games}: ${pat(top.pattern).name.toLowerCase()} on move ${Math.ceil(top.ply / 2 + 0.5)}` : `Game ${st.game} of ${st.games}: a clean one`;
        }
        if (st.phase === 'game' && st.game >= 5 && st.game < st.games && !o.canStart) { o.canStart = true; const eb = $('#earlyBtn'); if (eb) eb.hidden = false; }
        if (o.early) {
          setBg(`Analyzing game ${Math.min(st.game || 0, st.games || 0)} of ${st.games || '?'} · ${Math.round(o.progress * 100)}% · ${plural(o.counts.mistakes, 'mistake')} found`, o.progress);
          if (st.phase === 'game' && o.step === 'reveal') render();
        }
        const el = view.querySelector('.live');
        if (el) {
          view.querySelector('.bar > i').style.width = Math.round(o.progress * 100) + '%';
          el.textContent = o.live;
          const c = view.querySelectorAll('.counts b');
          c[0].textContent = o.counts.games; c[1].textContent = o.counts.mistakes; c[2].textContent = o.counts.drills;
        }
      },
    });
    ui.syncing = false;
    const sum = importSummary(result, o.source);
    ui.importNote = result.skipped.length || o.source === 'pgn' ? sum : null;
    if (o.early) {
      setBg(null);
      if (o.step === 'reveal' || ['today', 'diagnose', 'report'].includes(ui.tab)) render();
      toast('All games analyzed.');
      return;
    }
    o.step = 'reveal';
  } catch (e) {
    ui.syncing = false;
    logError('sync', e);
    if (o.early) { setBg(null); toast(e.message || 'Analysis stopped. Pull in more games from Diagnose.'); return; }
    logError('sync', e);
    o.step = 'form'; s.profile = null; o.reportable = true;
    o.error = e.message || 'Something went wrong. Try again.';
  }
  render();
}

function importNoteHtml() {
  const n = ui.importNote;
  if (!n) return '';
  return `<div class="card" style="margin-top:12px;background:var(--amber-soft);border-color:transparent" role="status"><p><b>${esc(n.head)}</b></p>${n.lines.map((l) => `<p class="small" style="margin-top:4px">${esc(l)}</p>`).join('')}<button class="link" data-act="dismiss-note" style="padding:0;min-height:0;margin-top:6px">Dismiss</button></div>`;
}

/* ------------------------------------------------------------------ Today */
function patCard(p, max, rank, withBtn = true) {
  const games = Math.max(1, patternStats(state()).games);
  const cost = (p.cost / games).toFixed(1);
  return `<article class="card pat stack" style="margin-top:0;gap:10px">
    <div class="row"><h3>${rank} · ${esc(nameOf(p.id))}</h3><span class="tag">${plural(p.count, 'time')}</span></div>
    <p>${esc(PATTERNS[p.id].blurb)}</p>
    <div class="bar" role="img" aria-label="Cost ${cost} points"><i style="width:${Math.max(4, (p.cost / max) * 100)}%"></i></div>
    <p class="small sub">Costs you about ${cost} win-chance points per game</p>
    ${withBtn ? `<div class="row" style="gap:8px"><button class="btn sm" style="flex:1" data-act="drill-pattern" data-p="${p.id}">Drill this</button><button class="btn sm ghost" data-act="see-pattern" data-p="${p.id}">See mistakes</button></div>` : ''}
  </article>`;
}

function viewToday() {
  const s = state();
  const today = buildToday(s);
  const res = todayResults(s);
  const ids = today.ids;
  const doneN = ids.filter((i) => res[i]).length;
  const st = streak(s);
  const ps = patternStats(s);
  const focus = ps.list[0] && ps.list[0].count ? ps.list[0] : null;
  const due = dueCount(s), tomorrow = dueTomorrowCount(s), ds = deliberateStreak(s);
  if (!ids.length) {
    const isPgn = s.profile && s.profile.source === 'pgn';
    return `<section class="view"><h1 class="h1">Nothing to drill from your games yet</h1><p class="sub">No mistakes were found to turn into drills. You can still train now with a few sample positions, or add more games and drills will appear here.</p>
      <div class="stack"><button class="btn" data-act="start-sample">Try a sample set</button><button class="btn ghost" data-act="tab" data-v="puzzles">Practice themed puzzles</button><button class="btn ghost" data-act="sync">${isPgn ? 'Add games from PGN' : 'Import more games'}</button></div></section>`;
  }
  const allDone = doneN === ids.length;
  const mins = Math.max(1, Math.round((ids.length - doneN) * 1.5));
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `<section class="view">
    <p class="eyebrow">${greet}</p>
    <h1 class="h1">${allDone ? 'Done for today' : 'One thing to do today'}</h1>
    <div class="stack">
      <section class="card hero">
        <div class="ring" style="--p:${Math.round((doneN / ids.length) * 100)}"><b>${doneN}/${ids.length}</b></div>
        <div><h2 class="h2">Today's set</h2><p class="sub small">${allDone ? 'All drills finished. Tomorrow’s set is already chosen.' : `${plural(ids.length - doneN, 'drill')} left, about ${mins} min`}</p></div>
      </section>
      <section class="card" aria-label="Drills in today's set">
        ${ids.map((id, i) => { const d = s.drills[id]; const r = res[id]; return `<button class="drill" data-act="open-drill" data-id="${esc(id)}"><span class="num ${r ? (r.ok ? 'done' : 'miss') : ''}">${r ? (r.ok ? '✓' : '×') : i + 1}</span><span><b>${esc(nameOf(d.pattern))}</b><small>${d.box == null ? 'New, from your games' : 'Review'} · move ${Math.ceil(d.ply / 2 + 0.5)}</small></span><span class="tag ${r ? (r.ok ? 'good' : 'bad') : ''}">${r ? (r.ok ? 'Solved' : 'Missed') : 'Start'}</span></button>`; }).join('')}
      </section>
      ${focus ? `<section class="card lesson"><div class="row"><div><p class="eyebrow">Micro-lesson · 90 sec</p><h3 class="h2" style="margin-top:2px">${esc(nameOf(focus.id))}</h3></div><button class="btn ghost sm" data-act="lesson" aria-expanded="false">Read</button></div><p id="lessonBody" class="hide">${esc(PATTERNS[focus.id].lesson)}</p></section>` : ''}
      <section class="card"><div class="row"><h2 class="h2">Your week</h2><span class="row" style="gap:6px"><span class="tag">${st.current ? `${st.current}-day streak` : 'No streak yet'}</span><span class="tag" title="Drills solved first try, with no hint, after thinking">${ds.current} deliberate</span></span></div>
        <div class="week" style="margin-top:12px">${st.week.map((d) => `<div class="${d.done ? 'on' : ''} ${d.today ? 'today' : ''}"><i>${d.done ? '✓' : ''}</i>${['M', 'T', 'W', 'T', 'F', 'S', 'S'][(new Date(d.ts).getDay() + 6) % 7]}</div>`).join('')}</div>
        <p class="small sub" style="margin-top:12px">Finish at least ${Math.min(3, setSize())} drills to count the day. One rest day a week will not break your streak.</p>
        <p class="small sub" style="margin-top:6px">Deliberate streak: drills solved first try, with no hint, after at least ${MIN_THINK_SECS} seconds of thinking. Taking longer never hurts it.</p>
      </section>
      <div class="row" style="gap:12px">
        <section class="card" style="flex:1"><div class="big">${due}</div><p class="sub small" style="margin-top:6px">positions due for review today</p><p class="sub small">${tomorrow} due tomorrow</p></section>
        <section class="card" style="flex:1"><div class="big">${minutesTrained(s, weekStart(Date.now()))}</div><p class="sub small" style="margin-top:6px">minutes trained this week</p></section>
      </div>
    </div>
    ${allDone ? '' : `<div class="cta"><button class="btn" data-act="start-set">${doneN ? 'Continue today’s set' : 'Start today’s set'}</button></div>`}
  </section>`;
}

/* ------------------------------------------------------------------ Diagnose */
function viewDiagnose() {
  const s = state();
  const ps = patternStats(s);
  const games = gamesByDate(s).slice(0, 25);
  const max = Math.max(1, ...ps.list.map((p) => p.cost));
  const withData = ps.list.filter((p) => p.count);
  return `<section class="view">
    <div class="row"><button class="link" data-act="tab" data-v="report" style="padding-left:0">‹ Report</button></div>
    <p class="eyebrow">${esc(sourceLabel(s.profile.source))} · ${esc(s.profile.username)}${s.lastSync ? ` · synced ${fmtDay(s.lastSync)}` : ''}</p>
    <h1 class="h1">${s.profile.source === 'pgn' ? 'Your' : 'Your last'} ${plural(ps.games, 'game')}</h1>
    <p class="sub">The patterns that cost you the most win chance. Words are templates over engine facts, never guesses.</p>
    <div class="stack">
      <button class="btn ghost" data-act="sync" ${ui.syncing ? 'disabled' : ''}>${ui.syncing ? 'Analyzing…' : s.profile.source === 'pgn' ? 'Add games from PGN' : 'Import new games'}</button>
      ${importNoteHtml()}
      ${s.staleMistakes ? `<div class="card" style="background:var(--amber-soft);border-color:transparent"><p><b>${plural(s.staleMistakes, 'older mistake')}</b> use the previous labels. Delete your data in Settings and import again to refresh them.</p></div>` : ''}
      ${withData.length ? withData.map((p, i) => patCard(p, max, i + 1)).join('') : '<div class="card"><p>No mistakes found. Great games, or import more.</p></div>'}
      <section class="card"><h2 class="h2">Recent games</h2><p class="sub small" style="margin:2px 0 6px">Tap a game to step through its biggest mistakes.</p>
        ${games.map((g) => `<div class="game" data-act="review" data-id="${esc(g.id)}" role="button" tabindex="0" aria-label="${esc(`${gameTitle(g)}, accuracy ${Math.round(g.accuracy)}, ${fmtDay(g.date)}, ${plural(g.mistakes.length, 'mistake')}. Review`)}"><span class="acc ${accClass(g.accuracy)}" title="Accuracy">${Math.round(g.accuracy)}</span><span><b>${resultWord(g.result)}</b> as ${g.color} vs ${esc(g.opponent)}<small>${fmtDay(g.date)}${g.speed ? ' · ' + esc(g.speed) : ''} · ${plural(g.mistakes.length, 'mistake')}</small></span><span class="small sub" aria-hidden="true">Review ›</span></div>`).join('') || '<p class="sub">No games yet.</p>'}
      </section>
    </div>
  </section>`;
}

function seePattern(id) {
  const s = state();
  const items = Object.values(s.games).flatMap((g) => g.mistakes.filter((m) => m.pattern === id).map((m) => ({ g, m })))
    .sort((a, b) => b.g.date - a.g.date).slice(0, 40);
  openSheet(`<h2 class="h2">${esc(nameOf(id))}</h2><p class="sub small" style="margin:4px 0 8px">${esc(PATTERNS[id].blurb)}</p>
    ${items.map(({ g, m }) => `<div class="mrow"><b>${esc(m.playedSan)} on move ${Math.ceil(m.ply / 2 + 0.5)}</b><span class="tag bad">−${Math.round(m.wpLoss)}%</span><small>${fmtDay(g.date)} vs ${esc(g.opponent)}</small><button class="link" data-act="review" data-id="${esc(g.id)}" data-ply="${m.ply}" style="min-height:36px;padding:2px 6px">Review</button></div>`).join('') || '<p class="sub">Nothing here.</p>'}
    <button class="btn ghost" style="margin-top:14px" data-act="close">Close</button>`);
}

/* ------------------------------------------------------------------ Retry */
function startSample() {
  ui.onboard.step = 'form';
  startSession(SAMPLE_DRILLS.map((d) => d.id), 'Sample set');
  ui.session.sample = true;
}

function startSession(ids, label) {
  const s = state();
  const res = todayResults(s);
  const list = ids.slice();
  // unfinished first
  list.sort((a, b) => (res[a] ? 1 : 0) - (res[b] ? 1 : 0));
  ui.session = { ids: list, idx: 0, label, results: {} };
  ui.drill = null;
  nav('drills');
}

function currentDrill() {
  const s = state(), se = ui.session;
  if (!se) return null;
  return s.drills[se.ids[se.idx]] || sampleById(se.ids[se.idx]) || null;
}

function viewRetry() {
  const s = state(), se = ui.session;
  if (ui.puzzle) return viewPuzzle();
  if (!se) return viewHub();
  if (se.idx >= se.ids.length) return viewSummary();
  const d = currentDrill();
  const dr = ui.drill;
  const me = d.side === 'w' ? 'White' : 'Black';
  return `<section class="view">
    <div class="row"><p class="eyebrow">Drill ${se.idx + 1} of ${se.ids.length}</p><span class="row" style="gap:4px"><span class="tag">${esc(nameOf(d.pattern))}</span><button class="link" data-act="hub" style="min-height:36px;padding:4px 8px">End</button></span></div>
    <div class="prog" aria-hidden="true">${se.ids.map((id, i) => `<i class="${se.results[id] ? (se.results[id].ok ? 'on' : 'miss') : i === se.idx ? 'cur' : ''}"></i>`).join('')}</div>
    <h1 class="h1" style="margin-top:12px">${dr.phase === 'ask' ? 'Find the better move' : dr.ok ? 'Good find' : 'Not quite'}</h1>
    <p class="sub">${dr.phase === 'ask' ? `You are ${me}. In your game this position cost you ${Math.round(d.wpLoss)}% win chance.` : ''}</p>
    ${thinkBox}
    <div class="split">
      <div class="board-wrap"><div id="board"></div></div>
      <div class="split-side">
        <div id="fb">${fbHtml()}</div>
        <div class="stack" style="margin-top:12px">${actionsHtml()}</div>
      </div>
    </div>
  </section>`;
}

function fbHtml() {
  const d = currentDrill(), dr = ui.drill;
  if (!d || !dr) return '';
  if (dr.phase === 'checking') return '<div class="fb hint"><b>Checking with the engine<span class="thinking"><i></i><i></i><i></i></span></b></div>';
  let h = '';
  if (dr.hint) h += `<div class="fb hint"><b>The idea</b><p>${esc(dr.hint)}</p></div>`;
  if (dr.phase === 'ask') return h;
  const line = d.bestPv && d.bestPv.length ? d.bestPv.join(' ') : d.bestSan;
  const evalTxt = (cp, mate) => (mate != null ? `mate in ${Math.abs(mate)}` : `${cp >= 0 ? '+' : '−'}${(Math.abs(cp) / 100).toFixed(1)}`);
  const head = dr.ok ? (dr.exact ? 'Best move' : 'A good move') : 'That gives up too much';
  const body = dr.ok
    ? (dr.exact ? `${esc(d.bestSan)} is what the engine plays.` : `${esc(dr.san)} keeps the position healthy. The engine’s first choice was ${esc(d.bestSan)}.`)
    : `${esc(dr.san)} drops about ${Math.round(dr.drop)}% win chance.${dr.fast ? ` Played in ${Math.max(1, Math.round(dr.secs))}s. Look at checks, captures and threats first.` : ''}`;
  h += `<div class="fb ${dr.ok ? 'good' : 'bad'}" role="status"><b>${head}</b><p>${body}</p><p style="margin-top:8px">${esc(d.explain)}</p>
    <p class="small sub" style="margin-top:8px">${d.sample ? 'This is a built-in sample, so it is not saved to your reports.' : dr.ok ? 'It comes back for review on a spaced schedule.' : 'It returns tomorrow so you can try again.'}${dr.deliberate ? ' Counted toward your deliberate streak.' : ''}</p></div>
    ${lessonSection(dr.lesson, dr, 'lesson card')}
    <details class="eng"><summary>What the coach sees</summary><p>In your game you played <span class="mono">${esc(d.playedSan)}</span>. Engine line: <span class="mono">${esc(line)}</span>.</p><p>Evaluation for you: ${evalTxt(d.bestCp, d.bestMate)} with the best move, ${evalTxt(d.cpAfter)} after ${esc(d.playedSan)}. ${d.sample ? 'Approximate, for this built-in sample.' : 'Checked on this device with Stockfish.'}</p></details>`;
  return h;
}

function actionsHtml() {
  const dr = ui.drill, se = ui.session;
  if (dr.phase === 'ask') return `<button class="btn ghost" data-act="idea">${dr.hint ? (dr.hintSq ? 'Hint shown' : 'Show the piece to move') : 'Show the idea first'}</button><button class="link" data-act="skip" style="align-self:center">Skip, return it tomorrow</button>`;
  if (dr.phase === 'checking') return '';
  const last = se.idx >= se.ids.length - 1;
  let h = '';
  if (!dr.ok) h += `<button class="btn ghost" data-act="again">Try again</button><button class="btn ghost" data-act="answer">Show the answer</button>`;
  h += `<button class="btn" data-act="next">${last ? 'Finish set' : 'Next drill'}</button>`;
  return h;
}

/** Think-first mode: keeps the board locked until the chosen number of seconds has passed since the position appeared. */
let thinkTimer = null;
function applyThink(owner) {
  clearInterval(thinkTimer); thinkTimer = null;
  const el = $('#think'), secs = state().settings.thinkSecs || 0;
  if (!el) return;
  const left = () => (owner.thinkAt + secs * 1000 - Date.now()) / 1000;
  if (!secs || !owner.thinkAt || owner.phase !== 'ask' || left() <= 0) { el.hidden = true; return; }
  ui.board.setEnabled(false);
  const draw = () => {
    const l = left();
    if ((ui.drill !== owner && ui.puzzle !== owner) || !ui.board || !$('#think')) { clearInterval(thinkTimer); return; }
    if (l <= 0) { clearInterval(thinkTimer); el.hidden = true; if (owner.phase === 'ask') ui.board.setEnabled(true); announce('Your move'); return; }
    el.hidden = false;
    el.innerHTML = `<span>Think first. Look for checks, captures and threats. You can move in <b>${Math.ceil(l)}s</b>.</span><span class="tbar"><i style="width:${Math.round((1 - l / secs) * 100)}%"></i></span>`;
  };
  draw(); thinkTimer = setInterval(draw, 250);
}
const FAST_DRILL_SECS = 3;      // a wrong move this quick, with Think first off, is named as rushed
const MIN_THINK_SECS = 5;       // matches MIN_THINK_MS in srs.js
const THINK_OPTS = [[0, 'Off'], [5, '5 sec'], [15, '15 sec'], [30, '30 sec'], [60, '1 min']];
const thinkBox = '<div id="think" class="think" role="status" hidden></div>';

function mountDrill() {
  const d = currentDrill();
  if (!d) return;
  if (!ui.drill || ui.drill.id !== d.id) ui.drill = { id: d.id, phase: 'ask', start: Date.now(), thinkAt: Date.now(), hint: '', hintSq: false, graded: false };
  const el = $('#board');
  if (!el) return;
  ui.board = new Board(el, { fen: d.fen, orientation: d.side, canMove: ui.drill.phase === 'ask', onMove: answer });
  // re-apply state after a rerender mid-drill
  const dr = ui.drill;
  applyThink(dr);
  if (dr.phase !== 'ask' && dr.playedUci) { ui.board.play(dr.playedUci); ui.board.mark(dr.playedUci.slice(2, 4), dr.ok ? 'good' : 'bad'); }
  if (dr.phase === 'done' && dr.lesson && dr.shown) lpApply();
  if (dr.hintSq) ui.board.mark(d.bestUci.slice(0, 2), 'hint');
}

async function answer(uci, san) {
  const d = currentDrill(), dr = ui.drill;
  if (!d || dr.phase !== 'ask') return;
  dr.playedUci = uci; dr.san = san; dr.phase = 'checking';
  dr.secs = (Date.now() - dr.start) / 1000;   // seconds from the position appearing (or the last retry) to this move
  ui.board.play(uci); ui.board.setEnabled(false);
  rerenderDrillPanel();
  let ok, exact = uci === d.bestUci, drop = 0, ev = null;
  if (exact) ok = true;
  else {
    try {
      const after = ui.board.fen();
      ev = await getEngine().evaluate(after, { movetime: 250 });
      const userCp = -ev.cpc;
      drop = Math.max(0, winPct(d.bestCp) - winPct(userCp));
      ok = drop <= 7;
    } catch (e) { logError('drill-check', e); ok = false; drop = 99; }
  }
  if (ui.drill !== dr) return;
  dr.ok = ok; dr.exact = exact; dr.drop = drop; dr.phase = 'done';
  // A wrong move played within 3 seconds, with Think first off, gets the speed named in its feedback.
  dr.fast = !ok && dr.secs < FAST_DRILL_SECS && !(state().settings.thinkSecs > 0);
  ui.board.mark(uci.slice(2, 4), ok ? 'good' : 'bad');
  if (!dr.graded) {
    dr.graded = true;
    const s = state();
    const meta = { hint: !!dr.hint, retried: !!dr.retried };
    dr.deliberate = !d.sample && isDeliberate(ok, Date.now() - dr.start, meta);   // samples are never saved, so never counted
    gradeDrill(s, d.id, ok, Date.now() - dr.start, meta);
    ui.session.results[d.id] = { ok };
    save();
  }
  if (navigator.vibrate) try { navigator.vibrate(ok ? 15 : [30, 40, 30]); } catch { /* ignore */ }
  render();
  setTimeout(() => announce(`${ok ? (exact ? 'Best move.' : 'A good move.') : 'That gives up too much.'} ${d.explain}`), 700);
  loadDrillLesson(d, dr, ev);
}

/** Works out why the move was right or wrong, then fills in the explanation under the board. */
async function loadDrillLesson(d, dr, ev) {
  const same = dr.playedUci === d.playedUci;
  const lines = await ensureLines(d, !dr.exact && same);
  if (ui.drill !== dr) return;
  dr.lesson = buildLesson({
    fen: d.fen, playedUci: dr.playedUci, bestUci: d.bestUci, bestRest: lines.bestRest,
    refPv: dr.exact ? [] : same ? lines.ref : (ev ? ev.pv.slice(0, 8) : []),
    refMate: dr.exact ? null : same ? lines.refMate : (ev ? ev.mate : null),
    wpBefore: d.wpBefore, wpLoss: same ? d.wpLoss : dr.drop, bestMate: d.bestMate,
    verdict: dr.exact ? 'best' : dr.ok ? 'good' : 'bad',
  });
  if (!dr.shown) { dr.shown = dr.exact ? 'best' : 'played'; dr.idx = 0; }
  rerenderDrillPanel(); lpApply();
  announce(dr.lesson.played.points.join(' '));
}

function rerenderDrillPanel() {
  const fb = $('#fb'); if (fb) fb.innerHTML = fbHtml();
  const st = $('#view .stack:last-of-type'); if (st) st.innerHTML = actionsHtml();
}

function nextDrill() {
  const se = ui.session;
  se.idx++; ui.drill = null; render(); window.scrollTo(0, 0);
}


/* ------------------------------------------------------------------ Practice hub */
function viewHub() {
  const s = state(), pr = ui.practice;
  const onPuzzleTab = ui.tab === 'puzzles';
  const games = pr.mode === 'games' && !onPuzzleTab;
  const modeBar = onPuzzleTab ? '' : `<div class="mode" role="tablist" aria-label="Practice source"><button role="tab" data-act="mode" data-v="games" aria-selected="${games}">My games</button><button role="tab" data-act="mode" data-v="puzzles" aria-selected="${!games}">Puzzles</button></div>`;
  const thinkPick = `<p class="group-title" style="margin-top:16px">Think first</p><p class="sub small" style="margin:0 0 8px">Board stays locked until this time is up, so you look before you move.</p><div class="chips" role="group" aria-label="Think first">${THINK_OPTS.map(([n, l]) => `<button data-act="think" data-v="${n}" aria-pressed="${(s.settings.thinkSecs || 0) === n}">${l}</button>`).join('')}</div>`;
  const chip = (act, v, label, on, off) => `<button data-act="${act}" data-v="${v}" aria-pressed="${on}" ${off ? 'disabled' : ''}>${label}</button>`;
  if (games) {
    const t = buildToday(s), res = todayResults(s);
    const left = t.ids.filter((i) => !res[i]);
    const total = extraDrills(s, 9999, 'all').length;
    const counts = Object.fromEntries(PATTERN_ORDER.map((p) => [p, extraDrills(s, 9999, p).length]));
    const avail = pr.pattern === 'all' ? total : counts[pr.pattern];
    const n = Math.min(pr.n, avail);
    const dueNow = dueCount(s), dueTom = dueTomorrowCount(s), noDrills = !Object.keys(s.drills).length;
    const setLine = !t.ids.length ? 'No drills from your games yet.' : left.length ? `${plural(left.length, 'drill')} left in today’s set.` : 'Today’s set is done, so everything here is extra.';
    return `<section class="view"><p class="eyebrow">Train</p><h1 class="h1">Do more, your way</h1>${modeBar}
      <p class="sub" style="margin-top:12px">Positions from your own games. ${setLine}</p>
      <div class="stack" style="margin-top:12px">
        ${left.length ? '<button class="btn" data-act="start-set">Continue today’s set</button>' : ''}
        ${noDrills ? '<section class="card"><h2 class="h2">Nothing to drill from your games yet</h2><p class="sub small" style="margin:4px 0 10px">Try a few sample positions now, or practice themed puzzles.</p><button class="btn" data-act="start-sample">Try a sample set</button><button class="btn ghost" style="margin-top:8px" data-act="mode" data-v="puzzles">Practice themed puzzles</button></section>' : `<section class="card"><h2 class="h2">Reviews</h2><p class="sub small" style="margin:4px 0 10px">${plural(dueNow, 'position')} due today, ${dueTom} due tomorrow. Missed drills come back the next day.</p>${dueNow ? `<button class="btn" data-act="practice-due">Review ${plural(dueNow, 'due position')}</button>` : ''}</section>`}
        <section class="card"><h2 class="h2">Pick a mistake type</h2><p class="sub small" style="margin:4px 0 10px">Reviews that are due come first. Numbers show drills available.</p>
          <div class="chips" role="group" aria-label="Mistake type">${chip('pp', 'all', `All types · ${total}`, pr.pattern === 'all', !total)}${PATTERN_ORDER.map((p) => chip('pp', p, `${esc(nameOf(p))} · ${counts[p]}`, pr.pattern === p, !counts[p])).join('')}</div>
          <p class="group-title" style="margin-top:16px">How many</p>
          <div class="chips" role="group" aria-label="How many drills">${[5, 10, 20].map((k) => chip('pn', k, k, pr.n === k, false)).join('')}</div>
          ${thinkPick}
          ${total === 0 ? '<p class="sub small" style="margin-top:8px">Import more games from Report, under Your games and mistake patterns, to find more mistakes.</p>' : ''}
        </section>
      </div>
      <div class="cta"><button class="btn" data-act="practice" ${avail ? '' : 'disabled'}>${avail ? `Start ${plural(n, 'drill')}` : 'No drills available'}</button></div></section>`;
  }
  const ps = puzzleStats(s);
  return `<section class="view"><p class="eyebrow">${onPuzzleTab ? 'Puzzles' : 'Practice'}</p><h1 class="h1">${onPuzzleTab ? 'Sharpen your tactics' : 'Do more, your way'}</h1>${modeBar}
    <p class="sub" style="margin-top:12px">Puzzles sorted by theme. They are separate from your own games, are not scheduled for review, and work offline.</p>
    <p class="sub small" id="pzDl" style="margin-top:6px" aria-live="polite"></p>
    <div class="stack" style="margin-top:12px">
      <section class="card"><div class="row"><h2 class="h2">Choose a theme</h2><span class="tag">${ps.todaySolved} solved today \u00b7 ${ps.solved} total</span></div>
        <div class="chips" style="margin-top:10px" role="group" aria-label="Theme">${chip('pt', MIXED[0], MIXED[1], pr.theme === MIXED[0], false)}</div>
        ${THEME_GROUPS.map((g) => `<p class="group-title">${esc(g.name)}</p><div class="chips" role="group" aria-label="${esc(g.name)}">${g.themes.map(([id, name]) => chip('pt', id, esc(name), pr.theme === id, false)).join('')}</div>`).join('')}
        <p class="group-title">Moves in the solution</p>
        <div class="chips" role="group" aria-label="Moves in the solution">${MOVE_COUNTS.map(([id, name]) => chip('pm', id, name, String(pr.moves) === String(id), false)).join('')}</div>
        <p class="group-title">Difficulty</p>
        <div class="chips" role="group" aria-label="Difficulty">${DIFFICULTY.map(([id, name]) => chip('pd', id, name, pr.difficulty === id, false)).join('')}</div>
        ${thinkPick}
        ${Object.keys(s.drills).length ? '<button class="link" data-act="pmatch" style="margin-top:8px">Pick a theme for my top mistake type</button>' : ''}
      </section>
    </div>
    <div class="cta"><p class="sub small" id="pzCount" style="text-align:center;margin:0 0 6px;font-weight:600">&nbsp;</p>
      <button class="btn" data-act="puzzle-start" id="pzStart">Start ${esc(themeName(pr.theme))} puzzles</button></div></section>`;
}

/** First visit: fetch all puzzle sets once (about 0.3 MB compressed) so they work offline. */
let pzShown = 0;  // highest count shown so far, so the counter only ever goes up
function ensurePuzzlesSaved() {
  const el = () => $('#pzDl');
  downloadAll((d, n) => { pzShown = Math.max(pzShown, d); if (el()) el().textContent = `Saving puzzle sets for offline use… ${pzShown} of ${n}`; })
    .then(() => { if (el()) el().textContent = 'Saved on this device for offline use.'; })
    .catch(() => { if (el()) el().textContent = 'Could not save puzzles for offline use. Connect and reopen this tab to retry.'; });
}

async function refreshPuzzleCount() {
  const pr = ui.practice, el = $('#pzCount'), btn = $('#pzStart');
  if (!el) return;
  ensurePuzzlesSaved();
  try {
    const n = await countMatching(pr.theme, { moves: pr.moves, difficulty: pr.difficulty });
    if (!$('#pzCount') || ui.practice !== pr) return;
    el.textContent = n ? `${n} puzzles match` : 'No puzzles match this combination. Try another number of moves or difficulty.';
    btn.disabled = !n;
  } catch { if ($('#pzCount')) $('#pzCount').textContent = 'Could not load this set. Connect once to download it.'; }
}

/* ------------------------------------------------------------------ Puzzle practice */
const solverMoves = (p) => p.moves;

async function loadPuzzle() {
  const pz = ui.puzzle;
  pz.phase = 'loading'; pz.p = null; render();
  try {
    pz.p = await nextPuzzle(pz.theme, { moves: pz.moves, difficulty: pz.difficulty }, pz.seen);
    pz.seen.add(pz.p.id);
    const sv = state(); sv.puzzleSeen = [...pz.seen].slice(-4000); save();
    pz.step = 0; pz.phase = 'ask'; pz.failed = false; pz.hint = false; pz.start = Date.now(); pz.thinkAt = Date.now(); pz.msg = ''; pz.msgKind = '';
    if (pz.p.wrapped) { pz.msgTitle = 'You have seen them all'; pz.msg = `Every one of the ${pz.p.pool} matching puzzles is done. Starting over.`; pz.msgKind = 'hint'; }
  } catch (e) { pz.phase = 'error'; pz.error = e.message || 'Could not load a puzzle.'; }
  render();
}

function viewPuzzle() {
  const pz = ui.puzzle, p = pz.p;
  const head = `<div class="row"><p class="eyebrow" id="pzHead">Puzzles · ${pz.solved} solved of ${pz.tried}</p><button class="link" data-act="hub" style="min-height:36px;padding:4px 8px">Done</button></div>`;
  if (pz.phase === 'loading') return `<section class="view">${head}<h1 class="h1">Finding a puzzle<span class="thinking"><i></i><i></i><i></i></span></h1></section>`;
  if (pz.phase === 'error') return `<section class="view">${head}<h1 class="h1">No puzzle yet</h1><div class="err" role="alert">${esc(pz.error)}</div><div class="stack"><button class="btn" data-act="puzzle-next">Try again</button><button class="btn ghost" data-act="hub">Back to practice</button></div></section>`;
  const me = p.side === 'w' ? 'White' : 'Black';
  return `<section class="view">${head}
    <div class="row"><span class="tag">${esc(themeName(pz.theme))}</span><span class="tag">${plural(p.moves, 'move')}</span><span class="tag">Rating ${p.rating}</span></div>
    <h1 class="h1" style="margin-top:10px" id="pzTitle">${pzTitle()}</h1>
    <p class="sub" id="pzSub">${pzSub(me)}</p>
    ${thinkBox}
    <div class="split">
      <div class="board-wrap"><div id="board"></div></div>
      <div class="split-side">
        <div id="pzFb">${pzFb()}</div>
        <div class="stack" style="margin-top:12px" id="pzActions">${pzActions()}</div>
      </div>
    </div></section>`;
}
const pzTitle = () => (ui.puzzle.phase === 'solved' ? (ui.puzzle.failed ? 'Puzzle finished' : 'Solved') : 'Find the best move');
const pzSub = (me) => (ui.puzzle.phase === 'solved' ? '' : `You are ${me}. Move ${Math.floor(ui.puzzle.step / 2) + 1} of ${solverMoves(ui.puzzle.p)}.`);
function pzFb() {
  const pz = ui.puzzle;
  if (!pz.msg) return '';
  const kind = pz.phase === 'solved' && !pz.failed ? 'good' : pz.msgKind || 'hint';
  return `<div class="fb ${kind}" role="status"><b>${esc(pz.msgTitle || '')}</b><p>${esc(pz.msg)}</p></div>`;
}
function pzActions() {
  const pz = ui.puzzle;
  if (pz.phase === 'solved') return '<button class="btn" data-act="puzzle-next">Next puzzle</button><button class="btn ghost" data-act="hub">Back to practice</button>';
  return `<button class="btn ghost" data-act="pz-hint">${pz.hint ? 'Hint shown' : 'Show a hint'}</button><button class="link" data-act="pz-skip" style="align-self:center">Show the answer and skip</button>`;
}
function pzRefresh() {
  const me = ui.puzzle.p.side === 'w' ? 'White' : 'Black';
  $('#pzTitle').textContent = pzTitle(); $('#pzSub').textContent = pzSub(me);
  $('#pzFb').innerHTML = pzFb(); $('#pzActions').innerHTML = pzActions();
  $('#pzHead').textContent = `Puzzles · ${ui.puzzle.solved} solved of ${ui.puzzle.tried}`;
  if (ui.puzzle.msg) setTimeout(() => announce(`${ui.puzzle.msgTitle || ''}. ${ui.puzzle.msg}`), 500);
}
function mountPuzzle() {
  const pz = ui.puzzle;
  if (!pz || !pz.p || !$('#board')) return;
  ui.board = new Board($('#board'), { fen: pz.p.fen, orientation: pz.p.side, canMove: pz.phase === 'ask', onMove: puzzleMove });
  applyThink(pz);
}
function logPuzzle(ok) {
  const pz = ui.puzzle, s = state();
  s.attempts.push({ t: Date.now(), id: 'lp:' + pz.p.id, ok, ms: Math.min(Date.now() - pz.start, 120000), kind: 'puzzle', theme: pz.theme });
  pz.tried++; if (ok) pz.solved++;
  save();
}
function puzzleMove(uci, san) {
  const pz = ui.puzzle, sol = pz.p.solution;
  if (pz.phase !== 'ask') return;
  if (uci === sol[pz.step] || san.endsWith('#')) {
    ui.board.play(uci);
    pz.step++; pz.msg = '';
    if (pz.step >= sol.length || san.endsWith('#')) {
      pz.phase = 'solved'; pz.msgTitle = pz.failed ? 'Finished' : 'Well done'; pz.msg = pz.failed ? 'You got there. It counts as a miss because of the wrong tries.' : 'Every move found.';
      ui.board.setEnabled(false); logPuzzle(!pz.failed);
      if (navigator.vibrate) try { navigator.vibrate(15); } catch { /* ignore */ }
      pzRefresh(); return;
    }
    ui.board.setEnabled(false); pzRefresh();
    setTimeout(() => {
      if (ui.puzzle !== pz || !ui.board) return;
      ui.board.play(sol[pz.step]); pz.step++;
      if (pz.step >= sol.length) { pz.phase = 'solved'; pz.msgTitle = 'Finished'; pz.msg = 'Puzzle complete.'; logPuzzle(!pz.failed); pzRefresh(); return; }
      ui.board.setEnabled(true); pzRefresh();
    }, 450);
  } else {
    pz.failed = true; pz.msgTitle = 'Not that one'; pz.msgKind = 'bad'; pz.msg = 'Try another move. A hint is available.';
    ui.board.mark(uci.slice(2, 4), 'bad');
    setTimeout(() => { if (ui.board && ui.puzzle === pz) ui.board.clearMarks(); }, 600);
    if (navigator.vibrate) try { navigator.vibrate([30, 40, 30]); } catch { /* ignore */ }
    pzRefresh();
  }
}

function viewSummary() {
  const s = state(), se = ui.session;
  const ids = se.ids, got = ids.filter((i) => se.results[i] && se.results[i].ok).length;
  const st = streak(s);
  const left = dueCount(s);
  return `<section class="view"><p class="eyebrow">${esc(se.label || 'Set complete')}</p>
    <h1 class="h1">${got === ids.length ? 'Clean sweep' : 'Set complete'}</h1>
    <div class="stack">
      <div class="tiles"><div class="card tile"><div class="big up">${got}/${ids.length}</div><p class="k">solved first try</p></div><div class="card tile"><div class="big">${st.current || 0}</div><p class="k">day streak</p></div></div>
      <section class="card"><p class="story">${se.sample ? 'Sample positions are not saved to your reports. Add more games and drills from your own mistakes will appear on Today.' : got === ids.length ? 'Every position solved. These come back later on a spaced schedule.' : 'The ones you missed return tomorrow, and Today shows them as due tomorrow. That is how they stick.'}</p></section>
      ${se.sample ? '<button class="btn" data-act="tab" data-v="puzzles">Practice themed puzzles</button>' : '<button class="btn" data-act="tab" data-v="report">See your report</button>'}
      <button class="btn ghost" data-act="tab" data-v="today">Back to Today</button>
    </div></section>`;
}

/* ------------------------------------------------------------------ Report */
function viewReport() {
  const s = state();
  const week = ui.report === 'week';
  let body = '';
  let eyebrow, title;
  if (ui.report === 'puz') {
    eyebrow = 'Puzzle practice';
    title = 'Your puzzle habit';
    body = puzzleBody(puzzleReport(s, ui.pzPeriod, ui.pzSort));
  } else if (week) {
    const w = weekly(s, addDays(Date.now(), ui.weekOffset * 7));
    eyebrow = `Week of ${fmtRange(w.from, w.to)}`;
    title = w.isCurrent ? 'Your week in one screen' : 'That week in one screen';
    body = weekBody(w);
  } else {
    const a = allTime(s);
    eyebrow = a.games ? `${fmtDay(a.firstTs)} to now` : 'Since you started';
    title = 'How far you have come';
    body = allBody(a);
  }
  return `<section class="view"><p class="eyebrow">${eyebrow}</p><h1 class="h1">${title}</h1>
    <div class="seg seg3" role="tablist" aria-label="Report range"><button role="tab" data-act="rep" data-v="week" aria-selected="${week}">Week</button><button role="tab" data-act="rep" data-v="all" aria-selected="${ui.report === 'all'}">All time</button><button role="tab" data-act="rep" data-v="puz" aria-selected="${ui.report === 'puz'}">Puzzles</button></div>
    ${week ? `<div class="weeknav"><button class="link" data-act="wk" data-v="-1">‹ Earlier</button><button class="link" data-act="wk" data-v="1" ${ui.weekOffset >= 0 ? 'disabled style="opacity:.4"' : ''}>Later ›</button></div>` : ''}
    <div class="stack"><button class="btn ghost" data-act="tab" data-v="diagnose">Your games and mistake patterns</button>${body}</div></section>`;
}

function puzzleBody(p) {
  if (!p.hasData) return '<div class="card"><p class="story">No puzzles solved yet.</p><p class="sub small" style="margin-top:6px">Open the Train tab, switch to Puzzles and try a few. They will show up here by day, week, month and theme.</p></div>';
  const T = p.totals, tile = (k, label) => `<div class="card tile"><div class="big">${T[k].tried}</div><p class="k">${label}${T[k].acc != null ? `, ${T[k].acc}% solved first try` : ''}</p></div>`;
  const max = Math.max(1, ...p.days.map((d) => d.tried));
  const bars = p.days.map((d) => `<div class="pbar" title="${fmtDay(d.ts)}: ${d.solved} of ${d.tried} first try"><span class="pv">${d.tried || ''}</span><i style="height:${Math.round((d.tried / max) * 100)}%"><b style="height:${d.tried ? Math.round((d.solved / d.tried) * 100) : 0}%"></b></i><span class="pl">${new Date(d.ts).getDate()}</span></div>`).join('');
  const seg = (act, cur, opts) => `<div class="chips" role="group">${opts.map(([v, l]) => `<button data-act="${act}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  const rows = p.themes.map((t) => `<tr><td>${esc(t.id === '?' ? 'Before themes were tracked' : themeName(t.id))}</td><td>${t.tried}</td><td>${t.acc}%</td></tr>`).join('');
  return `<div class="tiles">${tile('day', 'today')}${tile('week', 'this week')}${tile('month', 'this month')}${tile('all', 'all time')}</div>
    <section class="card chart"><h2 class="h2" style="margin-bottom:4px">Puzzles per day, last 14 days</h2><p class="sub small" style="margin-bottom:10px">Bar height is puzzles tried. The dark part was solved first try.</p><div class="pbars" role="img" aria-label="Puzzles tried per day for the last 14 days">${bars}</div></section>
    <section class="card"><h2 class="h2" style="margin-bottom:10px">By theme</h2>
      ${seg('pz-period', p.period, [['day', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All time']])}
      <p class="sub small" style="margin:12px 0 8px">Sort by</p>
      ${seg('pz-sort', p.sort, [['count', 'Most played'], ['acc', 'Accuracy'], ['name', 'Name']])}
      ${rows ? `<table class="ptable"><thead><tr><th>Theme</th><th>Tried</th><th>First try</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="sub small" style="margin-top:12px">No puzzles in this period.</p>'}
    </section>`;
}

const scopeLine = (t) => `<br><span class="scope">${esc(t)}</span>`;

function weekBody(w) {
  if (!w.hasData) return '<div class="card"><p class="story">No games or drills this week yet.</p><p class="sub small" style="margin-top:6px">Play a few games, import them, then finish today’s set.</p></div>';
  const topName = nameOf(w.topPattern), focus = nameOf(w.focus);
  const story = [
    w.games ? `You analyzed ${plural(w.games, 'game')}${w.acc != null ? ` at ${w.acc}% accuracy${w.delta != null ? (w.delta >= 0 ? `, up ${w.delta}` : `, down ${Math.abs(w.delta)}`) + ' on the week before' : ''}` : ''}.` : 'No new games this week.',
    w.drillsTried ? `You trained on ${plural(w.daysTrained, 'day')} and solved ${w.drillsPassed} of ${w.drillsTried} drills.` : 'No drills this week yet.',
    `${topName} cost you the most (${w.scope.toLowerCase()})${w.improving ? ' and is improving' : ''}. Next focus: ${focus.toLowerCase()} (${w.focusScope.toLowerCase()}).`,
  ].join(' ');
  const pts = w.trend.map((t) => ({ v: t.acc }));
  return `<p class="story">${esc(story)}</p>
    <div class="tiles">
      <div class="card tile"><div class="big ${w.delta == null ? '' : w.delta >= 0 ? 'up' : 'down'}">${w.delta == null ? (w.acc != null ? w.acc + '%' : '–') : arrow(w.delta) + ' pts'}</div><p class="k">${w.delta == null ? 'accuracy this week' : 'accuracy vs last week'}${scopeLine(w.scope)}</p></div>
      <div class="card tile"><div class="big">${w.minutes} min</div><p class="k">trained across ${plural(w.daysTrained, 'day')}${scopeLine('This week')}</p></div>
      <div class="card tile"><div class="big" style="font-size:21px;line-height:1.15">${esc(topName)}</div><p class="k">top pattern${w.improving ? ', improving' : ''}${scopeLine(w.scope)}</p></div>
      <div class="card tile"><div class="big" style="font-size:21px;line-height:1.15">${esc(focus)}</div><p class="k">next week’s focus${scopeLine(w.focusScope)}</p></div>
    </div>
    <section class="card chart"><h2 class="h2" style="margin-bottom:8px">Accuracy, last 6 weeks</h2><p class="scope">Weekly averages, all analyzed games</p>${line(pts, { labels: [[0, fmtDay(w.trend[0].ts)], [5, w.isCurrent ? 'Now' : fmtDay(w.trend[5].ts)]], alt: 'Weekly accuracy for the last six weeks' })}</section>
    <button class="btn" data-act="share">Share my report</button>`;
}

function allBody(a) {
  if (!a.games) return '<div class="card"><p class="story">Import your games to start your history.</p></div>';
  const need = !a.trainStart ? 'Finish today’s set to start your training clock.' : `You have ${plural(a.afterN, 'game')} since training began, ${plural(a.trainedDays, 'day')} ago.`;
  const note = a.enough ? '' : `<section class="card" style="background:var(--amber-soft);border-color:transparent"><h2 class="h2">Baseline captured</h2><p style="margin-top:4px">Your ${plural(a.beforeN, 'earlier game')} set the starting line. Improvement appears once you have 10 new games and at least two weeks of training. ${esc(need)} Play, then import your new games.</p></section>`;
  const story = a.enough && a.accDelta != null
    ? `Since you started training, accuracy ${a.accDelta >= 0 ? 'is up' : 'is down'} ${Math.abs(a.accDelta)} points, from ${a.eAcc}% to ${a.lAcc}%.`
    : `Your starting accuracy is ${a.lAcc}%. This is the line you will beat.`;
  const pts = a.weeks.map((w) => ({ v: w.acc }));
  const idx = (f) => Math.min(pts.length - 1, Math.round((pts.length - 1) * f));
  return `${note}<p class="story">${esc(story)}</p>
    <div class="tiles">
      <div class="card tile"><div class="big ${a.accDelta == null ? '' : a.accDelta >= 0 ? 'up' : 'down'}">${a.enough && a.accDelta != null ? arrow(a.accDelta) + ' pts' : a.lAcc + '%'}</div><p class="k">${a.enough && a.accDelta != null ? `accuracy, ${a.eAcc}% to ${a.lAcc}%` : 'baseline accuracy'}${scopeLine(a.scope)}</p></div>
      <div class="card tile"><div class="big">${a.games}</div><p class="k">games analyzed${scopeLine('All time')}</p></div>
      <div class="card tile"><div class="big">${a.solved}</div><p class="k">drills solved${scopeLine('All time')}</p></div>
      <div class="card tile"><div class="big">${a.mastered}</div><p class="k">mistakes mastered${scopeLine('All time')}</p></div>
      <div class="card tile"><div class="big">${a.puzzlesSolved}</div><p class="k">puzzles solved${scopeLine('All time')}</p></div>
      <div class="card tile"><div class="big">${a.minutes >= 60 ? (a.minutes / 60).toFixed(1) + ' h' : a.minutes + ' min'}</div><p class="k">time trained${scopeLine('All time')}</p></div>
      <div class="card tile"><div class="big">${a.streak.longest} ${a.streak.longest === 1 ? 'day' : 'days'}</div><p class="k">longest streak${scopeLine('All time')}</p></div>
    </div>
    <section class="card chart"><h2 class="h2" style="margin-bottom:8px">Accuracy since you started</h2><p class="scope">${esc(a.scope)}</p>${line(pts, { labels: pts.length > 1 ? [[0, fmtDay(a.weeks[0].ts)], [pts.length - 1, 'Now']] : [], marker: a.markerIdx, alt: 'Weekly accuracy since the first analyzed game' })}<p class="sub small" style="margin-top:6px">Each dot is one week: the average accuracy of the games you played that week (higher is better). A dashed line joins weeks with a gap in between because you played no games then.${a.markerIdx >= 0 ? ' The dashed line marks when you started training.' : ''}</p></section>
    ${a.patterns.length ? `<section class="card"><h2 class="h2">Mistakes per 25 games</h2><p class="scope">${esc(a.scope)}${a.enough ? '' : `, counting the latest ${plural(a.lateGames, 'game')}`}</p><p class="sub small" style="margin-bottom:6px">${a.enough ? `Your ${a.slice} games before training against your latest ${a.slice}.` : 'Your starting point. This compares properly once you have new games after training.'} Per 25 games = mistakes ÷ games counted × 25${a.lateGames === 25 ? ', so with 25 games these are the exact counts on Diagnose' : ''}. Costs are win-chance points per game, as on Diagnose.</p>${a.patterns.map((p) => pairHtml(p, a)).join('')}</section>` : ''}
    <section class="card"><h2 class="h2" style="margin-bottom:6px">Milestones</h2><p class="scope">All time</p>${a.milestones.map((m) => `<div class="mile"><time>${fmtDay(m.ts)}</time><span>${esc(m.text)}</span></div>`).join('')}</section>`;
}

function pairHtml(p, a) {
  const max = Math.max(5, ...a.patterns.flatMap((x) => [x.then, x.now]));
  const change = p.then ? Math.round(((p.then - p.now) / p.then) * 100) : 0;
  return `<div class="pair"><b>${esc(nameOf(p.id))}</b><span class="delta ${a.enough ? (change > 0 ? 'up' : change < 0 ? 'down' : '') : ''}">${a.enough ? (change > 0 ? '−' + change + '%' : change < 0 ? '+' + Math.abs(change) + '%' : 'no change') : ''}</span>
    <div class="bars">${a.enough ? `<span>Before</span><div class="bar then"><i style="width:${(p.then / max) * 100}%"></i></div><span>${p.then}</span><span>Since</span>` : '<span>Start</span>'}<div class="bar"><i style="width:${(p.now / max) * 100}%"></i></div><span>${p.now}</span></div>
    <small class="sub">${plural(p.nowCount, 'mistake')} in ${plural(a.lateGames, 'game')}, about ${p.nowCost} win-chance points a game</small></div>`;
}

async function shareReport() {
  const w = weekly(state(), addDays(Date.now(), ui.weekOffset * 7));
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
  const g = c.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  g.fillStyle = v('--bg'); g.fillRect(0, 0, 1080, 1350);
  g.fillStyle = v('--accent'); g.fillRect(0, 0, 1080, 18);
  g.fillStyle = v('--ink'); g.font = '700 64px system-ui,sans-serif'; g.fillText('My chess week', 72, 150);
  g.fillStyle = v('--ink-3'); g.font = '500 34px system-ui,sans-serif'; g.fillText(fmtRange(w.from, w.to), 72, 205);
  const tile = (x, y, big, label) => { g.fillStyle = v('--surface'); g.beginPath(); g.roundRect(x, y, 456, 230, 28); g.fill(); g.fillStyle = v('--ink'); g.font = '700 84px system-ui,sans-serif'; g.fillText(big, x + 36, y + 120); g.fillStyle = v('--ink-2'); g.font = '500 32px system-ui,sans-serif'; g.fillText(label, x + 36, y + 180); };
  tile(72, 270, w.acc != null ? w.acc + '%' : '–', 'accuracy');
  tile(552, 270, w.minutes + ' min', 'trained');
  tile(72, 530, String(w.streak.current), 'day streak');
  tile(552, 530, String(w.drillsPassed), 'drills solved');
  g.fillStyle = v('--ink'); g.font = '700 46px system-ui,sans-serif'; g.fillText(`Top pattern: ${nameOf(w.topPattern)}`, 72, 850);
  g.fillStyle = v('--ink-2'); g.font = '500 36px system-ui,sans-serif'; g.fillText(`Next focus: ${nameOf(w.focus)}`, 72, 910);
  g.fillStyle = v('--accent'); g.font = '700 40px system-ui,sans-serif'; g.fillText('FixMyBlunder', 72, 1260);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'my-chess-week.png', { type: 'image/png' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'My chess week' }); return; } } catch { /* canceled */ }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'my-chess-week.png'; a.click();
  toast('Report image saved');
}

/* ------------------------------------------------------------------ Settings */
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Installed'); });
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function installRow() {
  if (isStandalone()) return '<div class="settings-row"><b>Installed</b><span class="sub small">You are using the installed app.</span></div>';
  if (installEvent) return '<div class="settings-row"><b>Install the app</b><span class="sub small">Opens full screen and works offline.</span><button class="btn sm" style="margin-top:6px;width:fit-content" data-act="install">Install</button></div>';
  return `<div class="settings-row"><b>Install the app</b><span class="sub small">${isIos() ? 'In Safari, tap Share, then Add to Home Screen.' : 'In your browser menu choose Install app or Add to Home screen. If you only see a shortcut option, reload once and try again.'}</span></div>`;
}

function openSettings() {
  const s = state(), p = s.profile, st = s.settings;
  openSheet(`<h2 class="h2">Settings</h2>
    ${p ? `<div class="settings-row"><b>${esc(sourceLabel(p.source))}: ${esc(p.username)}</b><span class="sub small">${plural(Object.keys(s.games).length, 'game')} analyzed${s.lastSync ? `, last sync ${fmtDay(s.lastSync)}` : ''}</span>
      <div class="row" style="gap:8px;margin-top:6px"><button class="btn sm" data-act="sync-from-settings">${p.source === 'pgn' ? 'Add games from PGN' : 'Sync games'}</button><button class="btn sm ghost" data-act="switch">Change account</button></div></div>` : ''}
    ${installRow()}
    <details class="sgroup" open><summary>Training</summary>
    <div class="settings-row"><label for="setSize"><b>Drills per day</b></label><select id="setSize" data-set="setSize">${[3, 5, 8, 10, 15].map((n) => `<option value="${n}" ${st.setSize === n ? 'selected' : ''}>${n} drills, about ${Math.round(n * 1.5)} min</option>`).join('')}</select></div>
    <div class="settings-row"><label for="thinkSecs"><b>Think first: drills and puzzles</b></label><select id="thinkSecs" data-set="thinkSecs">${[[0, 'Off'], [5, '5 seconds'], [15, '15 seconds'], [30, '30 seconds'], [60, '1 minute']].map(([n, l]) => `<option value="${n}" ${(st.thinkSecs || 0) === n ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="sub small">Locks the board in drills and puzzles until the time is up, so you look before you move. Many blunders come from moving too fast. Games in Play have their own Think first setting on the Play screen.</span></div>
    </details>
    <details class="sgroup"><summary>Game analysis</summary>
    <div class="settings-row"><label for="gamesN"><b>Games per sync</b></label><select id="gamesN" data-set="gamesToImport">${GAME_COUNTS.map((n) => `<option value="${n}" ${st.gamesToImport === n ? 'selected' : ''}>Latest ${n}</option>`).join('')}</select><span class="sub small">Used for the first analysis and manual syncs. The first time you open Diagnose after launching, the app also checks your latest 100 games for new ones.</span></div>
    <div class="settings-row"><label for="eng"><b>Analysis depth</b></label><select id="eng" data-set="engineMs"><option value="40" ${st.engineMs === 40 ? 'selected' : ''}>Fast</option><option value="70" ${st.engineMs === 70 ? 'selected' : ''}>Balanced</option><option value="150" ${st.engineMs === 150 ? 'selected' : ''}>Thorough, slower</option></select><span class="sub small">Applies to games you import from now on.</span></div>
    </details>
    <details class="sgroup"><summary>Appearance and reminders</summary>
    <div class="settings-row"><label for="theme"><b>Theme</b></label><select id="theme" data-set="theme">${['system', 'light', 'dark'].map((t) => `<option value="${t}" ${st.theme === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
    <div class="settings-row"><label for="remTime"><b>Daily reminder</b></label>
      <input type="time" id="remTime" data-set="reminderTime" value="${esc(st.reminderTime)}">
      <span class="sub small">An app that works offline cannot ring a closed phone by itself, so this adds a repeating event with an alert to your calendar. It works on iPhone, Android and desktop.</span>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap;justify-content:flex-start"><button class="btn sm" data-act="rem-ics">Add to calendar</button>${st.reminderTime ? '<button class="btn sm ghost" data-act="rem-off">Turn off</button>' : ''}</div>
      ${st.reminderTime ? `<span class="sub small">Reminder time saved: ${esc(st.reminderTime)}. To stop the alerts, also delete the event in your calendar.</span>` : ''}</div>
    </details>
    <details class="sgroup"><summary>Data and help</summary>
    <div class="settings-row"><b>Feedback and problems</b><span class="sub small">${getErrors().length ? `${plural(getErrors().length, 'problem')} recorded on this device. ` : ''}Tell us what is broken or missing. You see exactly what is sent before it goes.</span>
      <div class="row" style="gap:8px;margin-top:6px;justify-content:flex-start"><button class="btn sm ghost" data-act="feedback">Send feedback</button></div></div>
    <div class="settings-row"><b>Your data</b><span class="sub small">Stored only in this browser. Back it up before clearing site data.</span>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap"><button class="btn sm ghost" data-act="export">Download backup</button><label class="btn sm ghost" style="cursor:pointer">Restore backup<input type="file" id="restore" accept="application/json" class="hide"></label></div></div>
    <div class="settings-row"><b>Reset everything</b><span class="sub small">Deletes games, drills and history from this device.</span><button class="btn sm danger" style="margin-top:6px;width:fit-content" data-act="reset">Delete all data</button></div>
    </details>
    <p class="sub small" style="margin-top:12px">Engine: Stockfish 19 (GPLv3), running locally. Pieces: Colin M.L. Burnett (CC BY-SA 3.0). FixMyBlunder is free software under GPLv3: <a href="https://github.com/jakie127744/fixmyblunder" rel="noopener" target="_blank">source code</a>. <a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>
    <button class="btn" style="margin-top:12px" data-act="close">Done</button>`);
}

function openFeedback(prefill = '') {
  const crashed = getErrors().length;
  openSheet(`<h2 class="h2">Send feedback</h2>
    <p class="sub small" style="margin:6px 0 10px">What happened, or what would you like? One or two lines is plenty.</p>
    <label class="fl" for="fbNote">Your message</label>
    <textarea id="fbNote" style="font-family:var(--f-body);font-size:1rem" placeholder="e.g. The board froze on my third drill">${esc(prefill)}</textarea>
    <label class="check"><input type="checkbox" id="fbDetails" checked> Include technical details${crashed ? ` (${plural(crashed, 'recent error')})` : ''}</label>
    <details class="eng"><summary>What would be sent</summary><pre id="fbPreview" class="mono" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>
    <p class="small sub">Details are the app version, browser and recent errors. They never include your username, games or positions.</p>
    <div class="stack" style="margin-top:12px">
      ${FEEDBACK_EMAIL ? '<button class="btn" data-act="fb-mail">Send by email</button>' : ''}
      ${FEEDBACK_FORM_URL ? '<a class="btn ghost" href="' + esc(FEEDBACK_FORM_URL) + '" target="_blank" rel="noopener">Open the feedback form</a>' : ''}
      <button class="btn ${FEEDBACK_EMAIL || FEEDBACK_FORM_URL ? 'ghost' : ''}" data-act="fb-copy">Copy to clipboard</button>
      <button class="btn ghost" data-act="close">Cancel</button>
    </div>`);
  updateFeedbackPreview();
}
const feedbackText = () => buildReport($('#fbNote')?.value || '', { includeDetails: $('#fbDetails')?.checked !== false, gameCount: Object.keys(state().games).length });
function updateFeedbackPreview() { const p = $('#fbPreview'); if (p) p.textContent = feedbackText() || '(nothing yet)'; }

function downloadReminder() {
  const t = state().settings.reminderTime;
  if (!validTime(t)) { toast('Pick a time first.'); return; }
  const b = new Blob([reminderIcs(t, { url: location.origin + location.pathname })], { type: 'text/calendar' });
  const l = document.createElement('a'); l.href = URL.createObjectURL(b); l.download = 'fixmyblunder-reminder.ics'; l.click();
  setTimeout(() => URL.revokeObjectURL(l.href), 4000);
  toast('Open the file to add it to your calendar.');
}

function applyTheme() {
  const t = state().settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}

function openPgnImport(err = '') {
  const p = state().profile;
  openSheet(`<h2 class="h2">Add games from PGN</h2>
    <p class="sub small" style="margin:4px 0 10px">Paste one or more games where ${esc(p.username)} is White or Black. Games you have already analyzed are skipped.</p>
    <label class="fl" for="pgnNew">Games (PGN)</label>
    <textarea id="pgnNew" placeholder="Paste one or more games">${esc(ui.onboard.pgn)}</textarea>
    ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
    <div class="stack" style="margin-top:12px"><button class="btn" data-act="pgn-import">Analyze these games</button><button class="btn ghost" data-act="close">Cancel</button></div>`);
}

function showImportResult(r, source) {
  const sum = importSummary(r, source);
  ui.importNote = sum;
  // Always a sheet, not a toast: a toast vanishes in 2.8s and is easy to miss on a phone.
  const headline = r.analysed ? `${plural(r.analysed, 'new game')} analyzed, ${plural(r.drills, 'new drill')} added.`
    : r.skipped.length ? 'No new games were added.' : 'No new games found. You are up to date.';
  openSheet(`<h2 class="h2">Sync finished</h2><p style="margin-top:6px"><b>${esc(headline)}</b></p><p class="small" style="margin-top:6px">${esc(sum.head)}</p>${sum.lines.map((l) => `<p class="small" style="margin-top:6px">${esc(l)}</p>`).join('')}<button class="btn" style="margin-top:14px" data-act="close">Done</button>`);
}

async function manualSync(count, pgn) {
  if (ui.syncing) return;
  const s = state();
  if (s.profile.source === 'pgn' && pgn == null) { openPgnImport(); return; }   // a PGN account has nothing to fetch: ask for the games
  ui.syncing = true; render();
  setBg('Checking for new games', 0);   // visible on every tab, unlike the Diagnose button
  try {
    const r = await sync({ count: count || s.settings.gamesToImport, pgn: pgn || '', onStatus: (st) => { if (st.phase === 'analyse') {
      const pct = ((st.game - 1) + st.frac) / st.games;
      setBg(`Analyzing new game ${st.game} of ${st.games} · ${Math.round(pct * 100)}%`, pct);
      const b = $('[data-act="sync"]'); if (b) b.textContent = `Analyzing game ${st.game} of ${st.games} · ${Math.round(pct * 100)}%`;
    } } });
    ui.syncing = false; setBg(null); render();
    showImportResult(r, s.profile.source);
    return;
  } catch (e) {
    logError('sync', e);
    ui.syncing = false; setBg(null); render();
    if (s.profile.source === 'pgn') openPgnImport(e.message || 'Sync failed.'); else toast(e.message || 'Sync failed.');
    return;
  }
}

/* ------------------------------------------------------------------ Explanation + line player (drill feedback and game review) */
const curLesson = () => (ui.review ? (ui.review.lessons || {})[(rvKey(ui.review) || {}).id] : ui.drill && ui.drill.lesson);

/** The "why" text plus the continuation, one row per move, with the board following along. `h` holds { shown, idx }. */
function lessonSection(L, h, cls) {
  if (!L) return `<div class="${cls}"><p class="sub small" role="status">Working out why<span class="thinking"><i></i><i></i><i></i></span></p></div>`;
  const key = h.shown || (L.verdict === 'best' ? 'best' : 'played'), line = L[key];
  const idx = h.shown ? h.idx : -1;
  const texts = (l) => `<h3>${esc(l.title)}</h3>${l.points.map((p) => `<p>${esc(p)}</p>`).join('')}`;
  const tog = L.verdict === 'best' ? '' : `<div class="chips" role="group" aria-label="Which line to play out" style="margin-top:10px">${['played', 'best'].map((k) => `<button data-act="lp-pick" data-v="${k}" aria-pressed="${key === k}">${k === 'played' ? 'Your move' : 'Best'} <b class="mono">${esc(L[k].san)}</b></button>`).join('')}</div>`;
  const rows = line.steps.map((s, i) => `<li class="${s.mine ? 'mine' : 'theirs'}${i === idx ? ' cur' : ''}"><button data-act="lp-go" data-v="${i}" aria-current="${i === idx}"><b class="mono">${esc(s.label)} ${esc(s.san)}</b><span>${esc(s.note)}</span></button></li>`).join('');
  return `<div class="${cls}">
    ${texts(L.played)}${L.verdict === 'best' ? '' : texts(L.best)}
    <h3>Play it out</h3>${tog}
    <ol class="lp-steps" aria-label="Moves in this line">${rows}</ol>
    <div class="lp-ctl"><button class="btn ghost" data-act="lp-prev"${idx < 0 ? ' disabled' : ''}>\u2039 Back</button><button class="btn ghost" data-act="lp-next"${idx >= line.steps.length - 1 ? ' disabled' : ''}>Next \u203a</button></div>
  </div>`;
}

/** Put the board on the shown line, up to the chosen move. */
function lpApply() {
  const h = ui.review || ui.drill, L = curLesson();
  if (!h || !L || !h.shown || !ui.board) return;
  const line = L[h.shown];
  ui.board.setPosition(L.fen, L.mover);
  ui.board.setEnabled(false);
  for (let i = 0; i <= h.idx && i < line.steps.length; i++) ui.board.play(line.steps[i].uci);
  const cur = line.steps[h.idx];
  if (cur && h.idx === 0) ui.board.mark(cur.to, h.shown === 'played' && L.verdict === 'bad' ? 'bad' : 'good');
  else if (cur && cur.mine && h.shown === 'best') ui.board.mark(cur.to, 'good');
}

/** Redraw the explanation after a line or step change and keep keyboard focus on the same control. */
function refreshLesson() {
  const a = document.activeElement, d = a && a.dataset ? a.dataset : {};
  if (ui.review) { render(); return; }
  rerenderDrillPanel(); lpApply();
  if (d.act) { const n = document.querySelector(`#fb [data-act="${d.act}"]${d.v != null ? `[data-v="${CSS.escape(d.v)}"]` : ''}`); if (n && !n.disabled) n.focus({ preventScroll: true }); }
}

/** Works out the lines behind a game mistake the first time it is shown. */
function loadReviewLesson(rv, km) {
  if (rv.lessons[km.id] || rv.loading === km.id) return;
  rv.loading = km.id;
  ensureLines(km, true).then((lines) => {
    rv.loading = null;
    rv.lessons[km.id] = buildLesson({
      fen: km.fen, playedUci: km.playedUci, bestUci: km.bestUci, refPv: lines.ref, bestRest: lines.bestRest,
      wpBefore: km.wpBefore, wpLoss: km.wpLoss, refMate: lines.refMate, bestMate: km.bestMate, verdict: 'bad',
    });
    if (ui.review === rv && rvKey(rv) === km) { render(); announce(rv.lessons[km.id].played.points.join(' ')); }
  });
}

/* ------------------------------------------------------------------ Game review */
/** Only the biggest mistakes in a game: at least 12 points of win chance, at most five. */
const keyMoments = (g) => g.mistakes.filter((m) => m.wpLoss >= 12).sort((a, b) => b.wpLoss - a.wpLoss).slice(0, 5).sort((a, b) => a.ply - b.ply);
const moveNo = (ply) => Math.floor(ply / 2) + 1;
const rvKey = (rv) => (rv.mode === 'full' ? rv.keys.find((m) => m.ply === rv.p) : rv.keys[rv.p]);

function openReview(id, ply) {
  const g = state().games[id];
  if (!g) return;
  const rv = { id, p: 0, shown: '', keys: keyMoments(g), mode: g.sans ? 'full' : 'moments', fens: [], moves: [], idx: 0, lessons: {}, loading: null };
  if (rv.mode === 'full') {
    const c = new Chess();
    rv.fens.push(c.fen());
    for (const san of g.sans) {
      try { const m = c.move(san); rv.moves.push({ from: m.from, to: m.to, san: m.san }); rv.fens.push(c.fen()); } catch { break; }
    }
    rv.p = rv.keys.length ? rv.keys[0].ply : 0;
    if (ply != null && ply >= 0 && ply < rv.fens.length) rv.p = ply;
  } else if (ply != null) {
    const i = rv.keys.findIndex((k) => k.ply === ply);
    if (i >= 0) rv.p = i;
  }
  ui.review = rv;
  render(); window.scrollTo(0, 0);
}

function reviewGraph(g, rv) {
  const c = g.curve;
  if (!c || rv.mode !== 'full') return '';
  const n = c.length - 1, W = 320, H = 70;
  const X = (i) => (W * i) / n, Y = (v) => H - (v / 100) * H;
  const pts = c.map((v, i) => (v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  const dots = rv.keys.map((m) => (c[m.ply] == null ? '' : `<circle cx="${X(m.ply).toFixed(1)}" cy="${Y(c[m.ply]).toFixed(1)}" r="5" fill="var(--bad)" stroke="var(--surface)" stroke-width="2"/>`)).join('');
  return `<section class="card" style="margin-top:12px"><p class="eyebrow" style="margin-bottom:6px">Your winning chances, tap to jump</p>
    <svg data-act="rv-graph" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;cursor:pointer;touch-action:manipulation" role="img" aria-label="Win chance over the game with your biggest mistakes marked">
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--line)" stroke-dasharray="4 4"/>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}<line x1="${X(rv.p)}" x2="${X(rv.p)}" y1="0" y2="${H}" stroke="var(--amber)" stroke-width="2"/></svg></section>`;
}

/** Every move as text: tap to jump, with win chance after the move and the loss on your mistakes. */
function reviewMoves(g, rv) {
  if (rv.mode !== 'full' || !rv.moves.length) return '';
  const loss = {};
  for (const m of g.mistakes) loss[m.ply] = m.wpLoss;
  const c = g.curve || [];
  const cell = (i) => {
    const mv = rv.moves[i];
    if (!mv) return '<span></span>';
    const wp = c[i + 1] != null ? `${Math.round(c[i + 1])}%` : '';
    const bad = loss[i] >= 12;
    const mine = (i % 2 === 0) === (g.color === 'white');
    return `<button class="mv ${rv.p === i + 1 ? 'cur' : ''} ${bad ? 'bad' : ''}" data-act="rv-go" data-v="${i + 1}" aria-label="${esc(`Move ${moveNo(i)}, ${mine ? 'you' : 'opponent'} played ${mv.san}${wp ? `, win chance ${wp}` : ''}${bad ? `, lost ${Math.round(loss[i])} points` : ''}`)}" ${rv.p === i + 1 ? 'aria-current="true"' : ''}><b>${esc(mv.san)}</b><small>${wp}${bad ? ` −${Math.round(loss[i])}` : ''}</small></button>`;
  };
  const rows = [];
  for (let i = 0; i < rv.moves.length; i += 2) rows.push(`<span class="mn">${moveNo(i)}</span>${cell(i)}${cell(i + 1)}`);
  return `<section class="card" style="margin-top:12px"><h2 class="h2">Moves</h2><p class="sub small" style="margin:2px 0 8px">Tap a move to jump to it. Small numbers are your win chance after the move; red marks a big mistake.</p><div class="mvlist">${rows.join('')}</div></section>`;
}

function reviewLabel(rv) {
  if (rv.mode === 'moments') return `Mistake ${rv.p + 1} of ${rv.keys.length}`;
  if (rv.p === 0) return 'Start of the game';
  return `${moveNo(rv.p - 1)}${(rv.p - 1) % 2 === 0 ? '.' : '...'} ${rv.moves[rv.p - 1]?.san || ''}`;
}

function viewReview() {
  const s = state(), rv = ui.review, g = s.games[rv.id];
  const km = rvKey(rv);
  const result = resultWord(g.result);
  const label = reviewLabel(rv);
  const chips = rv.keys.length
    ? `<div class="chips" role="group" aria-label="Key mistakes" style="margin-top:12px">${rv.keys.map((m, i) => `<button data-act="rv-km" data-v="${i}" aria-pressed="${km === m}">Move ${moveNo(m.ply)} \u00b7 \u2212${Math.round(m.wpLoss)}%</button>`).join('')}</div>`
    : '<div class="card" style="margin-top:12px"><p><b>No big mistakes.</b> Nothing in this game lost more than 12 points of win chance.</p></div>';
  const notice = rv.mode === 'moments'
    ? `<div class="card" style="margin-top:12px;background:var(--amber-soft);border-color:transparent"><p>Showing key moments only. <button class="link" data-act="rv-load" style="padding:0;min-height:0">Load the full game</button> to step through every move.</p></div>`
    : '';
  const middle = km
    ? `<button class="btn ghost" data-act="rv-mine" aria-pressed="${rv.shown === 'played'}" style="${rv.shown === 'played' ? 'background:var(--bad-soft);color:var(--bad);border-color:var(--bad)' : ''}">My move<br><b>${esc(km.playedSan)}</b></button><button class="btn ghost" data-act="rv-best" aria-pressed="${rv.shown === 'best'}" style="${rv.shown === 'best' ? 'background:var(--good-soft);color:var(--good);border-color:var(--good)' : ''}">Best<br><b>${esc(km.bestSan)}</b></button>`
    : `<span class="rvlabel" style="grid-column:span 2">${esc(label)}</span>`;
  const panel = km
    ? `<section class="card" style="margin-top:12px"><div class="row"><span class="tag bad">\u2212${Math.round(km.wpLoss)}% win chance</span><span class="tag">${esc(nameOf(km.pattern))}</span></div>
        <p class="coach" style="font-size:17px;margin-top:10px">${esc(km.explain)}</p>
        ${lessonSection(rv.lessons[km.id], rv, 'lesson')}
        ${s.drills[km.id] ? '<button class="btn" style="margin-top:12px" data-act="rv-drill">Drill this position</button>' : ''}</section>`
    : (rv.mode === 'full' && rv.p > 0 ? '<p class="sub small" style="margin-top:12px">Nothing to fix here. Use the arrows, or jump to a mistake above.</p>' : '');
  return `<section class="view">
    <div class="row"><button class="link" data-act="rv-back" style="padding-left:0">\u2039 Games</button><span class="tag ${g.accuracy >= 85 ? 'good' : g.accuracy < 65 ? 'bad' : ''}">Accuracy ${Math.round(g.accuracy)}</span></div>
    <p class="eyebrow">${fmtDay(g.date)} \u00b7 ${esc(sourceLabel(g.source))}</p>
    <h1 class="h1" style="font-size:26px">${result} as ${g.color} vs ${esc(g.opponent)}</h1>
    ${chips}${notice}
    <div class="board-wrap"><div id="board"></div></div>
    <div class="rvctl"><button class="btn ghost" data-act="rv-prev" aria-label="Previous">\u2039</button>${middle}<button class="btn ghost" data-act="rv-next" aria-label="Next">\u203a</button></div>
    ${panel}
    ${rv.keys.length ? '<button class="btn" style="margin-top:12px" data-act="rv-nextkey">Next mistake</button>' : ''}
    ${reviewGraph(g, rv)}${reviewMoves(g, rv)}</section>`;
}

function mountReview() {
  const s = state(), rv = ui.review, g = s.games[rv.id];
  const el = $('#board');
  if (!el) return;
  const km = rvKey(rv);
  const fen = rv.mode === 'full' ? rv.fens[rv.p] : km.fen;
  ui.board = new Board(el, { fen, orientation: g.color === 'white' ? 'w' : 'b', canMove: false });
  if (km && rv.shown && rv.lessons[km.id]) lpApply();
  else if (km && rv.shown) {
    ui.board.setPosition(km.fen, g.color === 'white' ? 'w' : 'b');
    ui.board.setEnabled(false);
    const uci = rv.shown === 'played' ? km.playedUci : km.bestUci;
    ui.board.play(uci);
    ui.board.mark(uci.slice(2, 4), rv.shown === 'played' ? 'bad' : 'good');
  } else if (rv.mode === 'full' && rv.p > 0 && rv.moves[rv.p - 1]) {
    const m = rv.moves[rv.p - 1];
    ui.board.mark(m.from, 'last'); ui.board.mark(m.to, 'last');
  }
  if (km) loadReviewLesson(rv, km);
  announce(`${reviewLabel(rv)}.${km ? ` Mistake, lost ${Math.round(km.wpLoss)} percent win chance. You played ${km.playedSan}, best was ${km.bestSan}. ${km.explain}` : ''}`);
}

function reviewStep(delta) {
  const rv = ui.review;
  const max = rv.mode === 'full' ? rv.fens.length - 1 : rv.keys.length - 1;
  rv.p = Math.max(0, Math.min(max, rv.p + delta));
  rv.shown = '';
  render();
}

async function backfillMoves() {
  const s = state(), p = s.profile;
  if (!p || p.source === 'pgn') { toast('Paste the PGN again from Settings to load the moves.'); return; }
  toast('Loading moves…');
  try {
    const games = p.source === 'lichess' ? await fetchLichess(p.username, 100) : await fetchChessCom(p.username, 100);
    for (const g of games) { const ex = s.games[g.id]; if (ex && !ex.sans) ex.sans = g.moves.slice(); }
    save();
    const id = ui.review && ui.review.id;
    if (id && s.games[id].sans) openReview(id);
    else toast('That game is older than your latest 100, so its moves cannot be loaded.');
  } catch (e) { logError('backfill', e); toast(e.message || 'Could not load the moves.'); }
}

/* ------------------------------------------------------------------ router + render */
function nav(tab) {
  ui.tab = tab;
  if (tab !== 'diagnose') ui.review = null;
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  ui.focusHeading = true;
  render(); window.scrollTo(0, 0);
}

/** Re-draws the screen, then puts keyboard and screen-reader focus back where the user was. */
function render() {
  const cur = document.activeElement;
  const had = cur && cur !== view && view.contains(cur);
  let key = null;
  if (had) {
    const d = cur.dataset || {};
    if (d.sq) key = `[data-sq="${d.sq}"]`;
    else if (cur.id) key = '#' + cur.id;
    else if (d.act) key = `[data-act="${d.act}"]${d.v != null ? `[data-v="${CSS.escape(d.v)}"]` : ''}${d.id ? `[data-id="${CSS.escape(d.id)}"]` : ''}${d.p != null ? `[data-p="${CSS.escape(d.p)}"]` : ''}`;
  }
  renderView();
  if (ui.focusHeading) { ui.focusHeading = false; focusHeading(); return; }
  if (!had) return;
  const n = key && view.querySelector(key);
  if (n) n.focus({ preventScroll: true }); else focusHeading();
}
function focusHeading() { const h = view.querySelector('h1') || view; h.tabIndex = -1; h.focus({ preventScroll: true }); }

function renderView() {
  const s = state();
  const needsOnboard = !s.profile || ui.onboard.step === 'analyse' || ui.onboard.step === 'reveal';
  applyTheme();
  $('#tabs').hidden = needsOnboard;
  $('#settingsBtn').hidden = !s.profile;
  const chip = $('#streakChip');
  if (s.profile && !needsOnboard) { const st = streak(s); chip.hidden = !st.current; chip.textContent = `${st.current}-day streak`; } else chip.hidden = true;
  if (needsOnboard) { ui.board = null; view.innerHTML = viewOnboard(); return; }
  if (ui.tab === 'drills' && ui.session && !ui.drill && ui.session.idx < ui.session.ids.length) ui.drill = null;
  const navTab = { puzzles: 'drills', diagnose: 'report' }[ui.tab] || ui.tab; // sub-screens light up their parent tab
  $$('#tabs [data-tab]').forEach((b) => (b.dataset.tab === navTab ?b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const due = dueCount(s), badge = $('#dueBadge');
  badge.hidden = !due; badge.textContent = due;
  if (ui.tab === 'today') view.innerHTML = viewToday();
  else if (ui.tab === 'diagnose') {
    if (!ui.autoSynced) { ui.autoSynced = true; setTimeout(autoSync, 0); } // once per launch, the first time Diagnose opens
    if (ui.review && state().games[ui.review.id]) { view.innerHTML = viewReview(); mountReview(); save(); return; }
    ui.review = null;
    view.innerHTML = viewDiagnose();
  }
  else if (ui.tab === 'report') view.innerHTML = viewReport();
  else if (ui.tab === 'play') { view.innerHTML = viewPlay(playHost); mountPlay(playHost); save(); return; }
  else if (ui.tab === 'puzzles') {
    if (ui.puzzle) { view.innerHTML = viewPuzzle(); mountPuzzle(); save(); return; }
    view.innerHTML = viewHub();
    refreshPuzzleCount();
  }
  else if (ui.tab === 'drills') {
    const se = ui.session;
    if (ui.puzzle) { view.innerHTML = viewPuzzle(); mountPuzzle(); save(); return; }
    if (se && se.idx < se.ids.length && !ui.drill) { const d = currentDrill(); ui.drill = { id: d.id, phase: 'ask', start: Date.now(), thinkAt: Date.now(), hint: '', hintSq: false, graded: false }; }
    view.innerHTML = viewRetry();
    if (!ui.session && !ui.puzzle && ui.practice.mode === 'puzzles') refreshPuzzleCount();
    if (ui.session && ui.session.idx < ui.session.ids.length) mountDrill();
  }
  save(); // persists today's set the first time it is built
}

/* ------------------------------------------------------------------ events */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act], [data-tab]');
  if (e.target.id === 'scrim') { closeSheet(); return; }
  if (!t) return;
  if (e.target.closest('a')) return; // real links keep their normal behavior
  if (t.dataset.tab) {
    // Opening Drills after a finished set shows the practice list, not the old "Set complete" page.
    if (t.dataset.tab === 'drills' && ui.session && ui.session.idx >= ui.session.ids.length) ui.session = null;
    nav(t.dataset.tab); return;
  }
  const a = t.dataset.act, v = t.dataset.v ?? t.dataset.p, s = state();
  if (a.startsWith('pl-')) { playAct(a, v, playHost); return; }
  switch (a) {
    case 'src': ui.onboard.source = v; ui.onboard.username = $('#uname')?.value || ui.onboard.username; ui.onboard.error = ''; render(); break;
    case 'gcount': ui.onboard.username = $('#uname')?.value || ui.onboard.username; if ($('#pgn')) ui.onboard.pgn = $('#pgn').value; s.settings.gamesToImport = +v; save(); render(); break;
    case 'start': runOnboard(); break;
    case 'start-early': ui.onboard.early = true; ui.onboard.step = 'reveal'; setBg(`Analyzing in the background`, ui.onboard.progress); render(); break;
    case 'finish-onboard': ui.onboard.step = 'form'; ui.onboard.error = ''; nav('today'); break;
    case 'tab': if (v === 'drills' && ui.session && ui.session.idx >= ui.session.ids.length) ui.session = null; nav(v); break;
    case 'lesson': { const b = $('#lessonBody'); const open = b.classList.toggle('hide') === false; t.textContent = open ? 'Hide' : 'Read'; t.setAttribute('aria-expanded', open); break; }
    case 'start-set': {
      const today = buildToday(s);
      const res = todayResults(s);
      if (!today.ids.length) { startSample(); break; }    // no set exists, so never claim one finished
      if (today.ids.every((i) => res[i])) { ui.report = 'week'; ui.weekOffset = 0; nav('report'); break; }
      startSession(today.ids, 'Today’s set'); break;
    }
    case 'open-drill': {
      const today = buildToday(s);
      startSession(today.ids, 'Today’s set');
      ui.session.idx = Math.max(0, ui.session.ids.indexOf(t.dataset.id));
      render(); break;
    }
    case 'drill-pattern': {
      const ids = extraDrills(s, 10, v);
      if (!ids.length) { toast('No drills left for this pattern.'); break; }
      startSession(ids, nameOf(v)); break;
    }
    case 'start-sample': startSample(); break;
    case 'dismiss-note': ui.importNote = null; render(); break;
    case 'practice-due': {
      const key = dayKey();
      const ids = Object.values(s.drills).filter((d) => d.box != null && !isMastered(d) && d.due <= key).map((d) => d.id);
      if (!ids.length) { toast('Nothing is due right now.'); break; }
      startSession(ids, 'Due reviews'); break;
    }
    case 'see-pattern': seePattern(v); break;
    case 'review': closeSheet(); ui.tab = 'diagnose'; openReview(t.dataset.id, t.dataset.ply != null ? +t.dataset.ply : undefined); break;
    case 'rv-back': ui.review = null; render(); break;
    case 'rv-km': { const rv = ui.review; rv.p = rv.mode === 'full' ? rv.keys[+v].ply : +v; rv.shown = ''; render(); break; }
    case 'rv-prev': reviewStep(-1); break;
    case 'rv-next': reviewStep(1); break;
    case 'rv-nextkey': {
      const rv = ui.review;
      if (rv.mode === 'moments') { rv.p = (rv.p + 1) % rv.keys.length; }
      else { const nx = rv.keys.find((m) => m.ply > rv.p) || rv.keys[0]; rv.p = nx.ply; }
      rv.shown = ''; render(); break;
    }
    case 'rv-graph': {
      const rv = ui.review, r = t.getBoundingClientRect();
      rv.p = Math.max(0, Math.min(rv.fens.length - 1, Math.round(((e.clientX - r.left) / r.width) * (rv.fens.length - 1))));
      rv.shown = ''; render(); break;
    }
    case 'rv-go': ui.review.p = +v; ui.review.shown = ''; render(); break;
    case 'rv-mine': ui.review.shown = 'played'; ui.review.idx = 0; render(); break;
    case 'rv-best': ui.review.shown = 'best'; ui.review.idx = 0; render(); break;
    case 'lp-pick': { const h = ui.review || ui.drill; h.shown = v; h.idx = 0; refreshLesson(); break; }
    case 'lp-go': { const h = ui.review || ui.drill; h.shown = h.shown || (curLesson().verdict === 'best' ? 'best' : 'played'); h.idx = +v; refreshLesson(); break; }
    case 'lp-prev': case 'lp-next': {
      const h = ui.review || ui.drill, L = curLesson();
      h.shown = h.shown || (L.verdict === 'best' ? 'best' : 'played');
      h.idx = Math.max(-1, Math.min(L[h.shown].steps.length - 1, h.idx + (a === 'lp-next' ? 1 : -1)));
      refreshLesson(); break;
    }
    case 'rv-reset': ui.review.shown = ''; render(); break;
    case 'rv-drill': { const km = rvKey(ui.review); if (km && s.drills[km.id]) { ui.review = null; startSession([km.id], 'From your game'); } break; }
    case 'rv-load': backfillMoves(); break;
    case 'hub': ui.session = null; ui.drill = null; ui.puzzle = null; nav(ui.tab === 'puzzles' ? 'puzzles' : 'drills'); break;
    case 'mode': ui.practice.mode = v; render(); break;
    case 'pp': ui.practice.pattern = v; render(); break;
    case 'pn': ui.practice.n = +v; render(); break;
    case 'pt': ui.practice.theme = v; render(); break;
    case 'pd': ui.practice.difficulty = v; render(); break;
    case 'pm': ui.practice.moves = v === 'any' ? 'any' : +v; render(); break;
    case 'pmatch': { const top = patternStats(s).list.find((p) => p.count); ui.practice.theme = top ? PATTERN_THEME[top.id] : 'mix'; render(); break; }
    case 'practice': {
      const ids = extraDrills(s, ui.practice.n, ui.practice.pattern);
      if (!ids.length) { toast('No drills available for that choice.'); break; }
      startSession(ids, ui.practice.pattern === 'all' ? 'Practice' : nameOf(ui.practice.pattern)); break;
    }
    case 'puzzle-start': ui.session = null; ui.drill = null; ui.puzzle = { theme: ui.practice.theme, difficulty: ui.practice.difficulty, moves: ui.practice.moves, seen: new Set(state().puzzleSeen || []), solved: 0, tried: 0, phase: 'loading' }; if (ui.tab !== 'puzzles') ui.tab = 'drills'; loadPuzzle(); break;
    case 'puzzle-next': loadPuzzle(); break;
    case 'pz-hint': { const pz = ui.puzzle; pz.hint = true; ui.board.mark(pz.p.solution[pz.step].slice(0, 2), 'hint'); pzRefresh(); break; }
    case 'pz-skip': {
      const pz = ui.puzzle, mv = pz.p.solution[pz.step];
      pz.failed = true; pz.phase = 'solved'; pz.msgTitle = 'The answer'; pz.msg = `The next move was ${pvToSan(ui.board.fen(), [mv], 1)[0] || mv}.`; pz.msgKind = 'hint';
      ui.board.mark(mv.slice(0, 2), 'hint'); ui.board.mark(mv.slice(2, 4), 'good'); ui.board.setEnabled(false); logPuzzle(false); pzRefresh(); break;
    }

    case 'idea': {
      const d = currentDrill(), dr = ui.drill;
      if (!dr.hint) dr.hint = ideaText(d);
      else if (!dr.hintSq) { dr.hintSq = true; ui.board.mark(d.bestUci.slice(0, 2), 'hint'); }
      rerenderDrillPanel(); break;
    }
    case 'skip': {
      const d = currentDrill(), dr = ui.drill;
      if (!dr.graded) { dr.graded = true; gradeDrill(s, d.id, false, Date.now() - dr.start); ui.session.results[d.id] = { ok: false }; save(); }
      nextDrill(); break;
    }
    case 'again': { const d = currentDrill(); ui.drill = { ...ui.drill, phase: 'ask', hint: ui.drill.hint, hintSq: false, playedUci: null, start: Date.now(), thinkAt: Date.now(), lesson: null, shown: '', idx: 0, retried: true, fast: false }; ui.board.setPosition(d.fen, d.side); ui.board.setEnabled(true); render(); break; }
    case 'answer': { const d = currentDrill(); ui.drill.shown = 'best'; ui.drill.idx = 0; if (ui.drill.lesson) { refreshLesson(); break; } ui.board.setPosition(d.fen, d.side); const m = ui.board.play(d.bestUci); ui.board.mark(d.bestUci.slice(2, 4), 'good'); ui.board.setEnabled(false); toast(`The answer was ${m.san}`); break; }
    case 'next': nextDrill(); break;
    case 'think': state().settings.thinkSecs = +v; save(); render(); break;
    case 'rep': ui.report = v; render(); break;
    case 'pz-period': ui.pzPeriod = v; render(); break;
    case 'pz-sort': ui.pzSort = v; render(); break;
    case 'wk': if (!(+v > 0 && ui.weekOffset >= 0)) { ui.weekOffset += +v; render(); } break;
    case 'share': shareReport(); break;
    case 'sync': manualSync(); break;
    case 'sync-from-settings': closeSheet(); manualSync(); break;
    case 'switch': openSheet(`<h2 class="h2">Change account?</h2><p class="sub" style="margin:6px 0 14px">This removes the ${plural(Object.keys(s.games).length, 'game')}, drills, streak and reports of ${esc(s.profile.username)} from this device, so two accounts are never mixed. Download a backup first if you want to keep them. Your settings stay.</p><button class="btn danger" data-act="switch-yes">Remove and change account</button><button class="btn ghost" style="margin-top:8px" data-act="export">Download backup first</button><button class="btn ghost" style="margin-top:8px" data-act="close">Keep this account</button>`); break;
    case 'switch-yes': closeSheet(); clearAccountData(); ui.session = null; ui.drill = null; ui.puzzle = null; ui.review = null; ui.importNote = null; ui.onboard = { ...ui.onboard, step: 'form', error: '', pgn: '', username: '' }; render(); break;
    case 'pgn-import': {
      const txt = ($('#pgnNew')?.value || '');
      ui.onboard.pgn = txt;                                   // kept if the import fails, so nothing has to be pasted twice
      if (!txt.trim()) { openPgnImport('Paste at least one game.'); break; }
      closeSheet(); manualSync(undefined, txt); break;
    }
    case 'export': { const b = new Blob([exportJson()], { type: 'application/json' }); const l = document.createElement('a'); l.href = URL.createObjectURL(b); l.download = `fixmyblunder-backup-${new Date().toISOString().slice(0, 10)}.json`; l.click(); break; }
    case 'reset': openSheet(`<h2 class="h2">Delete all data?</h2><p class="sub" style="margin:6px 0 14px">Your games, drills, streak and reports will be removed from this device. This cannot be undone. Download a backup first if you want to keep them.</p><button class="btn danger" data-act="reset-yes">Delete everything</button><button class="btn ghost" style="margin-top:8px" data-act="close">Keep my data</button>`); break;
    case 'reset-yes': reset(); closeSheet(); ui.session = null; ui.drill = null; ui.onboard.step = 'form'; render(); break;
    case 'install': if (installEvent) { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; closeSheet(); } break;
    case 'close': closeSheet(); break;
    case 'feedback': openFeedback(); break;
    case 'fb-mail': location.href = mailtoLink('FixMyBlunder feedback', feedbackText()); break;
    case 'fb-copy': { const txt = feedbackText(); try { await navigator.clipboard.writeText(txt); toast('Copied. Paste it into a message to us.'); } catch { const ta = $('#fbPreview'); if (ta) { $('#sheet details').open = true; toast('Select the text and copy it.'); } } break; }
    case 'rem-ics': downloadReminder(); break;
    case 'rem-off': state().settings.reminderTime = ''; save(); openSettings(); toast('Reminder cleared.'); break;
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.set) { const k = t.dataset.set; state().settings[k] = k === 'theme' || k === 'reminderTime' ? t.value : +t.value; if (k === 'setSize') state().today = null; save(); applyTheme(); }
  if (t.id === 'restore' && t.files[0]) {
    t.files[0].text().then((txt) => { try { importJson(txt); closeSheet(); ui.session = null; ui.drill = null; render(); toast('Backup restored'); } catch (err) { toast(err.message); } });
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#scrim').classList.contains('hide')) closeSheet(); });
document.addEventListener('keydown', (e) => { // keep Tab inside an open sheet
  if (e.key !== 'Tab' || $('#scrim').classList.contains('hide')) return;
  const f = $$('#sheet button, #sheet input, #sheet select, #sheet textarea, #sheet summary, #sheet a[href]').filter((x) => !x.disabled && x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
document.addEventListener('input', (e) => { if (e.target.id === 'fbNote') updateFeedbackPreview(); });
document.addEventListener('change', (e) => { if (e.target.id === 'fbDetails') updateFeedbackPreview(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('[role=button][data-act]')) e.target.click(); });
$('#settingsBtn').addEventListener('click', openSettings);
$('#streakChip').addEventListener('click', () => nav('today'));
window.addEventListener('hashchange', () => { const t = location.hash.slice(1);
  const t2 = t === 'retry' ? 'drills' : t; // #retry was the old name of this tab
  if (['today', 'diagnose', 'drills', 'puzzles', 'play', 'report'].includes(t2) && t2 !== ui.tab) { ui.tab = t2; render(); } });
const setOffline = () => { $('#offline').hidden = navigator.onLine; };
window.addEventListener('online', setOffline); window.addEventListener('offline', setOffline); setOffline();

/* ------------------------------------------------------------------ boot */
/** Re-label stored mistakes when the classifier changes. Needs no engine. */
function migrate() {
  const s = state();
  if (s.classifier === CLASSIFIER_VERSION) return;
  let stale = 0;
  for (const g of Object.values(s.games)) {
    for (const m of g.mistakes) {
      if (m.replyUci === undefined) { stale++; continue; }
      const r = reclassify(m, g.baseTime);
      m.pattern = r.pattern; m.explain = r.explain;
      const d = s.drills[m.id];
      if (d) { d.pattern = r.pattern; d.explain = r.explain; }
    }
  }
  s.today = null;
  s.staleMistakes = stale;
  if (!stale) s.classifier = CLASSIFIER_VERSION;
  save();
}
migrate();
watchGlobalErrors(() => toast('Something went wrong. Open Settings, then Send feedback, to report it.'));
const h = location.hash.slice(1) === 'retry' ? 'drills' : location.hash.slice(1);
if (['today', 'diagnose', 'drills', 'puzzles', 'play', 'report'].includes(h)) { ui.tab = h; if (location.hash.slice(1) !== h) history.replaceState(null, '', '#' + h); }
render();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
export { onChange, DAY, pvToSan };
