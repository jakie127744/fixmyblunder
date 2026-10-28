// Pulls public games from Lichess, Chess.com or pasted PGN into one common shape.
import { Chess } from '../vendor/chess/chess.js';

const lower = (s) => String(s || '').toLowerCase();

/** Shortest game we analyze, in half-moves (plies). The importer and the analyser both enforce this one value. */
export const MIN_PLIES = 12;

function resultFor(color, winner) {
  if (!winner) return 'draw';
  return winner === color ? 'win' : 'loss';
}

/** PGN Result tag to our result. Anything that is not 1-0, 0-1 or 1/2-1/2 (usually "*") is unfinished, not a draw. */
function resultFromPgn(color, tag) {
  if (tag === '1/2-1/2') return 'draw';
  if (tag === '1-0') return resultFor(color, 'white');
  if (tag === '0-1') return resultFor(color, 'black');
  return 'unfinished';
}

/** Lichess: one request, newline-delimited JSON, CORS enabled. */
export async function fetchLichess(username, max = 25, since) {
  const q = new URLSearchParams({ max: String(max), clocks: 'true', opening: 'false', moves: 'true', pgnInJson: 'false', tags: 'false', ongoing: 'false' });
  if (since) q.set('since', String(since));
  const res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(username)}?${q}`, { headers: { Accept: 'application/x-ndjson' } });
  if (res.status === 404) throw new Error(`No Lichess user called ${username}.`);
  if (res.status === 429) throw new Error('Lichess asked us to slow down. Try again in a minute.');
  if (!res.ok) throw new Error(`Lichess answered with an error (${res.status}).`);
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let g;
    try { g = JSON.parse(line); } catch { continue; }
    if (g.variant !== 'standard' || !g.moves) continue;
    const wName = g.players?.white?.user?.name || 'Anonymous';
    const color = lower(wName) === lower(username) ? 'white' : lower(g.players?.black?.user?.name) === lower(username) ? 'black' : null;
    if (!color) continue;
    const me = g.players[color], opp = g.players[color === 'white' ? 'black' : 'white'];
    out.push({
      id: `li:${g.id}`, source: 'lichess', url: `https://lichess.org/${g.id}`, date: g.createdAt,
      color, result: resultFor(color, g.winner), opponent: opp.user?.name || 'Anonymous',
      userRating: me.rating ?? null, oppRating: opp.rating ?? null, speed: g.speed,
      baseTime: g.clock ? g.clock.initial : null,
      moves: g.moves.split(' '),
      clocks: g.clocks ? g.clocks.map((c) => c / 100) : null, // centiseconds -> seconds, one per ply
    });
  }
  return out;
}

function parseClk(comment) {
  const m = /\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/.exec(comment || '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/**
 * Parse one PGN text. Returns { game } or { reason, label, plies? }.
 * reason: 'unreadable' (not valid PGN), 'variant' (not standard chess), 'name' (username is neither player), 'short' (under MIN_PLIES).
 */
export function readPgn(pgn, username, idHint) {
  const label = pgnLabel(pgn);
  const c = new Chess();
  try { c.loadPgn(pgn); } catch { return { reason: 'unreadable', label }; }
  const h = c.getHeaders();
  if ((h.Variant && lower(h.Variant) !== 'standard') || h.SetUp === '1' || h.FEN) return { reason: 'variant', label };
  const white = h.White || '', black = h.Black || '';
  let color = null;
  if (lower(white) === lower(username)) color = 'white';
  else if (lower(black) === lower(username)) color = 'black';
  if (!color) return { reason: 'name', label };
  const hist = c.history();
  if (hist.length < MIN_PLIES) return { reason: 'short', label, plies: hist.length };
  const comments = c.getComments();
  const byFen = new Map(comments.map((x) => [x.fen, x.comment]));
  const replay = new Chess();
  const clocks = [];
  for (const san of hist) { replay.move(san); clocks.push(parseClk(byFen.get(replay.fen()))); }
  const r = h.Result;
  const tc = /^(\d+)/.exec(h.TimeControl || '');
  const date = h.UTCDate ? Date.parse(`${h.UTCDate.replace(/\./g, '-')}T${h.UTCTime || '12:00:00'}Z`) : h.Date ? Date.parse(h.Date.replace(/\./g, '-')) : Date.now();
  const url = h.Link || h.Site || '';
  return { game: {
    id: idHint || `pgn:${h.Link || `${white}-${black}-${h.Date}-${h.UTCTime || ''}-${hist.length}`}`,
    source: /chess\.com/i.test(h.Site || '') ? 'chesscom' : 'pgn', url, date: Number.isFinite(date) ? date : Date.now(),
    color, result: resultFromPgn(color, r),
    opponent: color === 'white' ? black : white,
    userRating: +(color === 'white' ? h.WhiteElo : h.BlackElo) || null, oppRating: +(color === 'white' ? h.BlackElo : h.WhiteElo) || null,
    speed: null, baseTime: tc ? +tc[1] : null, moves: hist, clocks: clocks.some((x) => x != null) ? clocks : null,
  } };
}

/** Short name for a game in messages: "White vs Black", from the PGN tags. */
function pgnLabel(pgn) {
  const tag = (n) => (new RegExp(String.raw`\[${n} "([^"]*)"\]`).exec(pgn) || [])[1];
  const w = tag('White'), b = tag('Black');
  return w || b ? `${w || '?'} vs ${b || '?'}` : 'A game';
}

/** Same as readPgn but returns just the game, or null when it is not usable. */
export function parsePgn(pgn, username, idHint) {
  return readPgn(pgn, username, idHint).game || null;
}

export function splitPgns(text) {
  return text.split(/\n\s*\n(?=\[Event )/).map((s) => s.trim()).filter((s) => s.startsWith('['));
}

/** Chess.com: monthly archives, newest first, until we have enough. */
export async function fetchChessCom(username, max = 25) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(lower(username))}`;
  const ar = await fetch(`${base}/games/archives`);
  if (ar.status === 404) throw new Error(`No Chess.com user called ${username}.`);
  if (!ar.ok) throw new Error(`Chess.com answered with an error (${ar.status}).`);
  const { archives } = await ar.json();
  const out = [];
  out.skipped = [];           // games we saw but could not use, with the reason
  for (const url of [...archives].reverse()) {
    if (out.length >= max) break;
    const res = await fetch(url);
    if (!res.ok) continue;
    const { games } = await res.json();
    for (const g of [...games].reverse()) {
      if (g.rules !== 'chess' || !g.pgn) continue;
      const r = readPgn(g.pgn, username, `cc:${(g.url || '').split('/').pop() || g.end_time}`);
      if (!r.game) { out.skipped.push(r); continue; }
      const p = r.game;
      p.source = 'chesscom';
      p.url = g.url || p.url;
      p.date = (g.end_time || 0) * 1000 || p.date;
      p.speed = g.time_class || null;
      out.push(p);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** Reads pasted PGN text. { pasted, games, skipped:[{label, reason, plies?}] } so nothing is dropped silently. */
export function fromPgnText(text, username) {
  const parts = splitPgns(text), games = [], skipped = [];
  for (const part of parts) {
    const r = readPgn(part, username);
    if (r.game) games.push(r.game); else skipped.push(r);
  }
  return { pasted: parts.length, games, skipped };
}

/** One plain sentence per skipped game, naming the real reason. */
export function skipText(s) {
  switch (s.reason) {
    case 'short': return `${s.label} has ${s.plies} half-moves, under the ${MIN_PLIES} minimum (${MIN_PLIES / 2} moves each).`;
    case 'name': return `${s.label}: your name is not White or Black in this game.`;
    case 'variant': return `${s.label} is not a standard game from the starting position.`;
    default: return `${s.label} could not be read as a PGN game.`;
  }
}
