// Engines you can play against. Both speak UCI over a Web Worker; there are no clocks, so
// strength comes from the level (think time for Buddy, a rating cap for Stockfish).
import { workerTransport } from './engine.js';

const STALL_MS = 30000;

export const OPPONENTS = {
  buddy: {
    name: 'Buddy Trainer',
    blurb: 'The engine behind your Lichess bot, running on one core in your browser.',
    url: 'vendor/buddy/buddy-worker.js',
    levels: [
      { id: 'quick', label: 'Quick', note: '0.2 s a move', ms: 200 },
      { id: 'standard', label: 'Standard', note: '1 s a move', ms: 1000 },
      { id: 'deep', label: 'Deep', note: '3 s a move', ms: 3000 },
    ],
    defaultLevel: 'standard',
  },
  stockfish: {
    name: 'Stockfish',
    blurb: 'Stockfish 19, limited to the rating you pick.',
    url: 'vendor/stockfish/stockfish-19-lite-single.js',
    levels: [
      { id: '1400', label: '1400', note: 'Rating 1400', elo: 1400, ms: 300 },
      { id: '1700', label: '1700', note: 'Rating 1700', elo: 1700, ms: 400 },
      { id: '2000', label: '2000', note: 'Rating 2000', elo: 2000, ms: 500 },
      { id: '2300', label: '2300', note: 'Rating 2300', elo: 2300, ms: 700 },
      { id: 'max', label: 'Full strength', note: 'No limit', elo: 0, ms: 1500 },
    ],
    defaultLevel: '1700',
  },
};

export const levelOf = (kind, id) => {
  const o = OPPONENTS[kind];
  return o.levels.find((l) => l.id === id) || o.levels.find((l) => l.id === o.defaultLevel);
};

export class PlayEngine {
  constructor(kind) {
    this.kind = kind;
    this.t = workerTransport(OPPONENTS[kind].url);
    this.wait = null;
    this.info = null;
    this.ready = null;
    this.t.onLine((l) => this._line(l));
    this.t.onError((err) => this._fail(err));
  }

  _fail(err) {
    this.failed = err instanceof Error ? err : new Error(String(err));
    const w = this.wait; this.wait = null;
    if (w) { clearTimeout(w.timer); w.rej(this.failed); }
    if (this.onFail) this.onFail(this.failed);
  }

  _line(l) {
    if (l.startsWith('info') && / score /.test(l) && / pv /.test(l)) {
      const s = /score (cp|mate) (-?\d+)/.exec(l), d = /depth (\d+)/.exec(l);
      if (s) this.info = { kind: s[1], val: +s[2], depth: d ? +d[1] : 0 };
    }
    if (this.wait && this.wait.pred(l)) {
      const w = this.wait; this.wait = null; clearTimeout(w.timer); w.res(l);
    }
  }

  _until(pred, ms = STALL_MS) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => this._fail(new Error('The engine stopped answering.')), ms);
      this.wait = { pred, res, rej, timer };
    });
  }

  init() {
    if (this.failed) return Promise.reject(this.failed);
    if (!this.ready) {
      this.ready = (async () => {
        const ok = this._until((l) => l === 'uciok', 60000);
        this.t.post('uci');
        await ok;
        this.t.post('setoption name Hash value 32');
        this.t.post('setoption name Threads value 1');
        if (this.kind === 'buddy') {
          // The same options the Lichess bot ran, plus the opening book for variety.
          this.t.post('setoption name UseNNUE value false');
          this.t.post('setoption name singular_ext value false');
          this.t.post('setoption name Move Overhead value 20');
          this.t.post('setoption name OwnBook value true');
        }
        const r = this._until((l) => l === 'readyok');
        this.t.post('isready');
        await r;
      })();
      this.ready.catch(() => {});
    }
    return this.ready;
  }

  async newGame(level) {
    await this.init();
    if (this.kind === 'stockfish') {
      const lv = levelOf('stockfish', level);
      this.t.post(`setoption name UCI_LimitStrength value ${lv.elo ? 'true' : 'false'}`);
      if (lv.elo) this.t.post(`setoption name UCI_Elo value ${lv.elo}`);
    }
    this.t.post('ucinewgame');
    const r = this._until((l) => l === 'readyok');
    this.t.post('isready');
    await r;
  }

  /** Best reply after the given UCI moves from the start position. Resolves { uci, cp, mate } or uci:null. */
  async bestMove(ucis, level) {
    await this.init();
    const lv = levelOf(this.kind, level);
    this.info = null;
    const done = this._until((l) => l.startsWith('bestmove'));
    this.t.post('position startpos' + (ucis.length ? ' moves ' + ucis.join(' ') : ''));
    this.t.post(`go movetime ${lv.ms}`);
    const line = await done;
    const m = line.split(/\s+/)[1];
    const i = this.info;
    return {
      uci: !m || m === '(none)' ? null : m,
      cp: i && i.kind === 'cp' ? i.val : null,
      mate: i && i.kind === 'mate' ? i.val : null,
      depth: i ? i.depth : 0,
    };
  }

  close() { try { this.t.terminate(); } catch { /* already gone */ } }
}
