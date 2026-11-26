// Commercial Director (new target process): two tabs. 1 · GM Adjustment:
// the New Target per pack (editable within the CAP %) against YAGO sales,
// PAGO sales, AOP and the uploaded target; approving it opens 2 · Target by
// department: each pack's New Target split by each department's contribution
// = (average sales of the months the CD ticks + PAGO sales) / 2, viewed as
// cases, vs PAGO or vs YAGO. The CD approves and returns it to Admin.
import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { capFor } from '../../../shared/rules';
import { cdReconcile, cdSubmitProblems, type CdWork } from '../../../shared/calc/cd';
import { CATEGORIES, type Category } from '../../../shared/calc/packs';
import { addMonths, pago as pagoOf, yago as yagoOf } from '../../../shared/calc/periods';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto } from '../../../worker/services/cycle';
import type { OrgDto } from '../../../worker/services/cycleData';
import { api, ApiError } from '../../api';
import { errText, PageHead } from '../../components/AdminBits';
import { fmtNum, useLang } from '../../i18n';
import { useSession } from '../../session';
import {
  catMap, companyMonth, subMap, defaultDeptSplit, deptPack, groupSales, NO_CHANNEL, prevTargetMonths, rescalePack, routeIndex, sumCat,
  type CdRow, type ChannelHist, type Grid,
} from '../../cycle/compute';
import { deptColumns, orderedDeptCols } from '../../cycle/deptOrder';
import { tc } from '../../cycle/i18n';
import { getCycle, getOrg, loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import { packIndex, type FileRow, type RouteMonthData } from '../../cycle/parsers';
import { packKey } from '../../../shared/calc/packs';
import { CdByCategory } from './CdByCategory';
import { approvalLines } from '../../cycle/approval';
import { orderPacks } from '../../../shared/calc/packOrder';
import { defaultPeriod, rowColour, fmtGap, gapClass, MonthPicker, monthsLabel, NumCell, Section, Tabs, useMyWorkspaces, writeWorkbook, WsPeriod } from '../../cycle/ui';

type TabId = 'gm' | 'dept';

type Bench = {
  sales: RouteMonthData; deptChannel: ChannelHist;
  upload: { mode: 'pack' | 'dept' | 'leaf'; byPack: Grid; byChannel?: Record<string, Grid>; layout?: FileRow[] } | null;
  yagoSales: Grid; pagoSales: Grid; aopNow: Grid; uploaded: Grid;
  available: Set<string>;
  /** Pack order and Total rows of the uploaded file (master pack codes): the New Target by department, else the AOP by pack and department. */
  layout: FileRow[];
  /** Pack -> the Total it shows under when the file does not list it (Admin › Packs). */
  under: Record<string, string>;
};

type Loaded = { cycle: CycleDto; org: OrgDto; bench: Bench };

const gap = (a: number, b: number | null | undefined): number | null => (b && b > 0 ? a / b - 1 : null);

function Gap({ v }: { v: number | null }) {
  return <span class={gapClass(v)}>{fmtGap(v)}</span>;
}

/** The months loaded for the CD: the target year and the year before (the month picker), PAGO and YAGO. */
function pickableMonths(period: string): string[] {
  const y = Number(period.slice(0, 4));
  return [y - 1, y].flatMap((yy) => Array.from({ length: 12 }, (_, i) => `${yy}-${String(i + 1).padStart(2, '0')}`)).filter((m) => m < period);
}

async function loadAll(ws: Workspace, period: string): Promise<Loaded> {
  const [cycle, org, avail] = await Promise.all([getCycle(ws, period), getOrg(ws), api<{ months: string[] }>('GET', `/api/data/${ws}/sales-months`)]);
  const available = new Set(avail.months);
  const pm = pagoOf(period);
  const ym = yagoOf(period);
  const months = [...new Set([...pickableMonths(period), pm, ym])].filter((m) => available.has(m));
  const [sales, dc, aop, nt, aopDept, place] = await Promise.all([
    loadRouteData(ws, 'sales', months),
    loadMonthData<Record<string, Grid>>(ws, 'dept_channel'),
    loadMonthData<Record<string, { cases: number; nr: number | null }>>(ws, 'aop'),
    loadMonthData<{ mode: 'pack' | 'dept' | 'leaf'; byPack: Grid; byChannel?: Record<string, Grid>; layout?: FileRow[] }>(ws, 'new_target'),
    loadMonthData<{ layout?: FileRow[] }>(ws, 'aop_dept').catch(() => ({} as Record<string, { layout?: FileRow[] }>)),
    api<{ place: Record<string, string> }>('GET', `/api/data/${ws}/pack-place`).catch(() => ({ place: {} })),
  ]);
  const aopNow = Object.fromEntries(Object.entries(aop[period] ?? {}).map(([p, v]) => [p, v.cases]));
  const upload = nt[period] ?? null;
  // The file's order: the New Target file, else the AOP by pack and department of this month, else of the latest month.
  const aopMonths = [period, ...Object.keys(aopDept).sort().reverse()];
  const rawLayout = upload?.layout?.length ? upload.layout : aopMonths.map((m) => aopDept[m]?.layout).find((x) => Array.isArray(x) && x.length) ?? [];
  const pidx = packIndex(org.packs.map((p) => p.code));
  const code = (n: string) => pidx.get(packKey(n)) ?? n;
  const layout = rawLayout.map((x): FileRow => ('p' in x ? { p: code(x.p) } : { t: x.t, of: [...new Set(x.of.map(code))] }));
  return {
    cycle, org,
    bench: {
      sales: sales.data, deptChannel: dc, upload,
      yagoSales: companyMonth(sales.data, ym), pagoSales: companyMonth(sales.data, pm), aopNow,
      uploaded: upload ? Object.fromEntries(Object.entries(upload.byPack).map(([p, n]) => [p, Math.round(n)])) : { ...(cycle.cd?.nt ?? {}) },
      available, layout, under: place.place,
    },
  };
}

/**
 * Table rows in the order of the uploaded file (its packs and Total rows); packs
 * missing from the file go with their group. Without a file: the default layout (the department file).
 */
function fileOrderRows(layout: FileRow[], packs: string[], cats: Map<string, Category>, under: Record<string, string> = {}): { rows: CdRow[]; file: boolean } {
  const lines = approvalLines(layout, packs, (p) => cats.get(p) ?? 'LRB-Others', under);
  const has = new Set(packs);
  const rows = lines.flatMap((x): CdRow[] => (x.pack
    ? (has.has(x.pack) ? [{ kind: 'pack', pack: x.pack }] : [])
    : [{ kind: 'sub', label: x.label.trim(), packs: [...new Set(x.of)], level: 2 }]));
  return { rows, file: true };
}

/** The months the CD's split averages: the CD's own pick, else the cycle's. */
const cdMonths = (work: CdWork, l: Loaded) => (work.avgMonths?.length ? work.avgMonths : l.cycle.settings.avgMonths);

// ---------- vs YAGO / vs PAGO: sales by month per Head, and each Head's share ----------

function HeadSales({ work, l, cols, byChan, refMonth }: {
  work: CdWork; l: Loaded; cols: { id: string; name: string; chans: string[] }[]; byChan: Record<string, Record<string, Grid>>; refMonth: string;
}) {
  useLang();
  const cats = catMap(l.org);
  const period = l.cycle.period;
  // YAGO and the six months before the target month (PAGO included), where sales are loaded.
  const months = [...new Set([yagoOf(period), ...[-6, -5, -4, -3, -2, -1].map((k) => addMonths(period, k))])].filter((m) => byChan[m]).sort();
  const headSales = (m: string, d: { id: string; chans: string[] }): Grid => {
    const g: Grid = {};
    for (const c of d.chans) for (const [p, n] of Object.entries(byChan[m]?.[`${d.id}\u0000${c}`] ?? {})) g[p] = (g[p] ?? 0) + n;
    return g;
  };
  const headTarget = (d: { id: string }): Grid => {
    const g: Grid = {};
    for (const ch of Object.values(work.dm[d.id] ?? {})) for (const [p, n] of Object.entries(ch)) g[p] = (g[p] ?? 0) + n;
    return g;
  };
  const tot = (g: Grid) => Object.values(g).reduce((a, b) => a + b, 0);
  const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
  const byMonth = months.map((m) => ({ m, heads: cols.map((d) => tot(headSales(m, d))) }));
  const ref = cols.map((d) => headSales(refMonth, d));
  const tgt = cols.map((d) => headTarget(d));
  const groups: { label: string; of: (g: Grid) => number }[] = [
    ...CATEGORIES.map((c) => ({ label: c as string, of: (g: Grid) => sumCat(g, cats, c) })),
    { label: 'Total', of: tot },
  ];
  return (
    <Section title={tc('hsalesTitle')}>
      <p class="small muted">{tc('hsalesHelp', { m: refMonth })}</p>
      <div class="tablewrap"><table class="ad-table cy-table" data-testid="head-sales-month">
        <thead><tr><th>{tc('monthWord')}</th>{cols.map((d) => <th key={d.id} class="num">{d.name}</th>)}<th class="num">{tc('total')}</th></tr></thead>
        <tbody>{byMonth.map((r) => {
          const all = r.heads.reduce((a, b) => a + b, 0);
          return (
            <tr key={r.m} class={r.m === refMonth ? 'sub l2' : ''}>
              <td>{r.m}{r.m === yagoOf(period) ? ' (YAGO)' : r.m === pagoOf(period) ? ' (PAGO)' : ''}</td>
              {r.heads.map((v, i) => <td key={cols[i]!.id} class="num">{fmtNum(Math.round(v))}<div class="small muted">{pct(v, all)}</div></td>)}
              <td class="num"><b>{fmtNum(Math.round(all))}</b></td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <h3>{tc('hsalesByCat', { m: refMonth })}</h3>
      <div class="tablewrap"><table class="ad-table cy-table" data-testid="head-sales-cat">
        <thead>
          <tr><th rowSpan={2}>{tc('head')}</th>{groups.map((g) => <th key={g.label} colSpan={4} class="grp">{g.label}</th>)}</tr>
          <tr>{groups.map((g) => [
            <th key={`${g.label}s`} class="num">{tc('hsalesSales')}</th>, <th key={`${g.label}sp`} class="num">%</th>,
            <th key={`${g.label}t`} class="num">{tc('newTarget')}</th>, <th key={`${g.label}tp`} class="num">%</th>,
          ])}</tr>
        </thead>
        <tbody>
          {cols.map((d, i) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              {groups.map((g) => {
                const sAll = ref.reduce((a, x) => a + g.of(x), 0);
                const tAll = tgt.reduce((a, x) => a + g.of(x), 0);
                return [
                  <td key={`${g.label}s`} class="num">{fmtNum(Math.round(g.of(ref[i]!)))}</td>, <td key={`${g.label}sp`} class="num muted">{pct(g.of(ref[i]!), sAll)}</td>,
                  <td key={`${g.label}t`} class="num">{fmtNum(g.of(tgt[i]!))}</td>, <td key={`${g.label}tp`} class="num"><b>{pct(g.of(tgt[i]!), tAll)}</b></td>,
                ];
              })}
            </tr>
          ))}
          <tr class="sub l1">
            <td>{tc('total')}</td>
            {groups.map((g) => [
              <td key={`${g.label}s`} class="num">{fmtNum(Math.round(ref.reduce((a, x) => a + g.of(x), 0)))}</td>, <td key={`${g.label}sp`} class="num">100%</td>,
              <td key={`${g.label}t`} class="num">{fmtNum(tgt.reduce((a, x) => a + g.of(x), 0))}</td>, <td key={`${g.label}tp`} class="num">100%</td>,
            ])}
          </tr>
        </tbody>
      </table></div>
    </Section>
  );
}

// ---------- Tab 1 · GM Adjustment ----------

/** Packs whose New Target moved more than the CAP % from the uploaded target. */
export function overCap(work: CdWork, uploaded: Grid, capPct: number | null): string[] {
  if (capPct === null) return [];
  return Object.keys(work.nt).filter((p) => Math.abs((work.nt[p] ?? 0) - (uploaded[p] ?? 0)) > capFor(uploaded[p] ?? 0, capPct));
}

/** The default split by department & channel for the packs given, with the CD's months. */
type How = 'sales' | 'uploaded' | 'prev';

function splitFor(work: CdWork, l: Loaded, nt: Grid, how: How) {
  return defaultDeptSplit({
    period: l.cycle.period, nt, org: l.org, sales: l.bench.sales, avgMonths: cdMonths(work, l), deptChannel: l.bench.deptChannel,
    uploadedByChannel: how === 'uploaded' && l.bench.upload?.mode === 'dept' ? l.bench.upload.byChannel ?? null : null,
    byPrevTarget: how === 'prev',
  });
}

/** Previous department targets uploaded for the months of the split: they lead the default split. */
const hasPrev = (work: CdWork, l: Loaded) => prevTargetMonths(l.bench.deptChannel, cdMonths(work, l)).length > 0;
const defaultHow = (work: CdWork, l: Loaded): How => (l.bench.upload?.mode === 'dept' ? 'uploaded' : hasPrev(work, l) ? 'prev' : 'sales');

function GmTab({ work, edit, l, setWork, onApproved }: { work: CdWork; edit: boolean; l: Loaded; setWork: (w: CdWork) => void; onApproved: () => void }) {
  useLang();
  const cats = catMap(l.org);
  const { bench } = l;
  const packs = Object.keys(work.nt);
  const { rows, file } = fileOrderRows(bench.layout, packs, cats, bench.under);
  const sum = (g: Grid, list: string[]) => list.reduce((s, p) => s + (g[p] ?? 0), 0);
  const editable = edit && !work.ntOk;
  // The CAP % is not applied to the Commercial Director.
  const cap = null;
  const over = new Set(overCap(work, bench.uploaded, cap));

  function approve() {
    if (over.size) return;
    const stale = Object.keys(work.dm).length === 0 || packs.some((p) => work.splitNt[p] !== work.nt[p]);
    if (!stale) { setWork({ ...work, ntOk: true }); onApproved(); return; }
    const dm = structuredClone(work.dm);
    if (Object.keys(dm).length === 0) {
      const r = splitFor(work, l, work.nt, defaultHow(work, l));
      setWork({ ...work, ntOk: true, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
      onApproved();
      return;
    }
    // Only the packs whose New Target changed are rescaled; new packs get the default split.
    const fresh = packs.filter((p) => !(p in work.splitNt));
    for (const p of packs) if (p in work.splitNt && work.splitNt[p] !== work.nt[p]) rescalePack(dm, p, work.nt[p]!);
    const basis = { ...work.basis };
    if (fresh.length) {
      const r = splitFor(work, l, Object.fromEntries(fresh.map((p) => [p, work.nt[p]!])), l.bench.upload?.mode === 'dept' ? 'uploaded' : hasPrev(work, l) ? 'prev' : 'sales');
      for (const [d, ch] of Object.entries(r.dm)) for (const [c, g] of Object.entries(ch)) Object.assign((dm[d] ??= {})[c] ??= {}, g);
      Object.assign(basis, r.basis);
    }
    setWork({ ...work, ntOk: true, dm, basis, splitNt: { ...work.nt } });
    onApproved();
  }

  const cards = cdDashboard(work, l);
  return (
    <>
      <div class="cy-cards cy-mini-cards">
        {cards.map((c) => (
          <section key={c.label} class="card cy-card">
            <h3>{c.label}</h3>
            <p class="big">{fmtNum(c.nt)}</p>
            <dl>
              <dt>{tc('vsYago')}</dt><dd><Gap v={c.vsYago} /></dd>
              <dt>{tc('vsPago')}</dt><dd><Gap v={c.vsPago} /></dd>
              <dt>{tc('vsAop')}</dt><dd><Gap v={c.vsAop} /></dd>
            </dl>
          </section>
        ))}
      </div>
      <Section title={tc('gmTitle', { period: l.cycle.period })} right={edit && (
        work.ntOk
          ? <button type="button" class="btn" onClick={() => setWork({ ...work, ntOk: false })}>{tc('reopenNt')}</button>
          : <button type="button" class="btn primary" data-testid="approve-nt" disabled={over.size > 0} onClick={approve}>{tc('approveNt')}</button>
      )}>
        <p class="muted small">{work.ntOk ? tc('ntApproved') : tc('ntHelp')}{cap !== null && <> {tc('capRule', { n: cap })}</>}</p>
        {over.size > 0 && <div class="banner bad" role="alert">{tc('overCapPacks', { n: over.size, cap: cap ?? 0, list: [...over].slice(0, 8).join(', ') })}</div>}
        <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="gm-table">
          <thead><tr>
            <th>{tc('pack')}</th><th class="num">{tc('newTarget')}</th>
            <th class="num bench">{tc('yagoSales')}<div class="small muted">{tc('salesOf', { m: yagoOf(l.cycle.period) })}</div></th><th class="num">{tc('targetVsYago')}</th>
            <th class="num bench">{tc('pagoSales')}<div class="small muted">{tc('salesOf', { m: pagoOf(l.cycle.period) })}</div></th><th class="num">{tc('targetVsPago')}</th>
            <th class="num bench">AOP<div class="small muted">AOP {l.cycle.period}</div></th><th class="num">{tc('targetVsAop')}</th>
            <th class="num">{tc('uploadedCol')}</th>
          </tr></thead>
          <tbody>{rows.map((r) => {
            if (r.kind === 'sub') {
              const nt = sum(work.nt, r.packs);
              return (
                <tr key={r.label} class={`sub l${r.level}${file ? ' cd-file' : ''}`} style={file ? rowColour(r.label) : undefined}>
                  <td>{r.label}</td><td class="num">{fmtNum(nt)}</td>
                  <td class="num">{fmtNum(Math.round(sum(bench.yagoSales, r.packs)))}</td><td class="num"><Gap v={gap(nt, sum(bench.yagoSales, r.packs))} /></td>
                  <td class="num">{fmtNum(Math.round(sum(bench.pagoSales, r.packs)))}</td><td class="num"><Gap v={gap(nt, sum(bench.pagoSales, r.packs))} /></td>
                  <td class="num">{fmtNum(sum(bench.aopNow, r.packs))}</td><td class="num"><Gap v={gap(nt, sum(bench.aopNow, r.packs))} /></td>
                  <td class="num">{fmtNum(sum(bench.uploaded, r.packs))}</td>
                </tr>
              );
            }
            const p = r.pack;
            const nt = work.nt[p] ?? 0;
            return (
              <tr key={p} class={`${over.has(p) ? 'bad' : ''}${file ? ' cd-file' : ''}`} style={file ? rowColour(p) : undefined}>
                <td><bdi>{p}</bdi></td>
                <td class="num">{editable
                  ? <NumCell value={nt} invalid={over.has(p)} label={`${tc('newTarget')} ${p}`} onChange={(n) => setWork({ ...work, nt: { ...work.nt, [p]: n } })} />
                  : fmtNum(nt)}</td>
                <td class="num">{fmtNum(Math.round(bench.yagoSales[p] ?? 0))}</td><td class="num"><Gap v={gap(nt, bench.yagoSales[p])} /></td>
                <td class="num">{fmtNum(Math.round(bench.pagoSales[p] ?? 0))}</td><td class="num"><Gap v={gap(nt, bench.pagoSales[p])} /></td>
                <td class="num">{fmtNum(bench.aopNow[p] ?? 0)}</td><td class="num"><Gap v={gap(nt, bench.aopNow[p])} /></td>
                <td class="num muted">{fmtNum(bench.uploaded[p] ?? 0)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </Section>
    </>
  );
}

// ---------- Tab 2 · Target by department ----------

type View = 'cases' | 'pago' | 'yago';

function DeptTab({ work, edit, l, setWork }: { work: CdWork; edit: boolean; l: Loaded; setWork: (w: CdWork) => void }) {
  useLang();
  const [view, setView] = useState<View>('cases');
  const [hideZero, setHideZero] = useState(true);
  const [byCat, setByCat] = useState(true);
  // A target sent already split by department: the CD may still choose to distribute it by sales.
  const [useCalc, setUseCalc] = useState(() => l.bench.upload?.mode !== 'dept' || (Object.keys(work.basis).length > 0 && !Object.values(work.basis).some((b) => b.startsWith('uploaded'))));
  const { org, bench, cycle } = l;
  const cats = catMap(org);
  const pm = pagoOf(cycle.period);
  const ym = yagoOf(cycle.period);
  const idx = routeIndex(org);
  const byChan = useMemo(() => groupSales(bench.sales, (r) => { const i = idx.get(r); return i ? `${i.deptId}\u0000${i.channel}` : null; }), [bench.sales]);
  if (!work.ntOk) return <p class="card muted">{tc('splitNeedsNt')}</p>;
  const months = cdMonths(work, l);
  // Departments and channels in the order of the department target file (TT, MT, HoReCa, WS…).
  const cols = orderedDeptCols(org.depts, NO_CHANNEL);
  // Columns as in the department target file: TT DMM, TT Outer, Total TT, MT, MT SSV, MT Bulk, Total MT, HoReCa, WS.
  const { flat, heads } = deptColumns(cols, (name) => tc('totalOf', { name }));
  const packs = Object.keys(work.nt);
  const hasSplit = Object.keys(work.dm).length > 0;
  // The file's order, Total rows and colours (the New Target or the AOP by pack and department file).
  const layout = bench.layout;
  const baseRows = fileOrderRows(layout, packs, cats, bench.under).rows;
  const rows = baseRows.filter((r) => !hideZero || r.kind === 'sub' || (work.nt[r.pack] ?? 0) !== 0);
  const subOf = subMap(org.packs);
  const avgOf = (h: { id: string; chans: string[] }, p: string, ms: string[]) => (ms.length ? ms.reduce((s, m) => s + h.chans.reduce((t, c) => t + (byChan[m]?.[`${h.id}\u0000${c}`]?.[p] ?? 0), 0), 0) / ms.length : 0);
  const headBench = (p: string, h: { id: string; chans: string[] }) => ({ avg: avgOf(h, p, months), pago: avgOf(h, p, [pm]), yago: avgOf(h, p, [ym]) });
  const cell = (d: string, c: string, list: string[]) => list.reduce((s, p) => s + (work.dm[d]?.[c]?.[p] ?? 0), 0);
  const salesOf = (m: string, d: string, c: string, list: string[]) => list.reduce((s, p) => s + (byChan[m]?.[`${d}\u0000${c}`]?.[p] ?? 0), 0);
  const bench2 = (d: string, c: string, list: string[]) => salesOf(view === 'pago' ? pm : ym, d, c, list);
  const show = (v: number, d: string, c: string, list: string[]) => {
    if (view === 'cases') return fmtNum(v);
    const b = bench2(d, c, list);
    return <span title={`${fmtNum(v)} / ${fmtNum(Math.round(b))}`}><Gap v={gap(v, b)} /></span>;
  };
  const deptBench = (d: { id: string; chans: string[] }, list: string[]) => d.chans.reduce((s, c) => s + bench2(d.id, c, list), 0);

  /** The CD changes any cell freely: the pack's New Target becomes the sum of its cells (no limit, no check). */
  function setCell(d: string, c: string, p: string, n: number) {
    const dm = structuredClone(work.dm);
    ((dm[d] ??= {})[c] ??= {})[p] = n;
    let sum = 0;
    for (const ch of Object.values(dm)) for (const g of Object.values(ch)) sum += g[p] ?? 0;
    setWork({ ...work, dm, nt: { ...work.nt, [p]: sum }, splitNt: { ...work.splitNt, [p]: sum } });
  }
  function split(how: How) {
    const r = splitFor(work, l, work.nt, how);
    setWork({ ...work, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
  }
  /** Back to the starting split for one pack (by the average sales, or the uploaded split it came from). */
  function resetPack(p: string) {
    const b = work.basis[p] ?? '';
    const how: How = b.startsWith('uploaded') ? 'uploaded' : b === 'prev_target' ? 'prev' : 'sales';
    const r = splitFor(work, l, { [p]: work.nt[p] ?? 0 }, how);
    const dm = structuredClone(work.dm);
    for (const d of Object.keys(dm)) for (const c of Object.keys(dm[d]!)) delete dm[d]![c]![p];
    for (const [d, ch] of Object.entries(r.dm)) for (const [c, g] of Object.entries(ch)) if (p in g) ((dm[d] ??= {})[c] ??= {})[p] = g[p]!;
    setWork({ ...work, dm, basis: { ...work.basis, ...r.basis } });
  }
  function setMonths(m: string[]) {
    // New months: the split by sales is made again with them.
    const next = { ...work, avgMonths: m };
    if (!m.length) return setWork(next);
    const r = splitFor(next, l, work.nt, hasPrev(next, l) ? 'prev' : 'sales');
    setWork({ ...next, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
  }
  const badPacks = packs.filter((p) => org.depts.reduce((s, d) => s + deptPack(work.dm, String(d.id), p), 0) !== work.nt[p]);
  const uploadedSplit = bench.upload?.mode === 'dept';
  const calcOn = !uploadedSplit || useCalc;
  const fromUpload = Object.values(work.basis).some((b) => b.startsWith('uploaded'));
  const fromPrev = Object.values(work.basis).some((b) => b === 'prev_target');
  const prevOk = hasPrev(work, l);

  return (
    <>
      {uploadedSplit && (
        <div class="banner info small cd-choice" data-testid="cd-choice">
          <b>{tc('cdHowTitle')}</b>
          <label><input type="radio" name="cd-how" checked={!useCalc} disabled={!edit} data-testid="cd-how-uploaded"
            onChange={() => { setUseCalc(false); split('uploaded'); }} /> {tc('cdHowUploaded')}</label>
          <label><input type="radio" name="cd-how" checked={useCalc} disabled={!edit} data-testid="cd-how-calc"
            onChange={() => { setUseCalc(true); split(prevOk ? 'prev' : 'sales'); }} /> {tc('cdHowCalc')}</label>
          {!useCalc && <p class="small muted">{tc('cdUploadedHelp')}</p>}
        </div>
      )}
      {calcOn && (<>
      <MonthPicker period={cycle.period} months={months} available={bench.available} disabled={!edit} onChange={setMonths} title={tc('avgBasedOn')} />
      <div class="banner info small" data-testid="split-how">{fromUpload ? tc('splitHowUploaded') : fromPrev ? tc('splitHowPrev', { months: monthsLabel(prevTargetMonths(bench.deptChannel, months)) }) : tc('splitHowSales', { months: monthsLabel(months), pago: pm })}
        <div class="cy-formula" data-testid="split-formula"><b>{tc('formulaWord')}</b> {fromUpload ? tc('formulaUploaded') : fromPrev
          ? tc('formulaPrev', { months: monthsLabel(prevTargetMonths(bench.deptChannel, months)) })
          : tc('formulaSales', { months: monthsLabel(months) })}</div>
      </div>
      </>)}
      {hasSplit && (
        <div class="toolbar cd-dist-how" role="radiogroup" aria-label={tc('cdDistHow')} data-testid="cd-dist-how">
          <b class="small">{tc('cdDistHow')}:</b>
          <label class="small"><input type="radio" name="cd-dist" checked={byCat} onChange={() => setByCat(true)} data-testid="cd-dist-cat" /> {tc('cdDistCat')}</label>
          <label class="small"><input type="radio" name="cd-dist" checked={!byCat} onChange={() => setByCat(false)} data-testid="cd-dist-pack" /> {tc('cdDistPack')}</label>
        </div>
      )}
      {hasSplit && byCat && <CdByCategory baseKey={`${cycle.ws}-${cycle.period}`} work={work} heads={cols} cats={cats} subOf={subOf} bench={headBench} editable={edit} setWork={setWork} />}
      <Section title={tc('deptTitle', { period: cycle.period })} right={
        <div class="toolbar">
          {edit && calcOn && prevOk && <button type="button" class="btn primary" data-testid="split-prev" onClick={() => split('prev')}>{tc('splitByPrev')}</button>}
          {edit && calcOn && <button type="button" class={`btn${prevOk ? '' : ' primary'}`} data-testid="split-all" onClick={() => split('sales')}>{tc('splitAll')}</button>}
          {edit && uploadedSplit && !useCalc && <button type="button" class="btn" data-testid="split-uploaded" title={tc('backToUploadedHelp')} onClick={() => split('uploaded')}>{tc('backToUploaded')}</button>}
          <label class="small"><input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.currentTarget.checked)} /> {tc('hideZero')}</label>
          <Tabs<View> value={view} onChange={setView} items={[{ id: 'cases', label: tc('viewSplit') }, { id: 'pago', label: tc('vsPagoSales') }, { id: 'yago', label: tc('vsYagoSales') }]} />
        </div>
      }>
        {!hasSplit && <p class="muted">{tc('noSplitYet')}</p>}
        {hasSplit && badPacks.length > 0 && <div class="banner warn">{tc('packsNotAdding', { n: badPacks.length })}</div>}
        {hasSplit && (
          <div class="tablewrap cy-tall"><table class="ad-table cy-table cy-grid-table" data-testid="dept-table">
            <thead>
              <tr><th rowSpan={2}>{tc('pack')}</th>
                {heads.map((h) => (h.kind === 'dept'
                  ? <th key={`h${h.d.id}`} colSpan={h.span} class="grp">{h.d.name}</th>
                  : <th key={`t${h.label}`} rowSpan={2} class="num tot">{h.label}</th>))}
                <th rowSpan={2} class="num">ABC</th><th rowSpan={2} class="num">{tc('newTarget')}</th>
                {edit && <th rowSpan={2}><span class="visually-hidden">{tc('resetRow')}</span></th>}
              </tr>
              <tr>{flat.filter((x) => x.kind === 'cell').map((x) => x.kind === 'cell' && <th key={`${x.d.id}${x.c}`} class="num">{x.c === NO_CHANNEL ? x.d.name : x.c}</th>)}</tr>
            </thead>
            <tbody>{rows.map((r) => {
              const list = r.kind === 'sub' ? r.packs : [r.pack];
              const abc = cols.reduce((s, d) => s + d.chans.reduce((a, c) => a + cell(d.id, c, list), 0), 0);
              const nt = list.reduce((s, p) => s + (work.nt[p] ?? 0), 0);
              const off = r.kind === 'pack' && abc !== nt;
              const abcBench = cols.reduce((s, d) => s + deptBench(d, list), 0);
              return (
                <tr key={r.kind === 'sub' ? r.label : r.pack} class={`${r.kind === 'sub' ? `sub l${r.level}` : off ? 'bad' : ''} cd-file`} style={rowColour(r.kind === 'sub' ? r.label : r.pack)}>
                  <td><bdi>{r.kind === 'sub' ? r.label : r.pack}</bdi></td>
                  {flat.map((x) => (x.kind === 'cell' ? (
                    <td key={`${x.d.id}${x.c}`} class="num">
                      {r.kind === 'pack' && edit && view === 'cases'
                        ? <NumCell value={cell(x.d.id, x.c, list)} label={`${r.pack} ${x.c}`} onChange={(n) => setCell(x.d.id, x.c, r.pack, n)} />
                        : show(cell(x.d.id, x.c, list), x.d.id, x.c, list)}
                    </td>
                  ) : (
                    <td key={`t${x.label}`} class="num tot">{(() => {
                      const v = x.cells.reduce((s2, k) => s2 + cell(k.d, k.c, list), 0);
                      return view === 'cases' ? fmtNum(v) : <Gap v={gap(v, x.cells.reduce((s2, k) => s2 + bench2(k.d, k.c, list), 0))} />;
                    })()}</td>
                  )))}
                  <td class="num tot">{view === 'cases' ? fmtNum(abc) : <Gap v={gap(abc, abcBench)} />}</td>
                  <td class="num">{fmtNum(nt)}{off && <div class="small bad-text">{fmtNum(abc - nt)}</div>}</td>
                  {edit && <td>{r.kind === 'pack' && <button type="button" class="btn link" data-testid={`reset-${r.pack}`} title={tc('resetRowHelp')} onClick={() => resetPack(r.pack)}>{tc('resetRow')}</button>}</td>}
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        <p class="small muted">{view === 'cases' ? tc('deptFoot') : tc('deptFootGap', { m: view === 'pago' ? pm : ym })}</p>
      </Section>
      {view !== 'cases' && hasSplit && <HeadSales work={work} l={l} cols={cols} byChan={byChan} refMonth={view === 'pago' ? pm : ym} />}
    </>
  );
}

// ---------- the summary cards (category vs YAGO / PAGO sales / AOP) ----------

export function cdDashboard(work: CdWork, l: Loaded) {
  const cats = catMap(l.org);
  const groups: { label: string; packs: string[] }[] = [
    ...CATEGORIES.map((c) => ({ label: c, packs: Object.keys(work.nt).filter((p) => (cats.get(p) ?? 'LRB-Others') === c) })),
    { label: 'Total LRB', packs: Object.keys(work.nt) },
  ];
  const sum = (g: Grid, list: string[]) => list.reduce((s, p) => s + (g[p] ?? 0), 0);
  return groups.map((g) => {
    const nt = sum(work.nt, g.packs);
    return {
      label: g.label, nt, yago: sum(l.bench.yagoSales, g.packs), pago: sum(l.bench.pagoSales, g.packs), aop: sum(l.bench.aopNow, g.packs),
      vsYago: gap(nt, sum(l.bench.yagoSales, g.packs)), vsPago: gap(nt, sum(l.bench.pagoSales, g.packs)), vsAop: gap(nt, sum(l.bench.aopNow, g.packs)),
    };
  });
}

// ---------- the whole CD workbook ----------

function downloadWorkbook(work: CdWork, l: Loaded) {
  const { org, bench, cycle } = l;
  const cats = catMap(org);
  const packs = orderPacks(Object.keys(work.nt), (p) => cats.get(p) ?? 'LRB-Others', bench.layout, bench.under);
  const chans = orderedDeptCols(org.depts, NO_CHANNEL).flatMap((d) => d.chans.map((c) => ({ d: d.id, c, label: c === NO_CHANNEL ? d.name : c })));
  const r = (n: number) => Math.round(n);
  void writeWorkbook(`cd_${cycle.ws}_${cycle.period}.xlsx`, [
    {
      name: 'GM Adjustment', columns: ['Pack', 'Category', 'New Target', 'YAGO Sales', 'Target vs YAGO', 'PAGO Sales', 'Target vs PAGO', 'AOP', 'Target vs AOP', 'Uploaded'],
      rows: packs.map((p) => {
        const nt = work.nt[p] ?? 0;
        return [p, cats.get(p) ?? '', nt, r(bench.yagoSales[p] ?? 0), gap(nt, bench.yagoSales[p]), r(bench.pagoSales[p] ?? 0), gap(nt, bench.pagoSales[p]), bench.aopNow[p] ?? 0, gap(nt, bench.aopNow[p]), bench.uploaded[p] ?? 0];
      }),
    },
    {
      name: 'Target by department', head: [[null, ...chans.map((x) => org.depts.find((d) => String(d.id) === x.d)?.name ?? ''), null, null]],
      columns: ['Pack', ...chans.map((x) => x.label), 'ABC', 'New Target'],
      rows: packs.map((p) => {
        const vals = chans.map((x) => work.dm[x.d]?.[x.c]?.[p] ?? 0);
        return [p, ...vals, vals.reduce((s, v) => s + v, 0), work.nt[p] ?? 0];
      }),
    },
    {
      name: 'By department', columns: ['Head of Department', ...CATEGORIES, 'Total'],
      rows: org.depts.map((d) => {
        const g: Grid = {};
        for (const p of packs) g[p] = deptPack(work.dm, String(d.id), p);
        return [d.name, ...CATEGORIES.map((c) => sumCat(g, cats, c)), Object.values(g).reduce((s, v) => s + v, 0)];
      }),
    },
    {
      name: 'Summary', columns: ['Category', 'New Target', 'YAGO Sales', 'vs YAGO', 'PAGO Sales', 'vs PAGO', 'AOP', 'vs AOP'],
      rows: cdDashboard(work, l).map((c) => [c.label, c.nt, r(c.yago), c.vsYago, r(c.pago), c.vsPago, c.aop, c.vsAop]),
    },
  ]);
}

// ---------- the approval workbook for signing ----------

/** The approval workbook of the CD's final target (Template For Approval layout). */
export async function downloadApprovalOf(work: CdWork, l: Loaded): Promise<void> {
  const { org, bench, cycle } = l;
  const final = cdReconcile(work);
  const layout = bench.layout;
  const cats = catMap(org);
  const { downloadApproval } = await import('../../cycle/approval');
  // The company name and logo the admin set (Cycle setup).
  const b = await api<{ company: string; logo: string | null; logoW: number; logoH: number }>('GET', `/api/data/${cycle.ws}/approval-brand`).catch(() => null);
  const logo = b?.logo && b.logoW && b.logoH ? {
    data: Uint8Array.from(atob(b.logo.slice(b.logo.indexOf(',') + 1)), (ch) => ch.charCodeAt(0)),
    type: (b.logo.startsWith('data:image/png') ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg',
    width: b.logoW, height: b.logoH,
  } : null;
  await downloadApproval({
    brand: { company: b?.company ?? '', logo },
    period: cycle.period, layout, under: bench.under, catOf: (p) => cats.get(p) ?? 'LRB-Others',
    target: final.nt, yago: bench.yagoSales, pago: bench.pagoSales, plan: bench.aopNow,
    heads: orderedDeptCols(org.depts, NO_CHANNEL).map((d) => ({
      // "Total TT", "Total MT": the Head's code, as in the template.
      name: org.depts.find((x) => String(x.id) === d.id)?.code || d.name,
      chans: d.chans.map((c) => ({ label: c === NO_CHANNEL ? org.depts.find((x) => String(x.id) === d.id)?.name ?? c : c, g: final.dm[d.id]?.[c] ?? {} })),
    })),
  }, `Target_For_Approval_${cycle.period}.xlsx`);
}

/** For the Admin: loads what the CD screen loads, then the approval workbook. */
export async function downloadApprovalFor(ws: Workspace, period: string): Promise<void> {
  const l = await loadAll(ws, period);
  if (!l.cycle.cd) throw new Error('No target from the Commercial Director yet.');
  await downloadApprovalOf(l.cycle.cd, l);
}

// ---------- page ----------

export function CdPage({ ws: wsParam, period: periodParam }: { ws?: string; period?: string }) {
  useLang();
  const { route } = useLocation();
  const { user } = useSession();
  const allowed = useMyWorkspaces();
  // Key Accounts have no Commercial Director step: the CD screen is for Operation only.
  void wsParam;
  void allowed;
  const ws: Workspace = 'ops';
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : defaultPeriod();
  const [tab, setTab] = useState<TabId>('gm');
  const loaded = useAsync(() => loadAll(ws, period), [ws, period]);
  const [work, setWorkState] = useState<CdWork | null>(null);
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const l = loaded.data;
  const isCd = !!user?.cd?.includes(ws);

  // Take the server copy whenever a fresh load arrives (and nothing is being edited).
  useEffect(() => {
    if (!l || dirty) return;
    setWorkState(l.cycle.cd);
    setVersion(l.cycle.version);
  }, [l]);
  const setWork = (w: CdWork) => { setWorkState(w); setDirty(true); setMsg(null); };
  const edit = isCd && l?.cycle.cdStatus === 'with_cd';
  const cats = l ? new Map([...catMap(l.org)].map(([k, v]) => [k, v as string])) : new Map<string, string>();
  const problems = work && l ? [
    ...cdSubmitProblems(cdReconcile({ ...work, colJ: {}, gm: {} }), cats, l.org.depts.map((d) => String(d.id))),
  ] : [];

  async function save(): Promise<boolean> {
    if (!work || version === null) return false;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ version: number }>('PUT', `/api/cycle/${ws}/${period}/cd`, { version, cd: work });
      setVersion(r.version);
      setDirty(false);
      setMsg(tc('saved'));
      return true;
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 409 ? tc('staleCd') : errText(x));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!work) return;
    // The split by department is final: column J is not used in the new process.
    if (Object.keys(work.colJ).length || Object.keys(work.gm).length) {
      const next = { ...work, colJ: {}, gm: {} };
      setWorkState(next);
      setDirty(true);
      setBusy(true);
      try {
        const r = await api<{ version: number }>('PUT', `/api/cycle/${ws}/${period}/cd`, { version, cd: next });
        setVersion(r.version);
        setDirty(false);
      } catch (x) {
        setErr(errText(x));
        setBusy(false);
        return;
      } finally {
        setBusy(false);
      }
      return void submitNow();
    }
    if (dirty && !(await save())) return;
    return void submitNow();
  }
  async function submitNow() {
    setBusy(true);
    try {
      await api('POST', `/api/cycle/${ws}/${period}/cd/submit`, {});
      setMsg(tc('cdSubmitted'));
      loaded.reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  async function giveBack() {
    if (!comment.trim()) return;
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      await api('POST', `/api/cycle/${ws}/${period}/cd/return`, { comment });
      setComment('');
      setMsg(tc('cdReturnedMsg'));
      loaded.reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="cycle" data-testid="cd-page">
      <PageHead title={tc('cdTitle')} intro={tc('cdIntro')} />
      <WsPeriod ws={ws} period={period} allowed={[]} onChange={(w, p) => { setDirty(false); route(`/cd/${w}/${p}`); }} />
      {loaded.error && <div class="alert" role="alert">{loaded.error}</div>}
      {!l && !loaded.error && <p class="muted">{tc('loading')}</p>}
      {l && !work && <p class="card muted">{tc('cdNothingYet')}</p>}
      {l && work && (
        <>
          <div class="cy-status-row">
            <span>{tc('cdStatus')}: <b data-testid="cd-status">{tc(`cd_${l.cycle.cdStatus}` as 'cd_draft')}</b></span>
            {dirty && <span class="pill warn">{tc('unsaved')}</span>}
            <span class="spacer" />
            <button type="button" class="btn" onClick={() => downloadWorkbook(work, l)}>{tc('downloadExcel')}</button>
            <button type="button" class="btn" data-testid="approval-download" onClick={() => void downloadApprovalOf(work, l).catch((x) => setErr(errText(x)))}>{tc('approvalDownload')}</button>
            {edit && <button type="button" class="btn" disabled={busy || !dirty} onClick={() => void save()}>{tc('save')}</button>}
            {edit && <button type="button" class="btn primary" disabled={busy || problems.length > 0} title={problems.join('; ')} onClick={() => void submit()}>{tc('approveReturnAdmin')}</button>}
          </div>
          {edit && problems.length > 0 && <p class="small muted" data-testid="submit-reason">{tc('cannotSubmit')}: {problems.join('; ')}</p>}
          {msg && <div class="banner ok" role="status">{msg}</div>}
          {l.cycle.cdStatus === 'submitted' && (
            <div class="banner ok cy-approval" data-testid="approval-banner">
              <b>{tc('approvalReady')}</b> {tc('approvalReadyHelp')}{' '}
              <button type="button" class="btn primary" data-testid="approval-download-banner" onClick={() => void downloadApprovalOf(work, l).catch((x) => setErr(errText(x)))}>{tc('approvalDownload')}</button>
            </div>
          )}
          {err && <div class="alert" role="alert">{err}</div>}
          <div class="cy-flow banner small" data-testid="cd-flow">
            <span>1 · {tc('tabGm')} <span class={`pill ${work.ntOk ? 'ok' : 'warn'}`}>{work.ntOk ? tc('approvedWord') : tc('toApprove')}</span></span>
            <span aria-hidden="true">→</span>
            <span>2 · {tc('tabDept')} <span class={`pill ${work.ntOk && Object.keys(work.dm).length && problems.length === 0 ? 'ok' : ''}`}>{!work.ntOk ? tc('notYet') : problems.length === 0 ? tc('doneWord') : tc('inProgressWord')}</span></span>
          </div>
          <Tabs<TabId> value={tab} onChange={(t) => { if (t === 'dept' && !work.ntOk) return; setTab(t); }} items={[
            { id: 'gm', label: `1 · ${tc('tabGm')}` }, { id: 'dept', label: `2 · ${tc('tabDept')}${work.ntOk ? '' : ' 🔒'}` },
          ]} />
          {tab === 'gm' && <GmTab work={work} edit={edit} l={l} setWork={setWork} onApproved={() => setTab('dept')} />}
          {tab === 'dept' && <DeptTab work={work} edit={edit} l={l} setWork={setWork} />}
          {edit && (
            <Section title={tc('returnToAdmin')}>
              <textarea rows={3} value={comment} aria-label={tc('comment')} placeholder={tc('returnHelp')} onInput={(e) => setComment(e.currentTarget.value)} />
              <div class="actions"><button type="button" class="btn danger" disabled={busy || !comment.trim()} onClick={() => void giveBack()}>{tc('returnToAdmin')}</button></div>
            </Section>
          )}
          <p class="small muted">{tc('periodsNote', { pago: pagoOf(period), yago: yagoOf(period), from: addMonths(period, -3) })}</p>
        </>
      )}
    </section>
  );
}
