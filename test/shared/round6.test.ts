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
