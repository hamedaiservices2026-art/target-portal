// The new target process: admin overrides in the cascade, the CD split without
// column J, sub categories, and the new upload layouts.
import { describe, expect, it } from 'vitest';
import { cascade, type CascadeNode } from '../../src/shared/calc/cascade';
import { cdFinal, cdSubmitProblems, type CdWork } from '../../src/shared/calc/cd';
import { categoryOfSub, subCategoryByName, subsOf } from '../../src/shared/calc/packs';
import { packIndex, parseChannelGrid, parseNewTargetByLeaf, parseNewTargetByPack, parsePackMapping } from '../../src/web/cycle/parsers';

const idx = packIndex(['CSD_CANS150', 'CSD_PET2250', 'AquafinA_330', 'LIT_PET500']);

const tree: CascadeNode = {
  id: 'H', children: [
    { id: 'M1', children: [{ id: 'R1', children: [] }, { id: 'R2', children: [] }] },
    { id: 'M2', children: [{ id: 'R3', children: [] }] },
  ],
};
const avg: Record<string, number> = { R1: 30, R2: 10, R3: 60 };
const base = {
  root: tree, packs: ['P'], target: { P: 100 },
  packAvg: (r: string) => avg[r] ?? 0, categoryAvg: () => 0, routeTarget: () => 0,
};

describe('cascade with admin edits', () => {
  it('splits by average sales without edits', () => {
    const r = cascade(base);
    expect(r.nodes.M1!.P).toBe(40);
    expect(r.routes).toEqual({ R1: { P: 30 }, R2: { P: 10 }, R3: { P: 60 } });
    expect(r.issues).toEqual([]);
  });

  it('a fixed manager keeps its number and the siblings share the rest', () => {
    const r = cascade({ ...base, fixed: (n) => (n === 'M1' ? 50 : undefined) });
    expect(r.nodes.M1!.P).toBe(50);
    expect(r.routes.R3!.P).toBe(50);
    expect(r.routes.R1!.P! + r.routes.R2!.P!).toBe(50);
  });

  it('fixed numbers over the parent are reported', () => {
    const r = cascade({ ...base, fixed: (n) => (n === 'M1' ? 70 : n === 'M2' ? 50 : undefined) });
    expect(r.issues.some((i) => i.node === 'H' && i.kind === 'over' && i.cases === 20)).toBe(true);
  });
});

describe('CD split without column J', () => {
  const cats = new Map([['CSD_CANS150', 'CSD'], ['AquafinA_330', 'Water']]);
  const work: CdWork = {
    nt: { CSD_CANS150: 100, AquafinA_330: 10 }, ntOk: true,
    dm: { TT: { 'TT DMM': { CSD_CANS150: 60, AquafinA_330: 4 } }, MT: { MT: { CSD_CANS150: 30 }, 'MT SSV': { CSD_CANS150: 10, AquafinA_330: 6 } } },
    splitNt: { CSD_CANS150: 100, AquafinA_330: 10 }, basis: {}, gm: {}, colJ: {},
  };
  it('is final as split: each department gets the sum of its channels', () => {
    expect(cdSubmitProblems(work, cats, ['TT', 'MT'])).toEqual([]);
    expect(cdFinal(work, cats, ['TT', 'MT'])).toEqual({ TT: { CSD_CANS150: 60, AquafinA_330: 4 }, MT: { CSD_CANS150: 40, AquafinA_330: 6 } });
  });
  it('still refuses a split that does not add up', () => {
    const bad = { ...work, dm: { ...work.dm, TT: { 'TT DMM': { CSD_CANS150: 59, AquafinA_330: 4 } } } };
    expect(cdSubmitProblems(bad, cats, ['TT', 'MT']).join(' ')).toMatch(/don't add up/);
  });
});

describe('sub categories', () => {
  it('names map to SSNR / MSPET / PMIX / Water / LIT / LRB_Other', () => {
    expect(subCategoryByName('AquafinA_330', 'Water')).toBe('Water');
    expect(subCategoryByName('LIT_PET500', 'LRB-Others')).toBe('LIT');
    expect(categoryOfSub('MSPET')).toBe('CSD');
    expect(categoryOfSub('LRB_Other')).toBe('LRB-Others');
    const subs = subsOf('CSD', ['A', 'B', 'C'], (p) => (p === 'A' ? 'PMIX' : 'SSNR'));
    expect(new Set(subs)).toEqual(new Set(['SSNR', 'PMIX']));
  });
});

describe('new upload layouts', () => {
  it('department grid: a value only in "Total MT" goes to the first MT channel; unknown packs are skipped with a warning', () => {
    const r = parseChannelGrid([
      ['', 'Amir', '', '', 'Shehadeh'],
      ['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'MT', 'MT SSV', 'Total MT', 'ABC'],
      ['CSD_CANS150', 300, 200, 500, 100, 50, 150, 650],
      ['AquafinA_330', '', '', '', '', '', 80, 80],
      ['NOT_A_PACK', 1, 1, 2, '', '', '', 2],
    ], ['TT DMM', 'TT Outer', 'MT', 'MT SSV'], idx, { 'TT DMM': 'TT', 'TT Outer': 'TT', MT: 'MT', 'MT SSV': 'MT' });
    expect(r.byChannel.MT).toEqual({ CSD_CANS150: 100, AquafinA_330: 80 });
    expect(r.byChannel['MT SSV']).toEqual({ CSD_CANS150: 50 });
    expect(r.checks.some((c) => c.level === 'warning' && /NOT_A_PACK/.test(c.text))).toBe(true);
    expect(r.checks.some((c) => c.level === 'error')).toBe(false);
  });

  it('LIT_CANS320 and LIT_CANS310+320 are read as LIT_CANS310 (merged pack)', () => {
    const lit = packIndex(['LIT_CANS310', 'LIT_CANS320', 'CSD_CANS150']);
    const g = parseChannelGrid([
      ['Pack', 'TT DMM', 'MT'],
      ['LIT_CANS310+320', 100, 40],
      ['LIT_CANS320', 5, 0],
    ], ['TT DMM', 'MT'], lit);
    expect(g.byChannel['TT DMM']).toEqual({ LIT_CANS310: 105 });
    expect(g.byChannel.MT).toEqual({ LIT_CANS310: 40 });
    expect(g.checks.some((c) => c.level === 'warning')).toBe(false);
    const nt = parseNewTargetByPack([['Sales Target Category', 'Cases'], ['LIT_CANS310', 7], ['LIT_CANS320', 3]], '2026-12', lit);
    expect(nt.byPack).toEqual({ LIT_CANS310: 10 });
  });

  it('Key Accounts by pack, KAM and KAE', () => {
    const r = parseNewTargetByLeaf([
      ['Period (YYYYMM)', 'KAM', 'KAE ID', 'Sales Target Category', 'Cases'],
      [202611, 'Ali', 'K1', 'CSD_CANS150', 10],
      [202611, 'Ali', 'K2', 'CSD_CANS150', 5],
      [202611, 'Sara', 'K3', 'AquafinA_330', 7],
      [202610, 'Sara', 'K3', 'AquafinA_330', 99],
    ], '2026-11', idx);
    expect(r.byPack).toEqual({ CSD_CANS150: 15, AquafinA_330: 7 });
    expect(r.byLeaf.K1).toEqual({ CSD_CANS150: 10 });
    expect(r.byKam.Sara).toEqual({ AquafinA_330: 7 });
  });

  it('pack mapping file', () => {
    const r = parsePackMapping([
      ['Sales Target Category', 'Pacage'],
      ['CSD_CANS150', 'SSNR'],
      ['AquafinA_330', 'Water'],
      ['NOPE', 'LIT'],
    ], idx);
    expect(r.map).toEqual({ CSD_CANS150: 'SSNR', AquafinA_330: 'Water' });
    expect(r.checks.some((c) => /NOPE/.test(c.text))).toBe(true);
  });
});

describe('sales hierarchy file', () => {
  it('reads the Hierarchy.xlsx layout (title rows above, blank rows skipped)', async () => {
    const { parseHierarchySheet } = await import('../../src/web/cycle/hierarchyFile');
    const r = parseHierarchySheet([
      ['Sales hierarchy'],
      ['Channel Head', 'Sales Manager', 'Sales Supervisor', 'Route Code'],
      ['Amir Elnagar', 'Hussain Alsaleem', 'Mahdi Altawat', 314037],
      [null, null, null, null],
      ['Samir Najm', 'Samir Najm', 'Omar', '514001'],
    ]);
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([
      { head: 'Amir Elnagar', manager: 'Hussain Alsaleem', supervisor: 'Mahdi Altawat', route: '314037', ds: '' },
      { head: 'Samir Najm', manager: 'Samir Najm', supervisor: 'Omar', route: '514001', ds: '' },
    ]);
    expect(parseHierarchySheet([['Name', 'Code']]).error).toBe('no_header');
  });
});
