// Commercial Director (new target process): two tabs. 1 · GM Adjustment:
// the New Target per pack (editable within the CAP %) against YAGO sales,
// PAGO sales, AOP and the uploaded target; approving it opens 2 · Target by
// department: each pack's New Target split by each department's contribution
// = (average sales of the months the CD ticks + PAGO sales) / 2, viewed as
// cases, vs PAGO or vs YAGO. The CD approves and returns it to Admin.
import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { capFor } from '../../../shared/rules';
import { cdSubmitProblems, type CdWork } from '../../../shared/calc/cd';
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
  catMap, cdRows, companyMonth, defaultDeptSplit, deptPack, groupSales, NO_CHANNEL, rescalePack, routeIndex, sumCat,
  type ChannelHist, type Grid,
} from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { getCycle, getOrg, loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import type { RouteMonthData } from '../../cycle/parsers';
import { defaultPeriod, fmtGap, gapClass, MonthPicker, monthsLabel, NumCell, Section, Tabs, useMyWorkspaces, writeWorkbook, WsPeriod } from '../../cycle/ui';

type TabId = 'gm' | 'dept';

type Bench = {
  sales: RouteMonthData; deptChannel: ChannelHist;
  upload: { mode: 'pack' | 'dept' | 'leaf'; byPack: Grid; byChannel?: Record<string, Grid> } | null;
  yagoSales: Grid; pagoSales: Grid; aopNow: Grid; uploaded: Grid;
  available: Set<string>;
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
  const [sales, dc, aop, nt] = await Promise.all([
    loadRouteData(ws, 'sales', months),
    loadMonthData<Record<string, Grid>>(ws, 'dept_channel'),
    loadMonthData<Record<string, { cases: number; nr: number | null }>>(ws, 'aop'),
    loadMonthData<{ mode: 'pack' | 'dept' | 'leaf'; byPack: Grid; byChannel?: Record<string, Grid> }>(ws, 'new_target'),
  ]);
  const aopNow = Object.fromEntries(Object.entries(aop[period] ?? {}).map(([p, v]) => [p, v.cases]));
  const upload = nt[period] ?? null;
  return {
    cycle, org,
    bench: {
      sales: sales.data, deptChannel: dc, upload,
      yagoSales: companyMonth(sales.data, ym), pagoSales: companyMonth(sales.data, pm), aopNow,
      uploaded: upload ? Object.fromEntries(Object.entries(upload.byPack).map(([p, n]) => [p, Math.round(n)])) : { ...(cycle.cd?.nt ?? {}) },
      available,
    },
  };
}

/** The months the CD's split averages: the CD's own pick, else the cycle's. */
const cdMonths = (work: CdWork, l: Loaded) => (work.avgMonths?.length ? work.avgMonths : l.cycle.settings.avgMonths);

// ---------- Tab 1 · GM Adjustment ----------

/** Packs whose New Target moved more than the CAP % from the uploaded target. */
export function overCap(work: CdWork, uploaded: Grid, capPct: number | null): string[] {
  if (capPct === null) return [];
  return Object.keys(work.nt).filter((p) => Math.abs((work.nt[p] ?? 0) - (uploaded[p] ?? 0)) > capFor(uploaded[p] ?? 0, capPct));
}

/** The default split by department & channel for the packs given, with the CD's months. */
function splitFor(work: CdWork, l: Loaded, nt: Grid, how: 'sales' | 'uploaded') {
  return defaultDeptSplit({
    period: l.cycle.period, nt, org: l.org, sales: l.bench.sales, avgMonths: cdMonths(work, l), deptChannel: l.bench.deptChannel,
    uploadedByChannel: how === 'uploaded' && l.bench.upload?.mode === 'dept' ? l.bench.upload.byChannel ?? null : null,
  });
}

function GmTab({ work, edit, l, setWork, onApproved }: { work: CdWork; edit: boolean; l: Loaded; setWork: (w: CdWork) => void; onApproved: () => void }) {
  useLang();
  const cats = catMap(l.org);
  const { bench } = l;
  const packs = Object.keys(work.nt);
  const rows = cdRows(packs, cats);
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
      const r = splitFor(work, l, work.nt, bench.upload?.mode === 'dept' ? 'uploaded' : 'sales');
      setWork({ ...work, ntOk: true, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
      onApproved();
      return;
    }
    // Only the packs whose New Target changed are rescaled; new packs get the default split.
    const fresh = packs.filter((p) => !(p in work.splitNt));
    for (const p of packs) if (p in work.splitNt && work.splitNt[p] !== work.nt[p]) rescalePack(dm, p, work.nt[p]!);
    const basis = { ...work.basis };
    if (fresh.length) {
      const r = splitFor(work, l, Object.fromEntries(fresh.map((p) => [p, work.nt[p]!])), 'sales');
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
                <tr key={r.label} class={`sub l${r.level}`}>
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
              <tr key={p} class={over.has(p) ? 'bad' : ''}>
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
  const { org, bench, cycle } = l;
  const cats = catMap(org);
  const pm = pagoOf(cycle.period);
  const ym = yagoOf(cycle.period);
  const idx = routeIndex(org);
  const byChan = useMemo(() => groupSales(bench.sales, (r) => { const i = idx.get(r); return i ? `${i.deptId}\u0000${i.channel}` : null; }), [bench.sales]);
  if (!work.ntOk) return <p class="card muted">{tc('splitNeedsNt')}</p>;
  const months = cdMonths(work, l);
  // Departments and channels in the order of the department target file (TT, MT, HoReCa, WS…).
  const cols = [...org.depts]
    .map((d, i) => ({ id: String(d.id), name: d.name, i, chans: d.channels.length ? sortChannels(d.channels.map((c) => c.channel)) : [NO_CHANNEL] }))
    .sort((a, b) => channelRank(a.chans[0]!) - channelRank(b.chans[0]!) || a.i - b.i);
  const packs = Object.keys(work.nt);
  const hasSplit = Object.keys(work.dm).length > 0;
  const rows = cdRows(packs, cats).filter((r) => !hideZero || r.kind === 'sub' || (work.nt[r.pack] ?? 0) !== 0);
  const cell = (d: string, c: string, list: string[]) => list.reduce((s, p) => s + (work.dm[d]?.[c]?.[p] ?? 0), 0);
  const salesOf = (m: string, d: string, c: string, list: string[]) => list.reduce((s, p) => s + (byChan[m]?.[`${d}\u0000${c}`]?.[p] ?? 0), 0);
  const bench2 = (d: string, c: string, list: string[]) => salesOf(view === 'pago' ? pm : ym, d, c, list);
  const show = (v: number, d: string, c: string, list: string[]) => {
    if (view === 'cases') return fmtNum(v);
    const b = bench2(d, c, list);
    return <span title={`${fmtNum(v)} / ${fmtNum(Math.round(b))}`}><Gap v={gap(v, b)} /></span>;
  };
  const deptBench = (d: { id: string; chans: string[] }, list: string[]) => d.chans.reduce((s, c) => s + bench2(d.id, c, list), 0);

  function setCell(d: string, c: string, p: string, n: number) {
    const dm = structuredClone(work.dm);
    ((dm[d] ??= {})[c] ??= {})[p] = n;
    setWork({ ...work, dm });
  }
  function split(how: 'sales' | 'uploaded') {
    const r = splitFor(work, l, work.nt, how);
    setWork({ ...work, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
  }
  /** Back to the starting split for one pack (by the average sales, or the uploaded split it came from). */
  function resetPack(p: string) {
    const how = (work.basis[p] ?? '').startsWith('uploaded') ? 'uploaded' : 'sales';
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
    const r = splitFor(next, l, work.nt, 'sales');
    setWork({ ...next, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
  }
  const badPacks = packs.filter((p) => org.depts.reduce((s, d) => s + deptPack(work.dm, String(d.id), p), 0) !== work.nt[p]);
  const uploadedSplit = bench.upload?.mode === 'dept';
  const fromUpload = Object.values(work.basis).some((b) => b.startsWith('uploaded'));

  return (
    <>
      <MonthPicker period={cycle.period} months={months} available={bench.available} disabled={!edit} onChange={setMonths} title={tc('avgBasedOn')} />
      <div class="banner info small">{fromUpload ? tc('splitHowUploaded') : tc('splitHowSales', { months: monthsLabel(months), pago: pm })}</div>
      <Section title={tc('deptTitle', { period: cycle.period })} right={
        <div class="toolbar">
          {edit && <button type="button" class="btn primary" data-testid="split-all" onClick={() => split('sales')}>{tc('splitAll')}</button>}
          {edit && uploadedSplit && <button type="button" class="btn" onClick={() => split('uploaded')}>{tc('useUploadedSplit')}</button>}
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
                {cols.map((d) => <th key={d.id} colSpan={d.chans.length + (d.chans.length > 1 ? 1 : 0)} class="grp">{d.name}</th>)}
                <th rowSpan={2} class="num">ABC</th><th rowSpan={2} class="num">{tc('newTarget')}</th>
                {edit && <th rowSpan={2}><span class="visually-hidden">{tc('resetRow')}</span></th>}
              </tr>
              <tr>{cols.flatMap((d) => [
                ...d.chans.map((c) => <th key={`${d.id}${c}`} class="num">{c === NO_CHANNEL ? d.name : c}</th>),
                ...(d.chans.length > 1 ? [<th key={`${d.id}t`} class="num">{tc('totalOf', { name: d.name })}</th>] : []),
              ])}</tr>
            </thead>
            <tbody>{rows.map((r) => {
              const list = r.kind === 'sub' ? r.packs : [r.pack];
              const abc = cols.reduce((s, d) => s + d.chans.reduce((a, c) => a + cell(d.id, c, list), 0), 0);
              const nt = list.reduce((s, p) => s + (work.nt[p] ?? 0), 0);
              const off = r.kind === 'pack' && abc !== nt;
              const abcBench = cols.reduce((s, d) => s + deptBench(d, list), 0);
              return (
                <tr key={r.kind === 'sub' ? r.label : r.pack} class={r.kind === 'sub' ? `sub l${r.level}` : off ? 'bad' : ''}>
                  <td><bdi>{r.kind === 'sub' ? r.label : r.pack}</bdi></td>
                  {cols.flatMap((d) => [
                    ...d.chans.map((c) => (
                      <td key={`${d.id}${c}`} class="num">
                        {r.kind === 'pack' && edit && view === 'cases'
                          ? <NumCell value={cell(d.id, c, list)} label={`${r.pack} ${c}`} onChange={(n) => setCell(d.id, c, r.pack, n)} />
                          : show(cell(d.id, c, list), d.id, c, list)}
                      </td>
                    )),
                    ...(d.chans.length > 1 ? [<td key={`${d.id}t`} class="num tot">{(() => {
                      const v = d.chans.reduce((s, c) => s + cell(d.id, c, list), 0);
                      return view === 'cases' ? fmtNum(v) : <Gap v={gap(v, deptBench(d, list))} />;
                    })()}</td>] : []),
                  ])}
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
    </>
  );
}

// ---------- order of the department target file ----------

const CHANNEL_ORDER = ['tt dmm', 'tt outer', 'tt', 'mt', 'mt ssv', 'mt bulk', 'horeca', 'ws', 'kam', 'kae'];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Rank of a channel in the department file (TT DMM, TT Outer, MT, MT SSV, MT Bulk, HoReCa, WS); unknown last. */
export function channelRank(c: string): number {
  const n = norm(c);
  const exact = CHANNEL_ORDER.indexOf(n);
  if (exact >= 0) return exact;
  // "Presell – TT" or "TT - DMM": the longest known name the channel ends with or contains.
  let best = -1;
  for (const [i, k] of CHANNEL_ORDER.entries()) if (new RegExp(`(^| )${k}( |$)`).test(n) && (best < 0 || k.length > CHANNEL_ORDER[best]!.length)) best = i;
  return best >= 0 ? best : CHANNEL_ORDER.length;
}
const sortChannels = (list: string[]) => list.map((c, i) => ({ c, i })).sort((a, b) => channelRank(a.c) - channelRank(b.c) || a.i - b.i).map((x) => x.c);

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
  const packs = Object.keys(work.nt).sort();
  const chans = org.depts.flatMap((d) => (d.channels.length ? d.channels.map((c) => ({ d: String(d.id), c: c.channel, label: c.channel })) : [{ d: String(d.id), c: NO_CHANNEL, label: d.name }]));
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

// ---------- page ----------

export function CdPage({ ws: wsParam, period: periodParam }: { ws?: string; period?: string }) {
  useLang();
  const { route } = useLocation();
  const { user } = useSession();
  const allowed = useMyWorkspaces();
  const ws: Workspace = wsParam === 'ka' ? 'ka' : wsParam === 'ops' ? 'ops' : allowed[0] ?? 'ops';
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
    ...cdSubmitProblems({ ...work, colJ: {}, gm: {} }, cats, l.org.depts.map((d) => String(d.id))),
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
      <WsPeriod ws={ws} period={period} allowed={allowed} onChange={(w, p) => { setDirty(false); route(`/cd/${w}/${p}`); }} />
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
            {edit && <button type="button" class="btn" disabled={busy || !dirty} onClick={() => void save()}>{tc('save')}</button>}
            {edit && <button type="button" class="btn primary" disabled={busy || problems.length > 0} title={problems.join('; ')} onClick={() => void submit()}>{tc('approveReturnAdmin')}</button>}
          </div>
          {edit && problems.length > 0 && <p class="small muted" data-testid="submit-reason">{tc('cannotSubmit')}: {problems.join('; ')}</p>}
          {msg && <div class="banner ok" role="status">{msg}</div>}
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
