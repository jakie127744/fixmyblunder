export const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (ts = Date.now()) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const parseDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
export const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };
export const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Monday 00:00 local of the week containing ts. */
export const weekStart = (ts) => { const d = new Date(startOfDay(ts)); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getTime(); };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const fmtDay = (ts) => { const d = new Date(ts); return `${d.getDate()} ${MON[d.getMonth()]}`; };
export const fmtRange = (a, b) => { const x = new Date(a), y = new Date(b); return x.getMonth() === y.getMonth() ? `${x.getDate()} to ${y.getDate()} ${MON[y.getMonth()]}` : `${fmtDay(a)} to ${fmtDay(b)}`; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + 's'}`;
