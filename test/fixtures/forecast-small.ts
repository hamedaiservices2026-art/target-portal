import type { RawRow } from '../../src/shared/forecast';

export const DS = 'Presell – TT'; // en dash, as in the real TT DMM file

export const HEADER = ['Period (YYYY-MM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases'];

export const PACKS = ['PEP', 'MIR', 'AQUA', 'LIPTON'];

/** leaf key -> leafId */
export const LEAVES = new Map<string, number>([
  [`${DS}|314019`, 1],
  [`${DS}|314037`, 2],
  [`${DS}|314050`, 3],
  [`${DS}|314060`, 4],
]);

export function row(line: number, route: string, pack: string, cases: number | null, salesman = 'S1', period = '2026-10', ds = DS): RawRow {
  return { line, period, deliverySystem: ds, routeCode: route, salesmanId: salesman, pack, cases };
}

/**
 * Synthetic file copying the TT DMM quirks:
 * - 314019: clean, decimal cases;
 * - 314037: one stray row under another salesman ID (S9);
 * - 314050: blank salesman;
 * - 314060: not present (leaf exists in the hierarchy but not in this file).
 * Pack LIPTON is absent from the file entirely.
 */
export const CLEAN_ROWS: RawRow[] = [
  row(2, '314019', 'PEP', 83.03),
  row(3, '314019', 'MIR', 10),
  row(4, '314037', 'PEP', 728.96, 'S2'),
  row(5, '314037', 'MIR', 5, 'S2'),
  row(6, '314037', 'AQUA', 0, 'S9'),
];

/** As Excel rows (what read-excel-file returns), with numeric codes, a Date period and a template tail. */
export function excelRows(): unknown[][] {
  return [
    ['Some title row'],
    HEADER,
    [new Date(Date.UTC(2026, 9, 1)), DS, 314019, 5101, 'PEP', 83.03],
    ['2026-10', ` ${DS} `, '314037', '5102', 'PEP', '728.96'],
    ['2026/10', DS, 314050, null, 'MIR', null],
    [null, null, null, null, null, null],
    [null, null, null, null, 'PEP', null],
  ];
}
