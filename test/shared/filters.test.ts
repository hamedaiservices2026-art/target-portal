import { describe, expect, it } from 'vitest';
import { parseNumFilter } from '../../src/web/components/Filters.tsx';

describe('parseNumFilter', () => {
  it('blank (or only spaces) always passes', () => {
    for (const expr of ['', '   ']) {
      const f = parseNumFilter(expr);
      expect([0, 1, 500, -3, 1e9].every(f)).toBe(true);
    }
  });

  it('>500 and <100 are strict', () => {
    const gt = parseNumFilter('>500');
    expect([gt(500), gt(501), gt(0)]).toEqual([false, true, false]);
    const lt = parseNumFilter('<100');
    expect([lt(99), lt(100), lt(0)]).toEqual([true, false, true]);
  });

  it('>= and <= include the bound', () => {
    const ge = parseNumFilter('>=500');
    expect([ge(499), ge(500), ge(501)]).toEqual([false, true, true]);
    const le = parseNumFilter('<=100');
    expect([le(99), le(100), le(101)]).toEqual([true, true, false]);
  });

  it('=0 matches exactly, and a bare number means equals', () => {
    const eq = parseNumFilter('=0');
    expect([eq(0), eq(1)]).toEqual([true, false]);
    const bare = parseNumFilter('250');
    expect([bare(250), bare(251)]).toEqual([true, false]);
  });

  it('100-500 is an inclusive range', () => {
    const r = parseNumFilter('100-500');
    expect([r(99), r(100), r(300), r(500), r(501)]).toEqual([false, true, true, true, false]);
  });

  it('ignores spaces, thousands commas and accepts Arabic-Indic digits', () => {
    expect(parseNumFilter(' > 1,000 ')(1001)).toBe(true);
    expect(parseNumFilter(' > 1,000 ')(1000)).toBe(false);
    expect(parseNumFilter('>٥٠٠')(501)).toBe(true);
    expect(parseNumFilter('١٠٠-٢٠٠')(150)).toBe(true);
  });

  it('an expression it cannot read does not hide anything', () => {
    const f = parseNumFilter('abc');
    expect([f(0), f(10)]).toEqual([true, true]);
  });

  it('a value that is not a number (an invalid cell) only passes the blank filter', () => {
    expect(parseNumFilter('')(Number.NaN)).toBe(true);
    expect(parseNumFilter('>0')(Number.NaN)).toBe(false);
    expect(parseNumFilter('=0')(Number.NaN)).toBe(false);
  });
});
