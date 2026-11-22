// Admin › Target calculator (new target process): after the Commercial
// Director returns the target, Admin sees it by department and category,
// picks the months for the average sales, calculates the target of every
// manager, supervisor and route by pack (each level's share of the level
// above), may change any of them without going over what the CD gave, checks
// the totals, exports, and applies it as the new target.
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES, type Category } from '../../../shared/calc/packs';
import { addMonths, pago as pagoOf } from '../../../shared/calc/periods';
import type { CascadeNode } from '../../../shared/calc/cascade';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto } from '../../../worker/services/cycle';
import type { OrgDto } from '../../../worker/services/cycleData';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { fmtDateTime } from '../../format';
import { fmtNum, useLang } from '../../i18n';
import { calculate, catMap, deptTree, routeAverages, subMap, sumCat, total, type Grid } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import { Checks, fmtPct, MonthPicker, monthsLabel, NumCell, Section, Tabs, writeWorkbook } from '../../cycle/ui';

type Loaded = { cycle: CycleDto; org: OrgDto };
type Basis = 'sales' | 'uploaded';

/** A row of the cascade: a node or a route, with its depth. */
type TreeRow = { id: string; name: string; level: number; leaf: boolean; parent: string | null; routes: string[] };

function flatten(root: CascadeNode, names: Map<string, string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (n: CascadeNode, level: number, parent: string | null): string[] => {
    const row: TreeRow = { id: n.id, name: names.get(n.id) ?? n.id, level, leaf: n.children.length === 0, parent, routes: [] };
    out.push(row);
    row.routes = n.children.length === 0 ? [n.id.slice(2)] : n.children.flatMap((c) => walk(c, level + 1, n.id));
    return row.routes;
  };
  walk(root, 0, null);
  return out;
}

const sumPacks = (g: Grid | undefined, packs: string[]) => packs.reduce((s, p) => s + (g?.[p] ?? 0), 0);

export function CalcTab({ ws, period, l, reload }: { ws: Workspace; period: string; l: Loaded; reload: () => void }) {
  const [lang] = useLang();
  const { cycle, org } = l;
  const cats = catMap(org);
  const subOf = useMemo(() => subMap(org.packs), [org]);
  const [months, setMonthsState] = useState<string[]>(cycle.settings.avgMonths);
  const [basis, setBasis] = useState<Basis>('sales');
  const [ran, setRan] = useState(false);
  const [fixed, setFixed] = useState<Record<string, Grid>>({});
  const [view, setView] = useState<'cat' | 'pack'>('cat');
  const [deptSel, setDeptSel] = useState<string>(org.depts[0] ? String(org.depts[0].id) : '');
  const [showSel, setShowSel] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const pm = pagoOf(period);
  const dept = cycle.dept;
  const deptT: Record<string, Grid> = dept ?? {};

  const avail = useAsync(() => api<{ months: string[] }>('GET', `/api/data/${ws}/sales-months`), [ws]);
  const data = useAsync(dept ? async () => {
    const [sales, prev, nt] = await Promise.all([
      loadRouteData(ws, 'sales', months),
      loadRouteData(ws, 'prev_target', [period, pm]),
      loadMonthData<{ mode: string; byPack: Grid; byLeaf?: Record<string, Grid> }>(ws, 'new_target'),
    ]);
    return { sales: sales.data, routeTargets: prev.data[period] ?? prev.data[pm] ?? {}, upload: nt[period] ?? null };
  } : null, [ws, period, months.join(',')]);

  async function setMonths(m: string[]) {
    setMonthsState(m);
    setMsg(null);
    if (!m.length) return;
    try {
      await api('PUT', `/api/admin/cycle/${ws}/${period}/settings`, { avgMonths: m });
    } catch (x) {
      setErr(errText(x));
    }
  }

  const uploadedLeaf = data.data?.upload?.mode === 'leaf' ? data.data.upload.byLeaf ?? null : null;
  const useUploaded = basis === 'uploaded' && !!uploadedLeaf;

  const routeAvg = useMemo(() => (data.data ? routeAverages(data.data.sales, months, org.leaves.map((x) => x.routeCode)) : new Map<string, Grid>()), [data.data, org]);
  const base = useMemo(() => (dept && data.data && ran && months.length
    ? calculate({ org, dept, sales: data.data.sales, avgMonths: months, routeTargets: data.data.routeTargets, uploadedLeaf: useUploaded ? uploadedLeaf : null })
    : null), [dept, data.data, ran, useUploaded, org]);
  const live = useMemo(() => (dept && data.data && ran && months.length && Object.keys(fixed).length
    ? calculate({ org, dept, sales: data.data.sales, avgMonths: months, routeTargets: data.data.routeTargets, uploadedLeaf: useUploaded ? uploadedLeaf : null, fixed })
    : base), [base, fixed]);

  if (!dept) return <p class="card muted">{cycle.settings.cdStep ? tc('calcWaitCd') : tc('calcWaitDept')}</p>;

  const deptName = (id: string) => org.depts.find((d) => String(d.id) === id)?.name ?? id;
  const deptIds = org.depts.map((d) => String(d.id)).filter((d) => d in dept);
  const companyNt = cycle.cd?.nt ?? null;
  const byCat = (g: Grid | undefined, c: Category) => sumCat(g, cats, c);

  // ---------- 1. what the CD returned ----------
  const returned = (
    <Section title={tc('returnedTitle')} right={<span class="muted small">{cycle.cdStatus === 'submitted' ? tc('cd_submitted') : ''}</span>}>
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('head')}</th>{CATEGORIES.map((c) => <th key={c} class="num">{c}</th>)}<th class="num">{tc('total')}</th></tr></thead>
        <tbody>
          {deptIds.map((d) => (
            <tr key={d}><td>{deptName(d)}</td>{CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(byCat(dept[d], c))}</td>)}<td class="num tot">{fmtNum(total(dept[d]))}</td></tr>
          ))}
        </tbody>
        <tfoot>
          <tr class="sub l1"><td>{tc('newTotalTarget')}</td>{CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(deptIds.reduce((s, d) => s + byCat(dept[d], c), 0))}</td>)}
            <td class="num">{fmtNum(deptIds.reduce((s, d) => s + total(dept[d]), 0))}</td></tr>
        </tfoot>
      </table></div>
    </Section>
  );

  // ---------- 2. months and average sales per Head ----------
  const routesOf = (d: string) => org.leaves.filter((x) => String(x.deptId) === d).map((x) => x.routeCode);
  const avgTable = (
    <Section title={tc('avgByHead')} right={<span class="muted small">{tc('avgOver', { months: monthsLabel(months) })}</span>}>
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('head')}</th><th class="num">{tc('routesWithSales')}</th>{CATEGORIES.map((c) => <th key={c} class="num">{tc('avgOf', { c })}</th>)}<th class="num">{tc('avgTotal')}</th></tr></thead>
        <tbody>{deptIds.map((d) => {
          const rs = routesOf(d);
          const g: Grid = {};
          let withSales = 0;
          for (const r of rs) {
            const a = routeAvg.get(r) ?? {};
            if (total(a) > 0) withSales++;
            for (const [p, n] of Object.entries(a)) g[p] = (g[p] ?? 0) + n;
          }
          return (
            <tr key={d}><td><b>{deptName(d)}</b></td><td class="num">{withSales} / {rs.length}</td>
              {CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(Math.round(byCat(g, c)))}</td>)}<td class="num tot">{fmtNum(Math.round(total(g)))}</td></tr>
          );
        })}</tbody>
      </table></div>
      {uploadedLeaf && (
        <div class="toolbar" role="radiogroup" aria-label={tc('splitBasis')}>
          <span class="small">{tc('splitBasis')}:</span>
          <label class="small"><input type="radio" checked={basis === 'sales'} onChange={() => setBasis('sales')} /> {tc('basisSales')}</label>
          <label class="small"><input type="radio" checked={basis === 'uploaded'} onChange={() => setBasis('uploaded')} /> {tc('basisUploadedLeaf')}</label>
        </div>
      )}
      <div class="actions">
        <button type="button" class="btn primary" disabled={!data.data || !months.length} onClick={() => { setRan(true); setFixed({}); setMsg(null); }}>
          {tc('calcByPack')}
        </button>
        {!months.length && <span class="small bad-text">{tc('pickMonths')}</span>}
      </div>
    </Section>
  );

  const head = (
    <>
      {returned}
      <MonthPicker period={period} months={months} onChange={(m) => void setMonths(m)} available={avail.data ? new Set(avail.data.months) : null} title={tc('monthsForAvg')} />
      {data.error && <div class="alert" role="alert">{data.error}</div>}
      {avgTable}
    </>
  );
  if (!live || !base) return <>{head}{cycle.calcDepts.length > 0 && <p class="small muted">{tc('calcStored', { n: cycle.calcDepts.length })} {cycle.updatedAt && fmtDateTime(cycle.updatedAt, lang)}</p>}</>;

  // ---------- 3. contribution, cascaded ----------
  const names = new Map<string, string>();
  for (const n of org.nodes) names.set(`n:${n.id}`, n.name);
  for (const x of org.leaves) names.set(`r:${x.routeCode}`, `${ws === 'ka' ? 'KAE' : tc('route')} ${x.routeCode}`);
  const calcOf = (d: string) => live.depts.find((x) => String(x.deptId) === d) ?? null;
  const baseOf = (d: string) => base.depts.find((x) => String(x.deptId) === d) ?? null;
  const tree = deptSel ? deptTree(org, Number(deptSel)) : null;
  const rows = tree ? flatten(tree, names) : [];
  const levelName = (r: TreeRow) => (r.level === 0 ? tc('lvHead') : r.leaf ? (ws === 'ka' ? 'KAE' : tc('lvRoute')) : r.level === 1 ? (ws === 'ka' ? 'KAM' : tc('lvManager')) : tc('lvSupervisor'));
  const dc = calcOf(deptSel);
  const targetOf = (id: string, p: string, c = dc): number => {
    if (!c) return 0;
    return id.startsWith('r:') ? c.result.routes[id]?.[p] ?? 0 : c.result.nodes[id]?.[p] ?? 0;
  };
  const avgOfRow = (r: TreeRow, packs: string[]) => r.routes.reduce((s, x) => s + sumPacks(routeAvg.get(x), packs), 0);
  const deptPacks = Object.keys(dept[deptSel] ?? {});
  const catPacks = (c: Category) => deptPacks.filter((p) => (cats.get(p) ?? 'LRB-Others') === c);
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const byCategory = (
    <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="contribution-cat">
      <thead>
        <tr><th rowSpan={2}>{tc('name')}</th><th rowSpan={2}>{tc('level')}</th>{CATEGORIES.map((c) => <th key={c} colSpan={3} class="grp">{c}</th>)}<th rowSpan={2} class="num">{tc('newTargetAll')}</th></tr>
        <tr>{CATEGORIES.flatMap((c) => [<th key={`${c}a`} class="num">{tc('avgSales')}</th>, <th key={`${c}s`} class="num">{tc('share')}</th>, <th key={`${c}t`} class="num">{tc('newTarget')}</th>])}</tr>
      </thead>
      <tbody>{rows.map((r) => {
        const parent = r.parent ? rowById.get(r.parent) : null;
        let all = 0;
        return (
          <tr key={r.id} class={r.level === 0 ? 'sub l1' : r.leaf ? 'muted' : r.level === 1 ? 'sub l2' : ''}>
            <td><span style={{ paddingInlineStart: `${r.level * 14}px` }}>{r.name}</span></td>
            <td class="small">{levelName(r)}</td>
            {CATEGORIES.flatMap((c) => {
              const packs = catPacks(c);
              const a = avgOfRow(r, packs);
              const pa = parent ? avgOfRow(parent, packs) : a;
              const t = packs.reduce((s, p) => s + targetOf(r.id, p), 0);
              all += t;
              return [
                <td key={`${c}a`} class="num">{fmtNum(Math.round(a))}</td>,
                <td key={`${c}s`} class="num">{fmtPct(pa > 0 ? a / pa : null, 2)}</td>,
                <td key={`${c}t`} class="num"><b>{fmtNum(t)}</b></td>,
              ];
            })}
            <td class="num tot">{fmtNum(all)}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );

  const shown = rowById.get(showSel) ?? rows[0] ?? null;
  const shownParent = shown?.parent ? rowById.get(shown.parent) ?? null : null;
  const bc = baseOf(deptSel);
  function edit(id: string, p: string, n: number) {
    setFixed((f) => ({ ...f, [id]: { ...(f[id] ?? {}), [p]: n } }));
    setMsg(null);
  }
  function unedit(id: string, p: string) {
    setFixed((f) => {
      const g = { ...(f[id] ?? {}) };
      delete g[p];
      const next = { ...f, [id]: g };
      if (!Object.keys(g).length) delete next[id];
      return next;
    });
  }
  const byPack = shown && (
    <>
      <div class="toolbar">
        <label class="small">{tc('show')}{' '}
          <select value={shown.id} onChange={(e) => setShowSel(e.currentTarget.value)}>
            {rows.map((r) => <option key={r.id} value={r.id}>{' '.repeat(r.level * 2)}{r.name} ({levelName(r)})</option>)}
          </select>
        </label>
      </div>
      <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="contribution-pack">
        <thead><tr>
          <th>{tc('pack')}</th><th class="num">{tc('avgSales')}</th>
          <th class="num">{shown.level === 0 ? tc('shareOfDeptCat') : tc('shareOfParent', { name: shownParent?.name ?? '' })}</th>
          <th class="num">{tc('newTarget')}</th>
          <th class="num">{shown.level === 0 ? tc('deptTargetCd') : tc('recommended')}</th>
          <th class="num">{tc('diff')}</th><th />
        </tr></thead>
        <tbody>{CATEGORIES.flatMap((c) => {
          const packs = catPacks(c);
          if (!packs.length) return [];
          const catAvg = avgOfRow(shown, packs);
          const catT = packs.reduce((s, p) => s + targetOf(shown.id, p), 0);
          const catRef = packs.reduce((s, p) => s + (shown.level === 0 ? dept[deptSel]?.[p] ?? 0 : targetOf(shown.id, p, bc)), 0);
          return [
            <tr key={c} class="sub l2"><td>{c}</td><td class="num">{fmtNum(Math.round(catAvg))}</td><td class="num">{shown.level === 0 ? '100.00%' : fmtPct(shownParent && avgOfRow(shownParent, packs) > 0 ? catAvg / avgOfRow(shownParent, packs) : null, 2)}</td>
              <td class="num">{fmtNum(catT)}</td><td class="num">{fmtNum(catRef)}</td><td class="num">{catT - catRef === 0 ? '±0' : fmtNum(catT - catRef)}</td><td /></tr>,
            ...packs.map((p) => {
              const a = avgOfRow(shown, [p]);
              const share = shown.level === 0 ? (catAvg > 0 ? a / catAvg : null) : (shownParent && avgOfRow(shownParent, [p]) > 0 ? a / avgOfRow(shownParent, [p]) : null);
              const t = targetOf(shown.id, p);
              const ref = shown.level === 0 ? dept[deptSel]?.[p] ?? 0 : targetOf(shown.id, p, bc);
              const isFixed = fixed[shown.id]?.[p] !== undefined;
              return (
                <tr key={p} class={isFixed ? 'edited' : ''}>
                  <td><bdi>{p}</bdi></td><td class="num">{fmtNum(Math.round(a))}</td><td class="num">{fmtPct(share, 2)}</td>
                  <td class="num">{shown.level === 0 ? <b>{fmtNum(t)}</b> : <NumCell value={t} label={`${tc('newTarget')} ${shown.name} ${p}`} onChange={(n) => edit(shown.id, p, n)} />}</td>
                  <td class="num">{fmtNum(ref)}</td>
                  <td class="num">{t - ref === 0 ? '±0' : fmtNum(t - ref)}</td>
                  <td>{isFixed && <button type="button" class="btn link small" onClick={() => unedit(shown.id, p)}>{tc('undo')}</button>}</td>
                </tr>
              );
            }),
          ];
        })}</tbody>
      </table></div>
      <p class="small muted">{shown.level === 0 ? tc('packHeadHelp') : tc('packEditHelp')}</p>
    </>
  );

  // ---------- 4. checks ----------
  const issues = live.depts.flatMap((d) => d.result.issues.map((i) => ({ ...i, dept: String(d.deptId) })));
  const over = issues.filter((i) => i.kind === 'over');
  const short = issues.filter((i) => i.kind === 'short');
  const issueChecks = [
    ...over.slice(0, 20).map((i) => ({ level: 'error' as const, text: tc('issueOver', { name: names.get(i.node) ?? i.node, pack: i.pack, n: fmtNum(i.cases) }) })),
    ...short.slice(0, 20).map((i) => ({ level: 'warning' as const, text: tc('issueShort', { name: names.get(i.node) ?? i.node, pack: i.pack, n: fmtNum(i.cases) }) })),
  ];
  const calcTot = (d: string, c: Category | null) => {
    const x = calcOf(d);
    if (!x) return 0;
    return Object.values(x.routes).reduce((s, g) => s + (c ? sumCat(g, cats, c) : total(g)), 0);
  };
  const tgtTot = (d: string, c: Category | null) => (c ? sumCat(dept[d], cats, c) : total(dept[d]));
  const lines = deptIds.map((d) => ({ d, cells: [...CATEGORIES, null].map((c) => ({ calc: calcTot(d, c), tgt: tgtTot(d, c) })) }));
  const anyOver = lines.some((x) => x.cells.some((c) => c.calc > c.tgt)) || over.length > 0;
  const abc = companyNt ? [...CATEGORIES.map((c) => sumCat(companyNt, cats, c)), total(companyNt)] : null;
  const allCalc = [...CATEGORIES, null].map((c) => deptIds.reduce((s, d) => s + calcTot(d, c), 0));
  const overAbc = abc ? allCalc.some((v, i) => v > abc[i]!) : false;
  const cellCheck = (calc: number, tgt: number) => (calc === tgt ? <span class="status ok">{tc('matches')}</span>
    : calc > tgt ? <span class="status bad">{tc('overBy', { n: fmtNum(calc - tgt) })}</span>
      : <span class="status warn">{tc('underBy', { n: fmtNum(tgt - calc) })}</span>);

  const check = (
    <Section title={tc('checkTitle')} right={<span class={`status ${anyOver || overAbc ? 'bad' : 'ok'}`}>{anyOver || overAbc ? tc('overSomeTotal') : tc('notOverAny')}</span>}>
      <p class="muted small">{tc('checkHelp')}</p>
      <Checks checks={issueChecks} />
      <div class="tablewrap"><table class="ad-table cy-table" data-testid="calc-check">
        <thead><tr><th>{tc('head')}</th>{CATEGORIES.map((c) => <th key={c} class="num">{c}<div class="small muted">{tc('calcVsTarget')}</div></th>)}<th class="num">{tc('total')}<div class="small muted">{tc('calcVsTarget')}</div></th><th>{tc('checkCol')}</th></tr></thead>
        <tbody>
          {lines.map((x) => {
            const tot = x.cells[3]!;
            return (
              <tr key={x.d}><td>{deptName(x.d)}</td>
                {x.cells.map((c, i) => <td key={i} class="num">{fmtNum(c.calc)}<div class="small muted">{tc('targetN', { n: fmtNum(c.tgt) })}</div></td>)}
                <td>{cellCheck(tot.calc, tot.tgt)}</td></tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr class="sub l2"><td>{tc('allDepts')}</td>{allCalc.map((v, i) => <td key={i} class="num">{fmtNum(v)}<div class="small muted">{tc('targetN', { n: fmtNum(lines.reduce((s, x) => s + x.cells[i]!.tgt, 0)) })}</div></td>)}
            <td>{cellCheck(allCalc[3]!, lines.reduce((s, x) => s + x.cells[3]!.tgt, 0))}</td></tr>
          {abc && <tr class="sub l1"><td>{tc('companyTotal')}</td>{abc.map((v, i) => <td key={i} class="num">{fmtNum(allCalc[i]!)}<div class="small muted">{tc('targetN', { n: fmtNum(v) })}</div></td>)}
            <td>{cellCheck(allCalc[3]!, abc[3]!)}</td></tr>}
        </tfoot>
      </table></div>
    </Section>
  );

  // ---------- exports and apply ----------
  function exportCalc() {
    const catRows: (string | number | null)[][] = [];
    const packRows: (string | number | null)[][] = [];
    for (const d of deptIds) {
      const t = deptTree(org, Number(d));
      if (!t) continue;
      const rs = flatten(t, names);
      const byId = new Map(rs.map((r) => [r.id, r]));
      const c = calcOf(d);
      const tg = (id: string, p: string) => (id.startsWith('r:') ? c?.result.routes[id]?.[p] ?? 0 : c?.result.nodes[id]?.[p] ?? 0);
      const packs = Object.keys(deptT[d] ?? {});
      for (const r of rs) {
        const parent = r.parent ? byId.get(r.parent) : null;
        const line: (string | number | null)[] = [deptName(d), levelName(r), r.name];
        for (const cat of CATEGORIES) {
          const ps = packs.filter((p) => (cats.get(p) ?? 'LRB-Others') === cat);
          const a = avgOfRow(r, ps);
          const pa = parent ? avgOfRow(parent, ps) : a;
          line.push(Math.round(a), pa > 0 ? Math.round((a / pa) * 10000) / 10000 : null, ps.reduce((s, p) => s + tg(r.id, p), 0));
        }
        catRows.push(line);
        for (const p of packs) {
          const a = avgOfRow(r, [p]);
          const pa = parent ? avgOfRow(parent, [p]) : null;
          packRows.push([deptName(d), levelName(r), r.name, p, cats.get(p) ?? '', subOf(p), Math.round(a * 100) / 100, pa ? Math.round((a / pa) * 10000) / 10000 : null, tg(r.id, p)]);
        }
      }
    }
    void writeWorkbook(`target_calculation_${ws}_${period}.xlsx`, [
      { name: 'By category', columns: ['Head of Department', 'Level', 'Name', ...CATEGORIES.flatMap((c) => [`${c} avg sales`, `${c} share`, `${c} new target`])], rows: catRows },
      { name: 'By pack', columns: ['Head of Department', 'Level', 'Name', 'Pack', 'Category', 'Sub category', 'Avg sales', 'Share of level above', 'New target'], rows: packRows },
      { name: 'Check', columns: ['Head of Department', ...CATEGORIES.flatMap((c) => [`${c} calculated`, `${c} target`]), 'Total calculated', 'Total target'],
        rows: lines.map((x) => [deptName(x.d), ...x.cells.flatMap((c) => [c.calc, c.tgt])]) },
    ]);
  }
  function exportRoutes() {
    const byId = new Map(org.nodes.map((n) => [n.id, n]));
    const packs = [...new Set(deptIds.flatMap((d) => Object.keys(deptT[d] ?? {})))].sort();
    const list: (string | number | null)[][] = [];
    const matrix: (string | number | null)[][] = [];
    for (const x of org.leaves) {
      const c = calcOf(String(x.deptId));
      if (!c) continue;
      const g = c.routes[x.routeCode] ?? {};
      const path: string[] = [];
      for (let n = byId.get(x.nodeId); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) path.unshift(n.name);
      const [h = '', m = '', s = ''] = path;
      for (const p of packs) if (g[p]) list.push([period.replace('-', ''), x.deliverySystem, x.routeCode, h, m, s, p, cats.get(p) ?? '', g[p]!]);
      matrix.push([h, m, s, x.routeCode, ...packs.map((p) => g[p] ?? 0), total(g)]);
    }
    void writeWorkbook(`target_by_route_and_pack_${ws}_${period}.xlsx`, [
      { name: 'Route x pack', columns: ['Period', 'Delivery System', 'Route Code', 'Head of Department', 'Manager', 'Supervisor', 'Sales Target Category', 'Category', 'Cases'], rows: list },
      { name: 'Matrix', columns: ['Head of Department', 'Manager', 'Supervisor', 'Route Code', ...packs, 'Total'], rows: matrix },
    ]);
  }
  async function apply() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const calc = Object.fromEntries(live!.depts.map((d) => [String(d.deptId), d.routes]));
      const notes = {
        at: new Date().toISOString(), months, basis: useUploaded ? 'uploaded' : 'sales', edits: fixed, problems: live!.problems,
        depts: live!.depts.map((d) => ({ deptId: d.deptId, basis: d.result.basisCount, fallback: d.result.fallbackPacks })),
      };
      const out = await api<{ applied: string[]; kept: string[] }>('PUT', `/api/admin/cycle/${ws}/${period}/calc`, { calc, notes });
      setMsg(tc('calcApplied', { n: out.applied.length, kept: out.kept.length }));
      reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  const nEdits = Object.values(fixed).reduce((s, g) => s + Object.keys(g).length, 0);

  return (
    <>
      {head}
      {live.problems.length > 0 && <Checks checks={live.problems.map((text) => ({ level: 'warning', text }))} />}
      <Section title={tc('contribTitle')} right={<Tabs<'cat' | 'pack'> value={view} onChange={setView} items={[{ id: 'cat', label: tc('byCategory') }, { id: 'pack', label: tc('byPack') }]} />}>
        <div class="toolbar">
          <label class="small">{tc('head')}{' '}
            <select value={deptSel} onChange={(e) => { setDeptSel(e.currentTarget.value); setShowSel(''); }}>
              {deptIds.map((d) => <option key={d} value={d}>{deptName(d)}</option>)}
            </select>
          </label>
          {nEdits > 0 && <span class="pill warn">{tc('nEdits', { n: nEdits })}</span>}
          {nEdits > 0 && <button type="button" class="btn" onClick={() => setFixed({})}>{tc('resetEdits')}</button>}
        </div>
        {view === 'cat' ? byCategory : byPack}
        <p class="small muted">{tc('contribHelp', { months: monthsLabel(months) })}</p>
      </Section>
      {check}
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="actions cy-end">
        <button type="button" class="btn" onClick={exportCalc}>{tc('exportCalc')}</button>
        <button type="button" class="btn" onClick={exportRoutes}>{tc('exportRoutes')}</button>
        <button type="button" class="btn primary" disabled={busy || anyOver || overAbc} data-testid="apply-calc" onClick={() => void apply()}>{tc('applyN', { n: live.depts.length })}</button>
      </div>
      <p class="small muted">{tc('periodsNote', { pago: pm, yago: addMonths(period, -12), from: addMonths(period, -3) })}</p>
    </>
  );
}
