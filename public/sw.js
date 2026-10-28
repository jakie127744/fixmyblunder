// Offline shell. App files are network-first (so updates arrive), the engine, pieces and chess.js are cache-first.
// Game APIs (lichess.org, api.chess.com) always go to the network.
const VERSION = 'bp-v21';
const PUZZLES = 'bp-puzzles'; // kept across app updates so the puzzle download is not repeated
const STATIC = [
  'vendor/chess/chess.js', 'vendor/buddy/buddy-worker.js', 'vendor/buddy/buddy.js', 'vendor/buddy/buddy.wasm','vendor/stockfish/stockfish-19-lite-single.js', 'vendor/stockfish/stockfish-19-lite-single.wasm',
  ...['b', 'w'].flatMap((c) => ['k', 'q', 'r', 'b', 'n', 'p'].map((p) => `img/pieces/${c}${p}.svg`)),
];
const SHELL = ['./', 'index.html', 'css/app.css', 'css/fonts.css', 'privacy.html', 'terms.html', 'fonts/figtree-400-1.woff2', 'fonts/bricolage-grotesque-500-0.woff2', 'fonts/jetbrains-mono-500-2.woff2', 'manifest.webmanifest', 'img/icon.svg', 'img/icon-192.png', 'img/icon-512.png', 'img/icon-maskable-512.png', 'img/wordmark.png', 'img/favicon-32.png', 'img/apple-touch-icon.png', 'js/app.js', 'js/analyze.js', 'js/board.js', 'js/classify.js', 'js/config.js', 'js/diag.js', 'js/reminder.js', 'js/engine.js', 'js/importer.js', 'js/lessons.js', 'js/patterns.js', 'js/play.js', 'js/playengine.js', 'js/puzzles.js','js/report.js', 'js/samples.js', 'js/score.js', 'js/srs.js', 'js/store.js', 'js/util.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => { await c.addAll(SHELL); await c.addAll(STATIC).catch(() => {}); }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== PUZZLES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin !== location.origin) return;
  const isStatic = /\/(vendor|fonts|img\/pieces|data\/puzzles)\//.test(u.pathname);
  const put = (r) => { if (r.ok) { const copy = r.clone(); caches.open(u.pathname.includes('/data/puzzles/') ? PUZZLES : VERSION).then((c) => c.put(e.request, copy)); } return r; };
  e.respondWith(isStatic
    ? caches.match(e.request).then((hit) => hit || fetch(e.request).then(put))
    : fetch(e.request).then(put).catch(() => caches.match(e.request)));
});
