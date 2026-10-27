// Builds the offline puzzle bank from Lichess' open puzzle data (CC0) already on this machine.
// Aim per theme: 100+ puzzles, solutions of 1 to 5 of your own moves, no repeated solutions.
// usage: node scripts/build-puzzle-bank.mjs [sourceDir]
//   sourceDir defaults to E:/Claude/Chess-App-Deployment (src/lib/data/fresh/*.json and public/puzzles/*.db)
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Chess } from '../public/vendor/chess/chess.js';

const src = process.argv[2] || 'E:/Claude/Chess-App-Deployment';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/data/puzzles');
await mkdir(out, { recursive: true });

// theme id -> Lichess tags that qualify a puzzle for it
const THEMES = {
  // basics
  fork: ['fork'], hangingPiece: ['hangingPiece'], skewer: ['skewer'], doubleCheck: ['doubleCheck'], pin: ['pin'],
  sacrifice: ['sacrifice'], discoveredAttack: ['discoveredAttack'],
  // more tactics
  discoveredCheck: ['discoveredCheck'], deflection: ['deflection'], attraction: ['attraction'], xRayAttack: ['xRayAttack'],
  trappedPiece: ['trappedPiece'], interference: ['interference'], clearance: ['clearance'], intermezzo: ['intermezzo'],
  capturingDefender: ['capturingDefender'], zugzwang: ['zugzwang'], quietMove: ['quietMove'], defensiveMove: ['defensiveMove'],
  // checkmates
  mateIn1: ['mateIn1'], mateIn2: ['mateIn2'], mateIn3: ['mateIn3'], backRankMate: ['backRankMate'], smotheredMate: ['smotheredMate'],
  anastasiaMate: ['anastasiaMate'], arabianMate: ['arabianMate'], balestraMate: ['balestraMate'], blindSwineMate: ['blindSwineMate'],
  bodenMate: ['bodenMate'], cornerMate: ['cornerMate'], doubleBishopMate: ['doubleBishopMate'], dovetailMate: ['dovetailMate'],
  epauletteMate: ['epauletteMate'], hookMate: ['hookMate'], killBoxMate: ['killBoxMate'], morphysMate: ['morphysMate'],
  operaMate: ['operaMate'], pillsburysMate: ['pillsburysMate'], swallowstailMate: ['swallowstailMate'], triangleMate: ['triangleMate'],
  vukovicMate: ['vukovicMate'],
  // endgame tactics
  endgame: ['endgame'], pawnEndgame: ['pawnEndgame'], rookEndgame: ['rookEndgame'], queenEndgame: ['queenEndgame'],
  minorEndgame: ['bishopEndgame', 'knightEndgame'], queenRookEndgame: ['queenRookEndgame'], advancedPawn: ['advancedPawn'],
  // attack and phase
  kingsideAttack: ['kingsideAttack'], queensideAttack: ['queensideAttack'], attackingF2F7: ['attackingF2F7'], exposedKing: ['exposedKing'],
  opening: ['opening'], middlegame: ['middlegame'],
  // goals
  advantage: ['advantage'], crushing: ['crushing'], equality: ['equality'],
};
const TARGET = 120;
const QUOTA = { 1: 22, 2: 36, 3: 34, 4: 18, 5: 10 };       // shares of 120, topped up from other lengths if short
const TOPUP = [2, 3, 1, 4, 5];
const FIRST_MOVE_CAP = 3;
const band = (r) => (r < 1300 ? 0 : r < 1800 ? 1 : 2);

// ---- collect every puzzle once
const all = new Map();
function take(p) {
  if (!p || !p.id || all.has(p.id) || !p.fen || !Array.isArray(p.moves)) return;
  const themes = Array.isArray(p.themes) ? p.themes : String(p.themes || '').split(/[ ,]+/).filter(Boolean);
  all.set(p.id, { id: p.id, fen: p.fen, moves: p.moves, rating: +p.rating || 1500, themes });
}
const freshDir = path.join(src, 'src/lib/data/fresh');
for (const f of await readdir(freshDir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const d = JSON.parse(await readFile(path.join(freshDir, f), 'utf8'));
    for (const p of Array.isArray(d) ? d : d.puzzles || []) take(p);
  } catch { /* skip files that are not puzzle arrays */ }
}
for (const dbFile of ['public/puzzles/puzzles.db', 'public/puzzles/refined_puzzles.db']) {
  const f = path.join(src, dbFile);
  if (!existsSync(f)) continue;
  const db = new DatabaseSync(f, { readOnly: true });
  for (const r of db.prepare('select id, fen, moves, rating, themes from puzzles').all()) take({ ...r, moves: String(r.moves).split(' ') });
  db.close();
}
console.log(`${all.size} unique source puzzles`);

// ---- start position: Lichess data lists the opponent's move first, so play it, then the rest is the solution
const prepared = [];
for (const p of all.values()) {
  const solver = Math.floor(p.moves.length / 2);
  if (solver < 1 || solver > 5) continue;
  const c = new Chess();
  try {
    c.load(p.fen);
    const m0 = p.moves[0];
    c.move({ from: m0.slice(0, 2), to: m0.slice(2, 4), promotion: m0[4] });
    const s1 = p.moves[1];
    new Chess(c.fen()).move({ from: s1.slice(0, 2), to: s1.slice(2, 4), promotion: s1[4] });
  } catch { continue; }
  prepared.push({ i: p.id, r: p.rating, f: c.fen(), s: p.moves.slice(1).join(' '), n: solver, themes: new Set(p.themes) });
}
console.log(`${prepared.length} usable (1 to 5 moves)`);

// ---- seeded shuffle so the bank is stable between runs
let seed = 20261027;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function pick(pool) {
  const sols = new Set(), first = new Map(), chosen = [];
  const byLen = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const p of shuffle(pool.slice())) byLen[p.n].push(p);
  const ok = (p) => !sols.has(p.s) && (first.get(p.s.split(' ')[0]) || 0) < FIRST_MOVE_CAP;
  const push = (p) => { chosen.push(p); sols.add(p.s); const k = p.s.split(' ')[0]; first.set(k, (first.get(k) || 0) + 1); };
  const takeFrom = (n, want) => {
    // alternate rating bands so every level is represented
    const bands = [[], [], []];
    for (const p of byLen[n]) bands[band(p.r)].push(p);
    let got = 0, b = 0, guard = 0;
    while (got < want && guard++ < 5000) {
      const bucket = bands[b % 3]; b++;
      while (bucket.length) { const p = bucket.pop(); if (ok(p)) { push(p); got++; break; } }
      if (!bands.some((x) => x.length)) break;
    }
    return got;
  };
  for (const n of [1, 2, 3, 4, 5]) takeFrom(n, Math.round(QUOTA[n] * (TARGET / 120)));
  for (const n of TOPUP) { if (chosen.length >= TARGET) break; takeFrom(n, TARGET - chosen.length); }
  return shuffle(chosen);
}

const index = {};
const rows = [];
async function write(id, list) {
  const items = list.map(({ i, r, f, s }) => ({ i, r, f, s }));
  await writeFile(path.join(out, `${id}.json`), JSON.stringify(items));
  const len = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const p of list) len[p.n]++;
  const rating = { easier: 0, normal: 0, harder: 0 };
  for (const p of list) rating[['easier', 'normal', 'harder'][band(p.r)]]++;
  index[id] = { n: list.length, len, rating };
  rows.push([id, list.length, len, rating]);
}
for (const [id, tags] of Object.entries(THEMES)) await write(id, pick(prepared.filter((p) => tags.some((t) => p.themes.has(t)))));
await write('mix', pick(prepared));
await writeFile(path.join(out, 'index.json'), JSON.stringify(index));

for (const [id, n, len, rating] of rows) console.log(id.padEnd(18), String(n).padStart(4), JSON.stringify(len), JSON.stringify(rating), n < 100 ? '  <-- under 100' : '');
console.log(`\n${rows.length} themes, ${rows.filter((r) => r[1] < 100).length} under 100`);
