// Upload templates of the Admin start (handover section 4 and the new target
// process). Each template is built from the live pack master and hierarchy, so
// the admin only types numbers: every active pack, every channel of every
// Head of Department, every route / KAE with its manager and supervisor.
import { addMonths } from '../../shared/calc/periods';
import type { Workspace } from '../../worker/auth';
import { subMap, type Org } from './compute';

type Cell = { value: string | number; type?: unknown; fontWeight?: 'bold'; format?: string } | null;
type Sheet = { sheet: string; data: Cell[][] };

const CAT_ORDER: Record<string, number> = { CSD: 0, Water: 1, 'LRB-Others': 2 };

const bold = (value: string | number): Cell => ({ value, fontWeight: 'bold' });
const str = (value: string): Cell => ({ value, type: String });
const num = (value: number): Cell => ({ value, type: Number });
const formula = (value: string): Cell => ({ value, type: 'Formula' });

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Active packs in category order (CSD, Water, LRB-Others), then by the pack master order. */
export function templatePacks(org: Org): { code: string; grp: string; sub: string }[] {
  const subOf = subMap(org.packs);
  return org.packs
    .filter((p) => p.active)
    .sort((a, b) => (CAT_ORDER[a.grp] ?? 9) - (CAT_ORDER[b.grp] ?? 9) || a.sort - b.sort || a.code.localeCompare(b.code))
    .map((p) => ({ code: p.code, grp: p.grp, sub: subOf(p.code) }));
}

const yyyymm = (m: string) => Number(m.replace('-', ''));
const productCategory = (grp: string) => (grp === 'LRB-Others' ? 'LRB - Other' : grp);

async function save(file: string, sheets: Sheet[]): Promise<void> {
  const { default: write } = await import('write-excel-file/browser');
  await (write as unknown as (d: unknown) => { toFile: (f: string) => Promise<void> })(sheets).toFile(file);
}

/** The route tree: route -> Head, manager, supervisor names (KA: Head, KAM). */
function routeLines(org: Org): { dept: string; route: string; ds: string; path: string[] }[] {
  const byId = new Map(org.nodes.map((n) => [n.id, n]));
  const deptName = new Map(org.depts.map((d) => [d.id, d.name]));
  return org.leaves.map((l) => {
    const path: string[] = [];
    for (let n = byId.get(l.nodeId); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) path.unshift(n.name);
    return { dept: deptName.get(l.deptId) ?? '', route: l.routeCode, ds: l.deliverySystem, path };
  }).sort((a, b) => a.dept.localeCompare(b.dept) || a.path.join('|').localeCompare(b.path.join('|')) || a.route.localeCompare(b.route));
}

/** Step 2A: Period (YYYYMM), Sales Target Category, Cases. */
export function newTargetByPack(org: Org, period: string): Promise<void> {
  const rows = templatePacks(org).map((p) => [num(yyyymm(period)), str(p.code), num(0)]);
  return save(`new_target_by_pack_${period}.xlsx`, [{ sheet: 'New target', data: [[bold('Period (YYYYMM)'), bold('Sales Target Category'), bold('Cases')], ...rows] }]);
}

/** The department & channel grid (step 2B and step 7): Head names above, Pack | channels | Total <group> | ABC. */
function channelGridSheet(org: Org, sheet: string, title: string | null): Sheet {
  type Col = { label: string; head: string; kind: 'ch' | 'tot'; from?: number; to?: number };
  const cols: Col[] = [];
  for (const d of org.depts) {
    const chans = d.channels.length ? d.channels : [{ channel: d.name, grp: '' }];
    const groups = new Map<string, string[]>();
    for (const c of chans) {
      const g = c.grp || c.channel;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(c.channel);
    }
    for (const [g, list] of groups) {
      const start = cols.length + 1; // +1: the Pack column
      list.forEach((c, i) => cols.push({ label: c, head: i === 0 ? d.name : '', kind: 'ch' }));
      if (list.length > 1) cols.push({ label: `Total ${g}`, head: '', kind: 'tot', from: start, to: start + list.length - 1 });
    }
  }
  const packs = templatePacks(org);
  const first = title ? 3 : 2; // first data row (1-based)
  const chanCols = cols.map((c, i) => ({ c, i: i + 1 })).filter((x) => x.c.kind === 'ch').map((x) => colName(x.i));
  const data: Cell[][] = [];
  if (title) data.push([bold(title)]);
  data.push([null, ...cols.map((c) => (c.head ? bold(c.head) : null)), null]);
  data.push([bold('Pack'), ...cols.map((c) => bold(c.label)), bold('ABC')]);
  packs.forEach((p, k) => {
    const r = first + k + 1;
    data.push([
      str(p.code),
      ...cols.map((c) => (c.kind === 'ch' ? num(0) : formula(`SUM(${colName(c.from!)}${r}:${colName(c.to!)}${r})`))),
      chanCols.length ? formula(chanCols.map((x) => `${x}${r}`).join('+')) : num(0),
    ]);
  });
  return { sheet, data };
}

/** Step 2B: New Target by pack & department (the CD's split starts from these numbers). */
export function newTargetByDept(org: Org, period: string): Promise<void> {
  return save(`new_target_by_pack_and_department_${period}.xlsx`, [channelGridSheet(org, 'New target', null)]);
}

/** Step 7: department & channel targets, one sheet per month (here: PAGO). */
export function deptChannelTargets(org: Org, period: string): Promise<void> {
  const pm = addMonths(period, -1);
  const name = new Date(`${pm}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return save(`department_channel_targets.xlsx`, [channelGridSheet(org, `${name}-${pm.slice(2, 4)}`, null)]);
}

/** Step 2C (Key Accounts): Period, KAM, KAE ID, Sales Target Category, Cases: every KAE x every pack. */
export function newTargetByLeaf(org: Org, period: string): Promise<void> {
  const packs = templatePacks(org);
  const rows: Cell[][] = [];
  for (const l of routeLines(org)) {
    const kam = l.path[l.path.length - 1] ?? '';
    for (const p of packs) rows.push([num(yyyymm(period)), str(kam), str(l.route), str(p.code), num(0)]);
  }
  if (!rows.length) for (const p of packs) rows.push([num(yyyymm(period)), str(''), str(''), str(p.code), num(0)]);
  return save(`new_target_by_pack_kam_kae_${period}.xlsx`, [{
    sheet: 'New target', data: [[bold('Period (YYYYMM)'), bold('KAM'), bold('KAE ID'), bold('Sales Target Category'), bold('Cases')], ...rows],
  }]);
}

/** Step 3: AOP, one sheet per year: Period (YYYYMM), Sales Target Category, AOP Cases, NR/Case. */
export function aop(org: Org, period: string): Promise<void> {
  const y = Number(period.slice(0, 4));
  const packs = templatePacks(org);
  const sheets = [y - 1, y].map((year) => ({
    sheet: `AOP ${year}`,
    data: [
      [bold('Period (YYYYMM)'), bold('Sales Target Category'), bold('AOP Cases'), bold('NR/Case')],
      ...Array.from({ length: 12 }, (_, i) => year * 100 + i + 1).flatMap((m) => packs.map((p) => [num(m), str(p.code), num(0), num(0)])),
    ] as Cell[][],
  }));
  return save(`aop_by_pack_${y - 1}_${y}.xlsx`, sheets);
}

/** Step 4: full-year target: Period (YYYYMM), Sales Target Category, Cases. */
export function fyTarget(org: Org, period: string): Promise<void> {
  const y = Number(period.slice(0, 4));
  const packs = templatePacks(org);
  return save(`target_full_year_${y}.xlsx`, [{
    sheet: `Target ${y}`,
    data: [
      [bold('Period (YYYYMM)'), bold('Sales Target Category'), bold('Cases')],
      ...Array.from({ length: 12 }, (_, i) => y * 100 + i + 1).flatMap((m) => packs.map((p) => [num(m), str(p.code), num(0)])),
    ] as Cell[][],
  }]);
}

/**
 * Step 5: sales by month, the layout of "Sales by Month.xlsx": HOD Name, HOD
 * ID, Manager Name, Manager ID, Supervisor Name, Supervisor ID, Route Code,
 * Product Category, Sales Target Category, Pacage, then one column per month
 * (the 24 months up to PAGO). Key Accounts: KAM Name, KAM ID, KAE ID, ...
 */
export function sales(org: Org, period: string, ws: Workspace): Promise<void> {
  const months = Array.from({ length: 24 }, (_, i) => addMonths(period, i - 24));
  const packs = templatePacks(org);
  const lines = routeLines(org);
  const head = ws === 'ka'
    ? ['HOD Name', 'KAM Name', 'KAM ID', 'KAE ID', 'Product Category', 'Sales Target Category', 'Pacage']
    : ['HOD Name', 'HOD ID', 'Manager Name', 'Manager ID', 'Supervisor Name', 'Supervisor ID', 'Route Code', 'Product Category', 'Sales Target Category', 'Pacage'];
  const rows: Cell[][] = [];
  const blanks = (n: number) => Array.from({ length: n }, () => null);
  for (const l of lines.length ? lines : [{ dept: '', route: '', ds: '', path: [] as string[] }]) {
    const [hod = l.dept, mgr = '', sup = ''] = l.path;
    for (const p of packs) {
      const who = ws === 'ka'
        ? [str(hod), str(l.path[l.path.length - 1] ?? ''), null, str(l.route)]
        : [str(hod), null, str(mgr), null, str(sup), null, str(l.route)];
      rows.push([...who, str(productCategory(p.grp)), str(p.code), str(p.sub), ...blanks(months.length)]);
    }
  }
  return save(`sales_by_month_${ws}.xlsx`, [{ sheet: 'Sales', data: [[null], [...head.map(bold), ...months.map(bold)], ...rows] }]);
}

/** Step 6: previous route targets (PAGO): Period, Delivery System, Route Code, Salesman ID, Sales Target Category, Cases. */
export function prevTargets(org: Org, period: string): Promise<void> {
  const pm = yyyymm(addMonths(period, -1));
  const packs = templatePacks(org);
  const rows: Cell[][] = [];
  for (const l of routeLines(org)) for (const p of packs) rows.push([num(pm), str(l.ds), str(l.route), null, str(p.code), num(0)]);
  return save(`previous_route_targets.xlsx`, [{
    sheet: 'Target', data: [[bold('Period'), bold('Delivery System'), bold('Route Code'), bold('Salesman ID'), bold('Sales Target Category'), bold('Cases')], ...rows],
  }]);
}

/** Pack mapping: Sales Target Category, Pacage (sub category). */
export function packMapping(org: Org): Promise<void> {
  return save('pack_mapping.xlsx', [{
    sheet: 'Packs', data: [[bold('Sales Target Category'), bold('Pacage')], ...templatePacks(org).map((p) => [str(p.code), str(p.sub)])],
  }]);
}

