import { describe, expect, it } from 'vitest';
import { fileLayout, packIndex, parseAopByDept } from '../../src/web/cycle/parsers';

const head = ['Pack', '2027-01', '2027-02', 'FY 2027'];
const abc = [head,
  ['A1', 1.4, 2, 3.4], ['A2', 2.4, 1, 3.4], ['Total A', 3.8, 3, 6.8],
  ['B1', 5, 5, 10], ['Total AB', 8.8, 8, 16.8],
];
const ch = (k: number) => [head, ['A1', 0.7 * k, 1 * k, 0], ['A2', 1.2 * k, 0.5 * k, 0], ['Total A', 0, 0, 0], ['B1', 2.5 * k, 2.5 * k, 0]];

describe('AOP by pack and department file', () => {
  it('keeps the file order and its Total rows, with the packs each sums', () => {
    const l = fileLayout(abc, packIndex(['A1', 'A2', 'B1']));
    expect(l).toEqual([{ p: 'A1' }, { p: 'A2' }, { t: 'Total A', of: ['A1', 'A2'] }, { p: 'B1' }, { t: 'Total AB', of: ['A1', 'A2', 'B1'] }]);
  });
  it('rounds to whole cases while keeping each channel total', () => {
    const r = parseAopByDept([{ sheet: 'X', data: ch(1) }, { sheet: 'Y', data: ch(1) }, { sheet: 'ABC', data: abc }], ['X', 'Y'], packIndex(['A1', 'A2', 'B1']));
    const jan = r.byMonth['2027-01']!;
    expect(Object.values(jan.X!).reduce((a, b) => a + b, 0)).toBe(Math.round(0.7 + 1.2 + 2.5));
    expect(r.layout.length).toBe(5);
  });
});
