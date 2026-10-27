// Win-probability and accuracy maths (Lichess published formulas).
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Centipawns (side to move) -> win percentage 0..100. */
export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -1000, 1000))) - 1);

/** Per-move accuracy from the win-percentage drop (percentage points). */
export const moveAccuracy = (wpLoss) => clamp(103.1668 * Math.exp(-0.04354 * wpLoss) - 3.1669, 0, 100);

export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
export const round1 = (v) => Math.round(v * 10) / 10;
