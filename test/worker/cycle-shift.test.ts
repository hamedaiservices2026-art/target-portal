import { describe, expect, it } from 'vitest';
import { rescaleRoutes } from '../../src/worker/services/cycle';

describe('route targets scaled to a shifted department target', () => {
  it('keeps the shares, adds up exactly, and spreads a new pack by route size', () => {
    const r = rescaleRoutes({ a: { P: 60, Q: 10 }, b: { P: 40, Q: 30 } }, { P: 110, Q: 40, N: 7 });
    expect(r.a!.P! + r.b!.P!).toBe(110);
    expect(r.a!.P).toBe(66);
    expect(r.a!.Q! + r.b!.Q!).toBe(40);
    expect((r.a!.N ?? 0) + (r.b!.N ?? 0)).toBe(7);
    expect(rescaleRoutes({ a: { P: 5 } }, {})).toEqual({ a: {} });
  });
});
