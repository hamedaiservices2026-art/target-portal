import { describe, expect, it } from 'vitest';
import { cdReconcile, cdSubmitProblems, type CdWork } from '../../src/shared/calc/cd';
import { deptColumns, fileHeads, matchHeads, orderedDeptCols } from '../../src/web/cycle/deptOrder';

const ROWS = [[null, 'Amir Elnagar', 'Mohamed Agwa', null, 'Mohamed shehata', null, null, null, 'Samer Elsalah', 'Samir Nigm', null],
  ['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'MT', 'MT SSV', 'MT Bulk', 'Total MT', 'HoReCa', 'WS', 'ABC']];

describe('department columns of the CD screen', () => {
  it('reads the Heads and channels of the department target file', () => {
    expect(fileHeads(ROWS)).toEqual([
      { head: 'Amir Elnagar', channels: ['TT DMM'] }, { head: 'Mohamed Agwa', channels: ['TT Outer'] },
      { head: 'Mohamed shehata', channels: ['MT', 'MT SSV', 'MT Bulk'] }, { head: 'Samer Elsalah', channels: ['HoReCa'] }, { head: 'Samir Nigm', channels: ['WS'] },
    ]);
  });

  it('matches the file names to the departments even when spelled differently', () => {
    const depts = ['Samer Saleh', 'Mohammed Shehadeh', 'Mohamed Agwa', 'Amir Elnagar', 'Samir Najm'].map((name, i) => ({ id: i + 1, name, code: `D${i}`, channels: [] }));
    const m = matchHeads(fileHeads(ROWS), depts);
    expect(m.map((x) => [x.head, x.deptId])).toEqual([['Amir Elnagar', 4], ['Mohamed Agwa', 3], ['Mohamed shehata', 2], ['Samer Elsalah', 1], ['Samir Nigm', 5]]);
  });

  it('lays out the columns as TT DMM, TT Outer, Total TT, MT, MT SSV, MT Bulk, Total MT, HoReCa, WS', () => {
    const depts = [
      { id: 1, name: 'Samer', code: 'S', channels: [{ channel: 'HoReCa' }] },
      { id: 2, name: 'Shehata', code: 'M', channels: [{ channel: 'MT Bulk' }, { channel: 'MT' }, { channel: 'MT SSV' }] },
      { id: 3, name: 'Agwa', code: 'A', channels: [{ channel: 'TT Outer' }] },
      { id: 4, name: 'Amir', code: 'E', channels: [{ channel: 'TT DMM' }] },
      { id: 5, name: 'Samir', code: 'W', channels: [{ channel: 'WS' }] },
    ];
    const { flat } = deptColumns(orderedDeptCols(depts, '_'), (n) => `Total ${n}`);
    expect(flat.map((x) => (x.kind === 'cell' ? x.c : x.label))).toEqual(['TT DMM', 'TT Outer', 'Total TT', 'MT', 'MT SSV', 'MT Bulk', 'Total MT', 'HoReCa', 'WS']);
  });
});

describe('the CD changes the target freely', () => {
  it('the New Target follows the department cells, so the split can be submitted', () => {
    const work: CdWork = {
      nt: { CSD_CANS150: 100, AquafinA_330: 50 }, ntOk: true, splitNt: { CSD_CANS150: 100, AquafinA_330: 50 }, basis: {}, gm: {}, colJ: {},
      dm: { 1: { 'TT DMM': { CSD_CANS150: 80, AquafinA_330: 50 } }, 2: { MT: { CSD_CANS150: 45 } } },
    };
    const cats = new Map([['CSD_CANS150', 'CSD'], ['AquafinA_330', 'Water']]);
    expect(cdSubmitProblems(work, cats, ['1', '2']).join(' ')).toMatch(/don't add up/);
    const r = cdReconcile(work);
    expect(r.nt).toEqual({ CSD_CANS150: 125, AquafinA_330: 50 });
    expect(cdSubmitProblems(r, cats, ['1', '2'])).toEqual([]);
  });
});

import { channelGridSheet } from '../../src/web/cycle/templates';
import { cdRows } from '../../src/web/cycle/compute';

describe('department template and tables follow the department file', () => {
  const ch = (...c: string[]) => c.map((channel) => ({ channel, grp: '' }));
  const packs = ['CSD_CANS150', 'STING_240', 'CSD_CANS240', 'CSD_NRB', 'CSD_SSPET250', 'CSD_SSPET400', 'CSD_PET1000', 'CSD_PET2000', 'CSD_PET2250', 'PMIX']
    .map((code, i) => ({ code, grp: 'CSD', active: true, sort: 100 - i, sub: null }));
  const org = {
    depts: [
      { id: 1, code: 'S', name: 'Samer Saleh', sort: 0, channels: ch('HoReCa') },
      { id: 2, code: 'M', name: 'Mohammed Shehadeh', sort: 0, channels: ch('MT', 'MT SSV', 'MT Bulk') },
      { id: 3, code: 'A', name: 'Mohamed Agwa', sort: 0, channels: ch('TT Outer') },
      { id: 4, code: 'E', name: 'Amir Elnagar', sort: 0, channels: ch('TT DMM') },
      { id: 5, code: 'W', name: 'Samir Najm', sort: 0, channels: ch('WS') },
    ],
    nodes: [], leaves: [], packs,
  };
  it('template columns and rows', () => {
    const s = channelGridSheet(org as never, 'X', null);
    const v = (r: number) => s.data[r]!.map((c) => (c && typeof c === 'object' ? c.value : c));
    expect(v(0)).toEqual([null, 'Amir Elnagar', 'Mohamed Agwa', null, 'Mohammed Shehadeh', null, null, null, 'Samer Saleh', 'Samir Najm', null]);
    expect(v(1)).toEqual(['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'MT', 'MT SSV', 'MT Bulk', 'Total MT', 'HoReCa', 'WS', 'ABC']);
    expect(s.data.slice(2).map((r) => (r[0] as { value: string }).value)).toEqual(['CSD_CANS150', 'STING_240', 'CSD_CANS240', 'Total CANS', 'CSD_NRB', 'CSD_SSPET250', 'CSD_SSPET400',
      'Total SSNR', 'CSD_PET1000', 'CSD_PET2000', 'CSD_PET2250', 'Total BIG MSPET', 'Total MSPET', 'PMIX', 'Total CSD', 'Total Water', 'Total LIT', 'Total ROCKSTAR', 'Total Sting Energy', 'Total Britvic', 'Total LRB-Others', 'Total LRB']);
  });
  it('table rows', () => {
    const cats = new Map(packs.map((p) => [p.code, 'CSD' as const]));
    const labels = cdRows(packs.map((p) => p.code), cats).map((r) => (r.kind === 'sub' ? r.label : r.pack));
    expect(labels.slice(0, 4)).toEqual(['CSD_CANS150', 'STING_240', 'CSD_CANS240', 'Total CANS']);
    expect(labels).toContain('Total MSPET');
  });
});
