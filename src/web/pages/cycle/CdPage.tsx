// Commercial Director (handover section 5): GM Adjustment, Target by
// department & channel, Share of mix (column I / column J) and the dashboard.
// Work is saved to the cycle (version-checked) and submitted to Admin, or
// returned with a comment.
import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useState } from 'preact/hooks';
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
  avgOf, catMap, cdRows, companyTarget, defaultDeptSplit, deptPack, groupSales, NO_CHANNEL, rescalePack, routeIndex, somRows, sumCat, total,
  type ChannelHist, type Grid,
} from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { getCycle, getOrg, loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import type { RouteMonthData } from '../../cycle/parsers';
import { defaultPeriod, fmtGap, fmtPct, gapClass, NumCell, Section, Tabs, useMyWorkspaces, writeWorkbook, WsPeriod } from '../../cycle/ui';

type TabId = 'gm' | 'dept' | 'som' | 'dash';

type Bench = {
  sales: RouteMonthData; deptChannel: ChannelHist; prev: RouteMonthData; fy: Record<string, Grid>;
  aop: Record<string, Record<string, { cases: number; nr: number | null }>>;
  upload: { mode: 'pack' | 'dept'; byPack: Grid; byChannel?: Record<string, Grid> } | null;
  yagoSales: Grid; pagoTarget: Grid; aopNow: Grid; recommended: Grid;
};

type Loaded = { cycle: CycleDto; org: OrgDto; bench: Bench };

const gap = (a: number, b: number | null | undefined): number | null => (b && b > 0 ? a / b - 1 : null);

function Gap({ v }: { v: number | null }) {
  return <span class={gapClass(v)}>{fmtGap(v)}</span>;
}

async function loadAll(ws: Workspace, period: string): Promise<Loaded> {
  const [cycle, org] = await Promise.all([getCycle(ws, period), getOrg(ws)]);
  const pm = pagoOf(period);
  const ym = yagoOf(period);
  const year = Number(period.slice(0, 4));
  const fyMonths = Array.from({ length: 12 }, (_, i) => `${year - 1}-${String(i + 1).padStart(2, '0')}`);
  const ytd = Array.from({ length: Number(period.slice(5)) - 1 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const months = [...new Set([...cycle.settings.avgMonths, pm, ym, ...fyMonths, ...ytd])];
  const [sales, prev, dc, fy, aop, nt] = await Promise.all([
    loadRouteData(ws, 'sales', months), loadRouteData(ws, 'prev_target', [pm]),
    loadMonthData<Record<string, Grid>>(ws, 'dept_channel'), loadMonthData<Grid>(ws, 'fy_target'),
    loadMonthData<Record<string, { cases: number; nr: number | null }>>(ws, 'aop'),
    loadMonthData<{ mode: 'pack' | 'dept'; byPack: Grid; byChannel?: Record<string, Grid> }>(ws, 'new_target'),
  ]);
  const company = groupSales(sales.data, () => 'all');
  const yagoSales = { ...(company[ym]?.all ?? {}) };
  const pagoTarget = companyTarget({ deptChannel: dc, prevTargets: prev.data, fyTarget: fy }, pm);
  const aopNow = Object.fromEntries(Object.entries(aop[period] ?? {}).map(([p, v]) => [p, v.cases]));
  const recommended: Grid = {};
  const avgPacks = new Set(cycle.settings.avgMonths.flatMap((m) => Object.keys(company[m]?.all ?? {})));
  for (const p of avgPacks) recommended[p] = Math.round(avgOf(company, 'all', p, cycle.settings.avgMonths));
  return {
    cycle, org,
    bench: { sales: sales.data, deptChannel: dc, prev: prev.data, fy, aop, upload: nt[period] ?? null, yagoSales, pagoTarget, aopNow, recommended },
  };
}

// ---------- Tab 1 ----------

function GmTab({ work, edit, l, setWork }: { work: CdWork; edit: boolean; l: Loaded; setWork: (w: CdWork) => void }) {
  useLang();
  const cats = catMap(l.org);
  const { bench } = l;
  const packs = Object.keys(work.nt);
  const rows = cdRows(packs, cats);
  const sum = (g: Grid, list: string[]) => list.reduce((s, p) => s + (g[p] ?? 0), 0);
  const editable = edit && !work.ntOk;

  function approve() {
    const stale = Object.keys(work.dm).length === 0 || packs.some((p) => work.splitNt[p] !== work.nt[p]);
    if (!stale) return setWork({ ...work, ntOk: true });
    const dm = structuredClone(work.dm);
    if (Object.keys(dm).length === 0) {
      const r = defaultDeptSplit({
        period: l.cycle.period, nt: work.nt, org: l.org, sales: bench.sales, avgMonths: l.cycle.settings.avgMonths, deptChannel: bench.deptChannel,
        uploadedByChannel: bench.upload?.mode === 'dept' ? bench.upload.byChannel ?? null : null,
      });
      return setWork({ ...work, ntOk: true, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
    }
    // Only the packs whose New Target changed are rescaled; new packs get the default split.
    const fresh = packs.filter((p) => !(p in work.splitNt));
    for (const p of packs) if (p in work.splitNt && work.splitNt[p] !== work.nt[p]) rescalePack(dm, p, work.nt[p]!);
    const basis = { ...work.basis };
    if (fresh.length) {
      const r = defaultDeptSplit({
        period: l.cycle.period, nt: Object.fromEntries(fresh.map((p) => [p, work.nt[p]!])), org: l.org, sales: bench.sales,
        avgMonths: l.cycle.settings.avgMonths, deptChannel: bench.deptChannel,
      });
      for (const [d, ch] of Object.entries(r.dm)) for (const [c, g] of Object.entries(ch)) Object.assign((dm[d] ??= {})[c] ??= {}, g);
      Object.assign(basis, r.basis);
    }
    setWork({ ...work, ntOk: true, dm, basis, splitNt: { ...work.nt } });
  }

  return (
    <Section title={tc('tabGm')} right={edit && (
      work.ntOk
        ? <button type="button" class="btn" onClick={() => setWork({ ...work, ntOk: false })}>{tc('reopenNt')}</button>
        : <button type="button" class="btn primary" onClick={approve}>{tc('approveNt')}</button>
    )}>
      <p class="muted small">{work.ntOk ? tc('ntApproved') : tc('ntHelp')}</p>
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr>
          <th>{tc('pack')}</th><th class="num">{tc('newTarget')}</th><th class="num">{tc('yagoSales')}</th><th class="num">{tc('vsYago')}</th>
          <th class="num">{tc('pagoTarget')}</th><th class="num">{tc('vsPago')}</th><th class="num">AOP</th><th class="num">{tc('vsAop')}</th><th class="num">{tc('recommended')}</th>
        </tr></thead>
        <tbody>{rows.map((r) => {
          if (r.kind === 'sub') {
            const nt = sum(work.nt, r.packs);
            return (
              <tr key={r.label} class={`sub l${r.level}`}>
                <td>{r.label}</td><td class="num">{fmtNum(nt)}</td>
                <td class="num">{fmtNum(sum(bench.yagoSales, r.packs))}</td><td class="num"><Gap v={gap(nt, sum(bench.yagoSales, r.packs))} /></td>
                <td class="num">{fmtNum(sum(bench.pagoTarget, r.packs))}</td><td class="num"><Gap v={gap(nt, sum(bench.pagoTarget, r.packs))} /></td>
                <td class="num">{fmtNum(sum(bench.aopNow, r.packs))}</td><td class="num"><Gap v={gap(nt, sum(bench.aopNow, r.packs))} /></td>
                <td class="num">{fmtNum(sum(bench.recommended, r.packs))}</td>
              </tr>
            );
          }
          const p = r.pack;
          const nt = work.nt[p] ?? 0;
          return (
            <tr key={p}>
              <td><bdi>{p}</bdi></td>
              <td class="num">{editable
                ? <NumCell value={nt} label={`${tc('newTarget')} ${p}`} onChange={(n) => setWork({ ...work, nt: { ...work.nt, [p]: n } })} />
                : fmtNum(nt)}</td>
              <td class="num">{fmtNum(bench.yagoSales[p] ?? 0)}</td><td class="num"><Gap v={gap(nt, bench.yagoSales[p])} /></td>
              <td class="num">{fmtNum(bench.pagoTarget[p] ?? 0)}</td><td class="num"><Gap v={gap(nt, bench.pagoTarget[p])} /></td>
              <td class="num">{fmtNum(bench.aopNow[p] ?? 0)}</td><td class="num"><Gap v={gap(nt, bench.aopNow[p])} /></td>
              <td class="num">{fmtNum(bench.recommended[p] ?? 0)}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </Section>
  );
}

// ---------- Tab 2 ----------

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
  const byChan = useMemo(() => groupSales(bench.sales, (r) => idx.get(r)?.channel ?? null), [bench.sales]);
  if (!work.ntOk || Object.keys(work.dm).length === 0) return <p class="card muted">{tc('splitNeedsNt')}</p>;
  const cols = org.depts.map((d) => ({ id: String(d.id), name: d.name, chans: d.channels.length ? d.channels.map((c) => c.channel) : [NO_CHANNEL] }));
  const packs = Object.keys(work.nt);
  const rows = cdRows(packs, cats).filter((r) => !hideZero || r.kind === 'sub' || (work.nt[r.pack] ?? 0) !== 0);
  const cell = (d: string, c: string, list: string[]) => list.reduce((s, p) => s + (work.dm[d]?.[c]?.[p] ?? 0), 0);
  const bench2 = (c: string, list: string[]) => list.reduce((s, p) => s + (view === 'pago' ? bench.deptChannel[pm]?.[c]?.[p] ?? 0 : byChan[ym]?.[c]?.[p] ?? 0), 0);
  const show = (v: number, c: string, list: string[]) => (view === 'cases' ? fmtNum(v) : <Gap v={gap(v, bench2(c, list))} />);
  const deptBench = (d: { chans: string[] }, list: string[]) => d.chans.reduce((s, c) => s + bench2(c, list), 0);

  function setCell(d: string, c: string, p: string, n: number) {
    const dm = structuredClone(work.dm);
    ((dm[d] ??= {})[c] ??= {})[p] = n;
    setWork({ ...work, dm });
  }
  function reset() {
    const r = defaultDeptSplit({
      period: cycle.period, nt: work.nt, org, sales: bench.sales, avgMonths: cycle.settings.avgMonths, deptChannel: bench.deptChannel,
      uploadedByChannel: bench.upload?.mode === 'dept' ? bench.upload.byChannel ?? null : null,
    });
    setWork({ ...work, dm: r.dm, basis: r.basis, splitNt: { ...work.nt } });
  }
  const badPacks = packs.filter((p) => org.depts.reduce((s, d) => s + deptPack(work.dm, String(d.id), p), 0) !== work.nt[p]);

  return (
    <Section title={tc('tabDept')} right={
      <div class="toolbar">
        <Tabs<View> value={view} onChange={setView} items={[{ id: 'cases', label: tc('viewCases') }, { id: 'pago', label: tc('vsPago') }, { id: 'yago', label: tc('vsYago') }]} />
        <label class="small"><input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.currentTarget.checked)} /> {tc('hideZero')}</label>
        {edit && <button type="button" class="btn" onClick={reset}>{tc('resetSplit')}</button>}
      </div>
    }>
      {badPacks.length > 0 && <div class="banner warn">{tc('packsNotAdding', { n: badPacks.length })}</div>}
      <div class="tablewrap"><table class="ad-table cy-table cy-grid-table">
        <thead>
          <tr><th rowSpan={2}>{tc('pack')}</th>
            {cols.map((d) => <th key={d.id} colSpan={d.chans.length + (d.chans.length > 1 ? 1 : 0)} class="grp">{d.name}</th>)}
            <th rowSpan={2} class="num">ABC</th><th rowSpan={2} class="num">{tc('newTarget')}</th>
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
          return (
            <tr key={r.kind === 'sub' ? r.label : r.pack} class={r.kind === 'sub' ? `sub l${r.level}` : off ? 'bad' : ''}>
              <td><bdi>{r.kind === 'sub' ? r.label : r.pack}</bdi></td>
              {cols.flatMap((d) => [
                ...d.chans.map((c) => (
                  <td key={`${d.id}${c}`} class="num">
                    {r.kind === 'pack' && edit && view === 'cases'
                      ? <NumCell value={cell(d.id, c, list)} label={`${r.pack} ${c}`} onChange={(n) => setCell(d.id, c, r.pack, n)} />
                      : show(cell(d.id, c, list), c, list)}
                  </td>
                )),
                ...(d.chans.length > 1 ? [<td key={`${d.id}t`} class="num tot">{(() => {
                  const v = d.chans.reduce((s, c) => s + cell(d.id, c, list), 0);
                  return view === 'cases' ? fmtNum(v) : <Gap v={gap(v, deptBench(d, list))} />;
                })()}</td>] : []),
              ])}
              <td class="num tot">{fmtNum(abc)}</td>
              <td class="num">{fmtNum(nt)}{off && <div class="small bad-text">{fmtNum(abc - nt)}</div>}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </Section>
  );
}

// ---------- Tab 3 ----------

function SomTab({ work, edit, l, setWork }: { work: CdWork; edit: boolean; l: Loaded; setWork: (w: CdWork) => void }) {
  useLang();
  const [cat, setCat] = useState<Category>('CSD');
  const { org, bench, cycle } = l;
  const cats = catMap(org);
  const rows = useMemo(() => somRows({ period: cycle.period, org, sales: bench.sales, avgMonths: cycle.settings.avgMonths, cat }), [cat, l]);
  const ntCat = sumCat(work.nt, cats, cat);
  const colI = (d: string) => work.gm[d]?.[cat] ?? Object.values(work.dm[d] ?? {}).reduce((s, g) => s + sumCat(g, cats, cat), 0);
  const colJ = (d: string) => work.colJ[d]?.[cat] ?? colI(d);
  const sumJ = org.depts.reduce((s, d) => s + colJ(String(d.id)), 0);
  const setIn = (key: 'gm' | 'colJ', d: string, n: number) => setWork({ ...work, [key]: { ...work[key], [d]: { ...(work[key][d] ?? {}), [cat]: n } } });
  function fillJ() {
    const colJNew = structuredClone(work.colJ);
    for (const d of org.depts) (colJNew[String(d.id)] ??= {})[cat] = colI(String(d.id));
    setWork({ ...work, colJ: colJNew });
  }
  return (
    <Section title={tc('tabSom')} right={
      <div class="toolbar">
        <Tabs<Category> value={cat} onChange={setCat} items={CATEGORIES.map((c) => ({ id: c, label: c }))} />
        {edit && <button type="button" class="btn" onClick={fillJ}>{tc('fillJ')}</button>}
      </div>
    }>
      <p class="small">{tc('colJCheck', { got: fmtNum(sumJ), want: fmtNum(ntCat) })} {sumJ === ntCat ? <span class="status ok">{tc('ok')}</span> : <span class="status bad">{fmtNum(sumJ - ntCat)}</span>}</p>
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr>
          <th>{tc('head')}</th><th class="num">{tc('somFy')}</th><th class="num">YTD</th><th class="num">{tc('som3')}</th><th class="num">PAGO</th><th class="num">YAGO</th>
          <th class="num">{tc('somRec')}</th><th class="num">{tc('casesPago')}</th><th class="num">{tc('casesYago')}</th>
          <th class="num">{tc('colI')}</th><th class="num">{tc('colJ')}</th><th class="num">{tc('deltaIJ')}</th><th class="num">{tc('vsYago')}</th><th class="num">{tc('vsPago')}</th>
        </tr></thead>
        <tbody>{rows.map((r) => {
          const main = r.channel === null;
          const d = r.dept;
          const i = main ? colI(d) : null;
          const j = main ? colJ(d) : null;
          return (
            <tr key={`${d}${r.channel ?? ''}`} class={main ? 'sub l2' : 'muted'}>
              <td>{main ? r.label : <span class="indent">{r.label}</span>}</td>
              <td class="num">{fmtPct(r.somFy)}</td><td class="num">{fmtPct(r.somYtd)}</td><td class="num">{fmtPct(r.som3)}</td>
              <td class="num">{fmtPct(r.somPago)}</td><td class="num">{fmtPct(r.somYago)}</td><td class="num"><b>{fmtPct(r.somRec)}</b></td>
              <td class="num">{fmtNum(r.casesPago)}</td><td class="num">{fmtNum(r.casesYago)}</td>
              <td class="num">{i === null ? '' : edit ? <NumCell value={i} label={`${tc('colI')} ${r.label}`} onChange={(n) => setIn('gm', d, n)} /> : fmtNum(i)}</td>
              <td class="num">{j === null ? '' : edit ? <NumCell value={j} label={`${tc('colJ')} ${r.label}`} onChange={(n) => setIn('colJ', d, n)} /> : fmtNum(j)}</td>
              <td class="num">{i === null || j === null ? '' : fmtNum(i - j)}</td>
              <td class="num">{j === null ? '' : <Gap v={gap(j, r.casesYago)} />}</td>
              <td class="num">{j === null ? '' : <Gap v={gap(j, r.casesPago)} />}</td>
            </tr>
          );
        })}</tbody>
        <tfoot><tr><td>{tc('total')}</td><td colSpan={8} /><td class="num">{fmtNum(org.depts.reduce((s, d) => s + colI(String(d.id)), 0))}</td><td class="num">{fmtNum(sumJ)}</td><td colSpan={3} /></tr></tfoot>
      </table></div>
    </Section>
  );
}

// ---------- Tab 4 ----------

function Bar({ v }: { v: number | null }) {
  const w = v === null ? 0 : Math.min(50, Math.abs(v) * 100);
  return (
    <div class="cy-bar" aria-hidden="true">
      <span class={v !== null && v < 0 ? 'neg' : 'pos'} style={{ width: `${w}%`, [v !== null && v < 0 ? 'right' : 'left']: '50%' }} />
    </div>
  );
}

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
      label: g.label, nt, yago: sum(l.bench.yagoSales, g.packs), pago: sum(l.bench.pagoTarget, g.packs), aop: sum(l.bench.aopNow, g.packs),
      vsYago: gap(nt, sum(l.bench.yagoSales, g.packs)), vsPago: gap(nt, sum(l.bench.pagoTarget, g.packs)), vsAop: gap(nt, sum(l.bench.aopNow, g.packs)),
    };
  });
}

function DashTab({ work, l }: { work: CdWork; l: Loaded }) {
  useLang();
  const cards = cdDashboard(work, l);
  return (
    <div class="cy-cards">
      {cards.map((c) => (
        <section key={c.label} class="card cy-card">
          <h3>{c.label}</h3>
          <p class="big">{fmtNum(c.nt)}</p>
          <dl>
            <dt>{tc('vsYago')}</dt><dd><Gap v={c.vsYago} /><Bar v={c.vsYago} /></dd>
            <dt>{tc('vsPago')}</dt><dd><Gap v={c.vsPago} /><Bar v={c.vsPago} /></dd>
            <dt>{tc('vsAop')}</dt><dd><Gap v={c.vsAop} /><Bar v={c.vsAop} /></dd>
          </dl>
        </section>
      ))}
    </div>
  );
}

// ---------- the whole CD workbook ----------

function downloadWorkbook(work: CdWork, l: Loaded) {
  const { org, bench, cycle } = l;
  const cats = catMap(org);
  const packs = Object.keys(work.nt).sort();
  const chans = org.depts.flatMap((d) => (d.channels.length ? d.channels.map((c) => ({ d: String(d.id), c: c.channel, label: c.channel })) : [{ d: String(d.id), c: NO_CHANNEL, label: d.name }]));
  const som = CATEGORIES.flatMap((cat) => somRows({ period: cycle.period, org, sales: bench.sales, avgMonths: cycle.settings.avgMonths, cat })
    .filter((r) => r.channel === null)
    .map((r) => [cat, r.label, r.somFy, r.somYtd, r.som3, r.somPago, r.somYago, r.somRec, r.casesPago, r.casesYago,
      work.gm[r.dept]?.[cat] ?? Object.values(work.dm[r.dept] ?? {}).reduce((s, g) => s + sumCat(g, cats, cat), 0), work.colJ[r.dept]?.[cat] ?? null]));
  void writeWorkbook(`cd_${cycle.ws}_${cycle.period}.xlsx`, [
    {
      name: 'GM Adjustment', columns: ['Pack', 'Category', 'New Target', 'YAGO Sales', 'PAGO Target', 'AOP', 'Recommended'],
      rows: packs.map((p) => [p, cats.get(p) ?? '', work.nt[p] ?? 0, bench.yagoSales[p] ?? 0, bench.pagoTarget[p] ?? 0, bench.aopNow[p] ?? 0, bench.recommended[p] ?? 0]),
    },
    {
      name: 'Target by department', columns: ['Pack', ...chans.map((x) => x.label), 'ABC', 'New Target'],
      rows: packs.map((p) => {
        const vals = chans.map((x) => work.dm[x.d]?.[x.c]?.[p] ?? 0);
        return [p, ...vals, vals.reduce((s, v) => s + v, 0), work.nt[p] ?? 0];
      }),
    },
    {
      name: 'Share of mix', columns: ['Category', 'Head', 'SOM FY', 'SOM YTD', 'SOM 3M', 'SOM PAGO', 'SOM YAGO', 'Recommended SOM', 'Cases PAGO', 'Cases YAGO', 'Column I', 'Column J'],
      rows: som as (string | number | null)[][],
    },
    {
      name: 'Dashboard', columns: ['Category', 'New Target', 'YAGO Sales', 'vs YAGO', 'PAGO Target', 'vs PAGO', 'AOP', 'vs AOP'],
      rows: cdDashboard(work, l).map((c) => [c.label, c.nt, c.yago, c.vsYago, c.pago, c.vsPago, c.aop, c.vsAop]),
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
  const problems = work && l ? cdSubmitProblems(work, cats, l.org.depts.map((d) => String(d.id))) : [];

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
    if (dirty && !(await save())) return;
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
            {edit && <button type="button" class="btn primary" disabled={busy || problems.length > 0} title={problems.join('; ')} onClick={() => void submit()}>{tc('submitToAdmin')}</button>}
          </div>
          {edit && problems.length > 0 && <p class="small muted" data-testid="submit-reason">{tc('cannotSubmit')}: {problems.join('; ')}</p>}
          {msg && <div class="banner ok" role="status">{msg}</div>}
          {err && <div class="alert" role="alert">{err}</div>}
          <Tabs<TabId> value={tab} onChange={setTab} items={[
            { id: 'gm', label: tc('tabGm') }, { id: 'dept', label: tc('tabDept') }, { id: 'som', label: tc('tabSom') }, { id: 'dash', label: tc('tabDash') },
          ]} />
          {tab === 'gm' && <GmTab work={work} edit={edit} l={l} setWork={setWork} />}
          {tab === 'dept' && <DeptTab work={work} edit={edit} l={l} setWork={setWork} />}
          {tab === 'som' && <SomTab work={work} edit={edit} l={l} setWork={setWork} />}
          {tab === 'dash' && <DashTab work={work} l={l} />}
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
