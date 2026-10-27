// Blunderprint app shell: onboarding, Today, Diagnose, Retry, Report, Settings.
import { state, save, onChange, exportJson, importJson, reset } from './store.js';
import { Engine, workerTransport } from './engine.js';
import { analyzeGame } from './analyze.js';
import { fetchLichess, fetchChessCom, fromPgnText } from './importer.js';
import { PATTERNS, PATTERN_ORDER, pat } from './patterns.js';
import { addDrillsFromGame, patternStats, buildToday, dueCount, todayResults, gradeDrill, streak, gamesByDate, isMastered, minutesTrained, extraDrills, puzzleStats } from './srs.js';
import { nextPuzzle, countMatching, THEME_GROUPS, MIXED, DIFFICULTY, MOVE_COUNTS, PATTERN_THEME, themeName } from './puzzles.js';
import { weekly, allTime } from './report.js';
import { winPct } from './score.js';
import { pvToSan, reclassify, CLASSIFIER_VERSION } from './classify.js';
import { Board } from './board.js';
import { Chess } from '../vendor/chess/chess.js';
import { esc, plural, fmtDay, fmtRange, addDays, weekStart, DAY } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');

const ui = {
  tab: 'today', report: 'week', weekOffset: 0, board: null, session: null, drill: null,
  onboard: { step: 'form', source: 'lichess', username: '', pgn: '', error: '', counts: { games: 0, mistakes: 0, drills: 0 }, live: '', progress: 0 },
  syncing: false, review: null,
  practice: { mode: 'games', pattern: 'all', n: 10, theme: 'mix', difficulty: 'any', moves: 'any' }, puzzle: null,
};

/* ------------------------------------------------------------------ engine */
let engine = null;
function getEngine() {
  if (!engine) engine = new Engine(workerTransport('vendor/stockfish/stockfish-19-lite-single.js'));
  return engine;
}

/* ------------------------------------------------------------------ helpers */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hide'), 2800);
}
function openSheet(html) { $('#sheet').innerHTML = html; $('#scrim').classList.remove('hide'); const f = $('#sheet button, #sheet input, #sheet select'); if (f) f.focus(); }
function closeSheet() { $('#scrim').classList.add('hide'); $('#sheet').innerHTML = ''; }
const nameOf = (id) => PATTERNS[id].name;
const setSize = () => state().settings.setSize;
const sourceLabel = (s) => ({ lichess: 'Lichess', chesscom: 'Chess.com', pgn: 'PGN' }[s] || s);
const accClass = (a) => (a >= 85 ? 'hi' : a < 65 ? 'lo' : '');
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
  const segs = []; let cur = [];
  points.forEach((p, i) => { if (p.v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([X(i), Y(p.v)]); });
  if (cur.length) segs.push(cur);
  const path = segs.map((s) => `<polyline points="${s.map((q) => q.join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const dots = points.map((p, i) => (p.v == null ? '' : `<circle cx="${X(i)}" cy="${Y(p.v)}" r="${i === points.length - 1 || points.length < 14 ? 3.5 : 0}" fill="var(--accent)"/>`)).join('');
  const lastIdx = points.map((p) => p.v != null).lastIndexOf(true);
  const lx = X(lastIdx), ly = Y(points[lastIdx].v);
  const labs = (opts.labels || []).map(([i, t]) => `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${esc(t)}</text>`).join('');
  const mk = opts.marker >= 0 && opts.marker != null ? `<line x1="${X(opts.marker)}" x2="${X(opts.marker)}" y1="${pt}" y2="${H - pb}" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="4 3"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.alt || 'Accuracy over time')}">${g}${mk}${path}${dots}<circle cx="${lx}" cy="${ly}" r="5" fill="var(--accent)"/><text x="${lx - 8}" y="${ly - 10}" text-anchor="end" style="fill:var(--ink);font-weight:600">${points[lastIdx].v}%</text>${labs}</svg>`;
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
async function sync({ count, pgn, onStatus }) {
  const s = state();
  const { source, username } = s.profile;
  onStatus({ phase: 'fetch' });
  let games;
  if (source === 'lichess') games = await fetchLichess(username, count);
  else if (source === 'chesscom') games = await fetchChessCom(username, count);
  else games = fromPgnText(pgn || '', username);
  if (!games.length) throw new Error(source === 'pgn' ? 'No usable games found. Check the username matches the White or Black name in the PGN.' : 'No standard games found for that account.');
  for (const g of games) { const ex = s.games[g.id]; if (ex && !ex.sans) ex.sans = g.moves.slice(); }
  const fresh = games.filter((g) => !s.games[g.id]);
  let mistakes = 0, drills = 0, done = 0;
  for (const g of fresh) {
    const rec = await analyzeGame(g, getEngine(), {
      movetime: s.settings.engineMs,
      onProgress: (i, n) => onStatus({ phase: 'analyse', game: done + 1, games: fresh.length, frac: i / n }),
    });
    done++;
    if (!rec) { onStatus({ phase: 'analyse', game: done, games: fresh.length, frac: 1, skipped: true }); continue; }
    s.games[rec.id] = rec;
    drills += addDrillsFromGame(s, rec);
    mistakes += rec.mistakes.length;
    save();
    onStatus({ phase: 'game', game: done, games: fresh.length, rec, mistakes, drills });
  }
  s.lastSync = Date.now();
  if (!Object.keys(todayResults(s)).length) s.today = null; // rebuild today's set, unless drilling has started
  save();
  return { total: games.length, analysed: fresh.length, mistakes, drills };
}

/* ------------------------------------------------------------------ onboarding */
function viewOnboard() {
  const o = ui.onboard;
  if (o.step === 'form') {
    return `<section class="view welcome">
      <p class="eyebrow">Free, no account</p>
      <h1 class="h1">Find the three mistakes costing you the most</h1>
      <p class="sub">Connect the account where you already play. In about a minute you will see the patterns behind your lost points, then drill them for ten minutes a day.</p>
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
        ${o.error ? `<div class="err" role="alert">${esc(o.error)}</div>` : ''}
        <button class="btn" style="margin-top:14px" data-act="start">Analyse my last ${state().settings.gamesToImport} games</button>
      </div>
    </section>`;
  }
  if (o.step === 'analyse') {
    return `<section class="view welcome">
      <p class="eyebrow">Analysing on your device</p>
      <h1 class="h1">Looking for the mistakes you repeat</h1>
      <div class="card" style="margin-top:18px">
        <div class="bar"><i style="width:${Math.round(o.progress * 100)}%"></i></div>
        <p class="live" aria-live="polite">${esc(o.live || 'Fetching your games')}</p>
        <div class="counts"><div><b>${o.counts.games}</b><span>games</span></div><div><b>${o.counts.mistakes}</b><span>mistakes</span></div><div><b>${o.counts.drills}</b><span>drills ready</span></div></div>
      </div>
      <button class="btn" id="earlyBtn" data-act="start-early" style="margin-top:14px" ${o.canStart ? '' : 'hidden'}>See my patterns now</button>
      <p class="sub small" style="margin-top:14px">First time takes a minute or two. Once five games are done you can start, and the rest keep analysing in the background.</p>
    </section>`;
  }
  // reveal
  const ps = patternStats(state());
  const max = Math.max(1, ...ps.list.map((p) => p.cost));
  return `<section class="view welcome">
    <p class="eyebrow">${plural(ps.games, 'game')} analysed</p>
    <h1 class="h1">Your top three patterns</h1>
    <p class="sub">Ranked by how many win-chance points each one cost you.</p>
    ${ui.syncing && o.early ? `<div class="card" style="margin-top:12px;background:var(--amber-soft);border-color:transparent"><p><b>Still analysing.</b> ${esc(o.live || '')} These numbers will keep updating.</p></div>` : ''}
    <div class="stack reveal">${ps.list.filter((p) => p.count).slice(0, 3).map((p, i) => patCard(p, max, i + 1, false)).join('') || '<div class="card"><p>No clear mistakes found in these games. Import more games to find patterns.</p></div>'}</div>
    <button class="btn" style="margin-top:18px" data-act="finish-onboard">See today's set</button>
  </section>`;
}

async function runOnboard() {
  const o = ui.onboard;
  o.username = ($('#uname')?.value || o.username).trim();
  if ($('#pgn')) o.pgn = $('#pgn').value;
  if (!o.username) { o.error = 'Enter your username first.'; render(); return; }
  if (o.source === 'pgn' && !o.pgn.trim()) { o.error = 'Paste at least one game.'; render(); return; }
  const s = state();
  s.profile = { source: o.source, username: o.username, createdAt: Date.now() };
  o.step = 'analyse'; o.error = ''; o.counts = { games: 0, mistakes: 0, drills: 0 }; o.live = 'Fetching your games'; o.progress = 0.02; o.early = false; o.canStart = false;
  ui.syncing = true;
  render();
  try {
    await sync({
      count: s.settings.gamesToImport, pgn: o.pgn,
      onStatus: (st) => {
        if (st.phase === 'fetch') o.live = `Fetching your ${sourceLabel(o.source)} games`;
        if (st.phase === 'analyse') { o.progress = ((st.game - 1) + st.frac) / st.games; o.live = `Analysing game ${st.game} of ${st.games}`; }
        if (st.phase === 'game') {
          o.counts = { games: st.game, mistakes: st.mistakes, drills: st.drills };
          const top = st.rec.mistakes[0];
          o.live = top ? `Game ${st.game} of ${st.games}: ${pat(top.pattern).name.toLowerCase()} on move ${Math.ceil(top.ply / 2 + 0.5)}` : `Game ${st.game} of ${st.games}: a clean one`;
        }
        if (st.phase === 'game' && st.game >= 5 && st.game < st.games && !o.canStart) { o.canStart = true; const eb = $('#earlyBtn'); if (eb) eb.hidden = false; }
        if (o.early) {
          setBg(`Analysing game ${Math.min(st.game || 0, st.games || 0)} of ${st.games || '?'}`, o.progress);
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
    if (o.early) {
      setBg(null);
      if (o.step === 'reveal' || ['today', 'diagnose', 'report'].includes(ui.tab)) render();
      toast('All games analysed.');
      return;
    }
    o.step = 'reveal';
  } catch (e) {
    ui.syncing = false;
    if (o.early) { setBg(null); toast(e.message || 'Analysis stopped. Pull in more games from Diagnose.'); return; }
    o.step = 'form'; s.profile = null;
    o.error = e.message || 'Something went wrong. Try again.';
  }
  render();
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
  const due = dueCount(s);
  if (!ids.length) {
    return `<section class="view"><h1 class="h1">Nothing to drill yet</h1><p class="sub">No mistakes were found to turn into drills. Import more games and they will appear here.</p><div class="stack"><button class="btn" data-act="sync">Import more games</button></div></section>`;
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
      <section class="card"><div class="row"><h2 class="h2">Your week</h2><span class="tag">${st.current ? `${st.current}-day streak` : 'No streak yet'}</span></div>
        <div class="week" style="margin-top:12px">${st.week.map((d) => `<div class="${d.done ? 'on' : ''} ${d.today ? 'today' : ''}"><i>${d.done ? '✓' : ''}</i>${['M', 'T', 'W', 'T', 'F', 'S', 'S'][(new Date(d.ts).getDay() + 6) % 7]}</div>`).join('')}</div>
        <p class="small sub" style="margin-top:12px">Finish at least ${Math.min(3, setSize())} drills to count the day. One rest day a week will not break your streak.</p>
      </section>
      <div class="row" style="gap:12px">
        <section class="card" style="flex:1"><div class="big">${due}</div><p class="sub small" style="margin-top:6px">positions due for review</p></section>
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
    <p class="eyebrow">${esc(sourceLabel(s.profile.source))} · ${esc(s.profile.username)}${s.lastSync ? ` · synced ${fmtDay(s.lastSync)}` : ''}</p>
    <h1 class="h1">Your last ${plural(ps.games, 'game')}</h1>
    <p class="sub">The patterns that cost you the most win chance. Words are templates over engine facts, never guesses.</p>
    <div class="stack">
      <button class="btn ghost" data-act="sync" ${ui.syncing ? 'disabled' : ''}>${ui.syncing ? 'Analysing…' : 'Import new games'}</button>
      ${s.staleMistakes ? `<div class="card" style="background:var(--amber-soft);border-color:transparent"><p><b>${plural(s.staleMistakes, 'older mistake')}</b> use the previous labels. Delete your data in Settings and import again to refresh them.</p></div>` : ''}
      ${withData.length ? withData.map((p, i) => patCard(p, max, i + 1)).join('') : '<div class="card"><p>No mistakes found. Great games, or import more.</p></div>'}
      <section class="card"><h2 class="h2">Recent games</h2><p class="sub small" style="margin:2px 0 6px">Tap a game to step through its biggest mistakes.</p>
        ${games.map((g) => `<div class="game" data-act="review" data-id="${esc(g.id)}" role="button" tabindex="0"><span class="acc ${accClass(g.accuracy)}" title="Accuracy">${Math.round(g.accuracy)}</span><span><b>${g.result === 'win' ? 'Won' : g.result === 'loss' ? 'Lost' : 'Drew'}</b> as ${g.color} vs ${esc(g.opponent)}<small>${fmtDay(g.date)}${g.speed ? ' · ' + esc(g.speed) : ''} · ${plural(g.mistakes.length, 'mistake')}</small></span><span class="small sub" aria-hidden="true">Review ›</span></div>`).join('') || '<p class="sub">No games yet.</p>'}
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
function startSession(ids, label) {
  const s = state();
  const res = todayResults(s);
  const list = ids.slice();
  // unfinished first
  list.sort((a, b) => (res[a] ? 1 : 0) - (res[b] ? 1 : 0));
  ui.session = { ids: list, idx: 0, label, results: {} };
  ui.drill = null;
  nav('retry');
}

function currentDrill() {
  const s = state(), se = ui.session;
  if (!se) return null;
  return s.drills[se.ids[se.idx]] || null;
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
    <div class="board-wrap"><div id="board"></div></div>
    <div id="fb">${fbHtml()}</div>
    <div class="stack" style="margin-top:12px">${actionsHtml()}</div>
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
    : `${esc(dr.san)} drops about ${Math.round(dr.drop)}% win chance.`;
  h += `<div class="fb ${dr.ok ? 'good' : 'bad'}" role="status"><b>${head}</b><p>${body}</p><p style="margin-top:8px">${esc(d.explain)}</p>
    <p class="small sub" style="margin-top:8px">${dr.ok ? 'It comes back for review on a spaced schedule.' : 'It returns tomorrow so you can try again.'}</p></div>
    <details class="eng"><summary>What the coach sees</summary><p>In your game you played <span class="mono">${esc(d.playedSan)}</span>. Engine line: <span class="mono">${esc(line)}</span>.</p><p>Evaluation for you: ${evalTxt(d.bestCp, d.bestMate)} with the best move, ${evalTxt(d.cpAfter)} after ${esc(d.playedSan)}. Checked on this device with Stockfish.</p></details>`;
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

function mountDrill() {
  const d = currentDrill();
  if (!d) return;
  if (!ui.drill || ui.drill.id !== d.id) ui.drill = { id: d.id, phase: 'ask', start: Date.now(), hint: '', hintSq: false, graded: false };
  const el = $('#board');
  if (!el) return;
  ui.board = new Board(el, { fen: d.fen, orientation: d.side, canMove: ui.drill.phase === 'ask', onMove: answer });
  // re-apply state after a rerender mid-drill
  const dr = ui.drill;
  if (dr.phase !== 'ask' && dr.playedUci) { ui.board.play(dr.playedUci); ui.board.mark(dr.playedUci.slice(2, 4), dr.ok ? 'good' : 'bad'); }
  if (dr.hintSq) ui.board.mark(d.bestUci.slice(0, 2), 'hint');
}

async function answer(uci, san) {
  const d = currentDrill(), dr = ui.drill;
  if (!d || dr.phase !== 'ask') return;
  dr.playedUci = uci; dr.san = san; dr.phase = 'checking';
  ui.board.play(uci); ui.board.setEnabled(false);
  rerenderDrillPanel();
  let ok, exact = uci === d.bestUci, drop = 0;
  if (exact) ok = true;
  else {
    try {
      const after = ui.board.fen();
      const ev = await getEngine().evaluate(after, { movetime: 250 });
      const userCp = -ev.cpc;
      drop = Math.max(0, winPct(d.bestCp) - winPct(userCp));
      ok = drop <= 7;
    } catch { ok = false; drop = 99; }
  }
  if (ui.drill !== dr) return;
  dr.ok = ok; dr.exact = exact; dr.drop = drop; dr.phase = 'done';
  ui.board.mark(uci.slice(2, 4), ok ? 'good' : 'bad');
  if (!dr.graded) {
    dr.graded = true;
    const s = state();
    gradeDrill(s, d.id, ok, Date.now() - dr.start);
    ui.session.results[d.id] = { ok };
    save();
  }
  if (navigator.vibrate) try { navigator.vibrate(ok ? 15 : [30, 40, 30]); } catch { /* ignore */ }
  render();
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
  const games = pr.mode === 'games';
  const modeBar = `<div class="mode" role="tablist" aria-label="Practice source"><button role="tab" data-act="mode" data-v="games" aria-selected="${games}">My games</button><button role="tab" data-act="mode" data-v="puzzles" aria-selected="${!games}">Puzzles</button></div>`;
  const chip = (act, v, label, on, off) => `<button data-act="${act}" data-v="${v}" aria-pressed="${on}" ${off ? 'disabled' : ''}>${label}</button>`;
  if (games) {
    const t = buildToday(s), res = todayResults(s);
    const left = t.ids.filter((i) => !res[i]);
    const total = extraDrills(s, 9999, 'all').length;
    const counts = Object.fromEntries(PATTERN_ORDER.map((p) => [p, extraDrills(s, 9999, p).length]));
    const avail = pr.pattern === 'all' ? total : counts[pr.pattern];
    const n = Math.min(pr.n, avail);
    return `<section class="view"><p class="eyebrow">Practice</p><h1 class="h1">Do more, your way</h1>${modeBar}
      <p class="sub" style="margin-top:12px">Positions from your own games. ${left.length ? `${plural(left.length, 'drill')} left in today’s set.` : 'Today’s set is done, so everything here is extra.'}</p>
      <div class="stack" style="margin-top:12px">
        ${left.length ? '<button class="btn" data-act="start-set">Continue today’s set</button>' : ''}
        <section class="card"><h2 class="h2">Pick a mistake type</h2><p class="sub small" style="margin:4px 0 10px">Reviews that are due come first. Numbers show drills available.</p>
          <div class="chips" role="group" aria-label="Mistake type">${chip('pp', 'all', `All types · ${total}`, pr.pattern === 'all', !total)}${PATTERN_ORDER.map((p) => chip('pp', p, `${esc(nameOf(p))} · ${counts[p]}`, pr.pattern === p, !counts[p])).join('')}</div>
          <p class="group-title" style="margin-top:16px">How many</p>
          <div class="chips" role="group" aria-label="How many drills">${[5, 10, 20].map((k) => chip('pn', k, k, pr.n === k, false)).join('')}</div>
          ${total === 0 ? '<p class="sub small" style="margin-top:8px">Import more games on the Diagnose tab to find more mistakes.</p>' : ''}
        </section>
      </div>
      <div class="cta"><button class="btn" data-act="practice" ${avail ? '' : 'disabled'}>${avail ? `Start ${plural(n, 'drill')}` : 'No drills available'}</button></div></section>`;
  }
  const ps = puzzleStats(s);
  return `<section class="view"><p class="eyebrow">Practice</p><h1 class="h1">Do more, your way</h1>${modeBar}
    <p class="sub" style="margin-top:12px">Puzzles sorted by theme. They are separate from your own games, are not scheduled for review, and work offline.</p>
    <div class="stack" style="margin-top:12px">
      <section class="card"><div class="row"><h2 class="h2">Choose a theme</h2><span class="tag">${ps.todaySolved} solved today \u00b7 ${ps.solved} total</span></div>
        <div class="chips" style="margin-top:10px" role="group" aria-label="Theme">${chip('pt', MIXED[0], MIXED[1], pr.theme === MIXED[0], false)}</div>
        ${THEME_GROUPS.map((g) => `<p class="group-title">${esc(g.name)}</p><div class="chips" role="group" aria-label="${esc(g.name)}">${g.themes.map(([id, name]) => chip('pt', id, esc(name), pr.theme === id, false)).join('')}</div>`).join('')}
        <p class="group-title">Moves in the solution</p>
        <div class="chips" role="group" aria-label="Moves in the solution">${MOVE_COUNTS.map(([id, name]) => chip('pm', id, name, String(pr.moves) === String(id), false)).join('')}</div>
        <p class="group-title">Difficulty</p>
        <div class="chips" role="group" aria-label="Difficulty">${DIFFICULTY.map(([id, name]) => chip('pd', id, name, pr.difficulty === id, false)).join('')}</div>
        ${Object.keys(s.drills).length ? '<button class="link" data-act="pmatch" style="margin-top:8px">Pick a theme for my top mistake type</button>' : ''}
      </section>
    </div>
    <div class="cta"><p class="sub small" id="pzCount" style="text-align:center;margin:0 0 6px;font-weight:600">&nbsp;</p>
      <button class="btn" data-act="puzzle-start" id="pzStart">Start ${esc(themeName(pr.theme))} puzzles</button></div></section>`;
}

async function refreshPuzzleCount() {
  const pr = ui.practice, el = $('#pzCount'), btn = $('#pzStart');
  if (!el) return;
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
    pz.step = 0; pz.phase = 'ask'; pz.failed = false; pz.hint = false; pz.start = Date.now(); pz.msg = ''; pz.msgKind = '';
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
    <div class="board-wrap"><div id="board"></div></div>
    <div id="pzFb">${pzFb()}</div>
    <div class="stack" style="margin-top:12px" id="pzActions">${pzActions()}</div></section>`;
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
}
function mountPuzzle() {
  const pz = ui.puzzle;
  if (!pz || !pz.p || !$('#board')) return;
  ui.board = new Board($('#board'), { fen: pz.p.fen, orientation: pz.p.side, canMove: pz.phase === 'ask', onMove: puzzleMove });
}
function logPuzzle(ok) {
  const pz = ui.puzzle, s = state();
  s.attempts.push({ t: Date.now(), id: 'lp:' + pz.p.id, ok, ms: Math.min(Date.now() - pz.start, 120000), kind: 'puzzle' });
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
      <section class="card"><p class="story">${got === ids.length ? 'Every position solved. These come back later on a spaced schedule.' : 'The ones you missed return tomorrow. That is how they stick.'}</p></section>
      <button class="btn" data-act="tab" data-v="report">See your report</button>
      <button class="btn ghost" data-act="tab" data-v="today">Back to Today</button>
    </div></section>`;
}

/* ------------------------------------------------------------------ Report */
function viewReport() {
  const s = state();
  const week = ui.report === 'week';
  let body = '';
  let eyebrow, title;
  if (week) {
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
    <div class="seg" role="tablist" aria-label="Report range"><button role="tab" data-act="rep" data-v="week" aria-selected="${week}">Week</button><button role="tab" data-act="rep" data-v="all" aria-selected="${!week}">All time</button></div>
    ${week ? `<div class="weeknav"><button class="link" data-act="wk" data-v="-1">‹ Earlier</button><button class="link" data-act="wk" data-v="1" ${ui.weekOffset >= 0 ? 'disabled style="opacity:.4"' : ''}>Later ›</button></div>` : ''}
    <div class="stack">${body}</div></section>`;
}

function weekBody(w) {
  if (!w.hasData) return '<div class="card"><p class="story">No games or drills this week yet.</p><p class="sub small" style="margin-top:6px">Play a few games, import them, then finish today’s set.</p></div>';
  const topName = nameOf(w.topPattern), focus = nameOf(w.focus);
  const story = [
    w.games ? `You analysed ${plural(w.games, 'game')}${w.acc != null ? ` at ${w.acc}% accuracy${w.delta != null ? (w.delta >= 0 ? `, up ${w.delta}` : `, down ${Math.abs(w.delta)}`) + ' on the week before' : ''}` : ''}.` : 'No new games this week.',
    w.drillsTried ? `You trained on ${plural(w.daysTrained, 'day')} and solved ${w.drillsPassed} of ${w.drillsTried} drills.` : 'No drills this week yet.',
    `${topName} cost you the most${w.improving ? ' and is improving' : ''}. Next focus: ${focus.toLowerCase()}.`,
  ].join(' ');
  const pts = w.trend.map((t) => ({ v: t.acc }));
  return `<p class="story">${esc(story)}</p>
    <div class="tiles">
      <div class="card tile"><div class="big ${w.delta == null ? '' : w.delta >= 0 ? 'up' : 'down'}">${w.delta == null ? (w.acc != null ? w.acc + '%' : '–') : arrow(w.delta) + ' pts'}</div><p class="k">${w.delta == null ? 'accuracy this week' : 'accuracy vs last week'}</p></div>
      <div class="card tile"><div class="big">${w.minutes} min</div><p class="k">trained across ${plural(w.daysTrained, 'day')}</p></div>
      <div class="card tile"><div class="big" style="font-size:21px;line-height:1.15">${esc(topName)}</div><p class="k">top pattern${w.improving ? ', improving' : ''}</p></div>
      <div class="card tile"><div class="big" style="font-size:21px;line-height:1.15">${esc(focus)}</div><p class="k">next week’s focus</p></div>
    </div>
    <section class="card chart"><h2 class="h2" style="margin-bottom:8px">Accuracy, last 6 weeks</h2>${line(pts, { labels: [[0, fmtDay(w.trend[0].ts)], [5, w.isCurrent ? 'Now' : fmtDay(w.trend[5].ts)]], alt: 'Weekly accuracy for the last six weeks' })}</section>
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
      <div class="card tile"><div class="big ${a.accDelta == null ? '' : a.accDelta >= 0 ? 'up' : 'down'}">${a.enough && a.accDelta != null ? arrow(a.accDelta) + ' pts' : a.lAcc + '%'}</div><p class="k">${a.enough && a.accDelta != null ? `accuracy, ${a.eAcc}% to ${a.lAcc}%` : 'baseline accuracy'}</p></div>
      <div class="card tile"><div class="big">${a.games}</div><p class="k">games analysed</p></div>
      <div class="card tile"><div class="big">${a.solved}</div><p class="k">drills solved</p></div>
      <div class="card tile"><div class="big">${a.mastered}</div><p class="k">mistakes mastered</p></div>
      <div class="card tile"><div class="big">${a.puzzlesSolved}</div><p class="k">Lichess puzzles solved</p></div>
      <div class="card tile"><div class="big">${a.minutes >= 60 ? (a.minutes / 60).toFixed(1) + ' h' : a.minutes + ' min'}</div><p class="k">time trained</p></div>
      <div class="card tile"><div class="big">${a.streak.longest} ${a.streak.longest === 1 ? 'day' : 'days'}</div><p class="k">longest streak</p></div>
    </div>
    <section class="card chart"><h2 class="h2" style="margin-bottom:8px">Accuracy since you started</h2>${line(pts, { labels: pts.length > 1 ? [[0, fmtDay(a.weeks[0].ts)], [pts.length - 1, 'Now']] : [], marker: a.markerIdx, alt: 'Weekly accuracy since the first analysed game' })}<p class="sub small" style="margin-top:6px">Weekly average. Weeks without games are left blank.${a.markerIdx >= 0 ? ' The dashed line marks when you started training.' : ''}</p></section>
    ${a.patterns.length ? `<section class="card"><h2 class="h2">Mistakes per 25 games</h2><p class="sub small" style="margin-bottom:6px">${a.enough ? `Your ${a.slice} games before training against your latest ${a.slice}.` : 'Your starting point. This compares properly once you have new games after training.'}</p>${a.patterns.map((p) => pairHtml(p, a)).join('')}</section>` : ''}
    <section class="card"><h2 class="h2" style="margin-bottom:6px">Milestones</h2>${a.milestones.map((m) => `<div class="mile"><time>${fmtDay(m.ts)}</time><span>${esc(m.text)}</span></div>`).join('')}</section>`;
}

function pairHtml(p, a) {
  const max = Math.max(5, ...a.patterns.flatMap((x) => [x.then, x.now]));
  const change = p.then ? Math.round(((p.then - p.now) / p.then) * 100) : 0;
  return `<div class="pair"><b>${esc(nameOf(p.id))}</b><span class="delta ${a.enough ? (change > 0 ? 'up' : change < 0 ? 'down' : '') : ''}">${a.enough ? (change > 0 ? '−' + change + '%' : change < 0 ? '+' + Math.abs(change) + '%' : 'no change') : ''}</span>
    <div class="bars">${a.enough ? `<span>Before</span><div class="bar then"><i style="width:${(p.then / max) * 100}%"></i></div><span>${p.then}</span><span>Since</span>` : '<span>Start</span>'}<div class="bar"><i style="width:${(p.now / max) * 100}%"></i></div><span>${p.now}</span></div></div>`;
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
  g.fillStyle = v('--accent'); g.font = '700 40px system-ui,sans-serif'; g.fillText('Blunderprint', 72, 1260);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'my-chess-week.png', { type: 'image/png' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'My chess week' }); return; } } catch { /* cancelled */ }
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
    ${p ? `<div class="settings-row"><b>${esc(sourceLabel(p.source))}: ${esc(p.username)}</b><span class="sub small">${plural(Object.keys(s.games).length, 'game')} analysed${s.lastSync ? `, last sync ${fmtDay(s.lastSync)}` : ''}</span>
      <div class="row" style="gap:8px;margin-top:6px"><button class="btn sm" data-act="sync-from-settings">Sync games</button><button class="btn sm ghost" data-act="switch">Change account</button></div></div>` : ''}
    ${installRow()}
    <div class="settings-row"><label for="setSize"><b>Drills per day</b></label><select id="setSize" data-set="setSize">${[3, 5, 8, 10, 15].map((n) => `<option value="${n}" ${st.setSize === n ? 'selected' : ''}>${n} drills, about ${Math.round(n * 1.5)} min</option>`).join('')}</select></div>
    <div class="settings-row"><label for="gamesN"><b>Games per sync</b></label><select id="gamesN" data-set="gamesToImport">${[25, 50, 100].map((n) => `<option value="${n}" ${st.gamesToImport === n ? 'selected' : ''}>Latest ${n}</option>`).join('')}</select></div>
    <div class="settings-row"><label for="eng"><b>Analysis depth</b></label><select id="eng" data-set="engineMs"><option value="40" ${st.engineMs === 40 ? 'selected' : ''}>Fast</option><option value="70" ${st.engineMs === 70 ? 'selected' : ''}>Balanced</option><option value="150" ${st.engineMs === 150 ? 'selected' : ''}>Thorough, slower</option></select><span class="sub small">Applies to games you import from now on.</span></div>
    <div class="settings-row"><label for="theme"><b>Theme</b></label><select id="theme" data-set="theme">${['system', 'light', 'dark'].map((t) => `<option value="${t}" ${st.theme === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
    <div class="settings-row"><b>Your data</b><span class="sub small">Stored only in this browser. Back it up before clearing site data.</span>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap"><button class="btn sm ghost" data-act="export">Download backup</button><label class="btn sm ghost" style="cursor:pointer">Restore backup<input type="file" id="restore" accept="application/json" class="hide"></label></div></div>
    <div class="settings-row"><b>Reset everything</b><span class="sub small">Deletes games, drills and history from this device.</span><button class="btn sm danger" style="margin-top:6px;width:fit-content" data-act="reset">Delete all data</button></div>
    <p class="sub small" style="margin-top:12px">Engine: Stockfish 19 (GPLv3), running locally. Pieces: Colin M.L. Burnett (CC BY-SA 3.0).</p>
    <button class="btn" style="margin-top:12px" data-act="close">Done</button>`);
}

function applyTheme() {
  const t = state().settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}

async function manualSync(count) {
  if (ui.syncing) return;
  const s = state();
  ui.syncing = true; render();
  try {
    const r = await sync({ count: count || s.settings.gamesToImport, pgn: '', onStatus: (st) => { if (st.phase === 'analyse') { const b = $('[data-act="sync"]'); if (b) b.textContent = `Analysing game ${st.game} of ${st.games}`; } } });
    toast(r.analysed ? `${plural(r.analysed, 'new game')} analysed, ${plural(r.drills, 'new drill')}.` : 'No new games found.');
  } catch (e) { toast(e.message || 'Sync failed.'); }
  ui.syncing = false; render();
}

/* ------------------------------------------------------------------ Game review */
/** Only the biggest mistakes in a game: at least 12 points of win chance, at most five. */
const keyMoments = (g) => g.mistakes.filter((m) => m.wpLoss >= 12).sort((a, b) => b.wpLoss - a.wpLoss).slice(0, 5).sort((a, b) => a.ply - b.ply);
const moveNo = (ply) => Math.floor(ply / 2) + 1;
const rvKey = (rv) => (rv.mode === 'full' ? rv.keys.find((m) => m.ply === rv.p) : rv.keys[rv.p]);

function openReview(id, ply) {
  const g = state().games[id];
  if (!g) return;
  const rv = { id, p: 0, shown: '', keys: keyMoments(g), mode: g.sans ? 'full' : 'moments', fens: [], moves: [] };
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

function viewReview() {
  const s = state(), rv = ui.review, g = s.games[rv.id];
  const km = rvKey(rv);
  const result = g.result === 'win' ? 'Won' : g.result === 'loss' ? 'Lost' : 'Drew';
  let label;
  if (rv.mode === 'moments') label = `Mistake ${rv.p + 1} of ${rv.keys.length}`;
  else if (rv.p === 0) label = 'Start of the game';
  else label = `${moveNo(rv.p - 1)}${(rv.p - 1) % 2 === 0 ? '.' : '...'} ${rv.moves[rv.p - 1]?.san || ''}`;
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
    ${reviewGraph(g, rv)}</section>`;
}

function mountReview() {
  const s = state(), rv = ui.review, g = s.games[rv.id];
  const el = $('#board');
  if (!el) return;
  const km = rvKey(rv);
  const fen = rv.mode === 'full' ? rv.fens[rv.p] : km.fen;
  ui.board = new Board(el, { fen, orientation: g.color === 'white' ? 'w' : 'b', canMove: false });
  if (km && rv.shown) {
    ui.board.setPosition(km.fen, g.color === 'white' ? 'w' : 'b');
    ui.board.setEnabled(false);
    const uci = rv.shown === 'played' ? km.playedUci : km.bestUci;
    ui.board.play(uci);
    ui.board.mark(uci.slice(2, 4), rv.shown === 'played' ? 'bad' : 'good');
  } else if (rv.mode === 'full' && rv.p > 0 && rv.moves[rv.p - 1]) {
    const m = rv.moves[rv.p - 1];
    ui.board.mark(m.from, 'last'); ui.board.mark(m.to, 'last');
  }
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
  } catch (e) { toast(e.message || 'Could not load the moves.'); }
}

/* ------------------------------------------------------------------ router + render */
function nav(tab) {
  ui.tab = tab;
  if (tab !== 'diagnose') ui.review = null;
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  render(); window.scrollTo(0, 0);
}

function render() {
  const s = state();
  const needsOnboard = !s.profile || ui.onboard.step === 'analyse' || ui.onboard.step === 'reveal';
  applyTheme();
  $('#tabs').hidden = needsOnboard;
  $('#settingsBtn').hidden = !s.profile;
  const chip = $('#streakChip');
  if (s.profile && !needsOnboard) { const st = streak(s); chip.hidden = !st.current; chip.textContent = `${st.current}-day streak`; } else chip.hidden = true;
  if (needsOnboard) { ui.board = null; view.innerHTML = viewOnboard(); return; }
  if (ui.tab === 'retry' && ui.session && !ui.drill && ui.session.idx < ui.session.ids.length) ui.drill = null;
  $$('#tabs [data-tab]').forEach((b) => (b.dataset.tab === ui.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const due = dueCount(s), badge = $('#dueBadge');
  badge.hidden = !due; badge.textContent = due;
  if (ui.tab === 'today') view.innerHTML = viewToday();
  else if (ui.tab === 'diagnose') {
    if (ui.review && state().games[ui.review.id]) { view.innerHTML = viewReview(); mountReview(); save(); return; }
    ui.review = null;
    view.innerHTML = viewDiagnose();
  }
  else if (ui.tab === 'report') view.innerHTML = viewReport();
  else if (ui.tab === 'retry') {
    const se = ui.session;
    if (ui.puzzle) { view.innerHTML = viewPuzzle(); mountPuzzle(); save(); return; }
    if (se && se.idx < se.ids.length && !ui.drill) { const d = currentDrill(); ui.drill = { id: d.id, phase: 'ask', start: Date.now(), hint: '', hintSq: false, graded: false }; }
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
  if (e.target.closest('a')) return; // real links keep their normal behaviour
  if (t.dataset.tab) { nav(t.dataset.tab); return; }
  const a = t.dataset.act, v = t.dataset.v ?? t.dataset.p, s = state();
  switch (a) {
    case 'src': ui.onboard.source = v; ui.onboard.username = $('#uname')?.value || ui.onboard.username; ui.onboard.error = ''; render(); break;
    case 'start': runOnboard(); break;
    case 'start-early': ui.onboard.early = true; ui.onboard.step = 'reveal'; setBg(`Analysing in the background`, ui.onboard.progress); render(); break;
    case 'finish-onboard': ui.onboard.step = 'form'; ui.onboard.error = ''; nav('today'); break;
    case 'tab': nav(v); break;
    case 'lesson': { const b = $('#lessonBody'); const open = b.classList.toggle('hide') === false; t.textContent = open ? 'Hide' : 'Read'; t.setAttribute('aria-expanded', open); break; }
    case 'start-set': {
      const today = buildToday(s);
      const res = todayResults(s);
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
    case 'rv-mine': ui.review.shown = 'played'; render(); break;
    case 'rv-best': ui.review.shown = 'best'; render(); break;
    case 'rv-reset': ui.review.shown = ''; render(); break;
    case 'rv-drill': { const km = rvKey(ui.review); if (km && s.drills[km.id]) { ui.review = null; startSession([km.id], 'From your game'); } break; }
    case 'rv-load': backfillMoves(); break;
    case 'hub': ui.session = null; ui.drill = null; ui.puzzle = null; nav('retry'); break;
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
    case 'puzzle-start': ui.session = null; ui.drill = null; ui.puzzle = { theme: ui.practice.theme, difficulty: ui.practice.difficulty, moves: ui.practice.moves, seen: new Set(state().puzzleSeen || []), solved: 0, tried: 0, phase: 'loading' }; ui.tab = 'retry'; loadPuzzle(); break;
    case 'puzzle-next': loadPuzzle(); break;
    case 'pz-hint': { const pz = ui.puzzle; pz.hint = true; ui.board.mark(pz.p.solution[pz.step].slice(0, 2), 'hint'); pzRefresh(); break; }
    case 'pz-skip': {
      const pz = ui.puzzle, mv = pz.p.solution[pz.step];
      pz.failed = true; pz.phase = 'solved'; pz.msgTitle = 'The answer'; pz.msg = `The next move was ${pvToSan(ui.board.fen(), [mv], 1)[0] || mv}.`; pz.msgKind = 'hint';
      ui.board.mark(mv.slice(0, 2), 'hint'); ui.board.mark(mv.slice(2, 4), 'good'); ui.board.setEnabled(false); logPuzzle(false); pzRefresh(); break;
    }

    case 'idea': {
      const d = currentDrill(), dr = ui.drill;
      if (!dr.hint) dr.hint = pat(d.pattern).idea;
      else if (!dr.hintSq) { dr.hintSq = true; ui.board.mark(d.bestUci.slice(0, 2), 'hint'); }
      rerenderDrillPanel(); break;
    }
    case 'skip': {
      const d = currentDrill(), dr = ui.drill;
      if (!dr.graded) { dr.graded = true; gradeDrill(s, d.id, false, Date.now() - dr.start); ui.session.results[d.id] = { ok: false }; save(); }
      nextDrill(); break;
    }
    case 'again': { const d = currentDrill(); ui.drill = { ...ui.drill, phase: 'ask', hint: ui.drill.hint, hintSq: false, playedUci: null, start: Date.now() }; ui.board.setPosition(d.fen, d.side); ui.board.setEnabled(true); render(); break; }
    case 'answer': { const d = currentDrill(); ui.board.setPosition(d.fen, d.side); const m = ui.board.play(d.bestUci); ui.board.mark(d.bestUci.slice(2, 4), 'good'); ui.board.setEnabled(false); toast(`The answer was ${m.san}`); break; }
    case 'next': nextDrill(); break;
    case 'rep': ui.report = v; render(); break;
    case 'wk': if (!(+v > 0 && ui.weekOffset >= 0)) { ui.weekOffset += +v; render(); } break;
    case 'share': shareReport(); break;
    case 'sync': manualSync(); break;
    case 'sync-from-settings': closeSheet(); manualSync(); break;
    case 'switch': closeSheet(); s.profile = null; ui.onboard = { ...ui.onboard, step: 'form', error: '' }; save(); render(); break;
    case 'export': { const b = new Blob([exportJson()], { type: 'application/json' }); const l = document.createElement('a'); l.href = URL.createObjectURL(b); l.download = `blunderprint-backup-${new Date().toISOString().slice(0, 10)}.json`; l.click(); break; }
    case 'reset': openSheet(`<h2 class="h2">Delete all data?</h2><p class="sub" style="margin:6px 0 14px">Your games, drills, streak and reports will be removed from this device. This cannot be undone. Download a backup first if you want to keep them.</p><button class="btn danger" data-act="reset-yes">Delete everything</button><button class="btn ghost" style="margin-top:8px" data-act="close">Keep my data</button>`); break;
    case 'reset-yes': reset(); closeSheet(); ui.session = null; ui.drill = null; ui.onboard.step = 'form'; render(); break;
    case 'install': if (installEvent) { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; closeSheet(); } break;
    case 'close': closeSheet(); break;
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.set) { const k = t.dataset.set; state().settings[k] = k === 'theme' ? t.value : +t.value; if (k === 'setSize') state().today = null; save(); applyTheme(); }
  if (t.id === 'restore' && t.files[0]) {
    t.files[0].text().then((txt) => { try { importJson(txt); closeSheet(); ui.session = null; ui.drill = null; render(); toast('Backup restored'); } catch (err) { toast(err.message); } });
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#scrim').classList.contains('hide')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('[role=button][data-act]')) e.target.click(); });
$('#settingsBtn').addEventListener('click', openSettings);
$('#streakChip').addEventListener('click', () => nav('today'));
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (['today', 'diagnose', 'retry', 'report'].includes(t) && t !== ui.tab) { ui.tab = t; render(); } });
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
const h = location.hash.slice(1);
if (['today', 'diagnose', 'retry', 'report'].includes(h)) ui.tab = h;
render();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
export { onChange, DAY, pvToSan };
