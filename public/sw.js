// Offline shell. App files are network-first (so updates arrive), the engine, pieces and chess.js are cache-first.
// Game APIs (lichess.org, api.chess.com) always go to the network.
const VERSION = 'bp-v7';
const STATIC = [
  'vendor/chess/chess.js', 'vendor/stockfish/stockfish-19-lite-single.js', 'vendor/stockfish/stockfish-19-lite-single.wasm',
  ...['b', 'w'].flatMap((c) => ['k', 'q', 'r', 'b', 'n', 'p'].map((p) => `img/pieces/${c}${p}.svg`)),
];
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'img/icon.svg', 'img/icon-192.png', 'img/icon-512.png', 'img/icon-maskable-512.png', 'js/app.js', 'js/analyze.js', 'js/board.js', 'js/classify.js', 'js/engine.js', 'js/importer.js', 'js/patterns.js', 'js/puzzles.js', 'js/report.js', 'js/score.js', 'js/srs.js', 'js/store.js', 'js/util.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => { await c.addAll(SHELL); await c.addAll(STATIC).catch(() => {}); }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const fonts = u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
  if (u.origin !== location.origin && !fonts) return;
  const isStatic = fonts || /\/(vendor|img\/pieces|data\/puzzles)\//.test(u.pathname);
  const put = (r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; };
  e.respondWith(isStatic
    ? caches.match(e.request).then((hit) => hit || fetch(e.request).then(put))
    : fetch(e.request).then(put).catch(() => caches.match(e.request)));
});
