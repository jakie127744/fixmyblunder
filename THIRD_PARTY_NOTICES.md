# Third-party notices

Blunderprint bundles the following. Keep this file and the licence texts alongside any copy of the app you give to other people.

| Component | Where | Licence | What it requires |
|---|---|---|---|
| Stockfish.js 19 (Chess.com, LLC; based on Stockfish by T. Romstad, M. Costalba, J. Kiiski, G. Linscott and contributors) | `public/vendor/stockfish/` | GNU GPL v3 | Licence text and notices stay with it. If you distribute the app, you must also offer the corresponding source of Stockfish.js and be able to license the parts that form one work with it under the GPL. Full text: `public/vendor/stockfish/COPYING.txt`. Source: https://github.com/nmrugg/stockfish.js and https://github.com/official-stockfish/Stockfish |
| chess.js 1.4.0 (Jeff Hlywa) | `public/vendor/chess/chess.js` | BSD 2-Clause | Keep the copyright notice and disclaimer (it is in the file header). |
| Chess piece images (Colin M. L. Burnett, "Cburnett" set from Wikimedia Commons) | `public/img/pieces/` | CC BY-SA 3.0 (also offered under GPL, GFDL and BSD by the author; check the Commons page for the exact terms) | Credit the author and link the licence. Changes to the images must be shared under the same licence. |
| Lichess open puzzle database | `public/data/puzzles/` | CC0 (public domain) | None. Credit is appreciated: https://database.lichess.org |
| Bricolage Grotesque, Figtree, JetBrains Mono | loaded from Google Fonts | SIL Open Font License 1.1 | None for loading them from Google. Loading them sends visitors' IP addresses to Google. |

## Online services the app calls

- Lichess API (`lichess.org/api`): public game export. Follow Lichess's API terms and rate limits.
- Chess.com Published-Data API (`api.chess.com/pub`): public archives. Check Chess.com's terms before commercial use.

## chess.js licence text

Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com). All rights reserved.
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the copyright notice, this list of conditions and the following disclaimer are kept. THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. The full text is in the file header of `public/vendor/chess/chess.js`.
