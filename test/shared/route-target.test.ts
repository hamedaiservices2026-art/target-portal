import { describe, expect, it } from 'vitest';
import { packIndex, parseRouteTarget } from '../../src/web/cycle/parsers';
import { formatOf, targetRows } from '../../src/web/cycle/targetFiles';

const idx = packIndex(['CSD_CANS150', 'WATER_330']);

describe('uploaded target by route (MTFL / MDD)', () => {
  it('reads an MTFL file under its "Creation Date:" row, 0s kept, other months ignored', () => {
    const rows = [
      ['Creation Date:', new Date('2026-10-01T10:00:00Z')],
      ['Period (YYYYMM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases', 'Amount', 'Format'],
      ['2026-10', 'Presell – TT', 314019, 42464, 'CSD_CANS150', 80, null, 'Small'],
      ['2026-10', 'Presell – TT', 314019, 42464, 'WATER_330', 0, null, 'Small'],
      ['2026-11', 'Presell – TT', 314019, 42464, 'WATER_330', 9, null, 'Small'],
      ['2026-10', 'Presell – TT', 314019, 42464, 'NOPE', 5, null, 'Small'],
    ];
    const r = parseRouteTarget(rows, '2026-10', idx);
    expect(r.byLeaf).toEqual({ '314019': { CSD_CANS150: 80, WATER_330: 0 } });
    expect(r.salesmen).toEqual({ '314019': '42464' });
    expect(r.formats).toEqual({ 'Presell – TT': 'Small' });
    expect(r.checks.some((c) => c.level === 'warning' && c.text.includes('NOPE'))).toBe(true);
    expect(r.checks.some((c) => c.level === 'error')).toBe(false);
  });

  it('reads an MDD file (KAE / KAM column, two rows above the header)', () => {
    const rows = [
      ['Prepared by', 'Someone'],
      ['Creation Date:', new Date()],
      ['Period (YYYYMM)', 'Delivery System', 'KAE / KAM', 'Sales Target Category', 'Cases', 'Amount', 'Format'],
      ['2026-11', 'Presell- MT', 41361, 'CSD_CANS150', 11690, null, 'Large'],
    ];
    const r = parseRouteTarget(rows, '2026-11', idx);
    expect(r.byLeaf).toEqual({ '41361': { CSD_CANS150: 11690 } });
    expect(r.deliverySystems['41361']).toBe('Presell- MT');
  });

  it('formats and rows follow the templates', () => {
    expect(formatOf('Presell – TT')).toBe('Small');
    expect(formatOf('Presell- MT')).toBe('Large');
    expect(formatOf('HoReCa')).toBe('Non-Retail');
    expect(formatOf('Wholesale')).toBe('Wholesale');
    const line = { ds: 'Presell – TT', code: '314019', salesman: '42464', grid: { CSD_CANS150: 80 }, packs: ['CSD_CANS150', 'WATER_330'] };
    expect(targetRows('mtfl', '2026-10', [line])).toEqual([
      ['2026-10', 'Presell – TT', 314019, 42464, 'CSD_CANS150', 80, null, 'Small'],
      ['2026-10', 'Presell – TT', 314019, 42464, 'WATER_330', 0, null, 'Small'],
    ]);
    expect(targetRows('mdd', '2026-11', [{ ...line, ds: 'Presell- MT', code: '41361' }])[0]).toEqual(['2026-11', 'Presell- MT', 41361, 'CSD_CANS150', 80, null, 'Large']);
  });
});
