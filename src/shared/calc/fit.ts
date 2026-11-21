/**
 * Iterative proportional fitting with whole-case rounding (handover section 5,
 * CD submit, and section 6 step C). Pure module.
 *
 * fitMatrix scales a seed matrix so its rows add up to rowTargets and its
 * columns to colTargets (80 iterations by default), then roundMatrix turns it
 * into whole cases whose rows AND columns add up exactly: each row by largest
 * remainder, then single cases are moved inside rows between columns that are
 * over and under, taking from the cells that were rounded up the most.
 */
import { largestRemainder } from '../rounding';

export class FitError extends Error {}

function checkTargets(name: string, t: readonly number[]): void {
  for (const v of t) {
    if (!Number.isInteger(v) || v < 0) throw new FitError(`${name} must be whole numbers >= 0, got ${v}`);
  }
}

/**
 * Real-valued fit. A row (or column) with a positive target but an all-zero
 * seed is first seeded from the other margin, so it can receive cases.
 */
export function fitMatrix(
  seed: readonly (readonly number[])[],
  rowTargets: readonly number[],
  colTargets: readonly number[],
  iterations = 80,
): number[][] {
  const R = rowTargets.length;
  const C = colTargets.length;
  if (seed.length !== R || seed.some((r) => r.length !== C)) throw new FitError('seed shape does not match the targets');
  checkTargets('row targets', rowTargets);
  checkTargets('column targets', colTargets);
  const rowSum = rowTargets.reduce((a, b) => a + b, 0);
  const colSum = colTargets.reduce((a, b) => a + b, 0);
  if (rowSum !== colSum) throw new FitError(`row targets add up to ${rowSum} but column targets to ${colSum}`);

  const m = seed.map((r) => r.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)));
  // Structural zeros that would make the fit impossible: seed them from the other margin.
  for (let i = 0; i < R; i++) {
    if (rowTargets[i]! > 0 && m[i]!.every((v) => v === 0)) {
      for (let j = 0; j < C; j++) m[i]![j] = colTargets[j]! > 0 ? colTargets[j]! / colSum : 0;
    }
  }
  for (let j = 0; j < C; j++) {
    if (colTargets[j]! > 0 && m.every((r) => r[j] === 0)) {
      for (let i = 0; i < R; i++) m[i]![j] = rowTargets[i]! > 0 ? rowTargets[i]! / rowSum : 0;
    }
  }

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < R; i++) {
      const s = m[i]!.reduce((a, b) => a + b, 0);
      const f = s > 0 ? rowTargets[i]! / s : 0;
      for (let j = 0; j < C; j++) m[i]![j]! *= f;
    }
    for (let j = 0; j < C; j++) {
      let s = 0;
      for (let i = 0; i < R; i++) s += m[i]![j]!;
      const f = s > 0 ? colTargets[j]! / s : 0;
      for (let i = 0; i < R; i++) m[i]![j]! *= f;
    }
  }
  return m;
}

/** Whole cases: rows add up to rowTargets and columns to colTargets, exactly. */
export function roundMatrix(fitted: readonly (readonly number[])[], rowTargets: readonly number[], colTargets: readonly number[]): number[][] {
  const R = rowTargets.length;
  const C = colTargets.length;
  checkTargets('row targets', rowTargets);
  checkTargets('column targets', colTargets);
  const keys = Array.from({ length: C }, (_, j) => String(j).padStart(6, '0'));
  const out = fitted.map((row, i) => {
    const r = largestRemainder(row.map((v, j) => ({ key: keys[j]!, value: Math.max(0, v) })), rowTargets[i]!);
    return keys.map((k) => r[k]!);
  });

  const diff = colTargets.map((t, j) => out.reduce((s, r) => s + r[j]!, 0) - t);
  // Move one case at a time from an over column to an under column, inside the
  // row where that costs least (cell most rounded up in the over column, most
  // rounded down in the under column). Each move keeps the row sum and brings
  // two columns one closer; it ends because the total excess falls each time.
  for (let guard = 0; guard < 1e7; guard++) {
    const over = diff.findIndex((d) => d > 0);
    if (over < 0) break;
    const under = diff.findIndex((d) => d < 0);
    if (under < 0) throw new FitError('column targets do not add up to the row targets');
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < R; i++) {
      if (out[i]![over]! <= 0) continue;
      const score = out[i]![over]! - fitted[i]![over]! + (fitted[i]![under]! - out[i]![under]!);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) throw new FitError('cannot balance columns');
    out[best]![over]! -= 1;
    out[best]![under]! += 1;
    diff[over]! -= 1;
    diff[under]! += 1;
  }
  return out;
}

/** fitMatrix then roundMatrix. */
export function fitAndRound(
  seed: readonly (readonly number[])[],
  rowTargets: readonly number[],
  colTargets: readonly number[],
  iterations = 80,
): number[][] {
  return roundMatrix(fitMatrix(seed, rowTargets, colTargets, iterations), rowTargets, colTargets);
}
