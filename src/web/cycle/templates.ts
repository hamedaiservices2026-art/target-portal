// Upload templates of the Admin start (handover section 4 and the new target
// process). Each template is built from the live pack master and hierarchy, so
// the admin only types numbers: every active pack, every channel of every
// Head of Department, every route / KAE with its manager and supervisor.
import { addMonths } from '../../shared/calc/periods';
import type { Workspace } from '../../worker/auth';
import { packKey } from '../../shared/calc/packs';
import { subMap, type Org } from './compute';
import { deptColumns, orderedDeptCols } from './deptOrder';

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

/**
 * Rows of the "Target by Pack by Department" file, in its own order and with
 * its Total rows (Total CANS, SSNR, BIG MSPET, MSPET, CSD, Water, LIT,
 * ROCKSTAR, Sting Energy, Britvic, LRB-Others, LRB). A Total adds up the
 * packs and Totals it names. Packs of the pack master that the file does not
 * list go at the end of their category, inside its Total.
 */
const DEPT_LAYOUT: ({ pack: string } | { total: string; refs: string[]; cat?: 'CSD' | 'Water' | 'LRB-Others' })[] = [
  ...['CSD_CANS150', 'STING_240', 'CSD_CANS240', 'CSD_CANS300', 'CSD_CANS320', 'CSD_CANS325', 'CSD_CANS330', 'CSD_CANS355', 'CSD_CANS360'].map((pack) => ({ pack })),
  { total: 'Total CANS', refs: ['CSD_CANS150', 'STING_240', 'CSD_CANS240', 'CSD_CANS300', 'CSD_CANS320', 'CSD_CANS325', 'CSD_CANS330', 'CSD_CANS355', 'CSD_CANS360'] },
  ...['CSD_NRB', 'STING_250', 'CSD_SSPET250', 'CSD_SSPET400', 'CSD_SSPET500'].map((pack) => ({ pack })),
  { total: 'Total SSNR', refs: ['Total CANS', 'CSD_NRB', 'STING_250', 'CSD_SSPET250', 'CSD_SSPET400', 'CSD_SSPET500'] },
  ...['CSD_PET1000', 'CSD_PET2000', 'CSD_PET2200', 'CSD_PET2250'].map((pack) => ({ pack })),
  { total: 'Total BIG MSPET', refs: ['CSD_PET2000', 'CSD_PET2200', 'CSD_PET2250'] },
  { total: 'Total MSPET', refs: ['Total BIG MSPET', 'CSD_PET1000'] },
  { pack: 'PMIX' },
  { total: 'Total CSD', refs: ['Total SSNR', 'Total MSPET', 'PMIX'], cat: 'CSD' },
  ...['AquafinA_200', 'AquafinA_330', 'AquafinA_500', 'AquafinA_1500', 'AquafinA_Sparkling_250', 'AquafinA_NRB_330', 'AquafinA_NRB_750'].map((pack) => ({ pack })),
  { total: 'Total Water', refs: ['AquafinA_200', 'AquafinA_330', 'AquafinA_500', 'AquafinA_1500', 'AquafinA_Sparkling_250', 'AquafinA_NRB_330', 'AquafinA_NRB_750'], cat: 'Water' },
  ...['LIT_CANS150', 'LIT_CANS240', 'LIT_CANS310', 'LIT_CANS315', 'LIT_FSY'].map((pack) => ({ pack })),
  { total: 'Total LIT', refs: ['LIT_CANS150', 'LIT_CANS240', 'LIT_CANS310', 'LIT_CANS315', 'LIT_FSY'] },
  { pack: 'GATORADE' },
  { pack: 'MPLUS_NRB300' },
  { pack: 'Rockstar_185' },
  { pack: 'Rockstar_250' },
  { total: 'Total ROCKSTAR', refs: ['Rockstar_185', 'Rockstar_250'] },
  ...['Sting Energy_185', 'Sting Energy_240', 'Sting Energy_300'].map((pack) => ({ pack })),
  { total: 'Total Sting Energy', refs: ['Sting Energy_185', 'Sting Energy_240', 'Sting Energy_300'] },
  { pack: 'Britvic_300' },
  { pack: 'Britvic_Soda' },
  { total: 'Total Britvic', refs: ['Britvic_300', 'Britvic_Soda'] },
  { total: 'Total LRB-Others', refs: ['Total LIT', 'GATORADE', 'MPLUS_NRB300', 'Total ROCKSTAR', 'Total Britvic', 'Total Sting Energy'], cat: 'LRB-Others' },
  { total: 'Total LRB', refs: ['Total CSD', 'Total Water', 'Total LRB-Others'] },
];

type LayoutRow = { kind: 'pack'; label: string } | { kind: 'total'; label: string; refs: string[] };

/** The file's layout over the live pack master: its packs by their master code, extra packs added in their category. */
export function deptLayout(packs: { code: string; grp: string }[]): LayoutRow[] {
  const byKey = new Map(packs.map((p) => [packKey(p.code), p]));
  const used = new Set<string>();
  const code = (name: string) => byKey.get(packKey(name))?.code;
  const out: LayoutRow[] = [];
  for (const e of DEPT_LAYOUT) {
    if ('pack' in e) {
      const c = code(e.pack);
      if (c && !used.has(c)) { used.add(c); out.push({ kind: 'pack', label: c }); }
      continue;
    }
    const refs = e.refs.map((r) => (r.startsWith('Total') ? r : code(r))).filter((r): r is string => !!r);
    if (e.cat) {
      const extra = packs.filter((p) => p.grp === e.cat && !used.has(p.code));
      for (const p of extra) { used.add(p.code); out.push({ kind: 'pack', label: p.code }); refs.push(p.code); }
    }
    out.push({ kind: 'total', label: e.total, refs });
  }
  return out;
}

/** The department & channel grid (step 2B and step 7): Head names above, Pack | channels | Total <group> | ABC. */
export function channelGridSheet(org: Org, sheet: string, title: string | null): Sheet {
  // Columns as in the department target file: TT DMM, TT Outer, Total TT, MT, MT SSV, MT Bulk, Total MT, HoReCa, WS, then ABC.
  type Col = { label: string; head: string; kind: 'ch' | 'tot'; sums?: number[] };
  const cols: Col[] = [];
  const { flat } = deptColumns(orderedDeptCols(org.depts, '_'), (name) => `Total ${name}`);
  const colOf = new Map<string, number>();
  let lastDept = '';
  for (const x of flat) {
    if (x.kind === 'cell') {
      colOf.set(`${x.d.id}\u0000${x.c}`, cols.length + 1); // +1: the Pack column
      cols.push({ label: x.c === '_' ? x.d.name : x.c, head: x.d.id === lastDept ? '' : x.d.name, kind: 'ch' });
      lastDept = x.d.id;
    } else {
      cols.push({ label: x.label, head: '', kind: 'tot', sums: x.cells.map((k) => colOf.get(`${k.d}\u0000${k.c}`)!) });
      lastDept = '';
    }
  }
  const packs = templatePacks(org);
  const layout = deptLayout(packs);
  const first = title ? 3 : 2; // rows above the first pack row
  const chanCols = cols.map((c, i) => ({ c, i: i + 1 })).filter((x) => x.c.kind === 'ch').map((x) => colName(x.i));
  const data: Cell[][] = [];
  if (title) data.push([bold(title)]);
  data.push([null, ...cols.map((c) => (c.head ? bold(c.head) : null)), null]);
  data.push([bold('Pack'), ...cols.map((c) => bold(c.label)), bold('ABC')]);
  // Excel row of every line (pack or Total), so a Total can add up packs and other Totals.
  const rowOf = new Map<string, number>();
  layout.forEach((r, k) => rowOf.set(r.label, first + k + 1));
  const all = cols.length + 1; // channel / Total columns + ABC
  layout.forEach((r, k) => {
    const row = first + k + 1;
    if (r.kind === 'pack') {
      data.push([
        str(r.label),
        ...cols.map((c) => (c.kind === 'ch' ? num(0) : formula(c.sums!.map((i) => `${colName(i)}${row}`).join('+')))),
        chanCols.length ? formula(chanCols.map((x) => `${x}${row}`).join('+')) : num(0),
      ]);
      return;
    }
    const refs = r.refs.map((x) => rowOf.get(x)).filter((x): x is number => x !== undefined);
    data.push([
      bold(r.label),
      ...Array.from({ length: all }, (_, j) => ({ value: refs.length ? `SUM(${refs.map((x) => `${colName(j + 1)}${x}`).join(',')})` : '0', type: 'Formula', fontWeight: 'bold' as const })),
    ]);
  });
  return { sheet, data };
}

/** Step 2B: New Target by pack & department (the CD's split starts from these numbers). */
export function newTargetByDept(org: Org, period: string): Promise<void> {
  return save(`new_target_by_pack_and_department_${period}.xlsx`, [channelGridSheet(org, 'New target', null)]);
}

/** Previous targets by department: one sheet per month (named like "Oct-26"), the 3 months before the target month. */
export function deptChannelTargets(org: Org, period: string): Promise<void> {
  const sheets = [-3, -2, -1].map((k) => {
    const m = addMonths(period, k);
    const name = new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return channelGridSheet(org, `${name}-${m.slice(2, 4)}`, null);
  });
  return save(`all_department_targets.xlsx`, sheets);
}

/** Key Accounts: the KAE lines (MDM, KAM, KAE with their IDs as far as the hierarchy knows them). */
function kaLines(org: Org): { mdm: string; kam: string; kae: string; id: string }[] {
  return routeLines(org).map((l) => ({ mdm: l.path[0] ?? l.dept, kam: l.path[1] ?? '', kae: l.path[2] ?? l.path[1] ?? '', id: l.route }));
}

/** Key Accounts sales by month (the layout of "Key Account Sales By month"): one row per month, KAE and pack. */
export function kaSales(org: Org, period: string): Promise<void> {
  const months = [-3, -2, -1].map((k) => addMonths(period, k));
  const packs = templatePacks(org);
  const lines = kaLines(org);
  const rows: Cell[][] = [];
  for (const m of months) for (const l of lines.length ? lines : [{ mdm: '', kam: '', kae: '', id: '' }]) {
    for (const p of packs) rows.push([num(Number(m.slice(0, 4))), str(m), str(l.mdm), null, str(l.kam), null, str(l.kae), str(l.id), str(productCategory(p.grp)), str(p.code), num(0)]);
  }
  const head = ['Year', 'Year Month', 'MDM Name', 'MDM ID', 'KAM Name', 'KAM ID', 'KAE Name', 'KAE ID', 'Product Category', 'Sales Target Category', 'Total Invoiced Cases'];
  return save('key_account_sales_by_month.xlsx', [{ sheet: 'Sheet1', data: [[null], head.map(bold), ...rows] }]);
}

/** Key Accounts previous targets (the layout of "Key Account Target By month"): one row per month, KAE and pack. */
export function kaPrevTargets(org: Org, period: string): Promise<void> {
  const months = [-3, -2, -1].map((k) => addMonths(period, k));
  const packs = templatePacks(org);
  const lines = kaLines(org);
  const rows: Cell[][] = [];
  for (const m of months) for (const l of lines.length ? lines : [{ mdm: '', kam: '', kae: '', id: '' }]) {
    for (const p of packs) rows.push([str(m), str(l.mdm), null, str(l.kam), null, str(l.kae), str(l.id), str(productCategory(p.grp)), str(p.code), num(0)]);
  }
  const head = ['Year Month', 'MDM Name', 'MDM ID', 'KAM Name', 'KAM ID', 'KAE Name', 'KAE ID', 'Product Category', 'Target Category', 'MD Target Cases'];
  return save('key_account_target_by_month.xlsx', [{ sheet: 'Sheet1', data: [[null], head.map(bold), ...rows] }]);
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

