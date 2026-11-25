// Excel layouts of the Admin start (handover section 4). Pure functions over
// the rows read-excel-file returns; each returns its data plus the problems
// found, as ok / info / warning / error, before anything is sent.
import { PACK_ALIASES, packKey } from '../../shared/calc/packs';
import { parseMonth, type Month } from '../../shared/calc/periods';

export type CheckLevel = 'info' | 'warning' | 'error';
/** `packs`: pack codes missing from the pack master (the screen offers to add them). */
export type Check = { level: CheckLevel; text: string; packs?: string[] };

export type PackIndex = Map<string, string>;

/** Maps packKey(name) -> the pack master code (CSD_CANS150 = CSD CANS150 = csd_cans150). */
export function packIndex(codes: string[]): PackIndex {
  const idx = new Map(codes.map((c) => [packKey(c), c]));
  // Merged packs (e.g. LIT_CANS320 -> LIT_CANS310) count as the pack they were merged into.
  for (const [alias, to] of Object.entries(PACK_ALIASES)) {
    const target = idx.get(packKey(to));
    if (target) idx.set(packKey(alias), target);
  }
  return idx;
}

const squash = (s: unknown): string => (typeof s === 'string' ? s : s === null || s === undefined ? '' : String(s)).toLowerCase().replace(/[\s_\-./]+/g, '');

function cellText(c: unknown): string {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c).trim();
}

export function cellNumber(c: unknown): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  if (typeof c === 'string' && c.trim() !== '') {
    const n = Number(c.trim().replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Finds the header row among the first 15 rows: the first row that has every
 * `required` header (any of its names). Returns the column of each header, or
 * null. A header found below row 1 is reported (shifted headers).
 */
export function findHeader(rows: unknown[][], spec: Record<string, string[]>, required: string[]): { row: number; col: Record<string, number> } | null {
  const lim = Math.min(rows.length, 15);
  for (let i = 0; i < lim; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const keys = r.map(squash);
    // "Period (YYYYMM)" matches "Period": a note in brackets is ignored.
    const plain = r.map((x) => (typeof x === 'string' ? squash(x.replace(/\([^)]*\)/g, '')) : ''));
    const col: Record<string, number> = {};
    for (const [field, names] of Object.entries(spec)) {
      // Names are tried in order, so "KAE ID" wins over "KAM ID" when a file has both.
      for (const n of names) {
        const want = squash(n);
        let idx = keys.indexOf(want);
        if (idx < 0) idx = plain.indexOf(want);
        if (idx >= 0) { col[field] = idx; break; }
      }
    }
    if (required.every((f) => f in col)) return { row: i, col };
  }
  return null;
}

const PACK_NAMES = ['Sales Target Category', 'Target Category', 'Pack', 'Pack Code', 'Category'];
const ROUTE_NAMES = ['Route Code', 'Route', 'KAE ID', 'KAE', 'KAM ID', 'KAM', 'KAE / KAM ID'];

function unknownPacksCheck(unknown: Set<string>): Check[] {
  if (unknown.size === 0) return [];
  const list = [...unknown].slice(0, 15).join(', ');
  return [{ level: 'warning', text: `${unknown.size} pack(s) are not in the pack master and their rows are skipped (add them in Admin › Packs): ${list}`, packs: [...unknown] }];
}

/**
 * Unknown packs of a target file: the rows are skipped. A warning names the
 * cases left out (add the pack in Admin › Packs and upload again to keep them);
 * packs whose cases are all 0 are only noted.
 */
function unknownTargetPacks(unknown: Map<string, number>): Check[] {
  if (unknown.size === 0) return [];
  const withCases = [...unknown].filter(([, n]) => n !== 0);
  const zero = [...unknown].filter(([, n]) => n === 0).map(([k]) => k);
  const out: Check[] = [];
  if (withCases.length) {
    const cases = withCases.reduce((s, [, n]) => s + n, 0);
    out.push({ level: 'warning', text: `${withCases.length} pack(s) are not in the pack master and are skipped (${Math.round(cases).toLocaleString('en-US')} cases): ${withCases.slice(0, 15).map(([k]) => k).join(', ')}. Add them in Admin › Packs and upload again to keep them.` });
  }
  if (zero.length) out.push({ level: 'info', text: `${zero.length} pack(s) with 0 cases are not in the pack master and were left out: ${zero.slice(0, 15).join(', ')}` });
  return out;
}

function shiftedCheck(row: number): Check[] {
  return row > 0 ? [{ level: 'info', text: `The header row was found on row ${row + 1}; the rows above it are ignored.` }] : [];
}

function resolvePack(idx: PackIndex, raw: string, unknown: Set<string>): string | null {
  const code = idx.get(packKey(raw));
  if (!code) unknown.add(raw);
  return code ?? null;
}

const isSubtotal = (s: string) => /^(total|sub ?total|grand ?total)\b/i.test(s.trim());

// ---------- step 2A: New Target by pack ----------

export type NewTargetByPack = { byPack: Record<string, number>; checks: Check[] };

/**
 * Sales Target Category (or Pack), Cases; Period optional (only the target
 * month is used). A route-level target file (with Route Code) is accepted and
 * summed by pack.
 */
export function parseNewTargetByPack(rows: unknown[][], target: Month, idx: PackIndex): NewTargetByPack {
  const h = findHeader(rows, { pack: PACK_NAMES, cases: ['Cases', 'New Target', 'Target', 'Total'], period: ['Period', 'Month'], route: ROUTE_NAMES }, ['pack', 'cases']);
  if (!h) return { byPack: {}, checks: [{ level: 'error', text: 'Columns "Sales Target Category" (or "Pack") and "Cases" were not found.' }] };
  const unknown = new Map<string, number>();
  const byPack: Record<string, number> = {};
  let other = 0;
  let bad = 0;
  for (const r of rows.slice(h.row + 1)) {
    if (!Array.isArray(r)) continue;
    const name = cellText(r[h.col.pack!]);
    if (!name || isSubtotal(name)) continue;
    if (h.col.period !== undefined) {
      const m = parseMonth(r[h.col.period]);
      if (m && m !== target) { other++; continue; }
    }
    const n = cellNumber(r[h.col.cases!]);
    if (n === null || n < 0) { bad++; continue; }
    const code = idx.get(packKey(name));
    if (code) byPack[code] = (byPack[code] ?? 0) + n;
    else unknown.set(name, (unknown.get(name) ?? 0) + n);
  }
  const checks: Check[] = [...shiftedCheck(h.row), ...unknownTargetPacks(unknown)];
  if (h.col.route !== undefined) checks.push({ level: 'info', text: 'Route-level target file: the cases were summed by pack.' });
  if (other) checks.push({ level: 'info', text: `${other} row(s) of other months were ignored (only ${target} is used).` });
  if (bad) checks.push({ level: 'warning', text: `${bad} row(s) have no valid number of cases and were skipped.` });
  if (Object.keys(byPack).length === 0) checks.push({ level: 'error', text: `No New Target found for ${target}.` });
  for (const k of Object.keys(byPack)) byPack[k] = Math.round(byPack[k]!);
  return { byPack, checks };
}

// ---------- steps 2B and 7: Pack x department & channel ----------

export type ChannelGrid = { byChannel: Record<string, Record<string, number>>; abc: Record<string, number>; checks: Check[] };

/**
 * Row above the header = Head of Department names (not needed); header =
 * Pack | TT DMM | TT Outer | Total TT | MT | ... | ABC. Subtotal rows (Total
 * CANS, Total CSD...), "Total ..." columns and a "New Target" column are ignored.
 */
export function parseChannelGrid(rows: unknown[][], channels: string[], idx: PackIndex, groups?: Record<string, string>): ChannelGrid {
  const want = new Map(channels.map((c) => [squash(c), c]));
  // "Total MT" etc.: the channels of that group (Water and LRB rows are often filled only in the total).
  const groupChannels = new Map<string, string[]>();
  for (const c of channels) {
    const g = groups?.[c];
    if (!g) continue;
    const k = squash(g);
    if (!groupChannels.has(k)) groupChannels.set(k, []);
    groupChannels.get(k)!.push(c);
  }
  let hRow = -1;
  let packCol = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const keys = r.map(squash);
    const p = keys.findIndex((k) => PACK_NAMES.some((n) => squash(n) === k));
    if (p >= 0 && keys.some((k) => want.has(k))) { hRow = i; packCol = p; break; }
  }
  if (hRow < 0) return { byChannel: {}, abc: {}, checks: [{ level: 'error', text: `No header row with "Pack" and channel columns (${channels.join(', ')}) was found.` }] };
  const header = rows[hRow]!.map(squash);
  const chCols: [number, string][] = [];
  const totalCols: [number, string[]][] = [];
  let abcCol = -1;
  header.forEach((k, i) => {
    if (want.has(k)) chCols.push([i, want.get(k)!]);
    else if (k === 'abc') abcCol = i;
    else if (k.startsWith('total') && groupChannels.has(k.slice(5))) totalCols.push([i, groupChannels.get(k.slice(5))!]);
  });
  // Older months: "Total MT" with no MT channel columns, or "MT PS" for MT. They count for the channel named
  // like them (MT) when that channel has no column of its own in the sheet.
  const present = new Set(chCols.map(([, c]) => c));
  header.forEach((k, i) => {
    if (!k || want.has(k) || k === 'abc' || chCols.some(([j]) => j === i) || totalCols.some(([j]) => j === i) || PACK_NAMES.some((n) => squash(n) === k)) return;
    const stem = k.startsWith('total') ? k.slice(5) : k;
    const match = channels.filter((c) => stem.startsWith(squash(c))).sort((a, b) => squash(b).length - squash(a).length)[0];
    if (!match || present.has(match)) return;
    if (k.startsWith('total') && channels.some((c) => squash(c) !== squash(match) && squash(c).startsWith(squash(match)) && present.has(c))) return;
    chCols.push([i, match]);
    present.add(match);
  });
  const missing = channels.filter((c) => !chCols.some(([, n]) => n === c));
  const unknown = new Map<string, number>();
  const byChannel: Record<string, Record<string, number>> = Object.fromEntries(chCols.map(([, c]) => [c, {}]));
  const abc: Record<string, number> = {};
  let fromTotals = 0;
  let abcOff = 0;
  for (const r of rows.slice(hRow + 1)) {
    if (!Array.isArray(r)) continue;
    const name = cellText(r[packCol]);
    if (!name || isSubtotal(name)) continue;
    const code = idx.get(packKey(name));
    if (!code) {
      let s = 0;
      for (const [i] of chCols) s += cellNumber(r[i]) ?? 0;
      if (abcCol >= 0) s = cellNumber(r[abcCol]) ?? s;
      unknown.set(name, (unknown.get(name) ?? 0) + s);
      continue;
    }
    let rowSum = 0;
    for (const [i, c] of chCols) {
      const n = cellNumber(r[i]);
      if (n !== null && n !== 0) {
        byChannel[c]![code] = (byChannel[c]![code] ?? 0) + Math.round(n);
        rowSum += Math.round(n);
      }
    }
    for (const [i, list] of totalCols) {
      const n = cellNumber(r[i]);
      if (n === null || Math.round(n) === 0) continue;
      const inGroup = chCols.filter(([j, c]) => list.includes(c) && (cellNumber(r[j]) ?? 0) !== 0);
      if (inGroup.length) continue;
      // The group's first channel with a column; when none of them has one (older months), its first channel.
      const first = list.find((c) => c in byChannel) ?? list[0];
      if (!first) continue;
      byChannel[first] ??= {};
      byChannel[first]![code] = (byChannel[first]![code] ?? 0) + Math.round(n);
      rowSum += Math.round(n);
      fromTotals++;
    }
    if (abcCol >= 0) {
      const n = cellNumber(r[abcCol]);
      if (n !== null) {
        abc[code] = (abc[code] ?? 0) + Math.round(n);
        if (Math.abs(Math.round(n) - rowSum) > chCols.length) abcOff++;
      }
    }
  }
  const checks: Check[] = [...shiftedCheck(hRow > 1 ? hRow - 1 : 0), ...unknownTargetPacks(unknown)];
  if (missing.length) checks.push({ level: 'warning', text: `Channel column(s) not in the file: ${missing.join(', ')} (taken as 0).` });
  if (fromTotals) checks.push({ level: 'info', text: `${fromTotals} row(s) had only a group total (for example Total MT); it was given to the group's first channel.` });
  if (abcOff) checks.push({ level: 'warning', text: `${abcOff} pack(s): the channels do not add up to the ABC column. The channel numbers are used.` });
  return { byChannel, abc, checks };
}

// ---------- step 2C (Key Accounts): New Target by pack, KAM and KAE ----------

export type NewTargetByLeaf = {
  byPack: Record<string, number>;
  /** KAE (route) code -> pack -> cases. */
  byLeaf: Record<string, Record<string, number>>;
  /** KAM name -> pack -> cases (as written in the file). */
  byKam: Record<string, Record<string, number>>;
  checks: Check[];
};

/**
 * Period (optional, only the target month is used), KAM, KAE ID, Sales Target
 * Category, Cases. Each KAE must be a KAE of the hierarchy (warning otherwise).
 */
export function parseNewTargetByLeaf(rows: unknown[][], target: Month, idx: PackIndex, knownLeaves?: Set<string>): NewTargetByLeaf {
  const h = findHeader(rows, {
    period: ['Period', 'Month'], kam: ['KAM', 'KAM Name', 'Key Account Manager', 'KAM ID'],
    leaf: ['KAE ID', 'KAE', 'KAE Code', 'Key Account Executive', 'Route Code', 'Route'], pack: PACK_NAMES, cases: ['Cases', 'New Target', 'Target'],
  }, ['leaf', 'pack', 'cases']);
  const empty = { byPack: {}, byLeaf: {}, byKam: {} };
  if (!h) return { ...empty, checks: [{ level: 'error', text: 'Columns "KAE ID", "Sales Target Category" and "Cases" were not found.' }] };
  const unknown = new Map<string, number>();
  const byPack: Record<string, number> = {};
  const byLeaf: Record<string, Record<string, number>> = {};
  const byKam: Record<string, Record<string, number>> = {};
  let other = 0;
  for (const r of rows.slice(h.row + 1)) {
    if (!Array.isArray(r)) continue;
    const leaf = cellText(r[h.col.leaf!]);
    const name = cellText(r[h.col.pack!]);
    if (!leaf || !name || isSubtotal(leaf) || isSubtotal(name)) continue;
    if (h.col.period !== undefined) {
      const m = parseMonth(r[h.col.period]);
      if (m && m !== target) { other++; continue; }
    }
    const n = cellNumber(r[h.col.cases!]);
    if (n === null || n < 0) continue;
    const code = idx.get(packKey(name));
    if (!code) { unknown.set(name, (unknown.get(name) ?? 0) + n); continue; }
    const v = Math.round(n);
    byPack[code] = (byPack[code] ?? 0) + v;
    (byLeaf[leaf] ??= {})[code] = ((byLeaf[leaf] ??= {})[code] ?? 0) + v;
    const kam = h.col.kam !== undefined ? cellText(r[h.col.kam]) : '';
    if (kam) (byKam[kam] ??= {})[code] = ((byKam[kam] ??= {})[code] ?? 0) + v;
  }
  const checks: Check[] = [...shiftedCheck(h.row), ...unknownTargetPacks(unknown)];
  if (other) checks.push({ level: 'info', text: `${other} row(s) of other months were ignored (only ${target} is used).` });
  if (knownLeaves) {
    const missing = Object.keys(byLeaf).filter((k) => !knownLeaves.has(k));
    if (missing.length) checks.push({ level: 'warning', text: `${missing.length} KAE(s) are not in the hierarchy; their cases count in the total but not in the KAE split: ${missing.slice(0, 10).join(', ')}` });
  }
  if (Object.keys(byPack).length === 0) checks.push({ level: 'error', text: `No New Target found for ${target}.` });
  checks.push({ level: 'info', text: `${Object.keys(byKam).length} KAM(s), ${Object.keys(byLeaf).length} KAE(s).` });
  return { byPack, byLeaf, byKam, checks };
}

// ---------- pack mapping: Sales Target Category -> sub category ----------

/** Sales Target Category, Pacage (sub category: SSNR, MSPET, PMIX, Water, LIT, LRB_Other). */
export function parsePackMapping(rows: unknown[][], idx: PackIndex): { map: Record<string, string>; checks: Check[] } {
  const h = findHeader(rows, { pack: ['Sales Target Category', 'Pack', 'Pack Code'], sub: ['Pacage', 'Package', 'Sub Category', 'Subcategory', 'Sub'] }, ['pack', 'sub']);
  if (!h) return { map: {}, checks: [{ level: 'error', text: 'Columns "Sales Target Category" and "Pacage" (sub category) were not found.' }] };
  const map: Record<string, string> = {};
  const unknown = new Map<string, number>();
  for (const r of rows.slice(h.row + 1)) {
    if (!Array.isArray(r)) continue;
    const name = cellText(r[h.col.pack!]);
    const sub = cellText(r[h.col.sub!]);
    if (!name || !sub) continue;
    const code = idx.get(packKey(name));
    if (!code) { unknown.set(name, 0); continue; }
    map[code] = sub.slice(0, 40);
  }
  const checks: Check[] = [...shiftedCheck(h.row)];
  if (unknown.size) checks.push({ level: 'info', text: `${unknown.size} pack(s) are not in the pack master and were left out: ${[...unknown.keys()].slice(0, 15).join(', ')}` });
  if (!Object.keys(map).length) checks.push({ level: 'error', text: 'No pack of the pack master was found in the file.' });
  else checks.push({ level: 'info', text: `${Object.keys(map).length} pack(s) mapped.` });
  return { map, checks };
}

/** Step 7: one sheet per month; the month is in the sheet name (like "Oct-26") or in the first row. */
export function sheetMonth(sheet: { sheet: string; data: unknown[][] }): Month | null {
  const byName = parseMonth(sheet.sheet);
  if (byName) return byName;
  for (const c of sheet.data[0] ?? []) {
    const m = parseMonth(c);
    if (m) return m;
  }
  return null;
}

// ---------- steps 3 and 4: AOP and full-year target ----------

export type ByMonthPack<T> = { byMonth: Record<Month, Record<string, T>>; checks: Check[] };

/** Every sheet named like "AOP": Period (YYYYMM), Sales Target Category, AOP Cases, NR/Case. */
export function parseAop(sheets: { sheet: string; data: unknown[][] }[], idx: PackIndex): ByMonthPack<{ cases: number; nr: number | null }> {
  const use = sheets.filter((s) => /aop/i.test(s.sheet));
  const checks: Check[] = [];
  if (use.length === 0) return { byMonth: {}, checks: [{ level: 'error', text: 'No sheet named "AOP" was found.' }] };
  const unknown = new Set<string>();
  const byMonth: Record<Month, Record<string, { cases: number; nr: number | null }>> = {};
  for (const s of use) {
    const h = findHeader(s.data, { period: ['Period', 'Month'], pack: PACK_NAMES, cases: ['AOP Cases', 'AOP', 'Cases'], nr: ['NR/Case', 'NR per Case', 'NR Case', 'NR'] }, ['period', 'pack', 'cases']);
    if (!h) { checks.push({ level: 'error', text: `Sheet ${s.sheet}: columns Period, Sales Target Category and AOP Cases were not found.` }); continue; }
    for (const r of s.data.slice(h.row + 1)) {
      if (!Array.isArray(r)) continue;
      const m = parseMonth(r[h.col.period!]);
      const name = cellText(r[h.col.pack!]);
      const n = cellNumber(r[h.col.cases!]);
      if (!m || !name || n === null || isSubtotal(name)) continue;
      const code = resolvePack(idx, name, unknown);
      if (!code) continue;
      const cur = (byMonth[m] ??= {})[code];
      const nr = h.col.nr !== undefined ? cellNumber(r[h.col.nr]) : null;
      byMonth[m]![code] = { cases: (cur?.cases ?? 0) + n, nr: nr ?? cur?.nr ?? null };
    }
  }
  checks.push(...unknownPacksCheck(unknown));
  checks.push({ level: 'info', text: `${Object.keys(byMonth).length} month(s) of AOP read from ${use.length} sheet(s).` });
  return { byMonth, checks };
}

/** Every sheet named like "Target": Period (YYYYMM), Sales Target Category, Cases. */
export function parseFyTarget(sheets: { sheet: string; data: unknown[][] }[], idx: PackIndex): ByMonthPack<number> {
  const use = sheets.filter((s) => /target/i.test(s.sheet));
  const checks: Check[] = [];
  if (use.length === 0) return { byMonth: {}, checks: [{ level: 'error', text: 'No sheet named "Target" was found.' }] };
  const unknown = new Set<string>();
  const byMonth: Record<Month, Record<string, number>> = {};
  for (const s of use) {
    const h = findHeader(s.data, { period: ['Period', 'Month'], pack: PACK_NAMES, cases: ['Cases', 'Target', 'Target Cases'] }, ['period', 'pack', 'cases']);
    if (!h) { checks.push({ level: 'error', text: `Sheet ${s.sheet}: columns Period, Sales Target Category and Cases were not found.` }); continue; }
    for (const r of s.data.slice(h.row + 1)) {
      if (!Array.isArray(r)) continue;
      const m = parseMonth(r[h.col.period!]);
      const name = cellText(r[h.col.pack!]);
      const n = cellNumber(r[h.col.cases!]);
      if (!m || !name || n === null || isSubtotal(name)) continue;
      const code = resolvePack(idx, name, unknown);
      if (code) (byMonth[m] ??= {})[code] = ((byMonth[m] ??= {})[code] ?? 0) + n;
    }
  }
  checks.push(...unknownPacksCheck(unknown));
  checks.push({ level: 'info', text: `${Object.keys(byMonth).length} month(s) of target read.` });
  return { byMonth, checks };
}

// ---------- step 5: sales by month ----------

/** month -> route -> pack -> cases */
export type RouteMonthData = Record<Month, Record<string, Record<string, number>>>;

export type SalesParse = { data: RouteMonthData; checks: Check[]; layout: 'wide' | 'long' };

/**
 * Route Code (KA: KAE / KAM ID), Product Category, Sales Target Category, then
 * one column per month (2026-09, 202609, Excel date, Sep-26, Sep 2026,
 * September 2026, 09/2026). Also accepted: the long layout (Period + Cases).
 */
export function parseSales(rows: unknown[][], idx: PackIndex, knownRoutes?: Set<string>): SalesParse {
  const unknown = new Set<string>();
  const data: RouteMonthData = {};
  const add = (m: Month, route: string, pack: string, n: number) => {
    const g = ((data[m] ??= {})[route] ??= {});
    g[pack] = (g[pack] ?? 0) + n;
  };
  const checks: Check[] = [];
  const long = findHeader(rows, { route: ROUTE_NAMES, pack: PACK_NAMES, period: ['Period', 'Year Month', 'Month'], cases: ['Cases', 'Total Invoiced Cases', 'Invoiced Cases', 'Sales', 'Sales Cases', 'Actual'] }, ['route', 'pack', 'period', 'cases']);
  let layout: 'wide' | 'long' = 'wide';
  if (long) {
    layout = 'long';
    checks.push(...shiftedCheck(long.row));
    for (const r of rows.slice(long.row + 1)) {
      if (!Array.isArray(r)) continue;
      const route = cellText(r[long.col.route!]);
      const name = cellText(r[long.col.pack!]);
      const m = parseMonth(r[long.col.period!]);
      const n = cellNumber(r[long.col.cases!]);
      if (!route || !name || !m || n === null) continue;
      const code = resolvePack(idx, name, unknown);
      if (code) add(m, route, code, n);
    }
  } else {
    const h = findHeader(rows, { route: ROUTE_NAMES, pack: PACK_NAMES }, ['route', 'pack']);
    if (!h) return { data, layout, checks: [{ level: 'error', text: 'Columns "Route Code" and "Sales Target Category" were not found.' }] };
    checks.push(...shiftedCheck(h.row));
    const monthCols: [number, Month][] = [];
    (rows[h.row] ?? []).forEach((c, i) => {
      if (i === h.col.route || i === h.col.pack) return;
      const m = parseMonth(c);
      if (m) monthCols.push([i, m]);
    });
    if (monthCols.length === 0) return { data, layout, checks: [...checks, { level: 'error', text: 'No month columns were found next to the pack column.' }] };
    for (const r of rows.slice(h.row + 1)) {
      if (!Array.isArray(r)) continue;
      const route = cellText(r[h.col.route!]);
      const name = cellText(r[h.col.pack!]);
      if (!route || !name || isSubtotal(route) || isSubtotal(name)) continue;
      const code = resolvePack(idx, name, unknown);
      if (!code) continue;
      for (const [i, m] of monthCols) {
        const n = cellNumber(r[i]);
        if (n !== null) add(m, route, code, n);
      }
    }
  }
  checks.push(...unknownPacksCheck(unknown));
  if (knownRoutes) {
    const routes = new Set(Object.values(data).flatMap((g) => Object.keys(g)));
    const notMapped = [...routes].filter((r) => !knownRoutes.has(r));
    if (notMapped.length) checks.push({ level: 'warning', text: `${notMapped.length} route(s) are not in the hierarchy: ${notMapped.slice(0, 10).join(', ')}` });
  }
  const months = Object.keys(data).sort();
  checks.push({ level: 'info', text: `${layout === 'wide' ? 'Wide' : 'Long'} layout: ${months.length} month(s) (${months[0] ?? '-'} to ${months[months.length - 1] ?? '-'}).` });
  return { data, checks, layout };
}

// ---------- step 6: previous targets (and the monthly target by route file) ----------

export type PrevTargets = {
  data: RouteMonthData;
  extra: Record<Month, Record<string, { salesmanId: string | null; deliverySystem: string | null }>>;
  checks: Check[];
};

/** Period, Delivery System, Route Code (KA: KAE / KAM), Salesman ID, Sales Target Category, Cases. */
export function parsePrevTargets(rows: unknown[][], idx: PackIndex): PrevTargets {
  const h = findHeader(rows, {
    period: ['Period', 'Year Month', 'Month'], ds: ['Delivery System', 'DS'], route: ROUTE_NAMES, salesman: ['Salesman ID', 'Salesman', 'Salesman Code'],
    pack: PACK_NAMES, cases: ['Cases', 'MD Target Cases', 'Target Cases', 'Target'],
  }, ['period', 'route', 'pack', 'cases']);
  const data: RouteMonthData = {};
  const extra: PrevTargets['extra'] = {};
  if (!h) return { data, extra, checks: [{ level: 'error', text: 'Columns Period, Route Code, Sales Target Category and Cases were not found.' }] };
  const unknown = new Set<string>();
  let blankSalesman = 0;
  for (const r of rows.slice(h.row + 1)) {
    if (!Array.isArray(r)) continue;
    const m = parseMonth(r[h.col.period!]);
    const route = cellText(r[h.col.route!]);
    const name = cellText(r[h.col.pack!]);
    const n = cellNumber(r[h.col.cases!]);
    if (!m || !route || !name || n === null) continue;
    const code = resolvePack(idx, name, unknown);
    if (!code) continue;
    const g = ((data[m] ??= {})[route] ??= {});
    g[code] = (g[code] ?? 0) + n;
    const salesman = h.col.salesman !== undefined ? cellText(r[h.col.salesman]) || null : null;
    const ds = h.col.ds !== undefined ? cellText(r[h.col.ds]) || null : null;
    const e = ((extra[m] ??= {})[route] ??= { salesmanId: null, deliverySystem: null });
    if (salesman && !e.salesmanId) e.salesmanId = salesman;
    if (ds && !e.deliverySystem) e.deliverySystem = ds;
  }
  for (const m of Object.keys(extra)) for (const e of Object.values(extra[m]!)) if (!e.salesmanId) blankSalesman++;
  const checks: Check[] = [...shiftedCheck(h.row), ...unknownPacksCheck(unknown)];
  if (blankSalesman) checks.push({ level: 'warning', text: `${blankSalesman} route-month(s) have no Salesman ID.` });
  checks.push({ level: 'info', text: `${Object.keys(data).length} month(s) of previous targets read.` });
  return { data, extra, checks };
}

// ---------- templates ("Download template") ----------

export const TEMPLATES: Record<string, { file: string; columns: string[]; sample: (string | number)[][] }> = {
  new_target_pack: { file: 'new_target_by_pack.xlsx', columns: ['Period', 'Sales Target Category', 'Cases'], sample: [['202610', 'CSD_CANS150', 1000]] },
  new_target_dept: { file: 'new_target_by_pack_and_department.xlsx', columns: ['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'MT', 'MT SSV', 'MT Bulk', 'Total MT', 'HoReCa', 'WS', 'ABC'], sample: [['CSD_CANS150', 300, 200, 500, 150, 50, 20, 220, 100, 180, 1000]] },
  aop: { file: 'aop_full_year.xlsx', columns: ['Period', 'Sales Target Category', 'AOP Cases', 'NR/Case'], sample: [['202610', 'CSD_CANS150', 1200, 25.5]] },
  fy_target: { file: 'target_full_year.xlsx', columns: ['Period', 'Sales Target Category', 'Cases'], sample: [['202610', 'CSD_CANS150', 1100]] },
  sales: { file: 'sales_by_month.xlsx', columns: ['Route Code', 'Product Category', 'Sales Target Category', '2026-07', '2026-08', '2026-09'], sample: [['R001', 'CSD', 'CSD_CANS150', 30, 35, 32]] },
  prev_target: { file: 'previous_targets.xlsx', columns: ['Period', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases'], sample: [['202609', 'TT DMM', 'R001', 'S100', 'CSD_CANS150', 33]] },
  dept_channel: { file: 'department_channel_targets.xlsx', columns: ['Pack', 'TT DMM', 'TT Outer', 'Total TT', 'MT', 'MT SSV', 'MT Bulk', 'Total MT', 'HoReCa', 'WS', 'ABC'], sample: [['CSD_CANS150', 300, 200, 500, 150, 50, 20, 220, 100, 180, 1000]] },
};

/**
 * AOP by pack and department (one sheet per channel, e.g. "TT Damm", "MT SSV";
 * rows: Pack; columns: the months of the year, then FY). The sheet named ABC /
 * Total is the check: channels must add up to it. Values are rounded to whole cases.
 */
/** The rows of a target file in its own order: packs, and the file's Total rows with the packs each one sums. */
export type FileRow = { p: string } | { t: string; of: string[] };

/**
 * The file's layout from one sheet (the ABC / total sheet): packs in order and
 * each "Total …" row with the packs it adds up, found from the numbers (the
 * nearest packs above it whose months add up to the total).
 */
export function fileLayout(data: unknown[][], idx: PackIndex): FileRow[] {
  const hRow = data.findIndex((r) => Array.isArray(r) && r.some((x) => PACK_NAMES.some((n) => squash(n) === squash(x))));
  if (hRow < 0) return [];
  const header = data[hRow]!;
  const pCol = header.findIndex((x) => PACK_NAMES.some((n) => squash(n) === squash(x)));
  const nCols = header.map((x, i) => (i !== pCol && (parseMonth(x) || /fy|total/i.test(String(x ?? ''))) ? i : -1)).filter((i) => i >= 0);
  const rows: { name: string; code: string | null; total: boolean; v: number[] }[] = [];
  for (const r of data.slice(hRow + 1)) {
    if (!Array.isArray(r)) continue;
    const name = cellText(r[pCol]);
    if (!name) continue;
    const total = isSubtotal(name);
    rows.push({ name, total, code: total ? null : idx.get(packKey(name)) ?? null, v: nCols.map((i) => cellNumber(r[i]) ?? 0) });
  }
  const out: FileRow[] = [];
  const seen = new Set<string>();
  rows.forEach((row, t) => {
    if (!row.total) {
      if (row.code && !seen.has(row.code)) { seen.add(row.code); out.push({ p: row.code }); }
      return;
    }
    const sum = row.v.map(() => 0);
    const of: string[] = [];
    let ok = false;
    for (let k = t - 1; k >= 0; k--) {
      const x = rows[k]!;
      if (x.total) continue;
      x.v.forEach((n, i) => { sum[i] = (sum[i] ?? 0) + n; });
      if (x.code && !of.includes(x.code)) of.unshift(x.code);
      if (sum.every((n, i) => Math.abs(n - row.v[i]!) <= 1)) { ok = true; break; }
    }
    if (ok && of.length) out.push({ t: row.name, of });
  });
  return out;
}

/** Whole cases per pack whose sum keeps the column's total (largest remainder). */
function roundKeepTotal(g: Record<string, number>): Record<string, number> {
  const keys = Object.keys(g);
  const want = Math.round(keys.reduce((s, k) => s + g[k]!, 0));
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = Math.floor(g[k]!);
  let left = want - keys.reduce((s, k) => s + out[k]!, 0);
  for (const k of [...keys].sort((a, b) => (g[b]! - Math.floor(g[b]!)) - (g[a]! - Math.floor(g[a]!)))) {
    if (left <= 0) break;
    out[k]! += 1;
    left--;
  }
  for (const k of keys) if (out[k] === 0) delete out[k];
  return out;
}

export function parseAopByDept(sheets: { sheet: string; data: unknown[][] }[], channels: string[], idx: PackIndex): { byMonth: Record<Month, Record<string, Record<string, number>>>; layout: FileRow[]; checks: Check[] } {
  const checks: Check[] = [];
  const consonants = (s: string) => s.slice(0, 1) + s.slice(1).replace(/[aeiou]/g, '');
  const chanOf = (name: string): string | null => {
    const k = squash(name);
    return channels.find((c) => squash(c) === k) ?? channels.find((c) => consonants(squash(c)) === consonants(k)) ?? null;
  };
  const unknown = new Set<string>();
  const byMonth: Record<Month, Record<string, Record<string, number>>> = {};
  const totalSheet: Record<Month, Record<string, number>> = {};
  const skipped: string[] = [];
  const read = (data: unknown[][]): Record<Month, Record<string, number>> | null => {
    const hRow = data.findIndex((r) => Array.isArray(r) && r.some((x) => PACK_NAMES.some((n) => squash(n) === squash(x))));
    if (hRow < 0) return null;
    const header = data[hRow]!;
    const pCol = header.findIndex((x) => PACK_NAMES.some((n) => squash(n) === squash(x)));
    const mCols: [number, Month][] = [];
    header.forEach((x, i) => { const m = i === pCol || /fy|total/i.test(String(x ?? '')) ? null : parseMonth(x); if (m) mCols.push([i, m]); });
    const out: Record<Month, Record<string, number>> = {};
    for (const r of data.slice(hRow + 1)) {
      if (!Array.isArray(r)) continue;
      const name = cellText(r[pCol]);
      if (!name || isSubtotal(name)) continue;
      const code = resolvePack(idx, name, unknown);
      if (!code) continue;
      for (const [i, m] of mCols) {
        const n = cellNumber(r[i]);
        if (n === null || n === 0) continue;
        const g = (out[m] ??= {});
        g[code] = (g[code] ?? 0) + n;
      }
    }
    return out;
  };
  let layout: FileRow[] = [];
  for (const s of sheets) {
    if (/^(abc|total|all)$/i.test(s.sheet.trim())) {
      const t = read(s.data);
      if (t) Object.assign(totalSheet, t);
      layout = fileLayout(s.data, idx);
      continue;
    }
    const ch = chanOf(s.sheet);
    if (!ch) { skipped.push(s.sheet); continue; }
    const g = read(s.data);
    if (!g) { checks.push({ level: 'error', text: `Sheet ${s.sheet}: the Pack column and the month columns were not found.` }); continue; }
    for (const [m, packs] of Object.entries(g)) {
      const dst = ((byMonth[m] ??= {})[ch] ??= {});
      for (const [p, n] of Object.entries(packs)) dst[p] = (dst[p] ?? 0) + n;
    }
  }
  // Whole cases, keeping each channel's monthly total as in the file.
  for (const chs of Object.values(byMonth)) for (const [c, g] of Object.entries(chs)) chs[c] = roundKeepTotal(g);
  if (!layout.length && sheets[0]) layout = fileLayout(sheets[0].data, idx);
  if (skipped.length) checks.push({ level: 'warning', text: `Sheet(s) not matched to a channel and not read: ${skipped.join(', ')}. Channels: ${channels.join(', ')}.` });
  const missing = channels.filter((c) => !Object.values(byMonth).some((x) => x[c]));
  if (missing.length) checks.push({ level: 'warning', text: `No sheet for channel(s): ${missing.join(', ')} (they get 0).` });
  // Check against the ABC / Total sheet.
  let off = 0;
  for (const [m, t] of Object.entries(totalSheet)) {
    for (const [p, n] of Object.entries(t)) {
      const sum = Object.values(byMonth[m] ?? {}).reduce((s2, g) => s2 + (g[p] ?? 0), 0);
      if (Math.abs(sum - n) > Math.max(2, Object.keys(byMonth[m] ?? {}).length)) off++;
    }
  }
  if (Object.keys(totalSheet).length) checks.push(off ? { level: 'warning', text: `${off} pack-month(s) where the channels do not add up to the ABC sheet.` } : { level: 'info', text: 'The channels add up to the ABC sheet.' });
  checks.push(...unknownPacksCheck(unknown));
  const months = Object.keys(byMonth).sort();
  if (!months.length) checks.push({ level: 'error', text: 'No month was read.' });
  else checks.push({ level: 'info', text: `${months.length} month(s) read (${months[0]} to ${months[months.length - 1]}), ${Object.keys(Object.assign({}, ...Object.values(byMonth))).length} channel(s).` });
  return { byMonth, layout, checks };
}
