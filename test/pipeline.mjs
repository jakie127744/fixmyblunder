// Node check of the whole analysis pipeline against real public games.
// usage: node test/pipeline.mjs lichess <user> [n]   |   node test/pipeline.mjs chesscom <user> [n]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Engine } from '../public/js/engine.js';
import { analyzeGame } from '../public/js/analyze.js';
import { fetchLichess, fetchChessCom } from '../public/js/importer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sf = path.join(here, '../node_modules/stockfish/bin/stockfish-19-lite-single.js');
const proc = spawn('node', [sf], { stdio: ['pipe', 'pipe', 'inherit'] });
const cbs = [];
createInterface({ input: proc.stdout }).on('line', (l) => cbs.forEach((f) => f(l)));
const engine = new Engine({ post: (c) => proc.stdin.write(c + '\n'), onLine: (f) => cbs.push(f) });

const [, , source = 'lichess', user = 'thibault', n = '3'] = process.argv;
const games = await (source === 'chesscom' ? fetchChessCom : fetchLichess)(user, +n);
console.log(`fetched ${games.length} games`);
const t0 = Date.now();
const tally = {};
const verbose = process.argv[5] !== 'quiet';
for (const g of games) {
  const r = await analyzeGame(g, engine, { movetime: +(process.env.MS || 50) });
  if (!r) { console.log('skipped', g.id); continue; }
  for (const m of r.mistakes) (tally[m.pattern] ||= []).push(m);
  if (!verbose) continue;
  console.log(`\n${g.id} ${g.color} ${g.result} acc ${r.accuracy} mistakes ${r.mistakes.length} clocks ${g.clocks ? 'yes' : 'no'}`);
  for (const m of r.mistakes.slice(0, 4)) console.log(`  ply ${m.ply} [${m.pattern}] -${m.wpLoss}  ${m.explain}`);
}
const total = Object.values(tally).reduce((a, l) => a + l.length, 0);
console.log(`\npattern mix (${total} mistakes):`);
for (const [k, l] of Object.entries(tally).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k.padEnd(11)} ${String(l.length).padStart(3)}  ${Math.round((l.length / total) * 100)}%   e.g. ${l[0].explain}`);
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
proc.kill();
process.exit(0);
