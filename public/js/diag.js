// On-device error log. Nothing here leaves the phone unless the user chooses to send a report.
import { APP_VERSION, FEEDBACK_EMAIL } from './config.js';

const KEY = 'blunderprint.errors';
const MAX = 20;
let cache = null;

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
export const getErrors = () => (cache ||= read());
const write = () => { try { localStorage.setItem(KEY, JSON.stringify(getErrors())); } catch { /* storage blocked or full */ } };
export function clearErrors() { cache = []; write(); }

/** Keeps the message and a short stack. Never records usernames, games or positions. */
export function logError(where, err) {
  const e = err instanceof Error ? err : new Error(String(err && err.message ? err.message : err));
  const list = getErrors();
  const msg = String(e.message || e).slice(0, 300);
  const last = list[list.length - 1];
  if (last && last.where === where && last.msg === msg) { last.n = (last.n || 1) + 1; last.t = Date.now(); }
  else list.push({ t: Date.now(), where, msg, stack: String(e.stack || '').split('\n').slice(0, 5).join('\n').slice(0, 600) });
  while (list.length > MAX) list.shift();
  write();
  return e;
}

/** Catches anything nobody else did. onFirst runs once per page load so the app can tell the user. */
export function watchGlobalErrors(onFirst) {
  let told = false;
  const handle = (where, err) => { logError(where, err); if (!told) { told = true; if (onFirst) onFirst(); } };
  window.addEventListener('error', (e) => { if (e.error || e.message) handle('window', e.error || new Error(e.message)); });
  window.addEventListener('unhandledrejection', (e) => handle('promise', e.reason));
}

/** Plain-text report the user can read before sending. */
export function buildReport(note = '', { includeDetails = true, gameCount = 0 } = {}) {
  const lines = [];
  if (note.trim()) lines.push(note.trim(), '');
  if (includeDetails) {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    lines.push('--- details (no username, games or positions) ---',
      `Blunderprint ${APP_VERSION}`,
      `Browser: ${nav.userAgent || 'unknown'}`,
      `Installed: ${typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'}, online: ${nav.onLine}`,
      `Games analysed: ${gameCount}`);
    const errs = getErrors();
    lines.push(errs.length ? `Recent errors (${errs.length}):` : 'Recent errors: none');
    for (const e of errs.slice(-8)) lines.push(`[${new Date(e.t).toISOString()}] ${e.where}${e.n > 1 ? ` x${e.n}` : ''}: ${e.msg}${e.stack ? '\n' + e.stack : ''}`);
  }
  return lines.join('\n');
}

export function mailtoLink(subject, body) {
  // Mail apps cut off very long links, so keep the body short.
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
}
