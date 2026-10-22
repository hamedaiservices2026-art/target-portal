/**
 * Forecast file checks. Pure module: runs in the browser before upload.
 *
 * `normalizeForecastRows` turns the cells read from Excel into typed rows;
 * `checkForecast` applies the upload checks (spec section 10) and builds the full grid.
 */
import { largestRemainder } from './rounding';
import type { Grid, Issue, PackCode } from './types';

export interface RawRow {
  line: number; // 1-based Excel row number
  period: string;
  deliverySystem: string;
  routeCode: string;
  salesmanId: string;
  pack: string;
  /** null = blank cell (counts as 0, warning blank_cases); NaN = not a number (error bad_cases). */
  cases: number | null;
}

export interface LeafGrid {
  leafId: number;
  deliverySystem: string;
  routeCode: string;
  salesmanId: string;
  values: Grid;
}

export interface ForecastCheck {
  errors: Issue[];
  warnings: Issue[];
  grids: LeafGrid[];
  packTotals: Grid;
}

export interface ForecastContext {
  period: string;
  packs: PackCode[];
  leaves: Map<string, number>; // "deliverySystem|routeCode" -> leafId
  takenLeafIds: Set<number>;
}

// ---------------------------------------------------------------- normalize

const HEADER_NAMES = [
  'Period (YYYY-MM)',
  'Delivery System',
  'Route Code',
  'Salesman ID',
  'Sales Target Category',
  'Cases',
] as const;

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, '');
// Accepted spellings per column. The owner's TT DMM file heads the first column "Period (YYYYMM)".
const HEADER_KEYS: string[][] = HEADER_NAMES.map((n) => (n === 'Period (YYYY-MM)' ? [squash(n), 'period(yyyymm)'] : [squash(n)]));

function isBlank(cell: unknown): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

function text(cell: unknown): string {
  if (isBlank(cell)) return '';
  if (cell instanceof Date) return '';
  return String(cell).trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function periodText(cell: unknown): string {
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return '';
    return `${cell.getUTCFullYear()}-${pad2(cell.getUTCMonth() + 1)}`;
  }
  const s = text(cell);
  const m = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s);
  if (m) return `${m[1]}-${pad2(Number(m[2]))}`;
  return s; // anything else stays as text and fails the period check
}

/** null for a blank cell, NaN for anything that is not a number. */
function casesValue(cell: unknown): number | null {
  if (isBlank(cell)) return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : Number.NaN;
  if (typeof cell === 'string') {
    const n = Number(cell.trim());
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

/** Thrown when no row of the sheet contains all six expected column names. */
export class ForecastHeaderError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Header row not found. Missing columns: ${missing.join(', ')}`);
    this.name = 'ForecastHeaderError';
    this.missing = missing;
  }
}

function findHeader(rows: unknown[][]): { index: number; cols: number[] } {
  let bestMissing: string[] = [...HEADER_NAMES];
  let bestFound = 0;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    if (!Array.isArray(cells)) continue;
    const keys = cells.map((c) => (typeof c === 'string' ? squash(c) : ''));
    const cols = HEADER_KEYS.map((alts) => keys.findIndex((k) => alts.includes(k)));
    const found = cols.filter((c) => c >= 0).length;
    if (found === HEADER_KEYS.length) return { index: i, cols };
    if (found > bestFound) {
      bestFound = found;
      bestMissing = HEADER_NAMES.filter((_, k) => cols[k]! < 0);
    }
  }
  throw new ForecastHeaderError(bestMissing);
}

/**
 * Finds the header row (throws ForecastHeaderError if there is none), then reads the rows below it. A row is skipped as
 * blank when Period, Delivery System, Route Code, Salesman ID and Cases are all
 * blank (this also drops the real file's template tail, which has only the pack
 * column filled).
 */
export function normalizeForecastRows(rows: unknown[][]): RawRow[] {
  const header = findHeader(rows);
  const [cPeriod, cDs, cRoute, cSales, cPack, cCases] = header.cols as [number, number, number, number, number, number];
  const out: RawRow[] = [];
  for (let i = header.index + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const blank = [cPeriod, cDs, cRoute, cSales, cCases].every((c) => isBlank(cells[c]));
    if (blank) continue;
    out.push({
      line: i + 1,
      period: periodText(cells[cPeriod]),
      deliverySystem: text(cells[cDs]),
      routeCode: text(cells[cRoute]),
      salesmanId: text(cells[cSales]),
      pack: text(cells[cPack]),
      cases: casesValue(cells[cCases]),
    });
  }
  return out;
}

// ------------------------------------------------------------------- check

interface LeafAcc {
  leafId: number;
  deliverySystem: string;
  routeCode: string;
  firstLine: number;
  values: Map<PackCode, number>;
  salesmen: Map<string, number>; // non-blank ID -> row count, insertion order = first appearance
  hasBlankSalesman: boolean;
  blankCases: number;
}

export function checkForecast(rows: RawRow[], ctx: ForecastContext): ForecastCheck {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: Issue['code'], line: number, detail: string) => errors.push({ level: 'error', code, line, detail });
  const warn = (code: Issue['code'], detail: string, line?: number) =>
    warnings.push(line === undefined ? { level: 'warning', code, detail } : { level: 'warning', code, line, detail });

  if (rows.length === 0) {
    errors.push({ level: 'error', code: 'no_rows', detail: 'The file has a header but no data rows.' });
  }

  const packSet = new Set(ctx.packs);
  const packsInFile = new Set<string>();
  const seenPair = new Map<string, number>(); // `${leafId}|${pack}` -> first line
  const reportedLeaf = new Set<string>();
  const leaves = new Map<number, LeafAcc>();

  for (const r of rows) {
    const ds = r.deliverySystem.trim();
    const route = r.routeCode.trim();
    const pack = r.pack.trim();
    const salesman = r.salesmanId.trim();
    const leafKey = `${ds}|${route}`;
    packsInFile.add(pack);
    let ok = true;

    const packKnown = packSet.has(pack);
    if (!packKnown) {
      ok = false;
      err('unknown_pack', r.line, `Pack "${pack}" is not in the pack list.`);
    }

    if (r.period.trim() !== ctx.period) {
      ok = false;
      err('period_mismatch', r.line, `Period "${r.period}" does not match the month being opened (${ctx.period}).`);
    }

    const leafId = ctx.leaves.get(leafKey);
    let leafUsable = false;
    if (leafId === undefined) {
      ok = false;
      if (!reportedLeaf.has(leafKey)) {
        reportedLeaf.add(leafKey);
        err('unmapped_leaf', r.line, `Route ${route} (${ds}) is not placed under any node in the hierarchy.`);
      }
    } else if (ctx.takenLeafIds.has(leafId)) {
      ok = false;
      if (!reportedLeaf.has(leafKey)) {
        reportedLeaf.add(leafKey);
        err('leaf_in_other_file', r.line, `Route ${route} (${ds}) is already covered by another file this month.`);
      }
    } else {
      leafUsable = true;
    }

    // A blank cell counts as 0 (warned once per route below); text and negatives are errors.
    const blankCases = r.cases === null;
    const c = blankCases ? 0 : r.cases;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) {
      ok = false;
      err('bad_cases', r.line, `Cases must be a number of zero or more, got ${Number.isNaN(c) ? 'text that is not a number' : String(c)}.`);
    }

    if (leafUsable && packKnown) {
      const pairKey = `${leafId}|${pack}`;
      const first = seenPair.get(pairKey);
      if (first !== undefined) {
        ok = false;
        err('duplicate', r.line, `Route ${route} and pack ${pack} already appear on row ${first}.`);
      } else {
        seenPair.set(pairKey, r.line);
      }
    }

    if (!ok || leafId === undefined) continue;

    let acc = leaves.get(leafId);
    if (!acc) {
      acc = { leafId, deliverySystem: ds, routeCode: route, firstLine: r.line, values: new Map(), salesmen: new Map(), hasBlankSalesman: false, blankCases: 0 };
      leaves.set(leafId, acc);
    }
    acc.values.set(pack, c as number);
    if (blankCases) acc.blankCases += 1;
    if (salesman === '') acc.hasBlankSalesman = true;
    else acc.salesmen.set(salesman, (acc.salesmen.get(salesman) ?? 0) + 1);
  }

  const accs = [...leaves.values()];

  // Per-pack rounding: leaves must sum to round(sum of decimals).
  const rounded = new Map<PackCode, Record<string, number>>();
  const packTotals: Grid = {};
  for (const pack of ctx.packs) {
    const items = accs.map((a) => ({ key: String(a.leafId), value: a.values.get(pack) ?? 0 }));
    const sum = items.reduce((s, it) => s + it.value, 0);
    const target = Math.round(Math.round(sum * 1e6) / 1e6);
    const dist = largestRemainder(items, target);
    rounded.set(pack, dist);
    packTotals[pack] = target;
  }

  const grids: LeafGrid[] = accs.map((a) => {
    const values: Grid = {};
    for (const pack of ctx.packs) values[pack] = rounded.get(pack)![String(a.leafId)] ?? 0;

    let salesmanId = '';
    let best = 0;
    for (const [id, n] of a.salesmen) {
      if (n > best) {
        best = n;
        salesmanId = id;
      }
    }

    const label = `Route ${a.routeCode} (${a.deliverySystem})`;
    if (a.hasBlankSalesman) warn('blank_salesman', `${label} has a blank Salesman ID.`, a.firstLine);
    if (a.blankCases > 0) {
      warn('blank_cases', `${label} has ${a.blankCases} blank Cases cell${a.blankCases === 1 ? '' : 's'}, counted as 0.`, a.firstLine);
    }
    if (a.salesmen.size > 1) {
      warn('split_salesman', `${label} has rows under ${a.salesmen.size} Salesman IDs (${[...a.salesmen.keys()].join(', ')}); using ${salesmanId}.`, a.firstLine);
    }
    if ([...a.values.values()].every((v) => v === 0)) warn('all_zero_leaf', `${label} has 0 cases in every pack.`, a.firstLine);

    return { leafId: a.leafId, deliverySystem: a.deliverySystem, routeCode: a.routeCode, salesmanId, values };
  });

  for (const pack of ctx.packs) {
    if (!packsInFile.has(pack)) warn('missing_pack', `Pack ${pack} is in the pack list but missing from the file.`);
  }

  return { errors, warnings, grids, packTotals };
}

// ----------------------------------------------------------------- compare

export function compareToTotals(
  packTotals: Grid,
  expected: Grid,
): { pack: PackCode; forecast: number; expected: number; diff: number }[] {
  const packs = [...new Set([...Object.keys(packTotals), ...Object.keys(expected)])];
  const out: { pack: PackCode; forecast: number; expected: number; diff: number }[] = [];
  for (const pack of packs) {
    const forecast = packTotals[pack] ?? 0;
    const exp = Math.round(expected[pack] ?? 0);
    if (forecast !== exp) out.push({ pack, forecast, expected: exp, diff: forecast - exp });
  }
  return out;
}
