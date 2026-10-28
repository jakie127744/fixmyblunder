// Practice puzzles from a bundled bank (Lichess open puzzle data, CC0), built by scripts/build-puzzle-bank.mjs.
// Kept apart from drills built from your own games. Works offline once a theme has been opened.

/** Themes grouped the way a player thinks about them. [id, label]. ids match files in data/puzzles. */
export const THEME_GROUPS = [
  { name: 'Basic tactics', themes: [['fork', 'Forks'], ['hangingPiece', 'Hanging pieces'], ['skewer', 'Skewers'], ['doubleCheck', 'Double check'], ['pin', 'Pins'], ['sacrifice', 'Sacrifices'], ['discoveredAttack', 'Discovered attacks'], ['deflection', 'Deflection']] },
  { name: 'More tactics', themes: [['discoveredCheck', 'Discovered check'], ['attraction', 'Attraction'], ['xRayAttack', 'X-ray'], ['trappedPiece', 'Trapped piece'], ['interference', 'Interference'], ['clearance', 'Clearance'], ['intermezzo', 'In-between move'], ['capturingDefender', 'Remove the defender'], ['zugzwang', 'Zugzwang'], ['quietMove', 'Quiet moves'], ['defensiveMove', 'Defence']] },
  { name: 'Checkmates', themes: [['mateIn1', 'Mate in 1'], ['mateIn2', 'Mate in 2'], ['mateIn3', 'Mate in 3'], ['backRankMate', 'Back rank mate'], ['smotheredMate', 'Smothered mate']] },
  { name: 'Mate patterns', themes: [['anastasiaMate', 'Anastasia’s'], ['arabianMate', 'Arabian'], ['balestraMate', 'Balestra'], ['blindSwineMate', 'Blind swine'], ['bodenMate', 'Boden’s'], ['cornerMate', 'Corner'], ['doubleBishopMate', 'Double bishop'], ['dovetailMate', 'Dovetail'], ['epauletteMate', 'Epaulette'], ['hookMate', 'Hook'], ['killBoxMate', 'Kill box'], ['morphysMate', 'Morphy’s'], ['operaMate', 'Opera'], ['pillsburysMate', 'Pillsbury’s'], ['swallowstailMate', 'Swallow’s tail'], ['triangleMate', 'Triangle'], ['vukovicMate', 'Vuković']] },
  { name: 'Endgame tactics', themes: [['endgame', 'All endgames'], ['pawnEndgame', 'Pawn endings'], ['rookEndgame', 'Rook endings'], ['queenEndgame', 'Queen endings'], ['minorEndgame', 'Bishop and knight'], ['queenRookEndgame', 'Queen and rook'], ['advancedPawn', 'Promotion']] },
  { name: 'Attack and phase', themes: [['kingsideAttack', 'Kingside attack'], ['queensideAttack', 'Queenside attack'], ['attackingF2F7', 'Attack on f2 / f7'], ['exposedKing', 'Exposed king'], ['opening', 'Opening'], ['middlegame', 'Middlegame']] },
  { name: 'Goals', themes: [['advantage', 'Win material'], ['crushing', 'Crushing wins'], ['equality', 'Save the game']] },
];
export const MIXED = ['mix', 'Mixed'];
const ALL = [MIXED, ...THEME_GROUPS.flatMap((g) => g.themes)];
export const themeName = (id) => (ALL.find((t) => t[0] === id) || MIXED)[1];

export const DIFFICULTY = [['any', 'Any'], ['easier', 'Easier'], ['normal', 'Normal'], ['harder', 'Harder']];
export const MOVE_COUNTS = [['any', 'Any'], [1, '1 move'], [2, '2 moves'], [3, '3 moves'], [4, '4 moves'], [5, '5 moves']];

/** A starting theme for each of your mistake types, so practice can target a weak spot. */
export const PATTERN_THEME = { hanging: 'hangingPiece', tactic: 'fork', advantage: 'advantage', endgame: 'endgame', king: 'backRankMate', positional: 'quietMove', time: 'mix' };

const band = (r) => (r < 1300 ? 'easier' : r < 1800 ? 'normal' : 'harder');
const cache = new Map();
let indexPromise = null;

/** Counts per theme: { fork: { n, len:{1..5}, rating:{easier,normal,harder} } }. Null if it cannot load. */
export function loadIndex() {
  if (!indexPromise) indexPromise = fetch('data/puzzles/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return indexPromise;
}

let dlPromise = null;

/** Fetches every theme so puzzles work offline. The service worker keeps the files and serves repeats from its cache, so calling this each session is cheap. onProgress(done, total). */
export function downloadAll(onProgress = () => {}) {
  if (dlPromise) return dlPromise;
  dlPromise = (async () => {
    const idx = await loadIndex();
    if (!idx) throw new Error('Could not reach the puzzle files.');
    const ids = Object.keys(idx);
    let done = 0, next = 0;
    onProgress(0, ids.length);
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const res = await fetch(`data/puzzles/${encodeURIComponent(id)}.json`);
        if (!res.ok) throw new Error('A puzzle set failed to download.');
        await res.arrayBuffer();
        onProgress(++done, ids.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  })().catch((e) => { dlPromise = null; throw e; });
  return dlPromise;
}

async function loadTheme(id) {
  if (cache.has(id)) return cache.get(id);
  const res = await fetch(`data/puzzles/${encodeURIComponent(id)}.json`);
  if (!res.ok) throw new Error('Could not load that puzzle set. Check your connection once, then it works offline.');
  const list = (await res.json()).map((p) => {
    const solution = p.s.split(' ');
    return { id: p.i, rating: p.r, fen: p.f, side: p.f.split(' ')[1], solution, moves: Math.ceil(solution.length / 2) };
  });
  cache.set(id, list);
  return list;
}

/** How many puzzles match the filters. */
export async function countMatching(theme, { moves = 'any', difficulty = 'any' } = {}) {
  const list = await loadTheme(theme);
  return list.filter((p) => (moves === 'any' || p.moves === +moves) && (difficulty === 'any' || band(p.rating) === difficulty)).length;
}

/**
 * Pick a random puzzle that matches the filters and has not been seen. `seen` is a Set of ids.
 * When every match has been seen it starts over and says so.
 */
export async function nextPuzzle(theme, { moves = 'any', difficulty = 'any' } = {}, seen = new Set()) {
  const list = await loadTheme(theme);
  const match = list.filter((p) => (moves === 'any' || p.moves === +moves) && (difficulty === 'any' || band(p.rating) === difficulty));
  if (!match.length) throw new Error('No puzzles match that combination. Try another number of moves or difficulty.');
  let fresh = match.filter((p) => !seen.has(p.id));
  let wrapped = false;
  if (!fresh.length) { fresh = match; wrapped = true; match.forEach((p) => seen.delete(p.id)); }
  const p = fresh[Math.floor(Math.random() * fresh.length)];
  return { ...p, wrapped, pool: match.length };
}
