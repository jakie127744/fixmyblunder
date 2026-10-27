// Local-first storage. Everything lives in this browser; there is no account.
const KEY = 'blunderprint.v1';

const blank = () => ({
  v: 1,
  profile: null,               // { source, username, createdAt }
  settings: { setSize: 5, engineMs: 70, gamesToImport: 25, theme: 'system', reminderTime: '' },
  games: {},                   // id -> analysed game record (mistakes included)
  drills: {},                  // id -> drill (mistake + schedule)
  attempts: [],                // { t, id, ok, ms }
  today: null,                 // { date, ids }
  lastSync: null,
});

let mem = null;
let timer = null;
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { ...blank(), ...s, settings: { ...blank().settings, ...(s.settings || {}) } };
    }
  } catch { /* storage blocked or corrupt */ }
  return blank();
}

export const state = () => (mem ||= load());

export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state())); } catch { /* quota or blocked */ }
  }, 150);
  listeners.forEach((f) => f());
}

export const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

export function exportJson() { return JSON.stringify(state(), null, 1); }

export function importJson(text) {
  const s = JSON.parse(text);
  if (!s || s.v !== 1 || typeof s.games !== 'object') throw new Error('That file is not a Blunderprint backup.');
  mem = { ...blank(), ...s, settings: { ...blank().settings, ...(s.settings || {}) } };
  save();
}

export function reset() { mem = blank(); try { localStorage.removeItem(KEY); } catch { /* ignore */ } listeners.forEach((f) => f()); }
