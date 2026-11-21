import { describe, expect, it } from 'vitest';
import { largestRemainder } from '../../src/shared/rounding';
import { rescale, Rescaler } from '../../src/shared/scaling';

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

describe('rescale', () => {
  it('scales proportionally down', () => {
    expect(rescale([{ key: 'r1', value: 700 }, { key: 'r2', value: 300 }], 950)).toEqual({ r1: 665, r2: 285 });
  });

  it('scales proportionally up', () => {
    expect(rescale([{ key: 'r3', value: 600 }, { key: 'r4', value: 400 }], 1050)).toEqual({ r3: 630, r4: 420 });
  });

  it('splits evenly when the current values are all 0', () => {
    expect(
      rescale([{ key: 'a', value: 0 }, { key: 'b', value: 0 }, { key: 'c', value: 0 }], 10),
    ).toEqual({ a: 4, b: 3, c: 3 });
  });

  it('gives all zeros for a zero new total', () => {
    expect(rescale([{ key: 'a', value: 5 }, { key: 'b', value: 7 }], 0)).toEqual({ a: 0, b: 0 });
    expect(rescale([{ key: 'a', value: 0 }, { key: 'b', value: 0 }], 0)).toEqual({ a: 0, b: 0 });
  });

  it('keeps the new total exactly when shares are fractional', () => {
    const out = rescale([{ key: 'a', value: 1 }, { key: 'b', value: 1 }, { key: 'c', value: 1 }], 100);
    expect(out).toEqual({ a: 34, b: 33, c: 33 });
    expect(Object.values(out).reduce((s, v) => s + v, 0)).toBe(100);
  });

  it('leaves zero-valued leaves at zero when others are positive', () => {
    expect(rescale([{ key: 'a', value: 0 }, { key: 'b', value: 50 }], 80)).toEqual({ a: 0, b: 80 });
  });

  it('returns the same values when the total is unchanged', () => {
    expect(rescale([{ key: 'a', value: 5015 }, { key: 'b', value: 8234 }, { key: 'c', value: 6278 }], 19527)).toEqual({
      a: 5015,
      b: 8234,
      c: 6278,
    });
  });

  it('Rescaler gives exactly what largestRemainder gives (random sizes, ties, zeros, reals, reuse across columns)', () => {
    const rnd = mulberry32(20261021);
    for (let iter = 0; iter < 600; iter++) {
      const n = 1 + Math.floor(rnd() * (iter % 10 === 0 ? 600 : 25));
      // keys whose string order differs from numeric order ('10' < '9'), as leaf ids do
      const keys = Array.from({ length: n }, (_, i) => String(1 + Math.floor(i * 7 + rnd() * 3)) + (i % 3 === 0 ? '' : `_${i}`));
      if (new Set(keys).size !== n) continue;
      const r = new Rescaler(keys);
      // byOrder with any increasing integers in key order (gaps allowed) must agree too.
      const sortedKeys = [...keys].sort();
      const order = keys.map((k) => sortedKeys.indexOf(k) * 3 + 7);
      const ro = Rescaler.byOrder(order);
      const outOrder = new Array<number>(n);
      const out = new Float64Array(n);
      for (let col = 0; col < 4; col++) {
        const mode = rnd();
        const values = Array.from({ length: n }, () => {
          const m = rnd();
          if (mode < 0.05) return 0;
          if (mode < 0.35) return Math.floor(rnd() * 4); // heavy ties
          if (mode < 0.5) return m < 0.3 ? 0 : rnd() * 1000; // reals
          return Math.floor(rnd() * 2000);
        });
        const sum = values.reduce((a, b) => a + b, 0);
        const target = rnd() < 0.2 ? sum === Math.floor(sum) ? sum : 0 : Math.floor(rnd() * 3 * (sum + n));
        const ref = largestRemainder(keys.map((key, i) => ({ key, value: values[i]! })), target);
        r.scale(values, target, out);
        ro.scale(values, target, outOrder);
        for (let i = 0; i < n; i++) {
          expect(out[i], `iter ${iter} col ${col} key ${keys[i]}`).toBe(ref[keys[i]!]);
          expect(outOrder[i], `byOrder iter ${iter} col ${col} key ${keys[i]}`).toBe(ref[keys[i]!]);
        }
        expect(rescale(keys.map((key, i) => ({ key, value: values[i]! })), target)).toEqual(ref);
      }
    }
  });

  it('Rescaler rejects what largestRemainder rejects', () => {
    expect(() => new Rescaler(['a', 'a'])).toThrow(RangeError);
    const r = new Rescaler(['a', 'b']);
    const out = [0, 0];
    expect(() => r.scale([1, 1], -1, out)).toThrow(RangeError);
    expect(() => r.scale([1, 1], 1.5, out)).toThrow(RangeError);
    expect(() => r.scale([1, -1], 5, out)).toThrow(RangeError);
    expect(() => r.scale([1, Number.NaN], 5, out)).toThrow(RangeError);
    expect(() => new Rescaler([]).scale([], 5, out)).toThrow(RangeError);
    expect(() => new Rescaler([]).scale([], 0, out)).not.toThrow();
    expect(() => Rescaler.byOrder([1, 1])).toThrow(RangeError);
    expect(() => Rescaler.byOrder([1, -1])).toThrow(RangeError);
    expect(() => Rescaler.byOrder([1, 1.5])).toThrow(RangeError);
  });

  it('Rescaler.byOrder: ties after fraction and value go to the smaller order number', () => {
    const out = [0, 0, 0];
    Rescaler.byOrder([30, 10, 20]).scale([1, 1, 1], 10, out);
    expect(out).toEqual([3, 4, 3]);
    // value still beats order
    Rescaler.byOrder([1, 2]).scale([284.5, 665.5], 950, out);
    expect(out.slice(0, 2)).toEqual([284, 666]);
    // orders beyond the exact numeric-key range take the sort path, same result
    Rescaler.byOrder([3 * 2 ** 21, 2 ** 21, 2 * 2 ** 21]).scale([1, 1, 1], 10, out);
    expect(out).toEqual([3, 4, 3]);
  });
});
