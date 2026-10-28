// Runs Buddy (the C++ engine from the Lichess bot, built to WebAssembly) off the main thread.
// Speaks the same protocol as the Stockfish worker: UCI text in, UCI text out.
// buddy_command() is synchronous, so a long "go" blocks this worker until bestmove; the page
// never freezes because all of this happens here.
importScripts('buddy.js');

let mod = null;
const pending = [];
const run = (c) => mod.ccall('buddy_command', null, ['string'], [c]);

BuddyEngine({ print: (t) => postMessage(t), printErr: () => {} }).then((m) => {
  mod = m;
  pending.splice(0).forEach(run);
});

onmessage = (e) => {
  if (typeof e.data !== 'string') return;
  if (mod) run(e.data); else pending.push(e.data);
};
