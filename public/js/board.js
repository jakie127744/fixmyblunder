// Touch-first board: tap a piece then a square, or drag. Legal moves come from chess.js.
import { Chess } from '../vendor/chess/chess.js';

const FILES = 'abcdefgh';

export class Board {
  /** opts: { fen, orientation:'w'|'b', onMove(uci, san), canMove:boolean } */
  constructor(el, opts) {
    this.el = el;
    this.chess = new Chess(opts.fen);
    this.orient = opts.orientation || 'w';
    this.onMove = opts.onMove || (() => {});
    this.enabled = opts.canMove !== false;
    this.sel = null;
    this.marks = {};       // square -> css class (hint, good, bad, last-from, last-to)
    this.drag = null;
    el.classList.add('board');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Chess board');
    // A hidden description: how to play with a keyboard or screen reader, and where every piece stands.
    this.desc = document.createElement('p');
    this.desc.className = 'sr'; this.desc.id = 'boardDesc';
    document.querySelectorAll('#boardDesc').forEach((x) => x.remove());
    el.before(this.desc);
    el.setAttribute('aria-describedby', 'boardDesc');
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('keydown', (e) => this._key(e));
    this.render();
  }

  say(msg) { const el = document.getElementById('sr'); if (el && msg) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 60); } }

  describe() {
    const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    const out = { w: [], b: [] };
    for (const row of this.chess.board()) for (const c of row) if (c) out[c.color].push(`${names[c.type]} ${c.square}`);
    const how = this.enabled ? 'Arrow keys move between squares. Enter picks up a piece, then Enter on a highlighted square to move it. Escape cancels. ' : '';
    return `${how}${this.chess.turn() === 'w' ? 'White' : 'Black'} to move. White: ${out.w.join(', ')}. Black: ${out.b.join(', ')}.`;
  }

  setPosition(fen, orientation) {
    this.chess = new Chess(fen);
    if (orientation) this.orient = orientation;
    this.sel = null; this.marks = {};
    this.render();
  }
  setEnabled(v) { this.enabled = v; if (!v) this.sel = null; this.render(); }
  mark(sq, cls) { this.marks[sq] = cls; this.render(); }
  clearMarks() { this.marks = {}; this.render(); }
  fen() { return this.chess.fen(); }

  /** Play a move on the board (used to show the answer or the engine line). */
  play(uci) {
    const m = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    this.marks = { [m.from]: 'last', [m.to]: 'last' };
    this.sel = null; this.render();
    return m;
  }

  squares() {
    const files = this.orient === 'w' ? [...FILES] : [...FILES].reverse();
    const ranks = this.orient === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const out = [];
    ranks.forEach((r, ri) => files.forEach((f, fi) => out.push({ sq: f + r, ri, fi, dark: (FILES.indexOf(f) + r) % 2 === 0, file: f, rank: r })));
    return out;
  }

  legalFrom(sq) { return this.chess.moves({ square: sq, verbose: true }); }

  render() {
    const turn = this.chess.turn();
    const targets = this.sel ? new Map(this.legalFrom(this.sel).map((m) => [m.to, m])) : new Map();
    const inCheckSq = this.chess.isCheck() ? this._kingSq(turn) : null;
    let h = '';
    for (const q of this.squares()) {
      const p = this.chess.get(q.sq);
      const cls = ['sq', q.dark ? 'd' : 'l'];
      if (this.sel === q.sq) cls.push('sel');
      if (targets.has(q.sq)) cls.push(p ? 'cap' : 'dot');
      if (this.marks[q.sq]) cls.push('m-' + this.marks[q.sq]);
      if (inCheckSq === q.sq) cls.push('chk');
        const say = { hint: 'hint', good: 'correct move', bad: 'wrong move', last: 'last move' }[this.marks[q.sq]];
      const label = `${q.sq}${p ? ' ' + (p.color === 'w' ? 'white ' : 'black ') + { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[p.type] : ', empty'}${this.sel === q.sq ? ', selected' : ''}${targets.has(q.sq) ? (p ? ', capture' : ', legal move') : ''}${say ? ', ' + say : ''}${inCheckSq === q.sq ? ', in check' : ''}`;
      const coord = (q.ri === 7 ? `<i class="cf">${q.file}</i>` : '') + (q.fi === 0 ? `<i class="cr">${q.rank}</i>` : '');
      h += `<button class="${cls.join(' ')}" data-sq="${q.sq}" aria-label="${label}" tabindex="${q.sq === (this.sel || 'e4') ? 0 : -1}">${coord}${p ? `<img class="pc" alt="" draggable="false" src="img/pieces/${p.color}${p.type}.svg">` : ''}</button>`;
    }
    this.el.innerHTML = h;
    this.desc.textContent = this.describe();
  }

  _selMsg(sq) {
    const p = this.chess.get(sq), n = this.legalFrom(sq).length;
    return `Picked up ${p.color === 'w' ? 'white' : 'black'} ${{ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[p.type]} on ${sq}. ${n ? n + (n === 1 ? ' legal move.' : ' legal moves.') : 'No legal moves.'}`;
  }

  _kingSq(color) {
    for (const row of this.chess.board()) for (const c of row) if (c && c.type === 'k' && c.color === color) return c.square;
    return null;
  }

  _sqAt(x, y) {
    const t = document.elementFromPoint(x, y);
    const b = t && t.closest ? t.closest('.sq') : null;
    return b && this.el.contains(b) ? b.dataset.sq : null;
  }

  _down(e) {
    if (!this.enabled) return;
    const b = e.target.closest('.sq');
    if (!b) return;
    const sq = b.dataset.sq;
    const p = this.chess.get(sq);
    const own = p && p.color === this.chess.turn();
    if (this.sel && this.sel !== sq && this.legalFrom(this.sel).some((m) => m.to === sq)) { this._try(this.sel, sq); return; }
    if (own) {
      this.sel = sq; this.render(); this.say(this._selMsg(sq));
      const img = this.el.querySelector(`[data-sq="${sq}"] .pc`);
      if (img && e.pointerType !== 'mouse' ? true : img) this._startDrag(e, img, sq);
    } else if (this.sel) { this.sel = null; this.render(); }
  }

  _startDrag(e, img, from) {
    const r = this.el.getBoundingClientRect();
    const size = r.width / 8;
    const ghost = img.cloneNode();
    ghost.className = 'pc ghost';
    ghost.style.width = size + 'px'; ghost.style.height = size + 'px';
    document.body.appendChild(ghost);
    let moved = false;
    const place = (ev) => { ghost.style.transform = `translate(${ev.clientX - size / 2}px, ${ev.clientY - size * 0.7}px)`; };
    img.style.opacity = '0.3';
    const move = (ev) => { moved = true; place(ev); };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      ghost.remove();
      img.style.opacity = '';
      if (!moved) return;
      const to = this._sqAt(ev.clientX, ev.clientY);
      if (to && to !== from) this._try(from, to);
    };
    place(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  _try(from, to) {
    const legal = this.legalFrom(from).find((m) => m.to === to);
    if (!legal) { this.sel = null; this.render(); return; }
    const uci = from + to + (legal.promotion ? 'q' : '');
    this.sel = null;
    this.say(`You played ${legal.san}.`);
    this.onMove(uci, legal.san, legal);
  }

  _key(e) {
    if (!this.enabled) return;
    const b = e.target.closest('.sq');
    if (!b) return;
    const sq = b.dataset.sq;
    const f = FILES.indexOf(sq[0]), r = +sq[1];
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (d) {
      const nf = f + (this.orient === 'w' ? d[0] : -d[0]), nr = r + (this.orient === 'w' ? d[1] : -d[1]);
      if (nf >= 0 && nf < 8 && nr >= 1 && nr <= 8) { const n = this.el.querySelector(`[data-sq="${FILES[nf]}${nr}"]`); n.tabIndex = 0; n.focus(); }
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const p = this.chess.get(sq);
      if (this.sel && this.legalFrom(this.sel).some((m) => m.to === sq)) this._try(this.sel, sq);
      else if (p && p.color === this.chess.turn()) { this.sel = sq; this.render(); this.el.querySelector(`[data-sq="${sq}"]`).focus(); this.say(this._selMsg(sq)); }
      else if (this.sel) { this.sel = null; this.render(); this.el.querySelector(`[data-sq="${sq}"]`).focus(); }
    } else if (e.key === 'Escape') { this.sel = null; this.render(); }
  }
}
