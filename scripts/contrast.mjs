// WCAG contrast check for the colour tokens in public/css/app.css. Run: node scripts/contrast.mjs
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
const block = (re) => { const m = re.exec(css); const o = {}; for (const x of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) o[x[1]] = x[2]; return o; };
const light = block(/:root\{([^}]*)\}/);
const dark = { ...light, ...block(/:root\[data-theme="dark"\]\{([^}]*)\}/) };
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// [foreground, background, minimum]: 4.5 for text, 3 for large text and UI shapes
const pairs = [['ink', 'bg', 4.5], ['ink', 'surface', 4.5], ['ink-2', 'bg', 4.5], ['ink-2', 'surface', 4.5], ['ink-2', 'surface-2', 4.5], ['ink-3', 'bg', 4.5], ['ink-3', 'surface', 4.5], ['ink-3', 'surface-2', 4.5],
  ['accent', 'bg', 4.5], ['accent', 'surface', 4.5], ['accent', 'accent-soft', 4.5], ['accent-ink', 'accent', 4.5], ['amber', 'amber-soft', 4.5], ['amber', 'surface', 4.5], ['bad', 'bad-soft', 4.5], ['bad', 'surface', 4.5], ['good', 'good-soft', 4.5],
  ['ink', 'amber-soft', 4.5], ['ink', 'good-soft', 4.5], ['ink', 'bad-soft', 4.5], ['ink-2', 'amber-soft', 4.5], ['ink-3', 'accent-soft', 4.5], ['accent-ink', 'amber', 4.5], ['line', 'bg', 1.2]];
let bad = 0;
for (const [name, t] of [['light', light], ['dark', dark]]) for (const [f, b, min] of pairs) {
  const r = ratio(t[f], t[b]);
  if (r < min) { bad++; console.log(`FAIL ${name}: ${f} ${t[f]} on ${b} ${t[b]} = ${r.toFixed(2)} (need ${min})`); }
}
console.log(bad ? `${bad} failing pairs` : 'all pairs pass');
process.exit(bad ? 1 : 0);
