import { describe, expect, it } from 'vitest';
import { rescale } from '../../src/shared/scaling';

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
});
