import { describe, expect, it } from 'vitest';
import { defaultDeptSplit, type Org } from '../../src/web/cycle/compute';
import { channelRank, deptColumns, sortChannels } from '../../src/web/cycle/deptOrder';
import { parseHierarchySheet } from '../../src/web/cycle/hierarchyFile';
import { achievement, upliftPct } from '../../src/web/cycle/kaUplift';
import { packIndex, parseChannelGrid, parsePrevTargets, parseSales } from '../../src/web/cycle/parsers';

const idx = packIndex(['CSD_CANS150', 'AquafinA_330']);

describe('department target file order', () => {
  it('orders channels as the file and adds Total TT and Total MT columns', () => {
    expect(sortChannels(['WS', 'MT Bulk', 'MT', 'HoReCa', 'MT SSV', 'TT Outer', 'TT DMM'])).toEqual(['TT DMM', 'TT Outer', 'MT', 'MT SSV', 'MT Bulk', 'HoReCa', 'WS']);
    expect(channelRank('Non Retail')).toBeLessThan(channelRank('WS'));
    const cols = [
      { id: '1', name: 'Amir', chans: ['TT DMM'] }, { id: '2', name: 'Agwa', chans: ['TT Outer'] },
      { id: '3', name: 'Shehata', chans: ['MT', 'MT SSV', 'MT Bulk'] }, { id: '4', name: 'Samer', chans: ['HoReCa'] }, { id: '5', name: 'Samir', chans: ['WS'] },
    ];
    const { flat, heads } = deptColumns(cols, (n) => `Total ${n}`);
    expect(flat.map((x) => (x.kind === 'cell' ? x.c : x.label))).toEqual(['TT DMM', 'TT Outer', 'Total TT', 'MT', 'MT SSV', 'MT Bulk', 'Total MT', 'HoReCa', 'WS']);
    expect(heads.map((h) => (h.kind === 'dept' ? `${h.d.name}:${h.span}` : h.label))).toEqual(['Amir:1', 'Agwa:1', 'Total TT', 'Shehata:3', 'Total MT', 'Samer:1', 'Samir:1']);
  });
});

describe('previous targets by department', () => {
  const channels = ['TT DMM', 'TT Outer', 'MT', 'MT SSV', 'MT Bulk', 'HoReCa', 'WS'];
  it('older months: "Total MT" alone, or "MT PS", count for MT', () => {
    const apr = parseChannelGrid([
      ['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'Total MT', 'HoReCa', 'WS', 'ABC'],
      ['CSD_CANS150', 10, 20, 30, 40, 5, 6, 81],
    ], channels, idx);
    expect(apr.byChannel.MT).toEqual({ CSD_CANS150: 40 });
    const oct = parseChannelGrid([
      ['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'MT PS', 'MT Bulk', 'Total MT', 'HoReCa', 'WS', 'ABC'],
      ['CSD_CANS150', 10, 20, 30, 23, 15, 38, 5, 6, 79],
    ], channels, idx);
    expect(oct.byChannel.MT).toEqual({ CSD_CANS150: 23 });
    expect(oct.byChannel['MT Bulk']).toEqual({ CSD_CANS150: 15 });
  });

  it('the CD split follows the previous targets of the months picked', () => {
    const org: Org = {
      depts: [
        { id: 1, code: 'TT', name: 'TT', sort: 0, channels: [{ channel: 'TT DMM', grp: '' }] },
        { id: 2, code: 'MT', name: 'MT', sort: 1, channels: [{ channel: 'MT', grp: '' }, { channel: 'MT SSV', grp: '' }] },
      ],
      nodes: [], leaves: [],
      packs: [{ code: 'CSD_CANS150', grp: 'CSD', active: true, sort: 1 }],
    };
    const deptChannel = {
      '2026-08': { 'TT DMM': { CSD_CANS150: 100 }, MT: { CSD_CANS150: 200 }, 'MT SSV': { CSD_CANS150: 100 } },
      '2026-09': { 'TT DMM': { CSD_CANS150: 100 }, MT: { CSD_CANS150: 200 }, 'MT SSV': { CSD_CANS150: 100 } },
    };
    const r = defaultDeptSplit({ period: '2026-10', nt: { CSD_CANS150: 800 }, org, sales: {}, avgMonths: ['2026-08', '2026-09'], deptChannel, byPrevTarget: true });
    expect(r.basis.CSD_CANS150).toBe('prev_target');
    expect(r.dm).toEqual({ 1: { 'TT DMM': { CSD_CANS150: 200 } }, 2: { MT: { CSD_CANS150: 400 }, 'MT SSV': { CSD_CANS150: 200 } } });
  });
});

describe('Key Accounts', () => {
  it('reads the MDM / KAM / KAE hierarchy', () => {
    const r = parseHierarchySheet([
      [null],
      ['MDM Name', 'MDM ID', 'KAM Name', 'KAM ID', 'KAE Name', 'KAE ID'],
      ['Mohammed Shehadeh', '41232', 'Abdelhamid Selim', '41455', 'Mohammed Aref Ibrahim', '41461'],
      ['Samer Saleh', '41333', 'Steve Ahmed', '40059', 'Steve Ahmed', '40059'],
    ]);
    expect(r.ka).toBe(true);
    expect(r.rows[0]).toEqual({ head: 'Mohammed Shehadeh', manager: 'Abdelhamid Selim', supervisor: 'Mohammed Aref Ibrahim', route: '41461', ds: '' });
  });

  it('reads the KA sales and previous target files', () => {
    const s = parseSales([
      [null],
      ['Year', 'Year Month', 'MDM Name', 'MDM ID', 'KAM Name', 'KAM ID', 'KAE Name', 'KAE ID', 'Product Category', 'Sales Target Category', 'Total Invoiced Cases'],
      [2026, '2026-09', 'Mohammed Shehadeh - LF', '41232', 'Abdelhamid Selim', '41455', 'Mohammed Aref Ibrahim', '41461', 'CSD', 'CSD_CANS150', 1950.38],
    ], idx);
    expect(s.data).toEqual({ '2026-09': { 41461: { CSD_CANS150: 1950.38 } } });
    const t = parsePrevTargets([
      [null],
      ['Year Month', 'MDM Name', 'MDM ID', 'KAM Name', 'KAM ID', 'KAE Name', 'KAE ID', 'Product Category', 'Target Category', 'MD Target Cases'],
      ['2026-09', 'Mohammed Shehadeh - LF', '41232', 'Abdelhamid Selim', '41455', 'Mohammed Aref Ibrahim', '41461', 'CSD', 'CSD_CANS150', 2000],
    ], idx);
    expect(t.data).toEqual({ '2026-09': { 41461: { CSD_CANS150: 2000 } } });
  });

  it('uplift: sold above target by pack, kept within 1% to 3%; total when no pack target; the minimum otherwise', () => {
    const sales = { '2026-08': { K: { CSD_CANS150: 102, AquafinA_330: 50 } }, '2026-09': { K: { CSD_CANS150: 104, AquafinA_330: 50 } } };
    const prev = { '2026-08': { K: { CSD_CANS150: 100 } }, '2026-09': { K: { CSD_CANS150: 100 } } };
    const a = achievement('K', ['2026-08', '2026-09'], sales, prev);
    expect(upliftPct(a, 'CSD_CANS150', 1, 3)).toBeCloseTo(3); // 206 / 200 - 1 = 3%
    expect(upliftPct(a, 'AquafinA_330', 1, 3)).toBe(3); // no pack target: total 306 / 200 - 1 = 53% -> 3%
    const low = achievement('K', ['2026-08'], { '2026-08': { K: { CSD_CANS150: 90 } } }, prev);
    expect(upliftPct(low, 'CSD_CANS150', 1, 3)).toBe(1);
    expect(upliftPct(achievement('X', ['2026-08'], sales, prev), 'CSD_CANS150', 1, 3)).toBe(1);
    const mid = achievement('K', ['2026-08'], { '2026-08': { K: { CSD_CANS150: 102 } } }, prev);
    expect(upliftPct(mid, 'CSD_CANS150', 1, 3)).toBeCloseTo(2);
  });
});
