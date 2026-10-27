// Pulls public games from Lichess, Chess.com or pasted PGN into one common shape.
import { Chess } from '../vendor/chess/chess.js';

const lower = (s) => String(s || '').toLowerCase();

function resultFor(color, winner) {
  if (!winner) return 'draw';
  return winner === color ? 'win' : 'loss';
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

/** Parse one PGN text into the common shape. Returns null if it is not usable standard chess. */
export function parsePgn(pgn, username, idHint) {
  const c = new Chess();
  try { c.loadPgn(pgn); } catch { return null; }
  const h = c.getHeaders();
  if (h.Variant && lower(h.Variant) !== 'standard') return null;
  if (h.SetUp === '1' || h.FEN) return null;
  const white = h.White || '', black = h.Black || '';
  let color = null;
  if (lower(white) === lower(username)) color = 'white';
  else if (lower(black) === lower(username)) color = 'black';
  if (!color) return null;
  const hist = c.history();
  if (hist.length < 12) return null;
  const comments = c.getComments();
  const byFen = new Map(comments.map((x) => [x.fen, x.comment]));
  const replay = new Chess();
  const clocks = [];
  for (const san of hist) { replay.move(san); clocks.push(parseClk(byFen.get(replay.fen()))); }
  const r = h.Result;
  const winner = r === '1-0' ? 'white' : r === '0-1' ? 'black' : null;
  const tc = /^(\d+)/.exec(h.TimeControl || '');
  const date = h.UTCDate ? Date.parse(`${h.UTCDate.replace(/\./g, '-')}T${h.UTCTime || '12:00:00'}Z`) : h.Date ? Date.parse(h.Date.replace(/\./g, '-')) : Date.now();
  const url = h.Link || h.Site || '';
  return {
    id: idHint || `pgn:${h.Link || `${white}-${black}-${h.Date}-${h.UTCTime || ''}-${hist.length}`}`,
    source: /chess\.com/i.test(h.Site || '') ? 'chesscom' : 'pgn', url, date: Number.isFinite(date) ? date : Date.now(),
    color, result: r === '1/2-1/2' ? 'draw' : resultFor(color, winner),
    opponent: color === 'white' ? black : white,
    userRating: +(color === 'white' ? h.WhiteElo : h.BlackElo) || null, oppRating: +(color === 'white' ? h.BlackElo : h.WhiteElo) || null,
    speed: null, baseTime: tc ? +tc[1] : null, moves: hist, clocks: clocks.some((x) => x != null) ? clocks : null,
  };
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
  for (const url of [...archives].reverse()) {
    if (out.length >= max) break;
    const res = await fetch(url);
    if (!res.ok) continue;
    const { games } = await res.json();
    for (const g of [...games].reverse()) {
      if (g.rules !== 'chess' || !g.pgn) continue;
      const p = parsePgn(g.pgn, username, `cc:${(g.url || '').split('/').pop() || g.end_time}`);
      if (!p) continue;
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

export function fromPgnText(text, username) {
  return splitPgns(text).map((p) => parsePgn(p, username)).filter(Boolean);
}
