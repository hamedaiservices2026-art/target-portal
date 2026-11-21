import { describe, expect, it } from 'vitest';
import { addMonths, defaultAvgMonths, pago, parseMonth, yago } from '../../../src/shared/calc/periods';
import { categoryByName, cdSubtotals, editableGroupOf, packKey, summaryGroups } from '../../../src/shared/calc/packs';

describe('periods', () => {
  it('PAGO, YAGO and the default 3-month window for Oct 2026', () => {
    expect(pago('2026-10')).toBe('2026-09');
    expect(yago('2026-10')).toBe('2025-10');
    expect(defaultAvgMonths('2026-10')).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 13)).toBe('2027-01');
  });

  it.each([
    ['2026-09', '2026-09'],
    [202609, '2026-09'],
    ['202609', '2026-09'],
    ['Sep-26', '2026-09'],
    ['Sep 2026', '2026-09'],
    ['September 2026', '2026-09'],
    ['sept-2026', '2026-09'],
    ['09/2026', '2026-09'],
    ['2026-09-01', '2026-09'],
    [46266, '2026-09'], // Excel serial for 2026-09-01
    [new Date(Date.UTC(2026, 8, 15)), '2026-09'],
  ])('parses %s', (input, out) => {
    expect(parseMonth(input)).toBe(out);
  });

  it.each([['Route Code'], ['2026-13'], ['Septembre 2026'], [''], [null], ['Cases']])('rejects %s', (input) => {
    expect(parseMonth(input)).toBeNull();
  });
});

describe('packs', () => {
  it('matches names ignoring underscores, spaces and case', () => {
    expect(packKey('CSD_CANS150')).toBe(packKey('csd cans150'));
  });

  it('categorises by name', () => {
    expect(categoryByName('AquafinA_330')).toBe('Water');
    expect(categoryByName('CSD_PET1000')).toBe('CSD');
    expect(categoryByName('PMIX')).toBe('CSD');
    expect(categoryByName('STING_250')).toBe('CSD');
    expect(categoryByName('STING_ENERGY_500')).toBe('LRB-Others');
    expect(categoryByName('LIT_PET500')).toBe('LRB-Others');
  });

  it('CD subtotals', () => {
    expect(cdSubtotals('CSD_CANS150')).toEqual(['CANS', 'SSNR', 'CSD', 'LRB']);
    expect(cdSubtotals('STING_240')).toEqual(['CANS', 'SSNR', 'CSD', 'LRB']);
    expect(cdSubtotals('CSD_NRB250')).toEqual(['SSNR', 'CSD', 'LRB']);
    expect(cdSubtotals('CSD_PET2250')).toEqual(['MSPET2', 'MSPET', 'CSD', 'LRB']);
    expect(cdSubtotals('CSD_PET1000')).toEqual(['MSPET', 'CSD', 'LRB']);
    expect(cdSubtotals('AquafinA_330')).toEqual(['Water', 'LRB']);
  });

  it('distribution summary groups', () => {
    expect(summaryGroups('CSD_CANS150')).toEqual(['SSNR', 'Total CSD', 'Total']);
    expect(summaryGroups('CSD_PET2000')).toEqual(['MPT', 'Total CSD', 'Total']);
    expect(summaryGroups('PMIX')).toEqual(['PMIX', 'Total CSD', 'Total']);
    expect(summaryGroups('AquafinA_330')).toEqual(['Water', 'Total']);
    expect(summaryGroups('LIT_PET500')).toEqual(['LIT', 'Total LRB-Others', 'Total']);
    expect(summaryGroups('GATORADE_500')).toEqual(['Other LRB', 'Total LRB-Others', 'Total']);
    expect(editableGroupOf('CSD_PET500')).toBeNull();
  });

  it('the pack master overrides the name rule', () => {
    const master = new Map([[packKey('STING_250'), 'LRB-Others' as const]]);
    expect(summaryGroups('STING_250', master)).toEqual(['Other LRB', 'Total LRB-Others', 'Total']);
  });
});
