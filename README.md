# Blunderprint (MVP)

Import the games you already played, find the mistakes you keep repeating, and drill exactly those for ten minutes a day.
Local-first PWA: no account, no server-side analysis. Built from the design plan in `chess-app-design-plan.html`.

## Run

```bash
npm install
npm start          # http://localhost:5173
npm test           # unit checks for the pure logic
npm run test:pipeline   # real Lichess games through Stockfish in Node
```

Open it on a phone on the same network (`http://<your-pc-ip>:5173`) and use "Add to Home Screen". Any static host works
(`public/` is the whole app); a real deploy needs HTTPS for the service worker and install prompt.

## How it works

| Step | File | Notes |
|---|---|---|
| Import | `js/importer.js` | Lichess (NDJSON API), Chess.com (public monthly archives), pasted PGN. Clocks read from `[%clk]`. |
| Analyse | `js/analyze.js`, `js/engine.js` | Stockfish 19 lite (WASM, Web Worker) scores every position on-device. Opening plies are skipped. |
| Judge | `js/score.js` | Win-percentage and accuracy formulas published by Lichess. A mistake is a drop of 10+ win-chance points. |
| Name | `js/classify.js`, `js/patterns.js` | Plain code picks one of seven patterns (hanging pieces, missed tactics, throwing away wins, endgame technique, king safety, time trouble, positional slips) and fills a template sentence. No language model. The design plan listed five; the last two splits keep "missed tactics" from becoming a catch-all. `reclassify()` re-labels stored mistakes without the engine when the rules change. |
| Drill | `js/srs.js`, `js/app.js` | Answers are checked by the engine, so any move within 7 win-chance points of the best is accepted. Boxes at 1, 3, 7, 16, 35 days. |
| Streak | `js/srs.js` | A day counts at 3 drills. One rest day per week does not break it. |
| Reports | `js/report.js` | Weekly and all-time. All-time compares games before your first drill with games after it, and only once you have 10 new games and 2 weeks of training; until then it shows a baseline. |

First import: after five games you can open your patterns and start drilling while the rest analyse in the background (a banner shows progress). Today's set stays fixed once you have started drilling.

Data lives in `localStorage` (`blunderprint.v1`). Settings has backup and restore as JSON.

## Game review

Tap any game on the Diagnose tab. You see only its biggest mistakes (at least 12 points of win chance, at most five) as chips, a win-chance graph you can tap to jump around, and the board with arrows to step through every move.
At a mistake, "My move" and "Best" show both on the board, with the coach sentence and a button to drill that position. Games analysed before this feature get their moves filled in automatically on the next sync, or with "Load the full game" inside the viewer; the graph needs a re-analysis.

## Practice (separate from your games)

The Retry tab has two modes. **My games** drills the mistakes found in your own games, by type, in batches of 5, 10 or 20, with due reviews first.
**Puzzles** is a bundled bank of 58 themes with 117 to 120 puzzles each: basic tactics (forks, hanging pieces, skewers, double check, pins, sacrifices, discovered attacks, deflection), more tactics, all 19 named mate patterns plus mate in 1/2/3, endgame tactics, attack and phase themes, and goals.
Filter by solution length (1 to 5 of your moves) and difficulty. Puzzles never count toward your streak, drill totals or review schedule, and stay offline once a theme has been opened.

Rebuild the bank with `node scripts/build-puzzle-bank.mjs [sourceDir]`. It reads Lichess open puzzle data (CC0) already on this machine, plays the opponent's first move to get each start position, keeps solutions of 1 to 5 moves, and avoids repeated solutions (no two puzzles share a solution, and at most three share a first move).
Some themes have no 1-move puzzles because Lichess never makes them that short (skewers, sacrifices). Mate in 1/2/3 are fixed at 1/2/3 moves by definition.

## Known limits

- No accounts, sync across devices, or payments yet. The Pro tier from the plan is not built; everything is free.
- Move-by-move accuracy is a simple mean per game, not Lichess's volatility-weighted version.
- Pattern rules are heuristics, not proof. A tactic needs a forcing best move or a line that wins material; quiet mistakes go to "throwing away wins" (you were clearly better) or "positional slips".
- The 70 ms analysis setting is fast but shallow; Settings has a slower, deeper option.
- Only standard chess from the start position is analysed.
- Tested with Lichess and Chess.com accounts in Node and in the browser. Touch dragging, install-to-home-screen and offline mode are untested on a real phone.

## Licences

- Stockfish.js 19 is GPLv3. Shipping it means distributing this app under GPL-compatible terms. Decide this before any public release.
- Pieces: Colin M.L. Burnett, CC BY-SA 3.0 (copied from the ChessBotBuddies project's `public/pieces/standard`).
- chess.js: BSD-2-Clause.
