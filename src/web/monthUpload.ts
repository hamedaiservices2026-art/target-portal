// Pure helpers for the forecast upload on the month page: the optional Sheet 1
// (department total per pack), totals per pack group, and the 200-leaf batches.
import type { LeafGrid } from '../shared/forecast';
import type { Grid, PackGroup } from '../shared/types';

export const BATCH_SIZE = 200;

export type Sheet1 = {
  totals: Grid;
  /** Rows whose first cell is a pack code but whose total is not a number of zero or more. */
  invalid: { line: number; pack: string }[];
  /** Rows that look like data (text in the pack column, a number as total) but whose pack is not a pack of the month. */
  unrecognised: { line: number; pack: string; total: number }[];
};

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, '');
const PACK_HEADERS = new Set(['pack', 'packcode', 'salestargetcategory', 'category']);
const TOTAL_HEADERS = new Set(['total', 'cases', 'totalcases', 'target']);

function cellText(c: unknown): string {
  return c === null || c === undefined || c instanceof Date ? '' : String(c).trim();
}

function cellNumber(c: unknown): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  if (typeof c === 'string' && c.trim() !== '') {
    const n = Number(c.trim().replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Reads a Sheet 1 file: one pack code and its total per row. The columns are the
 * ones headed Pack (or Sales Target Category) and Total (or Cases) when such a
 * header row exists, else the first two. Rows whose pack cell is not a pack of the
 * month are ignored: the header and subtotals like "Total CANS" quietly, any other
 * row with a number is listed in `unrecognised`. An empty total is skipped (compared
 * as 0). A pack listed twice is added up.
 */
export function parseSheet1(rows: unknown[][], packs: string[]): Sheet1 {
  let cPack = 0;
  let cTotal = 1;
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const keys = r.map((c) => (typeof c === 'string' ? squash(c) : ''));
    const p = keys.findIndex((k) => PACK_HEADERS.has(k));
    const tot = keys.findIndex((k) => TOTAL_HEADERS.has(k));
    if (p >= 0 && tot >= 0) {
      cPack = p;
      cTotal = tot;
      break;
    }
  }
  const known = new Set(packs);
  const totals: Grid = {};
  const invalid: Sheet1['invalid'] = [];
  const unrecognised: Sheet1['unrecognised'] = [];
  rows.forEach((r, i) => {
    if (!Array.isArray(r)) return;
    const pack = cellText(r[cPack]);
    if (!known.has(pack)) {
      // Subtotals ("Total CANS", "Total LRB ") and header rows are expected; anything else with a number is worth a note.
      const n = cellNumber(r[cTotal]);
      if (pack !== '' && n !== null && !/^total\b/i.test(pack) && !PACK_HEADERS.has(squash(pack))) {
        unrecognised.push({ line: i + 1, pack, total: n });
      }
      return;
    }
    const blank = r[cTotal] === null || r[cTotal] === undefined || (typeof r[cTotal] === 'string' && (r[cTotal] as string).trim() === '');
    if (blank) return; // an empty total (like PMIX in the TT file) means no target: compared as 0
    const n = cellNumber(r[cTotal]);
    if (n === null || n < 0) {
      invalid.push({ line: i + 1, pack });
      return;
    }
    totals[pack] = (totals[pack] ?? 0) + n;
  });
  return { totals, invalid, unrecognised };
}

/** Cases per pack group, in the fixed group order, plus the grand total. */
export function groupTotals(packTotals: Grid, packs: { code: string; grp: string }[]): { groups: { grp: PackGroup; cases: number }[]; total: number } {
  const order: PackGroup[] = ['CSD', 'Water', 'LRB-Others'];
  const sums = new Map<string, number>(order.map((g) => [g, 0]));
  let total = 0;
  for (const p of packs) {
    const v = packTotals[p.code] ?? 0;
    sums.set(p.grp, (sums.get(p.grp) ?? 0) + v);
    total += v;
  }
  return { groups: order.map((grp) => ({ grp, cases: sums.get(grp) ?? 0 })), total };
}

/** The body of the batch requests: only what the server reads, at most BATCH_SIZE leaves each. */
export function toBatches(grids: LeafGrid[], size = BATCH_SIZE): { leafId: number; salesmanId: string; values: Grid }[][] {
  const out: { leafId: number; salesmanId: string; values: Grid }[][] = [];
  for (let i = 0; i < grids.length; i += size) {
    out.push(grids.slice(i, i + size).map((g) => ({ leafId: g.leafId, salesmanId: g.salesmanId, values: g.values })));
  }
  return out;
}
