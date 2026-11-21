/**
 * Largest-remainder rounding. Pure module: shared by the browser and the Worker.
 *
 * Splits an integer `target` across `items` in proportion to their `value`s and
 * returns whole numbers that sum to exactly `target`.
 */

export interface RoundingItem {
  key: string;
  value: number;
}

// Shares closer than this to an integer are treated as that integer, so float
// error (0.1 + 0.2 style) can never flip a floor or a remainder comparison.
export const EPS = 1e-9;
export const FRAC_SCALE = 1e9;

function byKeyAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function largestRemainder(items: RoundingItem[], target: number): Record<string, number> {
  if (!Number.isInteger(target) || target < 0) {
    throw new RangeError(`largestRemainder: target must be a non-negative integer, got ${target}`);
  }
  const seen = new Set<string>();
  for (const it of items) {
    if (!Number.isFinite(it.value) || it.value < 0) {
      throw new RangeError(`largestRemainder: value for "${it.key}" must be a finite number >= 0, got ${it.value}`);
    }
    if (seen.has(it.key)) {
      throw new RangeError(`largestRemainder: duplicate key "${it.key}"`);
    }
    seen.add(it.key);
  }
  if (items.length === 0) {
    if (target === 0) return {};
    throw new RangeError('largestRemainder: cannot distribute a positive target over no items');
  }

  const rawSum = items.reduce((s, it) => s + it.value, 0);
  // All zero: split evenly, i.e. treat every item as an equal share.
  const weights = rawSum > 0 ? items.map((it) => it.value) : items.map(() => 1);
  const weightSum = rawSum > 0 ? rawSum : items.length;

  const rows = items.map((it, i) => {
    const share = (weights[i]! * target) / weightSum;
    const floor = Math.floor(share + EPS);
    // Quantized to integers so the comparator below is a strict weak order.
    const frac = Math.max(0, Math.round((share - floor) * FRAC_SCALE));
    return { key: it.key, value: weights[i]!, floor, frac };
  });

  // Order in which the leftover units are handed out.
  rows.sort((a, b) => b.frac - a.frac || b.value - a.value || byKeyAsc(a.key, b.key));

  let remainder = target - rows.reduce((s, r) => s + r.floor, 0);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = r.floor;

  // Mathematically 0 <= remainder < items.length; the loops also stay correct
  // (and total-preserving) if float snapping ever pushed it outside that range.
  for (let i = 0; remainder > 0; i = (i + 1) % rows.length) {
    out[rows[i]!.key]! += 1;
    remainder -= 1;
  }
  for (let i = rows.length - 1; remainder < 0; i = (i - 1 + rows.length) % rows.length) {
    const k = rows[i]!.key;
    if (out[k]! > 0) {
      out[k]! -= 1;
      remainder += 1;
    }
  }
  return out;
}
