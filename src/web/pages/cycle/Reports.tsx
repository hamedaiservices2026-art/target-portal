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
import { fmtNum, useLang } from '../../i18n';
import { avgOf, catMap, groupSales, routeIndex, sumCat, total, type Grid } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { getCycle, getOrg, loadRouteData, useAsync } from '../../cycle/load';
import type { RouteMonthData } from '../../cycle/parsers';
import { defaultPeriod, downloadCsv, fmtGap, gapClass, Section, Tabs, useMyWorkspaces, WsPeriod } from '../../cycle/ui';

type TabId = 'flow' | 'avg' | 'summary' | 'dash';
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

function Averages({ l, sales, months }: { l: Loaded; sales: RouteMonthData; months: string[] }) {
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
    downloadCsv(`sales_averages_${l.cycle.ws}_${l.cycle.period}.csv`, ['Head of Department', 'Route Code', 'Sales Target Category', 'Category', 'Average cases'], rows);
  }
  return (
    <Section title={tc('tabAvg')} right={<button type="button" class="btn" onClick={csv}>{tc('downloadCsv')}</button>}>
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

function Summary({ l }: { l: Loaded }) {
  useLang();
  const { org, cycle } = l;
  const cats = catMap(org);
  const dept = cycle.dept ?? {};
  function csv() {
    const rows: (string | number)[][] = [];
    for (const d of org.depts) for (const [p, n] of Object.entries(dept[String(d.id)] ?? {})) rows.push([cycle.period, d.name, p, cats.get(p) ?? '', n, 'Cases']);
    downloadCsv(`target_summary_${cycle.ws}_${cycle.period}.csv`, ['Period', 'Head of Department', 'Sales Target Category', 'Category', 'Target', 'Format'], rows);
  }
  return (
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
  );
}

// ---------- dashboard ----------

type DashRow = { dept: string; target: number; sales: number; gap: number | null };

export function dashboardData(l: Loaded, sales: RouteMonthData, month: string): { cat: string; rows: DashRow[] }[] {
  const { org, cycle } = l;
  const cats = catMap(org);
  const idx = routeIndex(org);
  const byDept = groupSales(sales, (r) => { const i = idx.get(r); return i ? String(i.deptId) : null; });
  const dept = cycle.dept ?? {};
  const groups = [...CATEGORIES.map((c) => ({ cat: c as string, f: (g: Grid | undefined) => sumCat(g, cats, c) })), { cat: 'Total', f: (g: Grid | undefined) => total(g) }];
  return groups.map(({ cat, f }) => {
    const rows = org.depts.map((d) => {
      const target = f(dept[String(d.id)]);
      const s = f(byDept[month]?.[String(d.id)]);
      return { dept: d.name, target, sales: s, gap: s > 0 ? target / s - 1 : null };
    });
    const t = rows.reduce((a, r) => a + r.target, 0);
    const s = rows.reduce((a, r) => a + r.sales, 0);
    rows.push({ dept: 'Total', target: t, sales: s, gap: s > 0 ? t / s - 1 : null });
    return { cat, rows };
  });
}

async function downloadPptx(l: Loaded, data: { cat: string; rows: DashRow[] }[], month: string) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const title = pptx.addSlide();
  title.addText(`Target vs sales · ${l.cycle.ws.toUpperCase()} · ${l.cycle.period}`, { x: 0.6, y: 2.6, w: 12, h: 1, fontSize: 32, bold: true });
  title.addText(`Compared with sales of ${month}`, { x: 0.6, y: 3.6, w: 12, h: 0.6, fontSize: 18, color: '555555' });
  for (const g of data) {
    const s = pptx.addSlide();
    s.addText(`${g.cat}: target vs ${month} sales`, { x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 24, bold: true });
    const body = g.rows.filter((r) => r.dept !== 'Total');
    s.addChart(pptx.ChartType.bar, [
      { name: 'Target', labels: body.map((r) => r.dept), values: body.map((r) => r.target) },
      { name: `Sales ${month}`, labels: body.map((r) => r.dept), values: body.map((r) => r.sales) },
    ], { x: 0.5, y: 1.1, w: 7.2, h: 5.6, barDir: 'col', showLegend: true, legendPos: 'b', chartColors: ['1F6FB2', 'A0A7B4'], valAxisLabelFormatCode: '#,##0' });
    s.addTable([
      [{ text: 'Head', options: { bold: true } }, { text: 'Target', options: { bold: true } }, { text: 'Sales', options: { bold: true } }, { text: 'Gap', options: { bold: true } }],
      ...g.rows.map((r) => [r.dept, r.target.toLocaleString('en-US'), r.sales.toLocaleString('en-US'), r.gap === null ? '—' : `${r.gap >= 0 ? '+' : ''}${(r.gap * 100).toFixed(1)}%`].map((text) => ({ text }))),
    ], { x: 8, y: 1.1, w: 4.8, fontSize: 12, border: { type: 'solid', color: 'DDDDDD', pt: 0.5 } });
  }
  await pptx.writeFile({ fileName: `dashboard_${l.cycle.ws}_${l.cycle.period}.pptx` });
}

function Dashboard({ l, sales, month, setMonth, months }: { l: Loaded; sales: RouteMonthData; month: string; setMonth: (m: string) => void; months: string[] }) {
  useLang();
  const data = useMemo(() => dashboardData(l, sales, month), [l, sales, month]);
  const [busy, setBusy] = useState(false);
  if (!l.cycle.dept) return <p class="card muted">{tc('noDeptTarget')}</p>;
  return (
    <Section title={tc('tabDash')} right={
      <div class="toolbar">
        <label class="small">{tc('compareWith')}{' '}
          <select value={month} onChange={(e) => setMonth(e.currentTarget.value)}>
            {months.map((m) => <option key={m} value={m}>{m === pagoOf(l.cycle.period) ? `${m} (PAGO)` : m === yagoOf(l.cycle.period) ? `${m} (YAGO)` : m}</option>)}
          </select>
        </label>
        <button type="button" class="btn" disabled={busy} onClick={() => { setBusy(true); void downloadPptx(l, data, month).finally(() => setBusy(false)); }}>{tc('downloadPptx')}</button>
      </div>
    }>
      <div class="cy-cards">
        {data.map((g) => {
          const t = g.rows[g.rows.length - 1]!;
          return (
            <section key={g.cat} class="card cy-card">
              <h3>{g.cat}</h3>
              <p class="big">{fmtNum(t.target)}</p>
              <p class="small">{tc('salesWord')} {month}: {fmtNum(t.sales)} · <span class={gapClass(t.gap)}>{fmtGap(t.gap)}</span></p>
              <table class="cy-mini">
                <tbody>{g.rows.slice(0, -1).map((r) => (
                  <tr key={r.dept}><td>{r.dept}</td><td class="num">{fmtNum(r.target)}</td><td class="num"><span class={gapClass(r.gap)}>{fmtGap(r.gap)}</span></td></tr>
                ))}</tbody>
              </table>
            </section>
          );
        })}
      </div>
    </Section>
  );
}

// ---------- page ----------

export function Reports({ ws: wsParam, period: periodParam }: { ws?: string; period?: string }) {
  useLang();
  const { route } = useLocation();
  const allowed = useMyWorkspaces();
  const ws: Workspace = wsParam === 'ka' ? 'ka' : wsParam === 'ops' ? 'ops' : allowed[0] ?? 'ops';
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : defaultPeriod();
  const [tab, setTab] = useState<TabId>('flow');
  const [month, setMonth] = useState(pagoOf(period));
  const loaded = useAsync<Loaded>(async () => {
    const [cycle, org] = await Promise.all([getCycle(ws, period), getOrg(ws)]);
    return { cycle, org };
  }, [ws, period]);
  const l = loaded.data;
  const avgMonths = l?.cycle.settings.avgMonths ?? [];
  const pickMonths = useMemo(() => Array.from({ length: 15 }, (_, i) => addMonths(period, -1 - i)), [period]);
  const needSales = tab === 'avg' ? avgMonths : tab === 'dash' ? [month] : null;
  const sales = useAsync(l && needSales ? () => loadRouteData(ws, 'sales', needSales).then((r) => r.data) : null, [l, tab, month, ws]);
  return (
    <section class="cycle" data-testid="reports">
      <PageHead title={tc('reportsTitle')} intro={tc('reportsIntro')} />
      <WsPeriod ws={ws} period={period} allowed={allowed} onChange={(w, p) => route(`/reports/${w}/${p}`)} />
      <Tabs<TabId> value={tab} onChange={setTab} items={[
        { id: 'flow', label: tc('tabFlow') }, { id: 'avg', label: tc('tabAvg') }, { id: 'summary', label: tc('tabSummary') }, { id: 'dash', label: tc('tabDash') },
      ]} />
      {loaded.error && <div class="alert" role="alert">{loaded.error}</div>}
      {!l && !loaded.error && <p class="muted">{tc('loading')}</p>}
      {l && tab === 'flow' && <Flow l={l} />}
      {l && tab === 'summary' && <Summary l={l} />}
      {l && (tab === 'avg' || tab === 'dash') && sales.error && <div class="alert">{sales.error}</div>}
      {l && (tab === 'avg' || tab === 'dash') && !sales.data && !sales.error && <p class="muted">{tc('loading')}</p>}
      {l && tab === 'avg' && sales.data && <Averages l={l} sales={sales.data} months={avgMonths} />}
      {l && tab === 'dash' && sales.data && <Dashboard l={l} sales={sales.data} month={month} setMonth={setMonth} months={pickMonths} />}
    </section>
  );
}
