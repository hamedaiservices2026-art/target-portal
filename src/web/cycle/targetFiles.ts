// The target files the company loads into its sales system: MTFL (Operation,
// by route and salesman) and MDD (Key Accounts, by KAE / KAM). The admin's
// export of the target is written in exactly these layouts, and the same
// layouts can be uploaded instead of using the system calculation.
import type { Grid } from './compute';

/** Format of a delivery system, as the company's files write it. */
export function formatOf(ds: string, known?: Record<string, string>): string {
  const k = known?.[ds];
  if (k) return k;
  const s = ` ${ds.toLowerCase().replace(/[^a-z]+/g, ' ')} `;
  if (/ (tt|traditional) /.test(s)) return 'Small';
  if (/ (mt|modern) /.test(s)) return 'Large';
  if (/ horeca | non retail | nonretail /.test(s)) return 'Non-Retail';
  if (/ wholesale /.test(s)) return 'Wholesale';
  return '';
}

export type TargetLine = { ds: string; code: string; salesman?: string; grid: Grid; packs: string[] };

const asId = (v: string): string | number => (/^\d{1,15}$/.test(v) ? Number(v) : v);

type Cell = { value: string | number | Date; type?: unknown; format?: string } | null;

/** Rows of the file: every pack of each line, 0s included, Amount left empty. */
export function targetRows(kind: 'mtfl' | 'mdd', period: string, lines: TargetLine[], formats?: Record<string, string>): (string | number | null)[][] {
  const out: (string | number | null)[][] = [];
  for (const x of lines) {
    const f = formatOf(x.ds, formats);
    for (const p of x.packs) {
      const n = x.grid[p] ?? 0;
      out.push(kind === 'mtfl'
        ? [period, x.ds, asId(x.code), x.salesman ? asId(x.salesman) : null, p, n, null, f]
        : [period, x.ds, asId(x.code), p, n, null, f]);
    }
  }
  return out;
}

export const MTFL_COLUMNS = ['Period (YYYYMM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases', 'Amount', 'Format'];
export const MDD_COLUMNS = ['Period (YYYYMM)', 'Delivery System', 'KAE / KAM', 'Sales Target Category', 'Cases', 'Amount', 'Format'];

/** Writes the MTFL (Sheet1) or MDD (SalesTarget_MDD) file. */
export async function writeTargetFile(kind: 'mtfl' | 'mdd', file: string, period: string, lines: TargetLine[], opts: { preparedBy?: string; formats?: Record<string, string> } = {}): Promise<void> {
  const { default: write } = await import('write-excel-file/browser');
  const now = new Date();
  const date: Cell = { value: now, type: Date, format: 'm/d/yy h:mm' };
  const head: Cell[][] = kind === 'mtfl'
    ? [[{ value: 'Creation Date:' }, date]]
    : [[{ value: 'Prepared by' }, { value: opts.preparedBy ?? '' }], [{ value: 'Creation Date:' }, date]];
  const cols = kind === 'mtfl' ? MTFL_COLUMNS : MDD_COLUMNS;
  const data: Cell[][] = [
    ...head,
    cols.map((value) => ({ value })),
    ...targetRows(kind, period, lines, opts.formats).map((r) => r.map((v) => (v === null ? null : { value: v }))),
  ];
  const widths = kind === 'mtfl' ? [16, 17, 12, 17, 22, 8, 8, 12] : [16, 14, 10, 22, 8, 8, 12];
  await (write as unknown as (d: unknown) => { toFile: (f: string) => Promise<void> })([
    { sheet: kind === 'mtfl' ? 'Sheet1' : 'SalesTarget_MDD', data, columns: widths.map((width) => ({ width })) },
  ]).toFile(file);
}
