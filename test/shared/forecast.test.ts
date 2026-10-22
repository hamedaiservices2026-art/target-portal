import { describe, expect, it } from 'vitest';
import { ForecastHeaderError, checkForecast, compareToTotals, normalizeForecastRows } from '../../src/shared/forecast';
import type { RawRow } from '../../src/shared/forecast';
import { CLEAN_ROWS, DS, HEADER, LEAVES, PACKS, excelRows, row } from '../fixtures/forecast-small';

const ctx = (over: Partial<{ period: string; packs: string[]; takenLeafIds: Set<number> }> = {}) => ({
  period: '2026-10',
  packs: PACKS,
  leaves: LEAVES,
  takenLeafIds: new Set<number>(),
  ...over,
});

describe('normalizeForecastRows', () => {
  it('finds the header, normalizes codes, dates and cases, and ignores the template tail', () => {
    const out = normalizeForecastRows(excelRows());
    expect(out).toEqual([
      { line: 3, period: '2026-10', deliverySystem: DS, routeCode: '314019', salesmanId: '5101', pack: 'PEP', cases: 83.03 },
      { line: 4, period: '2026-10', deliverySystem: DS, routeCode: '314037', salesmanId: '5102', pack: 'PEP', cases: 728.96 },
      { line: 5, period: '2026-10', deliverySystem: DS, routeCode: '314050', salesmanId: '', pack: 'MIR', cases: null },
    ]);
  });

  it('skips blank rows in the middle of the data and still reads the rows after them', () => {
    const out = normalizeForecastRows([
      HEADER,
      ['2026-10', DS, 1, 'a', 'PEP', 1],
      [null, null, null, null, null, null],
      [null, null, null, null, 'PEP', null],
      ['2026-10', DS, 2, 'b', 'PEP', 2],
      [null, null, null, null, 'PEP', null],
      [null, null, null, null, 'MIR', null],
    ]);
    expect(out.map((r) => [r.line, r.routeCode])).toEqual([[2, '1'], [5, '2']]);
  });

  it('matches header names case- and space-insensitively', () => {
    const header = ['period (yyyy-mm)', ' DELIVERY  SYSTEM', 'route code', 'salesman id', 'sales target category', 'CASES'];
    const out = normalizeForecastRows([header, ['2026-10', DS, 1, 2, 'PEP', 3]]);
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBe(2);
  });

  it('accepts the real TT DMM period header "Period (YYYYMM)"', () => {
    const header = ['Period (YYYYMM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases'];
    const out = normalizeForecastRows([header, ['2026-10', DS, 1, 2, 'PEP', 3]]);
    expect(out.map((r) => [r.period, r.cases])).toEqual([['2026-10', 3]]);
  });

  it('throws ForecastHeaderError listing the missing columns of the best-matching row', () => {
    const garbled = ['Period (YYYY-MM)', 'Delivery Sistem', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Case'];
    let caught: unknown;
    try {
      normalizeForecastRows([['title'], garbled, ['2026-10', DS, 1, 2, 'PEP', 3]]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForecastHeaderError);
    expect((caught as ForecastHeaderError).missing).toEqual(['Delivery System', 'Cases']);
  });

  it('throws with all six columns missing when no row resembles a header', () => {
    expect(() => normalizeForecastRows([['a', 'b'], [1, 2]])).toThrow(ForecastHeaderError);
    try {
      normalizeForecastRows([['a', 'b'], [1, 2]]);
    } catch (e) {
      expect((e as ForecastHeaderError).missing).toEqual(HEADER);
    }
    expect(() => normalizeForecastRows([])).toThrow(ForecastHeaderError);
  });

  it('header-only file: normalize returns [] and checkForecast reports no_rows', () => {
    const rows = normalizeForecastRows([HEADER]);
    expect(rows).toEqual([]);
    const r = checkForecast(rows, ctx());
    expect(r.errors).toMatchObject([{ level: 'error', code: 'no_rows' }]);
    expect(r.grids).toEqual([]);
  });

  it('blank cases become null, unusable cases NaN; non-date, non-string periods stay text that will mismatch', () => {
    const out = normalizeForecastRows([
      HEADER,
      ['2026-10', DS, '1', 'x', 'PEP', 'abc'],
      ['2026-10', DS, '2', 'x', 'PEP', true],
      ['2026-10', DS, '3', 'x', 'PEP', -4],
      [202610, DS, '4', 'x', 'PEP', 1],
      ['2026-10', DS, '5', 'x', 'PEP', null],
      ['2026-10', DS, '6', 'x', 'PEP', '  '],
    ]);
    expect(out.map((r) => r.cases)).toEqual([Number.NaN, Number.NaN, -4, 1, null, null]);
    expect(out[3]!.period).toBe('202610');
  });
});

describe('checkForecast errors', () => {
  it('clean input has no errors; builds a full grid with missing packs = 0', () => {
    const r = checkForecast(CLEAN_ROWS, ctx());
    expect(r.errors).toEqual([]);
    expect(r.grids).toHaveLength(2);
    for (const g of r.grids) expect(Object.keys(g.values).sort()).toEqual([...PACKS].sort());
    expect(r.grids[0]).toMatchObject({ leafId: 1, deliverySystem: DS, routeCode: '314019', values: { PEP: 83, MIR: 10, AQUA: 0, LIPTON: 0 } });
    expect(r.grids[1]!.values).toEqual({ PEP: 729, MIR: 5, AQUA: 0, LIPTON: 0 });
  });

  it('unknown_pack', () => {
    const r = checkForecast([row(7, '314019', 'ZZZ', 5)], ctx());
    expect(r.errors).toMatchObject([{ level: 'error', code: 'unknown_pack', line: 7 }]);
  });

  it('period_mismatch', () => {
    const r = checkForecast([row(7, '314019', 'PEP', 5, 'S1', '2026-09')], ctx());
    expect(r.errors).toMatchObject([{ code: 'period_mismatch', line: 7 }]);
  });

  it.each([[-1], [-3], [Number.NaN], [Number.POSITIVE_INFINITY]])('bad_cases for %s', (cases) => {
    const r = checkForecast([row(7, '314019', 'PEP', cases)], ctx());
    expect(r.errors).toMatchObject([{ code: 'bad_cases', line: 7 }]);
  });

  it("text cases ('abc') and negatives (-3) from the sheet are errors", () => {
    const rows = normalizeForecastRows([HEADER, ['2026-10', DS, '314019', 'S1', 'PEP', 'abc'], ['2026-10', DS, '314019', 'S1', 'MIR', -3]]);
    const r = checkForecast(rows, ctx());
    expect(r.errors.map((e) => [e.code, e.line])).toEqual([['bad_cases', 2], ['bad_cases', 3]]);
  });

  it('duplicate (same leaf + pack twice) flags the later row', () => {
    const r = checkForecast([row(2, '314019', 'PEP', 5), row(9, '314019', 'PEP', 6)], ctx());
    expect(r.errors).toMatchObject([{ code: 'duplicate', line: 9 }]);
    expect(r.errors[0]!.detail).toContain('2');
  });

  it('unmapped_leaf, compared exactly after trim (no dash normalization)', () => {
    const r = checkForecast([row(7, '999999', 'PEP', 5), row(8, '314019', 'PEP', 5, 'S1', '2026-10', 'Presell - TT')], ctx());
    expect(r.errors.map((e) => [e.code, e.line])).toEqual([['unmapped_leaf', 7], ['unmapped_leaf', 8]]);
  });

  it('reports an unmapped leaf once, not once per pack', () => {
    const r = checkForecast([row(7, '999999', 'PEP', 5), row(8, '999999', 'MIR', 5)], ctx());
    expect(r.errors).toHaveLength(1);
  });

  it('leaf_in_other_file', () => {
    const r = checkForecast([row(7, '314019', 'PEP', 5)], ctx({ takenLeafIds: new Set([1]) }));
    expect(r.errors).toMatchObject([{ code: 'leaf_in_other_file', line: 7 }]);
    expect(r.grids).toEqual([]);
  });

  it('still returns grids and totals from the valid rows when there are errors', () => {
    const r = checkForecast([row(2, '314019', 'PEP', 10), row(3, '314019', 'MIR', -1), row(4, '314037', 'ZZZ', 3)], ctx());
    expect(r.errors.map((e) => e.code)).toEqual(['bad_cases', 'unknown_pack']);
    expect(r.grids).toHaveLength(1);
    expect(r.grids[0]!.values).toEqual({ PEP: 10, MIR: 0, AQUA: 0, LIPTON: 0 });
    expect(r.packTotals).toEqual({ PEP: 10, MIR: 0, AQUA: 0, LIPTON: 0 });
  });

  it('trims codes before matching', () => {
    const r = checkForecast([{ ...row(2, ' 314019 ', ' PEP ', 5), deliverySystem: `  ${DS} ` }], ctx());
    expect(r.errors).toEqual([]);
    expect(r.grids[0]!.values.PEP).toBe(5);
  });
});

describe('checkForecast warnings', () => {
  it('blank_cases: a blank Cases cell counts as 0, one warning per route at its first line with the count', () => {
    const rows = normalizeForecastRows([
      HEADER,
      ['2026-10', DS, '314019', 'S1', 'PEP', 7],
      ['2026-10', DS, '314019', 'S1', 'MIR', null],
      ['2026-10', DS, '314019', 'S1', 'AQUA', ''],
      ['2026-10', DS, '314037', 'S2', 'PEP', 3],
    ]);
    const r = checkForecast(rows, ctx());
    expect(r.errors).toEqual([]);
    const w = r.warnings.filter((x) => x.code === 'blank_cases');
    expect(w).toMatchObject([{ level: 'warning', code: 'blank_cases', line: 2 }]);
    expect(w[0]!.detail).toContain('2 blank');
    expect(r.grids.find((g) => g.routeCode === '314019')!.values).toEqual({ PEP: 7, MIR: 0, AQUA: 0, LIPTON: 0 });
  });


  it('blank_salesman: stores an empty ID', () => {
    const r = checkForecast([row(2, '314050', 'PEP', 5, '')], ctx());
    expect(r.warnings.filter((w) => w.code === 'blank_salesman')).toMatchObject([{ level: 'warning', line: 2 }]);
    expect(r.grids[0]!.salesmanId).toBe('');
  });

  it('blank_salesman is reported once per route', () => {
    const r = checkForecast([row(2, '314050', 'PEP', 5, ''), row(3, '314050', 'MIR', 5, '  ')], ctx());
    expect(r.warnings.filter((w) => w.code === 'blank_salesman')).toHaveLength(1);
  });

  it('split_salesman: keeps the ID with most rows', () => {
    const r = checkForecast(CLEAN_ROWS, ctx());
    expect(r.warnings.filter((w) => w.code === 'split_salesman')).toHaveLength(1);
    expect(r.grids.find((g) => g.routeCode === '314037')!.salesmanId).toBe('S2');
  });

  it('split_salesman tie: the ID appearing first wins', () => {
    const r = checkForecast([row(2, '314019', 'PEP', 1, 'B'), row(3, '314019', 'MIR', 1, 'A')], ctx());
    expect(r.grids[0]!.salesmanId).toBe('B');
    expect(r.warnings.filter((w) => w.code === 'split_salesman')).toHaveLength(1);
  });

  it('all_zero_leaf', () => {
    const r = checkForecast([row(2, '314019', 'PEP', 0), row(3, '314019', 'MIR', 0)], ctx());
    expect(r.warnings.filter((w) => w.code === 'all_zero_leaf')).toMatchObject([{ line: 2 }]);
  });

  it('missing_pack: pack in the list but not in the file', () => {
    const r = checkForecast(CLEAN_ROWS, ctx());
    expect(r.warnings.filter((w) => w.code === 'missing_pack')).toMatchObject([{ level: 'warning' }]);
    expect(r.warnings.find((w) => w.code === 'missing_pack')!.detail).toContain('LIPTON');
  });

  it('a clean file with every pack has no warnings', () => {
    const rows = [row(2, '314019', 'PEP', 1), row(3, '314019', 'MIR', 1), row(4, '314019', 'AQUA', 1), row(5, '314019', 'LIPTON', 1)];
    const r = checkForecast(rows, ctx());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe('checkForecast rounding', () => {
  it('rounds per pack so the leaves sum to the rounded decimal total', () => {
    const rows = [row(2, '314019', 'PEP', 83.03), row(3, '314037', 'PEP', 728.96)];
    const r = checkForecast(rows, ctx());
    expect(r.grids.map((g) => g.values.PEP)).toEqual([83, 729]);
    expect(r.packTotals.PEP).toBe(812);
  });

  it('preserves the total when remainders must be distributed', () => {
    const rows = [row(2, '314019', 'PEP', 1.4), row(3, '314037', 'PEP', 1.4), row(4, '314050', 'PEP', 1.4)];
    const r = checkForecast(rows, ctx());
    const vals = r.grids.map((g) => g.values.PEP!);
    expect(vals.reduce((a, b) => a + b, 0)).toBe(4);
    expect(r.packTotals.PEP).toBe(4);
  });

  it('packTotals has every pack, zero when empty', () => {
    const r = checkForecast([], ctx());
    expect(r.packTotals).toEqual({ PEP: 0, MIR: 0, AQUA: 0, LIPTON: 0 });
    expect(r.grids).toEqual([]);
  });
});

describe('compareToTotals', () => {
  it('reports a 1-case difference and omits equal packs', () => {
    expect(compareToTotals({ PEP: 812, MIR: 15 }, { PEP: 813, MIR: 15 })).toEqual([{ pack: 'PEP', forecast: 812, expected: 813, diff: -1 }]);
  });

  it('rounds expected first and covers packs present on only one side', () => {
    const out = compareToTotals({ PEP: 812 }, { PEP: 811.6, MIR: 4 });
    expect(out).toEqual([{ pack: 'MIR', forecast: 0, expected: 4, diff: -4 }]);
  });
});

// Type-level sanity: RawRow is exported.
const _r: RawRow = row(1, '1', 'PEP', 1);
void _r;
