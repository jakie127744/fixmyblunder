// UCI wrapper. Works over any transport {post(cmd), onLine(cb)} so it runs in a
// Web Worker in the browser and over a child process in the Node tests.
import { clamp } from './score.js';

const STALL_MS = 20000;   // one position never takes this long; if it does, the worker is stuck

export class Engine {
  constructor(transport) {
    this.t = transport;
    this.queue = Promise.resolve();
    this.cur = null;
    this.ready = null;
    this.t.onLine((l) => this._line(l));
    if (this.t.onError) this.t.onError((err) => this._fail(err));
  }

  /** The worker crashed or never started. Reject whatever is waiting so analysis stops instead of hanging. */
  _fail(err) {
    this.failed = err instanceof Error ? err : new Error(String(err));
    const cur = this.cur; this.cur = null;
    if (cur) { clearTimeout(cur.timer); cur.rej(this.failed); }
    if (this._readyRej) this._readyRej(this.failed);
    this._readyRej = null;
    if (this.onFail) this.onFail(this.failed);
  }

  init() {
    if (!this.ready) {
      this.ready = new Promise((res, rej) => { this._readyRes = res; this._readyRej = rej; });
      this.t.post('uci');
    }
    return this.ready;
  }

  _line(l) {
    if (l === 'uciok') {
      this.t.post('setoption name Threads value 1');
      this.t.post('setoption name Hash value 32');
      this.t.post('isready');
    } else if (l === 'readyok') {
      if (this._readyRes) this._readyRes();
      this._readyRes = null; this._readyRej = null;
    } else if (this.cur) {
      if (l.startsWith('info') && / score /.test(l) && / pv /.test(l)) {
        if (/ multipv (\d+)/.test(l) && RegExp.$1 !== '1') return;
        const s = /score (cp|mate) (-?\d+)/.exec(l);
        const d = /depth (\d+)/.exec(l);
        this.cur.info = {
          kind: s[1], val: +s[2], depth: d ? +d[1] : 0,
          pv: l.slice(l.indexOf(' pv ') + 4).trim().split(/\s+/),
        };
      } else if (l.startsWith('bestmove')) {
        const info = this.cur.info;
        const best = l.split(/\s+/)[1];
        const res = this.cur.res;
        clearTimeout(this.cur.timer);
        this.cur = null;
        if (!info) { res({ cp: 0, cpc: 0, mate: null, best: best === '(none)' ? null : best, pv: [], depth: 0 }); return; }
        const mate = info.kind === 'mate' ? info.val : null;
        const cp = info.kind === 'cp' ? info.val : (info.val > 0 ? 10000 : -10000);
        res({
          cp, mate, cpc: mate != null ? (mate > 0 ? 1000 : -1000) : clamp(cp, -1000, 1000),
          best: best === '(none)' ? null : best, pv: info.pv, depth: info.depth,
        });
      }
    }
  }

  /** Evaluate from the side to move's point of view. */
  evaluate(fen, opts = {}) {
    const run = async () => {
      if (this.failed) throw this.failed;
      await this.init();
      return new Promise((res, rej) => {
        const timer = setTimeout(() => this._fail(new Error('The engine stopped answering.')), STALL_MS);
        this.cur = { res, rej, timer, info: null };
        this.t.post('position fen ' + fen);
        this.t.post(opts.depth ? `go depth ${opts.depth}` : `go movetime ${opts.movetime || 80}`);
      });
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  newGame() { this.t.post('ucinewgame'); }
  stop() { this.t.post('stop'); }
}

export function workerTransport(url) {
  const w = new Worker(url);
  const cbs = [], errs = [];
  w.onmessage = (e) => { if (typeof e.data === 'string') cbs.forEach((f) => f(e.data)); };
  w.onerror = (e) => errs.forEach((f) => f(new Error(e.message || 'The engine failed to load.')));
  w.onmessageerror = () => errs.forEach((f) => f(new Error('The engine sent an unreadable message.')));
  return { post: (c) => w.postMessage(c), onLine: (f) => cbs.push(f), onError: (f) => errs.push(f), terminate: () => w.terminate() };
}
