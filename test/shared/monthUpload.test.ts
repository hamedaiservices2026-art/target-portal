import { describe, expect, it } from 'vitest';
import { groupTotals, parseSheet1, toBatches } from '../../src/web/monthUpload';
import type { LeafGrid } from '../../src/shared/forecast';

const PACKS = ['CSD_CANS150', 'CSD_NRB', 'AquafinA_330', 'GATORADE'];

describe('parseSheet1', () => {
  it('reads the TT layout: header row, pack code then total, subtotal rows ignored', () => {
    const s = parseSheet1([
      ['Sales Target Category', 'Total'],
      ['CSD_CANS150', 296.5],
      ['CSD_NRB', '1,200'],
      ['Total CANS', 1496.5],
      [null, null],
      ['AquafinA_330', 10],
    ], PACKS);
    expect(s.totals).toEqual({ CSD_CANS150: 296.5, CSD_NRB: 1200, AquafinA_330: 10 });
    expect(s.invalid).toEqual([]);
  });

  it('uses the Pack / Total columns wherever they are, adds up a repeated pack, reports bad totals', () => {
    const s = parseSheet1([
      ['Title'],
      ['Notes', 'Pack', 'Total'],
      ['x', 'GATORADE', 5],
      ['y', 'GATORADE', 7],
      ['z', 'CSD_NRB', 'abc'],
      ['z', 'CSD_CANS150', -1],
    ], PACKS);
    expect(s.totals).toEqual({ GATORADE: 12 });
    expect(s.invalid).toEqual([{ line: 5, pack: 'CSD_NRB' }, { line: 6, pack: 'CSD_CANS150' }]);
  });
});

describe('groupTotals', () => {
  it('sums by the three groups in fixed order', () => {
    const r = groupTotals({ CSD_CANS150: 3, CSD_NRB: 4, AquafinA_330: 5, GATORADE: 6 }, [
      { code: 'CSD_CANS150', grp: 'CSD' }, { code: 'CSD_NRB', grp: 'CSD' },
      { code: 'AquafinA_330', grp: 'Water' }, { code: 'GATORADE', grp: 'LRB-Others' },
    ]);
    expect(r).toEqual({ groups: [{ grp: 'CSD', cases: 7 }, { grp: 'Water', cases: 5 }, { grp: 'LRB-Others', cases: 6 }], total: 18 });
  });
});

describe('toBatches', () => {
  it('splits into batches of 200 with only leafId, salesmanId and values', () => {
    const grids: LeafGrid[] = Array.from({ length: 450 }, (_, i) => ({
      leafId: i + 1, deliverySystem: 'D', routeCode: String(i), salesmanId: 'S', values: { P: i },
    }));
    const b = toBatches(grids);
    expect(b.map((x) => x.length)).toEqual([200, 200, 50]);
    expect(b[2]![0]).toEqual({ leafId: 401, salesmanId: 'S', values: { P: 400 } });
  });
});

describe('parseSheet1 on the TT DMM "Total Target By Package" layout', () => {
  // Same shape as the owner's file: header Pack / TT DMM, pack rows, "Total …" subtotal
  // rows (one with a trailing space), a pack with an empty total. Numbers are made up.
  const rows: unknown[][] = [
    ['Pack', 'TT DMM'],
    ['CSD_CANS150', 2082.6],
    ['CSD_NRB', 10],
    ['Total CANS', 2092.6],
    ['PMIX', null],
    ['AquafinA_330', 40],
    ['XYZ', 12],
    ['GATORADE', 5],
    ['Total LRB ', 57.6],
  ];

  it('reads the pack totals, skips subtotal rows and blank totals quietly, reports an unknown row with a number', () => {
    const s = parseSheet1(rows, [...PACKS, 'PMIX']);
    expect(s.totals).toEqual({ CSD_CANS150: 2082.6, CSD_NRB: 10, AquafinA_330: 40, GATORADE: 5 });
    expect(s.invalid).toEqual([]);
    expect(s.unrecognised).toEqual([{ line: 7, pack: 'XYZ', total: 12 }]);
  });
});
