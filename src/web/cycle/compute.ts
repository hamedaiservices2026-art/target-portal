// Browser side of the cycle calculations (handover sections 5-6): the
// starting New Target, the CD's default department split, share of mix, and
// the cascade to routes. Pure functions over the data the cycle screens load;
// the rules themselves are in src/shared/calc.
import type { OrgDto } from '../../worker/services/cycleData';
import { averageSales } from '../../shared/calc/averages';
import { cascade, reconcile, type CascadeNode, type CascadeResult } from '../../shared/calc/cascade';
import { brandFamily, categoryByName, cdSubtotals, packKey, subCategoryByName, type Category, CATEGORIES } from '../../shared/calc/packs';
import { approvalLines, orderPacks } from '../../shared/calc/packOrder';
import { addMonths, pago as pagoOf, yago as yagoOf, type Month } from '../../shared/calc/periods';
import { channelSplit, departmentSplit, splitByWeights } from '../../shared/calc/splits';
import type { RouteMonthData } from './parsers';

export type Org = OrgDto;
export type ChannelHist = Record<Month, Record<string, Record<string, number>>>;
export type Grid = Record<string, number>;

export const NO_CHANNEL = '_';

/** Pack -> category from the pack master. */
export function catMap(org: Org): Map<string, Category> {
  return new Map(org.packs.map((p) => [p.code, p.grp as Category]));
}

/** Pack -> sub category (SSNR, MSPET, PMIX, Water, LIT, LRB_Other): the pack master's, else by name. */
export function subMap(packs: { code: string; grp: string; sub?: string | null }[]): (pack: string) => string {
  const m = new Map(packs.map((p) => [p.code, p.sub || subCategoryByName(p.code, p.grp as Category)]));
  return (pack) => m.get(pack) ?? subCategoryByName(pack);
}

/** Company sales of one month by pack. */
export function companyMonth(sales: RouteMonthData, m: Month): Grid {
  const out: Grid = {};
  for (const g of Object.values(sales[m] ?? {})) for (const [p, n] of Object.entries(g)) add(out, p, n);
  return out;
}

export type RouteInfo = { deptId: number; nodeId: number; channel: string };

/**
 * Route -> department, node and channel. The channel is the department's
 * channel whose name matches the route's delivery system; a Head with one
 * channel puts every route in it; otherwise the unassigned remainder '_'.
 */
export function routeIndex(org: Org): Map<string, RouteInfo> {
  const chans = new Map(org.depts.map((d) => [d.id, d.channels.map((c) => c.channel)]));
  const out = new Map<string, RouteInfo>();
  for (const l of org.leaves) {
    const list = chans.get(l.deptId) ?? [];
    const match = list.find((c) => c.toLowerCase() === l.deliverySystem.trim().toLowerCase());
    out.set(l.routeCode, { deptId: l.deptId, nodeId: l.nodeId, channel: match ?? (list.length === 1 ? list[0]! : NO_CHANNEL) });
  }
  return out;
}

export function channelsOf(org: Org, deptId: number): string[] {
  const d = org.depts.find((x) => x.id === deptId);
  return d && d.channels.length ? d.channels.map((c) => c.channel) : [NO_CHANNEL];
}

const add = (g: Grid, k: string, n: number) => { g[k] = (g[k] ?? 0) + n; };

/** month -> key -> pack -> cases, summing the routes of each key (department, channel, node...). */
export function groupSales(sales: RouteMonthData, keyOf: (route: string) => string | null): Record<Month, Record<string, Grid>> {
  const out: Record<Month, Record<string, Grid>> = {};
  for (const [m, routes] of Object.entries(sales)) {
    const mo = (out[m] = {} as Record<string, Grid>);
    for (const [r, g] of Object.entries(routes)) {
      const k = keyOf(r);
      if (k === null) continue;
      const t = (mo[k] ??= {});
      for (const [p, n] of Object.entries(g)) add(t, p, n);
    }
  }
  return out;
}

/** Average over months of one key and pack, skipping months with no value (Excel AVERAGE). */
export function avgOf(byMonth: Record<Month, Record<string, Grid>>, key: string, pack: string, months: Month[]): number {
  const series: Record<Month, number | undefined> = {};
  for (const m of months) {
    const g = byMonth[m]?.[key];
    if (g && pack in g) series[m] = g[pack];
  }
  return averageSales(series, months).avg;
}

export function sumCat(g: Grid | undefined, cats: Map<string, Category>, cat: Category): number {
  if (!g) return 0;
  let s = 0;
  for (const [p, n] of Object.entries(g)) if (cats.get(p) === cat) s += n;
  return s;
}

export function total(g: Grid | undefined): number {
  return g ? Object.values(g).reduce((a, b) => a + b, 0) : 0;
}

// ---------- starting New Target (section 5, Tab 1) ----------

export type NtSource = 'uploaded' | 'fy_target' | 'aop_ratio' | 'pago_target' | 'avg_sales' | 'none';

export type NtSources = {
  newTarget: { mode: 'pack' | 'dept'; byPack: Grid; byChannel?: Record<string, Grid> } | null;
  fyTarget: Record<Month, Grid>;
  aop: Record<Month, Record<string, { cases: number; nr: number | null }>>;
  deptChannel: ChannelHist;
  prevTargets: RouteMonthData;
  sales: RouteMonthData;
};

function sumChannels(h: Record<string, Grid> | undefined): Grid {
  const out: Grid = {};
  for (const g of Object.values(h ?? {})) for (const [p, n] of Object.entries(g)) add(out, p, n);
  return out;
}

function sumRoutes(h: Record<string, Grid> | undefined): Grid {
  return sumChannels(h);
}

/** The target of a past month for the company: department & channel file, else the previous route targets. */
export function companyTarget(src: Pick<NtSources, 'deptChannel' | 'prevTargets' | 'fyTarget'>, m: Month): Grid {
  if (src.deptChannel[m] && Object.keys(src.deptChannel[m]!).length) return sumChannels(src.deptChannel[m]);
  if (src.prevTargets[m]) return sumRoutes(src.prevTargets[m]);
  return { ...(src.fyTarget[m] ?? {}) };
}

/**
 * Starting value of New Target, first source found wins (section 5):
 * 1 uploaded new target for the month; 2 full-year Target for the month;
 * 3 AOP for the month x (last month's target / last month's AOP) per category;
 * 4 PAGO target; 5 average sales of the last 3 months.
 */
export function startNewTarget(period: Month, src: NtSources, cats: Map<string, Category>): { nt: Grid; source: NtSource } {
  const round = (g: Grid) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Math.max(0, Math.round(v))]));
  if (src.newTarget && Object.keys(src.newTarget.byPack).length) return { nt: round(src.newTarget.byPack), source: 'uploaded' };
  if (src.fyTarget[period] && Object.keys(src.fyTarget[period]!).length) return { nt: round(src.fyTarget[period]!), source: 'fy_target' };
  const prev = pagoOf(period);
  const aopNow = src.aop[period];
  const aopPrev = src.aop[prev];
  const tPrev = companyTarget(src, prev);
  if (aopNow && aopPrev && Object.keys(tPrev).length) {
    const ratio: Partial<Record<Category, number>> = {};
    for (const c of CATEGORIES) {
      const a = Object.entries(aopPrev).reduce((s, [p, v]) => s + (cats.get(p) === c ? v.cases : 0), 0);
      const tg = sumCat(tPrev, cats, c);
      ratio[c] = a > 0 ? tg / a : 1;
    }
    const nt: Grid = {};
    for (const [p, v] of Object.entries(aopNow)) nt[p] = v.cases * (ratio[cats.get(p) ?? 'LRB-Others'] ?? 1);
    return { nt: round(nt), source: 'aop_ratio' };
  }
  if (Object.keys(tPrev).length) return { nt: round(tPrev), source: 'pago_target' };
  const months = [addMonths(period, -3), addMonths(period, -2), addMonths(period, -1)];
  const company = groupSales(src.sales, () => 'all');
  const packs = new Set(months.flatMap((m) => Object.keys(company[m]?.all ?? {})));
  const nt: Grid = {};
  for (const p of packs) nt[p] = avgOf(company, 'all', p, months);
  return { nt: round(nt), source: Object.keys(nt).length ? 'avg_sales' : 'none' };
}

// ---------- CD Tab 2: default department & channel split ----------

export type DeptSplitResult = { dm: Record<string, Record<string, Grid>>; basis: Record<string, string> };

/**
 * Step A (pack -> departments by (3-month avg + PAGO sales) / 2 with
 * fallbacks) and step B (department -> channels by the PAGO department &
 * channel target), or the admin's "by pack & department" upload when there
 * is one (rescaled when the CD changed the pack's New Target).
 */
export function defaultDeptSplit(args: {
  period: Month; nt: Grid; org: Org; sales: RouteMonthData; avgMonths: Month[]; deptChannel: ChannelHist; uploadedByChannel?: Record<string, Grid> | null;
  /** Split by the average previous department & channel targets of the months (when uploaded), before the sales. */
  byPrevTarget?: boolean;
}): DeptSplitResult {
  const { period, nt, org, sales, avgMonths, deptChannel } = args;
  const prevMonths = args.byPrevTarget ? prevTargetMonths(deptChannel, avgMonths) : [];
  const prevChan = (c: string, p: string) => (prevMonths.length ? prevMonths.reduce((s2, m) => s2 + (deptChannel[m]?.[c]?.[p] ?? 0), 0) / prevMonths.length : 0);
  const cats = catMap(org);
  const idx = routeIndex(org);
  const depts = org.depts.map((d) => String(d.id));
  const pm = pagoOf(period);
  const byDept = groupSales(sales, (r) => { const i = idx.get(r); return i ? String(i.deptId) : null; });
  const chanToDept = new Map<string, string>();
  for (const d of org.depts) for (const c of d.channels) chanToDept.set(c.channel, String(d.id));
  const pagoHist = deptChannel[pm] ?? {};
  const pagoDeptTarget: Record<string, Grid> = {};
  for (const [ch, g] of Object.entries(pagoHist)) {
    const d = chanToDept.get(ch);
    if (!d) continue;
    const t = (pagoDeptTarget[d] ??= {});
    for (const [p, n] of Object.entries(g)) add(t, p, n);
  }
  const uploaded = args.uploadedByChannel ?? null;
  const upDept: Record<string, Grid> = {};
  if (uploaded) {
    for (const [ch, g] of Object.entries(uploaded)) {
      const d = chanToDept.get(ch);
      if (!d) continue;
      const t = (upDept[d] ??= {});
      for (const [p, n] of Object.entries(g)) add(t, p, n);
    }
  }
  const dm: DeptSplitResult['dm'] = Object.fromEntries(depts.map((d) => [d, {}]));
  const basis: Record<string, string> = {};
  for (const [pack, target] of Object.entries(nt)) {
    const cat = cats.get(pack) ?? 'LRB-Others';
    const w = (f: (d: string) => number) => Object.fromEntries(depts.map((d) => [d, f(d)]));
    // The previous targets by department & channel (average of the months picked) set the shares.
    if (prevMonths.length) {
      const chansOf = (d: string) => channelsOf(org, Number(d));
      const dw = w((d) => chansOf(d).reduce((s2, c) => s2 + prevChan(c, pack), 0));
      if (depts.some((d) => (dw[d] ?? 0) > 0)) {
        const alloc = splitByWeights(target, depts, dw);
        for (const d of depts) {
          const chans = chansOf(d);
          const amount = alloc[d] ?? 0;
          const cw = Object.fromEntries(chans.map((c) => [c, prevChan(c, pack)]));
          const byChan = chans[0] === NO_CHANNEL ? { [NO_CHANNEL]: amount }
            : chans.some((c) => (cw[c] ?? 0) > 0) ? splitByWeights(amount, chans, cw) : { [chans[0]!]: amount };
          for (const [c, n] of Object.entries(byChan)) (dm[d]![c] ??= {})[pack] = n;
        }
        basis[pack] = 'prev_target';
        continue;
      }
    }
    const catAvg = (d: string) => {
      let s = 0;
      for (const p of Object.keys(nt)) if (cats.get(p) === cat) s += avgOf(byDept, d, p, avgMonths);
      return s;
    };
    const split = departmentSplit({
      newTarget: target, depts,
      packAvg3: w((d) => avgOf(byDept, d, pack, avgMonths)),
      packPago: w((d) => byDept[pm]?.[d]?.[pack] ?? 0),
      catAvg3: w(catAvg),
      catPago: w((d) => sumCat(byDept[pm]?.[d], cats, cat)),
      pagoTarget: w((d) => pagoDeptTarget[d]?.[pack] ?? 0),
      uploaded: uploaded && Object.keys(upDept).length ? w((d) => upDept[d]?.[pack] ?? 0) : undefined,
    });
    basis[pack] = split.basis;
    for (const d of depts) {
      const chans = channelsOf(org, Number(d));
      const amount = split.alloc[d] ?? 0;
      let alloc: Grid;
      if (split.basis.startsWith('uploaded') && chans[0] !== NO_CHANNEL) {
        alloc = splitByWeights(amount, chans, Object.fromEntries(chans.map((c) => [c, uploaded?.[c]?.[pack] ?? 0])));
      } else if (chans[0] === NO_CHANNEL) {
        alloc = { [NO_CHANNEL]: amount };
      } else {
        alloc = channelSplit({
          total: amount, channels: chans,
          packPago: Object.fromEntries(chans.map((c) => [c, pagoHist[c]?.[pack] ?? 0])),
          catPago: Object.fromEntries(chans.map((c) => [c, sumCat(pagoHist[c], cats, cat)])),
          allPago: Object.fromEntries(chans.map((c) => [c, total(pagoHist[c])])),
        }).alloc;
      }
      for (const [c, n] of Object.entries(alloc)) (dm[d]![c] ??= {})[pack] = n;
    }
  }
  return { dm, basis };
}

/** The months of the list that have previous department & channel targets uploaded. */
export function prevTargetMonths(deptChannel: ChannelHist, months: Month[]): Month[] {
  return months.filter((m) => deptChannel[m] && Object.keys(deptChannel[m]!).length > 0);
}

/** Department total of a pack across its channels. */
export function deptPack(dm: Record<string, Record<string, Grid>>, d: string, p: string): number {
  return Object.values(dm[d] ?? {}).reduce((s, g) => s + (g[p] ?? 0), 0);
}

/** "Reset to the share-of-mix split" and the CD rescale: one pack's New Target changed -> rescale its split. */
export function rescalePack(dm: Record<string, Record<string, Grid>>, pack: string, newTotal: number): void {
  const cells: { key: string; d: string; c: string; v: number }[] = [];
  for (const [d, chans] of Object.entries(dm)) for (const [c, g] of Object.entries(chans)) cells.push({ key: `${d}\u0000${c}`, d, c, v: g[pack] ?? 0 });
  if (cells.length === 0) return;
  const out = splitByWeights(newTotal, cells.map((x) => x.key), Object.fromEntries(cells.map((x) => [x.key, x.v])));
  for (const x of cells) dm[x.d]![x.c]![pack] = out[x.key]!;
}

// ---------- CD Tab 3: share of mix ----------

export type SomRow = {
  dept: string; channel: string | null; label: string;
  somFy: number | null; somYtd: number | null; som3: number | null; somPago: number | null; somYago: number | null; somRec: number | null;
  casesPago: number; casesYago: number;
};

function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * Share of mix per department (with channel sub-rows) for one category: full
 * year last year, YTD, 3-month average, PAGO, YAGO and the recommended SOM =
 * (3-month avg + PAGO) / 2; cases PAGO / YAGO (sales).
 */
export function somRows(args: { period: Month; org: Org; sales: RouteMonthData; avgMonths: Month[]; cat: Category }): SomRow[] {
  const { period, org, sales, avgMonths, cat } = args;
  const cats = catMap(org);
  const idx = routeIndex(org);
  const year = Number(period.slice(0, 4));
  const fyMonths = Array.from({ length: 12 }, (_, i) => `${year - 1}-${String(i + 1).padStart(2, '0')}`);
  const ytdMonths = Array.from({ length: Number(period.slice(5)) - 1 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const pm = pagoOf(period);
  const ym = yagoOf(period);
  const keyDept = (r: string) => { const i = idx.get(r); return i ? String(i.deptId) : null; };
  const keyChan = (r: string) => { const i = idx.get(r); return i ? `${i.deptId}\u0000${i.channel}` : null; };
  const byDept = groupSales(sales, keyDept);
  const byChan = groupSales(sales, keyChan);
  const sumOver = (by: Record<Month, Record<string, Grid>>, k: string, months: Month[]) => months.reduce((s, m) => s + sumCat(by[m]?.[k], cats, cat), 0);
  const avgCat = (by: Record<Month, Record<string, Grid>>, k: string) => {
    const have = avgMonths.filter((m) => by[m]?.[k] !== undefined);
    return have.length ? have.reduce((s, m) => s + sumCat(by[m]?.[k], cats, cat), 0) / have.length : 0;
  };
  const allKeys = org.depts.map((d) => String(d.id));
  const totals = {
    fy: allKeys.reduce((s, k) => s + sumOver(byDept, k, fyMonths), 0),
    ytd: allKeys.reduce((s, k) => s + sumOver(byDept, k, ytdMonths), 0),
    a3: allKeys.reduce((s, k) => s + avgCat(byDept, k), 0),
    pago: allKeys.reduce((s, k) => s + sumOver(byDept, k, [pm]), 0),
    yago: allKeys.reduce((s, k) => s + sumOver(byDept, k, [ym]), 0),
  };
  const row = (by: Record<Month, Record<string, Grid>>, k: string, dept: string, channel: string | null, label: string): SomRow => {
    const a3 = share(avgCat(by, k), totals.a3);
    const pg = share(sumOver(by, k, [pm]), totals.pago);
    return {
      dept, channel, label,
      somFy: share(sumOver(by, k, fyMonths), totals.fy), somYtd: share(sumOver(by, k, ytdMonths), totals.ytd),
      som3: a3, somPago: pg, somYago: share(sumOver(by, k, [ym]), totals.yago),
      somRec: a3 === null && pg === null ? null : ((a3 ?? 0) + (pg ?? 0)) / 2,
      casesPago: sumOver(by, k, [pm]), casesYago: sumOver(by, k, [ym]),
    };
  };
  const out: SomRow[] = [];
  for (const d of org.depts) {
    out.push(row(byDept, String(d.id), String(d.id), null, d.name));
    if (d.channels.length > 1) for (const c of d.channels) out.push(row(byChan, `${d.id}\u0000${c.channel}`, String(d.id), c.channel, c.channel));
  }
  return out;
}

// ---------- CD workbook rows (GM Adjustment, Target by department) ----------

export type CdRow = { kind: 'pack'; pack: string } | { kind: 'sub'; label: string; packs: string[]; level: 1 | 2 };

/**
 * Pack rows with the CD workbook subtotals: CANS -> SSNR -> MSPET -> CSD,
 * Water, LRB-Others by brand family, then Total LRB.
 */
/** Packs in the order of the department file (the default layout). */
export const sortPacksLikeFile = (list: string[], cats?: Map<string, Category>) => orderPacks(list, (p) => cats?.get(p) ?? categoryByName(p));

/** The packs given in the pack master's order (the order of the uploaded file); packs it doesn't have follow in the file's default order. */
export function inPackOrder(list: Iterable<string>, master: readonly string[]): string[] {
  const at = new Map(master.map((p, i) => [p, i]));
  const rest = sortPacksLikeFile([...new Set(list)].filter((p) => !at.has(p)));
  const rank = new Map(rest.map((p, i) => [p, master.length + i]));
  return [...new Set(list)].sort((a, b) => (at.get(a) ?? rank.get(a)!) - (at.get(b) ?? rank.get(b)!));
}

/** Pack rows and the Total rows of the department file (the default layout); packs it doesn't list go with their group. */
export function cdRows(packs: string[], cats: Map<string, Category>): CdRow[] {
  const have = new Set(packs);
  return approvalLines([], [...have], (p) => cats.get(p) ?? 'LRB-Others').flatMap((x): CdRow[] => (x.pack
    ? (have.has(x.pack) ? [{ kind: 'pack', pack: x.pack }] : [])
    : [{ kind: 'sub', label: x.label, packs: [...new Set(x.of)], level: /^total\s+(csd|water|lrb-others|lrb)\s*$/i.test(x.label) ? 1 : 2 }]));
}

// ---------- Admin › Target calculator (section 6, step D) ----------

export type DeptCalc = { deptId: number; result: CascadeResult; routes: Record<string, Grid> };

/** Route -> pack -> average sales of the months given (Excel AVERAGE: months with no value skipped). */
export function routeAverages(sales: RouteMonthData, months: Month[], routes?: Iterable<string>): Map<string, Grid> {
  const byRoute = groupSales(sales, (r) => r);
  const out = new Map<string, Grid>();
  const list = routes ? [...routes] : [...new Set(months.flatMap((m) => Object.keys(byRoute[m] ?? {})))];
  for (const r of list) {
    const packs = new Set(months.flatMap((m) => Object.keys(byRoute[m]?.[r] ?? {})));
    const g: Grid = {};
    for (const p of packs) g[p] = avgOf(byRoute, r, p, months);
    out.set(r, g);
  }
  return out;
}

/** The live tree of one department as cascade nodes (routes are leaves). */
export function deptTree(org: Org, deptId: number): CascadeNode | null {
  const nodes = org.nodes.filter((n) => n.deptId === deptId);
  const root = nodes.find((n) => n.parentId === null);
  if (!root) return null;
  const kids = new Map<number, number[]>();
  for (const n of nodes) if (n.parentId !== null) {
    if (!kids.has(n.parentId)) kids.set(n.parentId, []);
    kids.get(n.parentId)!.push(n.id);
  }
  const leaves = new Map<number, string[]>();
  for (const l of org.leaves.filter((x) => x.deptId === deptId)) {
    if (!leaves.has(l.nodeId)) leaves.set(l.nodeId, []);
    leaves.get(l.nodeId)!.push(l.routeCode);
  }
  // A node with no route under it is left out: it could not hold a target (and is not a route).
  const build = (id: number): CascadeNode | null => {
    const children = [
      ...(kids.get(id) ?? []).map(build).filter((n): n is CascadeNode => n !== null),
      ...(leaves.get(id) ?? []).map((r) => ({ id: `r:${r}`, children: [] })),
    ];
    return children.length ? { id: `n:${id}`, children } : null;
  };
  return build(root.id);
}

/**
 * Cascades each department's target down to its routes by the average sales
 * of the selected months; fallbacks: the route's category sales, then the
 * uploaded route target of the pack, then equal per route.
 */
export function calculate(args: {
  org: Org; dept: Record<string, Grid>; sales: RouteMonthData; avgMonths: Month[]; routeTargets: Record<string, Grid>;
  /** Admin edits: cascade node id ('n:<node id>' or 'r:<route>') -> pack -> cases. */
  fixed?: Record<string, Grid>;
  /** Key Accounts: the uploaded target per KAE, used as the weights instead of sales. */
  uploadedLeaf?: Record<string, Grid> | null;
}): { depts: DeptCalc[]; problems: string[]; routeAvg: Map<string, Grid> } {
  const { org, dept, sales, avgMonths, routeTargets, fixed, uploadedLeaf } = args;
  const cats = catMap(org);
  const routes = new Set(org.leaves.map((l) => l.routeCode));
  const routeAvg = routeAverages(sales, avgMonths, routes);
  const routeCatAvg = new Map<string, Record<string, number>>();
  for (const r of routes) {
    const g = routeAvg.get(r) ?? {};
    const c: Record<string, number> = {};
    for (const [p, n] of Object.entries(g)) c[cats.get(p) ?? 'LRB-Others'] = (c[cats.get(p) ?? 'LRB-Others'] ?? 0) + n;
    routeCatAvg.set(r, c);
  }
  const problems: string[] = [];
  const depts: DeptCalc[] = [];
  for (const [d, target] of Object.entries(dept)) {
    const root = deptTree(org, Number(d));
    const name = org.depts.find((x) => String(x.id) === d)?.name ?? d;
    if (!root) { problems.push(`${name}: no routes under the Head; it keeps its current target.`); continue; }
    const result = cascade({
      root, packs: Object.keys(target), target,
      packAvg: uploadedLeaf ? (id, p) => uploadedLeaf[id.slice(2)]?.[p] ?? 0 : (id, p) => routeAvg.get(id.slice(2))?.[p] ?? 0,
      fixed: fixed ? (id, p) => fixed[id]?.[p] : undefined,
      categoryAvg: (id, p) => routeCatAvg.get(id.slice(2))?.[cats.get(p) ?? 'LRB-Others'] ?? 0,
      routeTarget: (id, p) => routeTargets[id.slice(2)]?.[p] ?? 0,
    });
    const out: Record<string, Grid> = {};
    for (const [id, g] of Object.entries(result.routes)) {
      if (!id.startsWith('r:')) continue;
      const clean: Grid = {};
      for (const [p, n] of Object.entries(g)) if (n > 0) clean[p] = n;
      out[id.slice(2)] = clean;
    }
    if (Object.keys(out).length === 0) problems.push(`${name}: no routes under the Head.`);
    depts.push({ deptId: Number(d), result, routes: out });
  }
  return { depts, problems, routeAvg };
}

/** Reconciliation lines per department and category (section 6). */
export function reconciliation(org: Org, dept: Record<string, Grid>, calc: DeptCalc[], abc: Grid | null) {
  const cats = catMap(org);
  const lines: { dept: string; category: string; target: number; calculated: number }[] = [];
  for (const c of calc) {
    const target = dept[String(c.deptId)] ?? {};
    const name = org.depts.find((x) => x.id === c.deptId)?.name ?? String(c.deptId);
    for (const cat of CATEGORIES) {
      let calcSum = 0;
      for (const g of Object.values(c.routes)) calcSum += sumCat(g, cats, cat);
      lines.push({ dept: name, category: cat, target: sumCat(target, cats, cat), calculated: calcSum });
    }
  }
  return reconcile(lines, abc ? total(abc) : null);
}
