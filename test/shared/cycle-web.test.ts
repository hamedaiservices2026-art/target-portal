import { describe, expect, it } from 'vitest';
import { calculate, cdRows, defaultDeptSplit, reconciliation, routeIndex, somRows, startNewTarget, type Org } from '../../src/web/cycle/compute';
import { packIndex, parseAop, parseChannelGrid, parseNewTargetByPack, parsePrevTargets, parseSales, sheetMonth } from '../../src/web/cycle/parsers';

const idx = packIndex(['CSD_CANS150', 'CSD_PET2250', 'AquafinA_330', 'LIT_PET500']);

describe('parsers', () => {
  it('New Target by pack: shifted header, other months ignored, names matched loosely', () => {
    const r = parseNewTargetByPack([
      ['New target Oct'],
      ['Period', 'Sales Target Category', 'Cases'],
      ['202610', 'csd cans150', 1000.4],
      ['202609', 'CSD_CANS150', 5],
      ['202610', 'Total CSD', 1000],
      ['202610', 'UNKNOWN_X', 3],
    ], '2026-10', idx);
    expect(r.byPack).toEqual({ CSD_CANS150: 1000 });
    expect(r.checks.map((c) => c.level)).toEqual(['info', 'error', 'info']);
  });

  it('channel grid: subtotal rows and Total columns ignored, ABC kept', () => {
    const r = parseChannelGrid([
      ['', 'Amir', 'Agwa', '', 'Shehadeh'],
      ['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'MT', 'New Target', 'ABC'],
      ['CSD_CANS150', 300, 200, 500, 150, 650, 650],
      ['Total CANS', 300, 200, 500, 150, 650, 650],
    ], ['TT DMM', 'TT Outer', 'MT', 'HoReCa'], idx);
    expect(r.byChannel).toEqual({ 'TT DMM': { CSD_CANS150: 300 }, 'TT Outer': { CSD_CANS150: 200 }, MT: { CSD_CANS150: 150 } });
    expect(r.abc).toEqual({ CSD_CANS150: 650 });
    expect(r.checks.some((c) => /HoReCa/.test(c.text))).toBe(true);
    expect(sheetMonth({ sheet: 'Oct-26', data: [] })).toBe('2026-10');
  });

  it('sales: wide layout with mixed month headers, and the long layout', () => {
    const wide = parseSales([
      ['Route Code', 'Product Category', 'Sales Target Category', '2026-07', 202608, 'Sep-26'],
      ['R1', 'CSD', 'CSD_CANS150', 10, 20, 30],
      ['R1', 'CSD', 'CSD_CANS150', 1, 1, 1],
    ], idx, new Set(['R1']));
    expect(wide.data).toEqual({ '2026-07': { R1: { CSD_CANS150: 11 } }, '2026-08': { R1: { CSD_CANS150: 21 } }, '2026-09': { R1: { CSD_CANS150: 31 } } });
    const long = parseSales([['Route Code', 'Sales Target Category', 'Period', 'Cases'], ['R2', 'AquafinA_330', 202609, 7]], idx);
    expect(long.layout).toBe('long');
    expect(long.data).toEqual({ '2026-09': { R2: { AquafinA_330: 7 } } });
  });

  it('AOP from every AOP sheet, previous targets with salesman', () => {
    const aop = parseAop([{ sheet: 'AOP 2026', data: [['Period', 'Sales Target Category', 'AOP Cases', 'NR/Case'], [202610, 'CSD_CANS150', 100, 2.5]] }, { sheet: 'Notes', data: [] }], idx);
    expect(aop.byMonth).toEqual({ '2026-10': { CSD_CANS150: { cases: 100, nr: 2.5 } } });
    const prev = parsePrevTargets([['Period', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases'], [202609, 'TT DMM', 'R1', 'S1', 'CSD_CANS150', 9]], idx);
    expect(prev.data['2026-09']).toEqual({ R1: { CSD_CANS150: 9 } });
    expect(prev.extra['2026-09']!.R1).toEqual({ salesmanId: 'S1', deliverySystem: 'TT DMM' });
  });
});

const org: Org = {
  depts: [
    { id: 1, code: 'TT', name: 'TT', sort: 0, channels: [{ channel: 'TT DMM', grp: 'TT' }] },
    { id: 2, code: 'MT', name: 'MT', sort: 1, channels: [{ channel: 'MT', grp: 'MT' }, { channel: 'MT SSV', grp: 'MT' }] },
  ],
  nodes: [
    { id: 10, deptId: 1, parentId: null, name: 'TT Head', managerUserId: null, managerName: null },
    { id: 11, deptId: 1, parentId: 10, name: 'Mgr', managerUserId: null, managerName: null },
    { id: 12, deptId: 1, parentId: 10, name: 'Empty team', managerUserId: null, managerName: null },
    { id: 20, deptId: 2, parentId: null, name: 'MT Head', managerUserId: null, managerName: null },
  ],
  leaves: [
    { id: 1, deptId: 1, nodeId: 11, routeCode: 'R1', deliverySystem: 'TT DMM', label: 'R1' },
    { id: 2, deptId: 1, nodeId: 11, routeCode: 'R2', deliverySystem: 'TT DMM', label: 'R2' },
    { id: 3, deptId: 2, nodeId: 20, routeCode: 'M1', deliverySystem: 'MT', label: 'M1' },
    { id: 4, deptId: 2, nodeId: 20, routeCode: 'M2', deliverySystem: 'MT SSV', label: 'M2' },
  ],
  packs: [
    { code: 'CSD_CANS150', grp: 'CSD', active: true, sort: 1 },
    { code: 'AquafinA_330', grp: 'Water', active: true, sort: 2 },
  ],
};
const sales = {
  '2026-07': { R1: { CSD_CANS150: 30 }, M1: { CSD_CANS150: 60 } },
  '2026-08': { R1: { CSD_CANS150: 30 }, R2: { CSD_CANS150: 30 }, M1: { CSD_CANS150: 60 } },
  '2026-09': { R1: { CSD_CANS150: 50 }, R2: { CSD_CANS150: 10 }, M1: { CSD_CANS150: 40 }, M2: { AquafinA_330: 10 } },
};

describe('cycle compute', () => {
  it('maps routes to channels by delivery system', () => {
    expect(routeIndex(org).get('M2')).toEqual({ deptId: 2, nodeId: 20, channel: 'MT SSV' });
  });

  it('starting New Target: first source found wins', () => {
    const cats = new Map([['CSD_CANS150', 'CSD' as const], ['AquafinA_330', 'Water' as const]]);
    const base = { newTarget: null, fyTarget: {}, aop: {}, deptChannel: {}, prevTargets: {}, sales };
    expect(startNewTarget('2026-10', { ...base, newTarget: { mode: 'pack', byPack: { CSD_CANS150: 7 } } }, cats)).toEqual({ nt: { CSD_CANS150: 7 }, source: 'uploaded' });
    expect(startNewTarget('2026-10', { ...base, fyTarget: { '2026-10': { CSD_CANS150: 8 } } }, cats).source).toBe('fy_target');
    const aop = startNewTarget('2026-10', { ...base, aop: { '2026-10': { CSD_CANS150: { cases: 100, nr: null } }, '2026-09': { CSD_CANS150: { cases: 50, nr: null } } }, prevTargets: { '2026-09': { R1: { CSD_CANS150: 60 } } } }, cats);
    expect(aop).toEqual({ nt: { CSD_CANS150: 120 }, source: 'aop_ratio' });
    expect(startNewTarget('2026-10', { ...base, prevTargets: { '2026-09': { R1: { CSD_CANS150: 60 } } } }, cats).source).toBe('pago_target');
    // average of the company total over Jul-Sep: (90 + 120 + 100) / 3
    expect(startNewTarget('2026-10', base, cats).nt.CSD_CANS150).toBe(103);
  });

  it('default department split adds up to the New Target per pack, then channels', () => {
    const r = defaultDeptSplit({
      period: '2026-10', nt: { CSD_CANS150: 1000, AquafinA_330: 50 }, org, sales, avgMonths: ['2026-07', '2026-08', '2026-09'],
      deptChannel: { '2026-09': { MT: { AquafinA_330: 1 }, 'MT SSV': { AquafinA_330: 3 } } },
    });
    const sum = (p: string) => Object.values(r.dm).reduce((s, ch) => s + Object.values(ch).reduce((a, g) => a + (g[p] ?? 0), 0), 0);
    expect(sum('CSD_CANS150')).toBe(1000);
    expect(sum('AquafinA_330')).toBe(50);
    expect(r.basis.CSD_CANS150).toBe('pack_sales');
    // Water: only MT has sales (M2, PAGO) -> all to MT, channels by PAGO channel target 1:3 (tie to the larger)
    expect(r.dm['2']).toMatchObject({ MT: { AquafinA_330: 12 }, 'MT SSV': { AquafinA_330: 38 } });
  });

  it('share of mix rows per department with channel sub-rows', () => {
    const rows = somRows({ period: '2026-10', org, sales, avgMonths: ['2026-07', '2026-08', '2026-09'], cat: 'CSD' });
    expect(rows.map((r) => r.label)).toEqual(['TT', 'MT', 'MT', 'MT SSV']);
    expect(rows[0]!.somPago).toBeCloseTo(0.6);
  });

  it('calculator cascades to routes and reconciles', () => {
    const dept = { '1': { CSD_CANS150: 101 } };
    const { depts } = calculate({ org, dept, sales, avgMonths: ['2026-07', '2026-08', '2026-09'], routeTargets: {} });
    expect(Object.values(depts[0]!.routes).reduce((s, g) => s + (g.CSD_CANS150 ?? 0), 0)).toBe(101);
    // A node with no route under it gets nothing and is never taken for a route.
    expect(Object.keys(depts[0]!.routes).sort()).toEqual(['R1', 'R2']);
    expect(reconciliation(org, dept, depts, null).ok).toBe(true);
  });

  it('CD rows carry the workbook subtotals', () => {
    const cats = new Map([['CSD_CANS150', 'CSD' as const], ['CSD_PET2250', 'CSD' as const], ['AquafinA_330', 'Water' as const], ['LIT_PET500', 'LRB-Others' as const]]);
    const labels = cdRows(['CSD_CANS150', 'CSD_PET2250', 'AquafinA_330', 'LIT_PET500'], cats).map((r) => (r.kind === 'sub' ? r.label : r.pack));
    expect(labels).toEqual(['CSD_CANS150', 'Total CANS', 'Total SSNR', 'CSD_PET2250', 'Total MSPET 2.0/2.2/2.25', 'Total MSPET', 'Total CSD',
      'AquafinA_330', 'Total Water', 'LIT_PET500', 'Total LRB-Others', 'Total LRB']);
  });
});
