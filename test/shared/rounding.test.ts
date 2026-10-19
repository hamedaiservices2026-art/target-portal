import { describe, expect, it } from 'vitest';
import { largestRemainder } from '../../src/shared/rounding';

// Small seeded PRNG (mulberry32) so property tests are reproducible without a dependency.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('largestRemainder', () => {
  it('breaks fractional ties toward the larger value', () => {
    expect(largestRemainder([{ key: 'a', value: 665.5 }, { key: 'b', value: 284.5 }], 950)).toEqual({ a: 666, b: 284 });
  });

  it('tie goes to the larger value even when its key sorts later', () => {
    expect(largestRemainder([{ key: 'a', value: 284.5 }, { key: 'b', value: 665.5 }], 950)).toEqual({ a: 284, b: 666 });
  });

  it('breaks full ties by key ascending', () => {
    expect(
      largestRemainder([{ key: 'a', value: 1 }, { key: 'b', value: 1 }, { key: 'c', value: 1 }], 10),
    ).toEqual({ a: 4, b: 3, c: 3 });
  });

  it('is independent of input order for ties', () => {
    expect(
      largestRemainder([{ key: 'c', value: 1 }, { key: 'a', value: 1 }, { key: 'b', value: 1 }], 10),
    ).toEqual({ a: 4, b: 3, c: 3 });
  });

  it('splits evenly when all values are 0 (remainder to keys ascending)', () => {
    expect(largestRemainder([{ key: 'x', value: 0 }, { key: 'y', value: 0 }], 5)).toEqual({ x: 3, y: 2 });
    expect(
      largestRemainder([{ key: 'c', value: 0 }, { key: 'a', value: 0 }, { key: 'b', value: 0 }], 10),
    ).toEqual({ a: 4, b: 3, c: 3 });
  });

  it('normalizes real-valued shares to the target', () => {
    expect(largestRemainder([{ key: 'a', value: 83.03 }, { key: 'b', value: 728.96 }], 812)).toEqual({ a: 83, b: 729 });
  });

  it('works at any scale of values', () => {
    expect(largestRemainder([{ key: 'a', value: 0.7 }, { key: 'b', value: 0.3 }], 950)).toEqual({ a: 665, b: 285 });
    expect(largestRemainder([{ key: 'a', value: 7e6 }, { key: 'b', value: 3e6 }], 950)).toEqual({ a: 665, b: 285 });
  });

  it('returns zeros for a zero target', () => {
    expect(largestRemainder([{ key: 'a', value: 5 }, { key: 'b', value: 7 }], 0)).toEqual({ a: 0, b: 0 });
    expect(largestRemainder([{ key: 'a', value: 0 }], 0)).toEqual({ a: 0 });
  });

  it('handles a single item and an empty list', () => {
    expect(largestRemainder([{ key: 'a', value: 3 }], 42)).toEqual({ a: 42 });
    expect(largestRemainder([], 0)).toEqual({});
  });

  it('gives a zero-valued item nothing when others are positive', () => {
    expect(
      largestRemainder([{ key: 'a', value: 0 }, { key: 'b', value: 1 }, { key: 'c', value: 1 }], 3),
    ).toEqual({ a: 0, b: 2, c: 1 });
  });

  it('is not fooled by float error in exact shares', () => {
    // 0.1 + 0.2 style inputs: exact shares are 1, 2 and 3.
    expect(
      largestRemainder([{ key: 'a', value: 0.1 }, { key: 'b', value: 0.2 }, { key: 'c', value: 0.3 }], 6),
    ).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('rejects invalid input', () => {
    expect(() => largestRemainder([{ key: 'a', value: 1 }], -1)).toThrow(RangeError);
    expect(() => largestRemainder([{ key: 'a', value: 1 }], 1.5)).toThrow(RangeError);
    expect(() => largestRemainder([{ key: 'a', value: -1 }], 5)).toThrow(RangeError);
    expect(() => largestRemainder([{ key: 'a', value: Number.NaN }], 5)).toThrow(RangeError);
    expect(() => largestRemainder([], 5)).toThrow(RangeError);
    expect(() => largestRemainder([{ key: 'a', value: 1 }, { key: 'a', value: 2 }], 5)).toThrow(RangeError);
  });

  it('property: random inputs sum to target, each within 1 of its exact share, order-independent', () => {
    const rnd = mulberry32(20261019);
    for (let iter = 0; iter < 2000; iter++) {
      const n = 1 + Math.floor(rnd() * 12);
      const target = Math.floor(rnd() * 5000);
      const allZero = rnd() < 0.05;
      const items = Array.from({ length: n }, (_, i) => {
        const mode = rnd();
        // mix of integers, reals, zeros and repeated values to provoke ties
        const value = allZero || mode < 0.15 ? 0 : mode < 0.4 ? Math.floor(rnd() * 5) : rnd() * 1000;
        return { key: `k${String(i).padStart(2, '0')}`, value };
      });
      const sum = items.reduce((s, it) => s + it.value, 0);

      const out = largestRemainder(items, target);

      expect(Object.keys(out).sort()).toEqual(items.map((it) => it.key).sort());
      let total = 0;
      for (const it of items) {
        const r = out[it.key]!;
        const exact = sum > 0 ? (it.value * target) / sum : target / n;
        expect(Number.isInteger(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(Math.abs(r - exact)).toBeLessThan(1 + 1e-6);
        total += r;
      }
      expect(total).toBe(target);

      // shuffling the input must not change the result
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(largestRemainder(shuffled, target)).toEqual(out);
    }
  });
});
