// Reports (handover section 9) for Admin and the Commercial Director: the
// workflow stepper, sales averages, the target summary (CSV) and the
// dashboard of target vs sales per category (PowerPoint).
import { useLocation } from 'preact-iso';
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES } from '../../../shared/calc/packs';
import { addMonths, pago as pagoOf, yago as yagoOf } from '../../../shared/calc/periods';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto } from '../../../worker/services/cycle';
import type { OrgDto } from '../../../worker/services/cycleData';
import { PageHead } from '../../components/AdminBits';
import { CdDashboard } from './CdDashboard';
import { fmtNum, useLang } from '../../i18n';
import { avgOf, catMap, groupSales, routeIndex, sumCat, total, type Grid } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { getCycle, getOrg, loadRouteData, useAsync } from '../../cycle/load';
import type { RouteMonthData } from '../../cycle/parsers';
import { api } from '../../api';
import { defaultPeriod, downloadCsv, fmtGap, gapClass, MonthPicker, monthsLabel, Section, Tabs, useMyWorkspaces, WsPeriod } from '../../cycle/ui';

type TabId = 'flow' | 'avg' | 'summary' | 'dash' | 'cdd';
type Loaded = { cycle: CycleDto; org: OrgDto };

// ---------- workflow stepper ----------

export function workflowSteps(c: CycleDto): { key: string; done: boolean; current: boolean }[] {
  const heads = c.heads;
  const sent = heads.some((h) => h.status !== 'draft');
  const approved = heads.length > 0 && heads.every((h) => h.status === 'approved');
  const final = heads.length > 0 && heads.every((h) => h.monthState === 'complete');
  const flags: [string, boolean][] = [
    ['wfOpen', c.version > 0],
    ['wfCd', !c.settings.cdStep || c.cdStatus === 'with_cd' || c.cdStatus === 'submitted'],
    ['wfCdDone', !c.settings.cdStep ? c.dept !== null || c.calcDepts.length > 0 : c.cdStatus === 'submitted'],
    ['wfCalc', c.calcDepts.length > 0],
    ['wfSent', sent],
    ['wfApproved', approved],
    ['wfFinal', final],
  ];
  const firstOpen = flags.findIndex(([, d]) => !d);
  return flags.map(([key, done], i) => ({ key, done, current: i === firstOpen }));
}

function Flow({ l }: { l: Loaded }) {
  useLang();
  const steps = workflowSteps(l.cycle);
  return (
    <Section title={tc('tabFlow')}>
      <ol class="cy-stepper">
        {steps.map((s, i) => (
          <li key={s.key} class={s.done ? 'done' : s.current ? 'current' : ''}>
            <span class="n">{s.done ? '✓' : i + 1}</span>{tc(s.key as 'wfOpen')}
          </li>
        ))}
      </ol>
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('head')}</th><th>{tc('status')}</th><th>{tc('progress')}</th></tr></thead>
        <tbody>{l.cycle.heads.map((h) => {
          const p = l.cycle.progress[String(h.deptId)];
          return (
            <tr key={h.deptId}>
              <td>{h.name}</td>
              <td><span class={`pill ${h.status}`}>{tc(`hs_${h.status}` as 'hs_draft')}</span>{h.monthState === 'complete' && <span class="pill ok">{tc('final')}</span>}</td>
              <td class="small">{p ? tc('progressText', { s: p.submitted, o: p.in_progress, w: p.waiting }) : '—'}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </Section>
  );
}

// ---------- sales averages ----------

function Averages({ l, sales, months, setMonths, available }: { l: Loaded; sales: RouteMonthData; months: string[]; setMonths: (m: string[]) => void; available: Set<string> | null }) {
  useLang();
  const { org } = l;
  const cats = catMap(org);
  const idx = routeIndex(org);
  const byDept = groupSales(sales, (r) => { const i = idx.get(r); return i ? String(i.deptId) : null; });
  const byRoute = groupSales(sales, (r) => r);
  const packs = [...new Set(months.flatMap((m) => Object.values(sales[m] ?? {}).flatMap((g) => Object.keys(g))))].sort();
  const deptAvg = (d: string): Grid => Object.fromEntries(packs.map((p) => [p, avgOf(byDept, d, p, months)]));
  function csv() {
    const rows: (string | number)[][] = [];
    for (const l2 of org.leaves) for (const p of packs) {
      const v = avgOf(byRoute, l2.routeCode, p, months);
      if (v) rows.push([org.depts.find((d) => d.id === l2.deptId)?.name ?? '', l2.routeCode, p, cats.get(p) ?? '', Math.round(v * 100) / 100]);
    }
    downloadCsv(`sales_averages_${l.cycle.ws}_${l.cycle.period}.csv`, ['Head of Department', l.cycle.ws === 'ka' ? 'KAE' : 'Route Code', 'Sales Target Category', 'Category', 'Average cases'], rows);
  }
  return (
    <Section title={tc('tabAvg')} right={<button type="button" class="btn" onClick={csv}>{tc('downloadCsv')}</button>}>
      <MonthPicker period={l.cycle.period} months={months} onChange={setMonths} available={available} title={tc('avgPickTitle')} />
      {!months.length && <p class="small muted">{tc('pickMonths')}</p>}
      <p class="small muted">{tc('avgOver', { months: months.join(', ') })}</p>
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('head')}</th>{CATEGORIES.map((c) => <th key={c} class="num">{c}</th>)}<th class="num">{tc('total')}</th></tr></thead>
        <tbody>{org.depts.map((d) => {
          const g = deptAvg(String(d.id));
          return <tr key={d.id}><td>{d.name}</td>{CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(Math.round(sumCat(g, cats, c)))}</td>)}<td class="num">{fmtNum(Math.round(total(g)))}</td></tr>;
        })}</tbody>
      </table></div>
    </Section>
  );
}

// ---------- summary ----------

/** One comparison of the Target Summary: the New Target per Head and category vs the average sales of the months ticked. */
function Comparison({ l, n, initial, onRemove }: { l: Loaded; n: number; initial: string[]; onRemove?: () => void }) {
  useLang();
  const { org, cycle } = l;
  const ws = cycle.ws;
  const [months, setMonths] = useState<string[]>(initial);
  const avail = useAsync(() => api<{ months: string[] }>('GET', `/api/data/${ws}/sales-months`), [ws]);
  const sales = useAsync(months.length ? () => loadRouteData(ws, 'sales', months).then((r) => r.data) : null, [ws, months.join(',')]);
  const cats = catMap(org);
  const idx = routeIndex(org);
  const dept = cycle.dept ?? {};
  const ms = months.filter((m) => sales.data?.[m]);
  const byDept = sales.data ? groupSales(sales.data, (r) => { const i = idx.get(r); return i ? String(i.deptId) : null; }) : {};
  const avg = (d: string): Grid => {
    const g: Grid = {};
    for (const m of ms) for (const [p, v] of Object.entries(byDept[m]?.[d] ?? {})) g[p] = (g[p] ?? 0) + v / ms.length;
    return g;
  };
  const groups = [...CATEGORIES.map((c) => ({ label: c as string, f: (g: Grid) => sumCat(g, cats, c) })), { label: tc('total'), f: (g: Grid) => total(g) }];
  const gap = (t: number, s: number) => (s > 0 ? t / s - 1 : null);
  const rows = org.depts.map((d) => ({ name: d.name, t: dept[String(d.id)] ?? {}, s: avg(String(d.id)) }));
  const all = { t: {} as Grid, s: {} as Grid };
  for (const r of rows) { for (const [p, v] of Object.entries(r.t)) all.t[p] = (all.t[p] ?? 0) + v; for (const [p, v] of Object.entries(r.s)) all.s[p] = (all.s[p] ?? 0) + v; }
  return (
    <section class="card cy-section ts-cmp" data-testid={`ts-cmp-${n}`}>
      <div class="cy-section-head">
        <h2>{tc('tsCmpTitle', { n })}</h2>
        {onRemove && <button type="button" class="btn link" onClick={onRemove}>{tc('tsCmpRemove')}</button>}
      </div>
      <MonthPicker period={cycle.period} months={months} onChange={setMonths} available={avail.data ? new Set(avail.data.months) : null} title={tc('tsCmpMonths')} />
      {!months.length ? <p class="small muted">{tc('pickMonths')}</p> : sales.loading && !sales.data ? <p class="muted">{tc('loading')}</p> : (
        <div class="tablewrap"><table class="ad-table cy-table">
          <thead><tr><th>{tc('head')}</th>{groups.map((g) => <th key={g.label} class="num">{g.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}><td>{r.name}</td>{groups.map((g) => {
                const v = gap(g.f(r.t), g.f(r.s));
                return <td key={g.label} class="num" title={`${tc('newTarget')} ${fmtNum(g.f(r.t))} · ${tc('salesWord')} ${fmtNum(Math.round(g.f(r.s)))}`}><span class={gapClass(v)}>{fmtGap(v)}</span></td>;
              })}</tr>
            ))}
          </tbody>
          <tfoot><tr><td>{tc('total')}</td>{groups.map((g) => { const v = gap(g.f(all.t), g.f(all.s)); return <td key={g.label} class="num"><span class={gapClass(v)}>{fmtGap(v)}</span></td>; })}</tr></tfoot>
        </table></div>
      )}
      <p class="small muted">{tc('tsCmpHelp')}</p>
    </section>
  );
}

function Summary({ l }: { l: Loaded }) {
  useLang();
  const { org, cycle } = l;
  const cats = catMap(org);
  const dept = cycle.dept ?? {};
  // Two comparisons to start (PAGO and YAGO); more can be added.
  const [cmps, setCmps] = useState<{ id: number; months: string[] }[]>(() => [
    { id: 1, months: [pagoOf(cycle.period)] }, { id: 2, months: [yagoOf(cycle.period)] },
  ]);
  function csv() {
    const rows: (string | number)[][] = [];
    for (const d of org.depts) for (const [p, n] of Object.entries(dept[String(d.id)] ?? {})) rows.push([cycle.period, d.name, p, cats.get(p) ?? '', n, 'Cases']);
    downloadCsv(`target_summary_${cycle.ws}_${cycle.period}.csv`, ['Period', 'Head of Department', 'Sales Target Category', 'Category', 'Target', 'Format'], rows);
  }
  return (
    <>
    <Section title={tc('tabSummary')} right={<button type="button" class="btn" disabled={!cycle.dept} onClick={csv}>{tc('downloadCsv')}</button>}>
      {!cycle.dept ? <p class="muted">{tc('noDeptTarget')}</p> : (
        <div class="tablewrap"><table class="ad-table cy-table">
          <thead><tr><th>{tc('head')}</th>{CATEGORIES.map((c) => <th key={c} class="num">{c}</th>)}<th class="num">{tc('total')}</th><th>{tc('status')}</th></tr></thead>
          <tbody>
            {org.depts.map((d) => {
              const g = dept[String(d.id)] ?? {};
              const h = cycle.heads.find((x) => x.deptId === d.id);
              return (
                <tr key={d.id}><td>{d.name}</td>{CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(sumCat(g, cats, c))}</td>)}<td class="num">{fmtNum(total(g))}</td>
                  <td>{h && <span class={`pill ${h.status}`}>{tc(`hs_${h.status}` as 'hs_draft')}</span>}</td></tr>
              );
            })}
          </tbody>
          <tfoot><tr><td>{tc('total')}</td>{CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(Object.values(dept).reduce((s, g) => s + sumCat(g, cats, c), 0))}</td>)}
            <td class="num">{fmtNum(Object.values(dept).reduce((s, g) => s + total(g), 0))}</td><td /></tr></tfoot>
        </table></div>
      )}
    </Section>
    {cycle.dept && cmps.map((c, k) => (
      <Comparison key={c.id} l={l} n={k + 1} initial={c.months} onRemove={cmps.length > 1 ? () => setCmps(cmps.filter((x) => x.id !== c.id)) : undefined} />
    ))}
    {cycle.dept && (
      <div class="actions"><button type="button" class="btn" data-testid="ts-add-cmp" onClick={() => setCmps([...cmps, { id: Date.now(), months: [addMonths(cycle.period, -1)] }])}>{tc('tsCmpAdd')}</button></div>
    )}
    </>
  );
}

// ---------- dashboard ----------

type DashRow = { dept: string; target: number; sales: number; gap: number | null };
type DashLvl = 'head' | 'manager' | 'supervisor' | 'route';

/**
 * Target vs the average sales of the months given, per category, by Head (the
 * department target) or by manager, supervisor or route (the route target).
 */
export function dashboardData(l: Loaded, sales: RouteMonthData, months: string[], lvl: DashLvl = 'head', calc: Record<string, Record<string, Grid>> = {}): { cat: string; rows: DashRow[] }[] {
  const { org, cycle } = l;
  const cats = catMap(org);
  const ms = months.filter((m) => sales[m]);
  const avgRoute = (r: string): Grid => {
    const g: Grid = {};
    for (const m of ms) for (const [p, v] of Object.entries(sales[m]?.[r] ?? {})) g[p] = (g[p] ?? 0) + v / ms.length;
    return g;
  };
  const add = (a: Grid, b: Grid) => { for (const [p, v] of Object.entries(b)) a[p] = (a[p] ?? 0) + v; };
  // Entities: name, target grid, sales grid.
  const ents = new Map<string, { name: string; t: Grid; s: Grid }>();
  const ent = (k: string, name: string) => { let e = ents.get(k); if (!e) { e = { name, t: {}, s: {} }; ents.set(k, e); } return e; };
  if (lvl === 'head') {
    const idx = routeIndex(org);
    for (const d of org.depts) add(ent(String(d.id), d.name).t, cycle.dept?.[String(d.id)] ?? {});
    for (const leaf of org.leaves) { const i = idx.get(leaf.routeCode); if (i) add(ent(String(i.deptId), org.depts.find((d) => d.id === i.deptId)?.name ?? '').s, avgRoute(leaf.routeCode)); }
  } else {
    const byId = new Map(org.nodes.map((n) => [n.id, n]));
    const depth = (id: number) => { let d = 0; for (let q = byId.get(id)?.parentId ?? null; q !== null; q = byId.get(q)?.parentId ?? null) d++; return d; };
    const routeT = new Map<string, Grid>();
    for (const routes of Object.values(calc)) for (const [r, g] of Object.entries(routes)) { const x = routeT.get(r) ?? {}; add(x, g); routeT.set(r, x); }
    for (const leaf of org.leaves) {
      const t = routeT.get(leaf.routeCode);
      if (!t) continue;
      const sg = avgRoute(leaf.routeCode);
      if (lvl === 'route') { const e = ent(leaf.routeCode, leaf.label && leaf.label !== leaf.routeCode ? `${leaf.routeCode} · ${leaf.label}` : leaf.routeCode); add(e.t, t); add(e.s, sg); continue; }
      for (let n = byId.get(leaf.nodeId); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) {
        const d = depth(n.id);
        if ((lvl === 'manager' && d === 1) || (lvl === 'supervisor' && d >= 2)) { const e = ent(String(n.id), n.name); add(e.t, t); add(e.s, sg); }
      }
    }
  }
  const list = [...ents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const groups = [...CATEGORIES.map((c) => ({ cat: c as string, f: (g: Grid) => sumCat(g, cats, c) })), { cat: 'Total', f: (g: Grid) => total(g) }];
  return groups.map(({ cat, f }) => {
    const rows = list.map((e) => {
      const target = Math.round(f(e.t));
      const s = Math.round(f(e.s));
      return { dept: e.name, target, sales: s, gap: s > 0 ? target / s - 1 : null };
    }).filter((r) => r.target || r.sales);
    const t = rows.reduce((a, r) => a + r.target, 0);
    const s2 = rows.reduce((a, r) => a + r.sales, 0);
    rows.push({ dept: 'Total', target: t, sales: s2, gap: s2 > 0 ? t / s2 - 1 : null });
    return { cat, rows };
  });
}

async function downloadPptx(l: Loaded, data: { cat: string; rows: DashRow[] }[], label: string) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const title = pptx.addSlide();
  title.addText(`Target vs sales · ${l.cycle.ws.toUpperCase()} · ${l.cycle.period}`, { x: 0.6, y: 2.6, w: 12, h: 1, fontSize: 32, bold: true });
  title.addText(`Compared with sales of ${label}`, { x: 0.6, y: 3.6, w: 12, h: 0.6, fontSize: 18, color: '555555' });
  for (const g of data) {
    const s = pptx.addSlide();
    s.addText(`${g.cat}: target vs ${label} sales`, { x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 24, bold: true });
    const body = g.rows.filter((r) => r.dept !== 'Total').slice(0, 30);
    s.addChart(pptx.ChartType.bar, [
      { name: 'Target', labels: body.map((r) => r.dept), values: body.map((r) => r.target) },
      { name: `Sales ${label}`, labels: body.map((r) => r.dept), values: body.map((r) => r.sales) },
    ], { x: 0.5, y: 1.1, w: 7.2, h: 5.6, barDir: 'col', showLegend: true, legendPos: 'b', chartColors: ['1F6FB2', 'A0A7B4'], valAxisLabelFormatCode: '#,##0' });
    s.addTable([
      [{ text: 'Name', options: { bold: true } }, { text: 'Target', options: { bold: true } }, { text: 'Sales', options: { bold: true } }, { text: 'Gap', options: { bold: true } }],
      ...g.rows.slice(-31).map((r) => [r.dept, r.target.toLocaleString('en-US'), r.sales.toLocaleString('en-US'), r.gap === null ? '—' : `${r.gap >= 0 ? '+' : ''}${(r.gap * 100).toFixed(1)}%`].map((text) => ({ text }))),
    ], { x: 8, y: 1.1, w: 4.8, fontSize: 10, border: { type: 'solid', color: 'DDDDDD', pt: 0.5 } });
  }
  await pptx.writeFile({ fileName: `dashboard_${l.cycle.ws}_${l.cycle.period}.pptx` });
}

type DashShape = 'cards' | 'chart' | 'table';

/** Target vs sales per row as grouped columns (blue = target, grey = sales), like the PowerPoint. */
function TargetSalesChart({ title, rows, salesLabel }: { title: string; rows: DashRow[]; salesLabel: string }) {
  const body = rows.filter((r) => r.dept !== 'Total');
  const max = Math.max(1, ...body.flatMap((r) => [r.target, r.sales]));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.max(4, Math.ceil(max / step) * step);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const left = 70, H = 280, bottom = 70, plotH = H - bottom - 16, gw = 54;
  const W = Math.max(420, left + body.length * (gw + 14) + 10);
  const y = (v: number) => 16 + plotH - (v / top) * plotH;
  return (
    <section class="card cy-card dash-chart">
      <h3>{title}</h3>
      <div class="cdd-chart"><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: target vs sales`} style={{ width: `${W}px`, maxWidth: 'none' }}>
        {ticks.map((t) => <g key={t}><line x1={left} x2={W - 4} y1={y(t)} y2={y(t)} class={t === 0 ? 'cdd-zero' : 'cdd-grid'} /><text x={left - 6} y={y(t) + 4} class="cdd-axis" text-anchor="end">{fmtNum(Math.round(t))}</text></g>)}
        {body.map((r, i) => {
          const x = left + 10 + i * (gw + 14);
          return (
            <g key={r.dept} class="cdd-row"><title>{`${r.dept}\nTarget: ${fmtNum(r.target)}\n${tc('salesWord')} ${salesLabel}: ${fmtNum(r.sales)}\n${fmtGap(r.gap)}`}</title>
              <rect x={x - 4} y={16} width={gw + 8} height={plotH} class="cdd-hit" />
              <rect x={x} y={y(r.target)} width={gw / 2 - 1} height={Math.max(0, y(0) - y(r.target))} class="dash-m t" rx={3} />
              <rect x={x + gw / 2 + 1} y={y(r.sales)} width={gw / 2 - 1} height={Math.max(0, y(0) - y(r.sales))} class="dash-m s" rx={3} />
              <text transform={`translate(${x + gw / 2}, ${H - bottom + 12}) rotate(-35)`} class="cdd-lbl" text-anchor="end">{r.dept.length > 16 ? `${r.dept.slice(0, 15)}…` : r.dept}</text>
            </g>
          );
        })}
      </svg></div>
      <p class="small"><span class={gapClass(rows[rows.length - 1]!.gap)}>{fmtGap(rows[rows.length - 1]!.gap)}</span> {tc('dashTotalGap')}</p>
    </section>
  );
}

/** One comparison of the dashboard: its own sales months (ticked, averaged). */
function DashComparison({ l, n, lvl, calc, initial, onRemove }: {
  l: Loaded; n: number; lvl: DashLvl; calc: Record<string, Record<string, Grid>>; initial: string[]; onRemove?: () => void;
}) {
  useLang();
  const ws = l.cycle.ws;
  const [months, setMonths] = useState<string[]>(initial);
  const [busy, setBusy] = useState(false);
  const [shape, setShape] = useState<DashShape>('cards');
  const avail = useAsync(() => api<{ months: string[] }>('GET', `/api/data/${ws}/sales-months`), [ws]);
  const sales = useAsync(months.length ? () => loadRouteData(ws, 'sales', months).then((r) => r.data) : null, [ws, months.join(',')]);
  const data = useMemo(() => (sales.data ? dashboardData(l, sales.data, months, lvl, calc) : null), [l, sales.data, lvl, calc, months.join(',')]);
  const label = monthsLabel(months.slice().sort());
  return (
    <section class="card cy-section" data-testid={`dash-cmp-${n}`}>
      <div class="cy-section-head">
        <h2>{tc('dashCmpTitle', { n })}</h2>
        <div class="toolbar">
          <label class="small">{tc('cddShape')}{' '}
            <select value={shape} data-testid={`dash-shape-${n}`} onChange={(e) => setShape(e.currentTarget.value as DashShape)}>
              <option value="cards">{tc('dashShapeCards')}</option>
              <option value="chart">{tc('cddShapeColumns')}</option>
              <option value="table">{tc('dashShapeTable')}</option>
            </select>
          </label>
          <button type="button" class="btn" disabled={busy || !data} onClick={() => { if (!data) return; setBusy(true); void downloadPptx(l, data, label).finally(() => setBusy(false)); }}>{tc('downloadPptx')}</button>
          {onRemove && <button type="button" class="btn link" onClick={onRemove}>{tc('tsCmpRemove')}</button>}
        </div>
      </div>
      <MonthPicker period={l.cycle.period} months={months} onChange={setMonths} available={avail.data ? new Set(avail.data.months) : null} title={tc('tsCmpMonths')} />
      {!months.length && <p class="small muted">{tc('pickMonths')}</p>}
      {sales.error && <div class="alert">{sales.error}</div>}
      {months.length > 0 && !data && <p class="muted">{tc('loading')}</p>}
      {data && shape === 'chart' && (
        <>
          <p class="small cdd-legend"><i class="sw dash-t" />{tc('newTarget')}<i class="sw dash-s" />{tc('salesWord')} {label}</p>
          <div class="dash-charts">{data.map((g) => <TargetSalesChart key={g.cat} title={g.cat} rows={g.rows} salesLabel={label} />)}</div>
        </>
      )}
      {data && shape === 'table' && (
        <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid={`dash-table-${n}`}>
          <thead>
            <tr><th rowSpan={2}>{tc('nameWord')}</th>{data.map((g) => <th key={g.cat} colSpan={3} class="grp">{g.cat}</th>)}</tr>
            <tr>{data.map((g) => [<th key={`${g.cat}t`} class="num">{tc('newTarget')}</th>, <th key={`${g.cat}s`} class="num">{tc('salesWord')}</th>, <th key={`${g.cat}g`} class="num">%</th>])}</tr>
          </thead>
          <tbody>{data[data.length - 1]!.rows.map((row, i) => (
            <tr key={row.dept} class={row.dept === 'Total' ? 'sub l1' : ''}>
              <td><bdi>{row.dept === 'Total' ? tc('total') : row.dept}</bdi></td>
              {data.map((g) => {
                const x = g.rows.find((y) => y.dept === row.dept) ?? { target: 0, sales: 0, gap: null };
                return [<td key={`${g.cat}t${i}`} class="num">{fmtNum(x.target)}</td>, <td key={`${g.cat}s${i}`} class="num">{fmtNum(x.sales)}</td>, <td key={`${g.cat}g${i}`} class="num"><span class={gapClass(x.gap)}>{fmtGap(x.gap)}</span></td>];
              })}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {data && shape === 'cards' && (
        <div class="cy-cards">
          {data.map((g) => {
            const t = g.rows[g.rows.length - 1]!;
            return (
              <section key={g.cat} class="card cy-card">
                <h3>{g.cat}</h3>
                <p class="big">{fmtNum(t.target)}</p>
                <p class="small">{tc('salesWord')} {label}: {fmtNum(t.sales)} · <span class={gapClass(t.gap)}>{fmtGap(t.gap)}</span></p>
                <div class="cy-mini-wrap"><table class="cy-mini">
                  <tbody>{g.rows.slice(0, -1).map((r) => (
                    <tr key={r.dept} title={`${tc('salesWord')}: ${fmtNum(r.sales)}`}><td><bdi>{r.dept}</bdi></td><td class="num">{fmtNum(r.target)}</td><td class="num"><span class={gapClass(r.gap)}>{fmtGap(r.gap)}</span></td></tr>
                  ))}</tbody>
                </table></div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Dashboard({ l }: { l: Loaded }) {
  useLang();
  const { cycle } = l;
  const ka = cycle.ws === 'ka';
  const [lvl, setLvl] = useState<DashLvl>('head');
  const [cmps, setCmps] = useState<{ id: number; months: string[] }[]>(() => [{ id: 1, months: [pagoOf(cycle.period)] }]);
  const calc = useAsync(lvl !== 'head' ? () => api<Record<string, Record<string, Grid>>>('GET', `/api/cycle/${cycle.ws}/${cycle.period}/calc`) : null, [cycle.ws, cycle.period, lvl !== 'head']);
  if (!cycle.dept) return <p class="card muted">{tc('noDeptTarget')}</p>;
  const levels: DashLvl[] = ka ? ['head', 'manager', 'route'] : ['head', 'manager', 'supervisor', 'route'];
  const label: Record<DashLvl, string> = { head: tc('lvHead'), manager: ka ? 'KAM' : tc('lvManager'), supervisor: tc('lvSupervisor'), route: ka ? 'KAE' : tc('route') };
  const noCalc = lvl !== 'head' && calc.data && Object.keys(calc.data).length === 0;
  return (
    <>
      <div class="toolbar cdd-filters">
        <b class="small">{tc('dashShowBy')}</b>
        <Tabs<DashLvl> value={lvl} onChange={setLvl} items={levels.map((x) => ({ id: x, label: label[x] }))} />
      </div>
      {noCalc && <p class="banner warn small">{tc('cddNoRoutes')}</p>}
      {(lvl === 'head' || calc.data) && cmps.map((c, k) => (
        <DashComparison key={c.id} l={l} n={k + 1} lvl={lvl} calc={calc.data ?? {}} initial={c.months}
          onRemove={cmps.length > 1 ? () => setCmps(cmps.filter((x) => x.id !== c.id)) : undefined} />
      ))}
      {lvl !== 'head' && !calc.data && <p class="muted">{tc('loading')}</p>}
      <div class="actions"><button type="button" class="btn" data-testid="dash-add-cmp" onClick={() => setCmps([...cmps, { id: Date.now(), months: [yagoOf(cycle.period)] }])}>{tc('tsCmpAdd')}</button></div>
    </>
  );
}

// ---------- page ----------

export function Reports({ ws: wsParam, period: periodParam }: { ws?: string; period?: string }) {
  useLang();
  const { route } = useLocation();
  const allowed = useMyWorkspaces();
  const ws: Workspace = wsParam === 'ka' ? 'ka' : wsParam === 'ops' ? 'ops' : allowed.includes('ops') || !allowed.length ? 'ops' : allowed[0]!;
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : defaultPeriod();
  const [tab, setTab] = useState<TabId>('flow');
  const loaded = useAsync<Loaded>(async () => {
    const [cycle, org] = await Promise.all([getCycle(ws, period), getOrg(ws)]);
    return { cycle, org };
  }, [ws, period]);
  const l = loaded.data;
  const [avgPick, setAvgPick] = useState<string[] | null>(null);
  const avgMonths = avgPick ?? l?.cycle.settings.avgMonths ?? [];
  const avail = useAsync(tab === 'avg' ? () => api<{ months: string[] }>('GET', `/api/data/${ws}/sales-months`) : null, [ws, tab]);
  const needSales = tab === 'avg' ? avgMonths : null;
  const sales = useAsync(l && needSales ? () => loadRouteData(ws, 'sales', needSales).then((r) => r.data) : null, [l, tab, ws, avgMonths.join(',')]);
  return (
    <section class="cycle" data-testid="reports">
      <PageHead title={tc('reportsTitle')} intro={tc('reportsIntro')} />
      <WsPeriod ws={ws} period={period} allowed={allowed} onChange={(w, p) => route(`/reports/${w}/${p}`)} />
      <Tabs<TabId> value={tab} onChange={setTab} items={[
        { id: 'flow', label: tc('tabFlow') }, { id: 'avg', label: tc('tabAvg') }, { id: 'summary', label: tc('tabSummary') }, { id: 'dash', label: tc('tabDash') }, { id: 'cdd', label: tc('cddTab') },
      ]} />
      {loaded.error && <div class="alert" role="alert">{loaded.error}</div>}
      {!l && !loaded.error && <p class="muted">{tc('loading')}</p>}
      {l && tab === 'flow' && <Flow l={l} />}
      {l && tab === 'summary' && <Summary l={l} />}
      {l && tab === 'cdd' && <CdDashboard ws={ws} cycle={l.cycle} org={l.org} />}
      {l && tab === 'avg' && sales.error && <div class="alert">{sales.error}</div>}
      {l && tab === 'avg' && !sales.data && !sales.error && <p class="muted">{tc('loading')}</p>}
      {l && tab === 'avg' && sales.data && <Averages l={l} sales={sales.data} months={avgMonths} setMonths={setAvgPick} available={avail.data ? new Set(avail.data.months) : null} />}
      {l && tab === 'dash' && <Dashboard l={l} />}
    </section>
  );
}
