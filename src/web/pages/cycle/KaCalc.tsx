// Admin › Target calculator for Key Accounts. The Key Account target is built
// on the Operation target of the linked department (MT, Non Retail) after the
// Commercial Director's split. It is shared to every KAE by their sales
// (each level's share of the level above, as in Operation), then each KAE
// goes up by 1% to 3% (the range is editable): how far the KAE sold above
// their previous target, by pack where the KAE has a target for the pack,
// else on the total. The admin sees the result by KAM and KAE (uplift %,
// cases added) and by pack, may set a KAE's % by hand, and applies it.
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES } from '../../../shared/calc/packs';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import { fmtNum, useLang } from '../../i18n';
import { calculate, catMap, inPackOrder, sumCat, total, type Grid } from '../../cycle/compute';
import { achievement, upliftPct } from '../../cycle/kaUplift';
import { tc } from '../../cycle/i18n';
import { loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import type { RouteMonthData } from '../../cycle/parsers';
import { fmtPct, MonthPicker, monthsLabel, NumCell, Section, Tabs, writeWorkbook } from '../../cycle/ui';
import type { Loaded } from './AdminCycle';

type Upload = { mode: string; byPack: Grid; byLeaf?: Record<string, Grid> };

type Line = {
  key: string; dept: string; kam: string; kae: string; route: string | null; level: 'dept' | 'kam' | 'kae';
  base: Grid; target: Grid; sales: Grid; prev: Grid; avg: Grid; pct: number | null;
};

const sumInto = (into: Grid, g: Grid) => { for (const [p, n] of Object.entries(g)) into[p] = (into[p] ?? 0) + n; };

export function KaCalcTab({ period, l, reload, onNext }: { period: string; l: Loaded; reload: () => void; onNext?: () => void }) {
  useLang();
  const { cycle, org } = l;
  const cats = catMap(org);
  const [months, setMonths] = useState<string[]>(cycle.settings.avgMonths);
  const [min, setMin] = useState(cycle.settings.uplift?.min ?? 1);
  const [max, setMax] = useState(cycle.settings.uplift?.max ?? 3);
  const [override, setOverride] = useState<Record<string, number>>({});
  const [view, setView] = useState<'kae' | 'pack'>('kae');
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const avail = useAsync(() => api<{ months: string[] }>('GET', '/api/data/ka/sales-months'), []);
  const data = useAsync(async () => {
    const [sales, prev, nt] = await Promise.all([
      loadRouteData('ka', 'sales', months), loadRouteData('ka', 'prev_target', months), loadMonthData<Upload>('ka', 'new_target'),
    ]);
    return { sales: sales.data, prev: prev.data, upload: nt[period] ?? null };
  }, [period, months.join(',')]);

  // ---------- the starting target per Key Account department ----------
  const mode = cycle.settings.ntMode;
  const base = useMemo<Record<string, Grid> | null>(() => {
    if (!data.data) return null;
    const out: Record<string, Grid> = {};
    if (mode === 'ops') {
      for (const lk of l.links ?? []) {
        const g = lk.opsDeptId !== null ? l.ops?.dept?.[String(lk.opsDeptId)] : undefined;
        if (g) out[String(lk.kaDeptId)] = { ...g };
      }
      return out;
    }
    const up = data.data.upload;
    if (!up) return out;
    if (up.mode === 'leaf' && up.byLeaf) {
      const deptOf = new Map(org.leaves.map((x) => [x.routeCode, String(x.deptId)]));
      for (const [r, g] of Object.entries(up.byLeaf)) { const d = deptOf.get(r); if (d) sumInto(out[d] ??= {}, g); }
      return out;
    }
    // By pack (or the AOP): shared to the Key Account departments by their sales of each pack.
    const depts = org.depts.map((d) => String(d.id));
    const salesOf = (d: string, p: string | null) => org.leaves.filter((x) => String(x.deptId) === d)
      .reduce((s, x) => s + months.reduce((a, m) => a + (p ? data.data!.sales[m]?.[x.routeCode]?.[p] ?? 0 : total(data.data!.sales[m]?.[x.routeCode])), 0), 0);
    for (const [p, n] of Object.entries(up.byPack)) {
      let w = depts.map((d) => salesOf(d, p));
      if (!w.some((x) => x > 0)) w = depts.map((d) => salesOf(d, null));
      if (!w.some((x) => x > 0)) w = depts.map(() => 1);
      const sum = w.reduce((a, b) => a + b, 0);
      let left = Math.round(n);
      depts.forEach((d, i) => {
        const v = i === depts.length - 1 ? left : Math.round((n * w[i]!) / sum);
        left -= v;
        (out[d] ??= {})[p] = v;
      });
    }
    return out;
  }, [data.data, mode, l.links, l.ops, org, months.join(',')]);

  // ---------- shared to the KAEs by sales, then the uplift ----------
  const calc = useMemo(() => (base && data.data && Object.keys(base).length
    ? calculate({ org, dept: base, sales: data.data.sales, avgMonths: months, routeTargets: {} })
    : null), [base, data.data, org]);

  const lines = useMemo<Line[]>(() => {
    if (!calc || !data.data) return [];
    const byId = new Map(org.nodes.map((n) => [n.id, n]));
    const depthOf = (id: number) => { let d = 0; for (let p = byId.get(id)?.parentId ?? null; p !== null; p = byId.get(p)?.parentId ?? null) d++; return d; };
    const out: Line[] = [];
    for (const dc of calc.depts) {
      const d = String(dc.deptId);
      const deptName = org.depts.find((x) => x.id === dc.deptId)?.name ?? d;
      const dl: Line = { key: `d:${d}`, dept: deptName, kam: '', kae: '', route: null, level: 'dept', base: {}, target: {}, sales: {}, prev: {}, avg: {}, pct: null };
      const kams = new Map<number, Line>();
      const kaes: Line[] = [];
      for (const leaf of org.leaves.filter((x) => x.deptId === dc.deptId)) {
        const r = leaf.routeCode;
        const share = dc.routes[r] ?? {};
        const a = achievement(r, months, data.data.sales, data.data.prev);
        // Average sales of the months picked (every month counts, a month without sales as 0).
        const avg: Grid = {};
        for (const m of months) for (const [p, n] of Object.entries(data.data.sales[m]?.[r] ?? {})) avg[p] = (avg[p] ?? 0) + n / Math.max(1, months.length);
        const target: Grid = {};
        for (const [p, n] of Object.entries(share)) target[p] = Math.round(n * (1 + (override[r] ?? upliftPct(a, p, min, max)) / 100));
        // KAM = the node right under the MDM; KAE = the node under the KAM (or the KAM when the KAM is also the KAE).
        let kamNode = byId.get(leaf.nodeId);
        while (kamNode && kamNode.parentId !== null && depthOf(kamNode.id) > 1) kamNode = byId.get(kamNode.parentId);
        const kaeNode = byId.get(leaf.nodeId);
        const kamId = kamNode?.id ?? leaf.nodeId;
        const kam = kamNode?.name ?? '';
        const line: Line = { key: `r:${r}`, dept: deptName, kam, kae: kaeNode && depthOf(kaeNode.id) >= 2 ? kaeNode.name : (leaf.label && leaf.label !== r ? leaf.label : kam), route: r, level: 'kae', base: share, target, sales: a.s, prev: a.t, avg, pct: override[r] ?? null };
        kaes.push(line);
        if (!kams.has(kamId)) kams.set(kamId, { key: `n:${kamId}`, dept: deptName, kam, kae: '', route: null, level: 'kam', base: {}, target: {}, sales: {}, prev: {}, avg: {}, pct: null });
        const kl = kams.get(kamId)!;
        for (const x of [kl, dl]) { sumInto(x.base, share); sumInto(x.target, target); sumInto(x.sales, a.s); sumInto(x.prev, a.t); sumInto(x.avg, avg); }
      }
      out.push(dl);
      for (const kl of [...kams.values()].sort((a, b) => a.kam.localeCompare(b.kam))) {
        out.push(kl);
        out.push(...kaes.filter((x) => x.kam === kl.kam).sort((a, b) => a.kae.localeCompare(b.kae)));
      }
    }
    return out;
  }, [calc, data.data, override, min, max, org]);

  if (mode === 'ops' && !(l.links ?? []).some((x) => x.opsDeptId !== null && l.ops?.dept?.[String(x.opsDeptId)])) {
    return <p class="card muted" data-testid="ka-calc-wait">{tc('kaCalcWaitOps', { period })}</p>;
  }
  if (mode !== 'ops' && data.data && !data.data.upload) return <p class="card muted">{tc('kaCalcWaitNt')}</p>;

  const pct = (x: Line) => { const b = total(x.base); return b > 0 ? total(x.target) / b - 1 : null; };
  const added = (x: Line) => total(x.target) - total(x.base);
  const shown = lines.find((x) => x.key === sel) ?? lines[0] ?? null;
  /** The KAE lines under a line (itself for a KAE). */
  const kaesOf = (x: Line) => (x.level === 'kae' ? [x] : lines.filter((y) => y.level === 'kae' && y.dept === x.dept && (x.level === 'dept' || y.kam === x.kam)));
  /** Uplift % typed on a line: every KAE under it gets it ('' goes back to the calculated uplift). */
  function setUplift(x: Line, v: string) {
    const rs = kaesOf(x).map((y) => y.route!).filter(Boolean);
    setOverride((o) => { const n = { ...o }; for (const r of rs) { if (v === '') delete n[r]; else n[r] = Number(v); } return n; });
  }
  /** Key Account target typed on a line: the uplift that gives it, for every KAE under it. */
  function setTarget(x: Line, v: number) {
    const b = total(x.base);
    if (b <= 0 || !Number.isFinite(v)) return;
    setUplift(x, String(Math.round((v / b - 1) * 10000) / 100));
  }
  const avgTot = (x: Line) => Math.round(total(x.avg));

  async function apply() {
    if (!calc) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const dept: Record<string, Grid> = {};
      const routes: Record<string, Record<string, Grid>> = {};
      for (const x of lines) {
        if (x.level !== 'kae' || !x.route) continue;
        const d = String(org.leaves.find((y) => y.routeCode === x.route)?.deptId ?? '');
        const g: Grid = {};
        for (const [p, n] of Object.entries(x.target)) if (n > 0) g[p] = n;
        sumInto(dept[d] ??= {}, g);
        (routes[d] ??= {})[x.route] = g;
      }
      await api('PUT', `/api/admin/cycle/ka/${period}/settings`, { avgMonths: months, uplift: { min, max } });
      await api('PUT', `/api/admin/cycle/ka/${period}/dept-target`, { dept });
      const notes = { at: new Date().toISOString(), months, uplift: { min, max }, override, from: mode };
      const out = await api<{ applied: string[]; kept: string[] }>('PUT', `/api/admin/cycle/ka/${period}/calc`, { calc: routes, notes });
      setMsg(`${tc('calcApplied', { n: out.applied.length, kept: out.kept.length })} ${tc('calcAppliedNext')}`);
      reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  function exportIt() {
    const packs = inPackOrder(lines.flatMap((x) => Object.keys(x.base)), org.packs.map((p) => p.code));
    void writeWorkbook(`key_account_target_${period}.xlsx`, [
      {
        name: 'By KAM and KAE',
        columns: ['MDM', 'KAM', 'KAE', 'KAE ID', 'Level', 'Avg sales', 'Uplift %', 'Cases added', 'Key Account target'],
        rows: lines.map((x) => [x.dept, x.kam, x.kae, x.route ?? '', x.level, avgTot(x), pct(x) === null ? null : Math.round(pct(x)! * 10000) / 100, added(x), total(x.target)]),
      },
      {
        name: 'By pack',
        columns: ['MDM', 'KAM', 'KAE', 'KAE ID', 'Pack', 'Category', 'Avg sales', 'Uplift %', 'Key Account target'],
        rows: lines.filter((x) => x.level === 'kae').flatMap((x) => packs.filter((p) => x.base[p]).map((p) => [
          x.dept, x.kam, x.kae, x.route ?? '', p, cats.get(p) ?? '', Math.round(x.avg[p] ?? 0),
          x.base[p] ? Math.round(((x.target[p] ?? 0) / x.base[p]! - 1) * 10000) / 100 : null, x.target[p] ?? 0,
        ])),
      },
    ]);
  }

  const depts = lines.filter((x) => x.level === 'dept');
  const packRows = shown ? inPackOrder(Object.keys({ ...shown.base, ...shown.target }), org.packs.map((p) => p.code)) : [];

  return (
    <>
      <MonthPicker period={period} months={months} onChange={setMonths} available={avail.data ? new Set(avail.data.months) : null} title={tc('kaMonths')} />
      {cycle.settings.note && <div class="banner info small" data-testid="ka-note-shown"><b>{tc('kaNote')}:</b> {cycle.settings.note}</div>}
      <Section title={tc('kaUpliftTitle')}>
        <div class="toolbar">
          <label class="small">{tc('kaUpliftMin')} <input type="number" step="0.5" min={0} max={100} value={min} data-testid="uplift-min" style={{ width: '5em' }} onInput={(e) => setMin(Math.max(0, Number(e.currentTarget.value) || 0))} /> %</label>
          <label class="small">{tc('kaUpliftMax')} <input type="number" step="0.5" min={0} max={100} value={max} data-testid="uplift-max" style={{ width: '5em' }} onInput={(e) => setMax(Math.max(0, Number(e.currentTarget.value) || 0))} /> %</label>
          {Object.keys(override).length > 0 && <button type="button" class="btn" onClick={() => setOverride({})}>{tc('resetAllEdits')}</button>}
        </div>
        <p class="muted small">{tc('kaUpliftHelp', { months: monthsLabel(months) })}</p>
        {min > max && <div class="alert">{tc('kaMinMax')}</div>}
      </Section>
      {data.error && <div class="alert" role="alert">{data.error}</div>}
      {!data.data && <p class="muted">{tc('loading')}</p>}
      {calc && calc.problems.length > 0 && <div class="banner warn small">{calc.problems.join(' · ')}</div>}
      {depts.length > 0 && (
        <Section title={tc('kaSummaryTitle', { period })}>
          <div class="tablewrap"><table class="ad-table cy-table" data-testid="ka-dept-summary">
            <thead><tr><th>{tc('kaDept')}</th>{CATEGORIES.map((c) => <th key={c} class="num">{c}<div class="small muted">{tc('kaOpsVsKa')}</div></th>)}<th class="num">{tc('kaOpsTotal')}</th><th class="num">{tc('kaKaTotal')}</th><th class="num">{tc('kaUpliftPct')}</th><th class="num">{tc('kaAdded')}</th></tr></thead>
            <tbody>{depts.map((x) => (
              <tr key={x.key}><td><b>{x.dept}</b></td>
                {CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(sumCat(x.base, cats, c))}<div class="small">{fmtNum(sumCat(x.target, cats, c))}</div></td>)}
                <td class="num">{fmtNum(total(x.base))}</td><td class="num tot"><b>{fmtNum(total(x.target))}</b></td>
                <td class="num">{fmtPct(pct(x), 2)}</td><td class="num">{fmtNum(added(x))}</td></tr>
            ))}</tbody>
          </table></div>
        </Section>
      )}
      {lines.length > 0 && (
        <Section title={tc('kaByKamKae')} right={<Tabs<'kae' | 'pack'> value={view} onChange={setView} items={[{ id: 'kae', label: tc('kaViewPeople') }, { id: 'pack', label: tc('byPack') }]} />}>
          {view === 'kae' ? (
            <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="ka-people">
              <thead><tr>
                <th>{tc('name')}</th><th>{tc('level')}</th><th class="num">{tc('kaAvgSales')}</th>
                <th class="num">{tc('kaUpliftPct')}</th><th class="num">{tc('kaAdded')}</th><th class="num">{tc('kaKaTarget')}</th><th><span class="visually-hidden">{tc('kaResetRow')}</span></th>
              </tr></thead>
              <tbody>{lines.map((x) => (
                <tr key={x.key} class={x.level === 'dept' ? 'sub l1' : x.level === 'kam' ? 'sub l2' : ''} data-testid={x.level === 'kae' ? 'ka-kae' : undefined}>
                  <td><span style={{ paddingInlineStart: `${x.level === 'dept' ? 0 : x.level === 'kam' ? 14 : 28}px` }}>
                    <button type="button" class="btn link" onClick={() => { setSel(x.key); setView('pack'); }}>{x.level === 'dept' ? x.dept : x.level === 'kam' ? x.kam : x.kae}</button>
                    {x.route && <span class="muted small"> {x.route}</span>}</span></td>
                  <td class="small">{x.level === 'dept' ? 'MDM' : x.level === 'kam' ? 'KAM' : 'KAE'}</td>
                  <td class="num">{fmtNum(avgTot(x))}</td>
                  <td class="num">
                    <input type="number" step="0.1" class="cy-num" style={{ width: '5.5em' }} aria-label={`${tc('kaUpliftPct')} ${x.level === 'dept' ? x.dept : x.level === 'kam' ? x.kam : x.kae}`}
                      key={`u${x.key}${(pct(x) ?? 0).toFixed(4)}`} defaultValue={x.level === 'kae' && x.route && override[x.route] !== undefined ? String(override[x.route]) : (pct(x) === null ? '' : (pct(x)! * 100).toFixed(2))}
                      onChange={(e) => setUplift(x, e.currentTarget.value)} />
                  </td>
                  <td class="num">{fmtNum(added(x))}</td>
                  <td class="num tot"><NumCell value={total(x.target)} label={`${tc('kaKaTarget')} ${x.level === 'dept' ? x.dept : x.level === 'kam' ? x.kam : x.kae}`} onChange={(n) => setTarget(x, n)} /></td>
                  <td>{kaesOf(x).some((y) => y.route && override[y.route] !== undefined) && (
                    <button type="button" class="btn small" data-testid="ka-reset-row" title={tc('kaResetRowHelp')}
                      aria-label={`${tc('kaResetRow')} ${x.level === 'dept' ? x.dept : x.level === 'kam' ? x.kam : x.kae}`}
                      onClick={() => setUplift(x, '')}>↺ {tc('kaResetRow')}</button>
                  )}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : shown && (
            <>
              <div class="toolbar">
                <label class="small">{tc('show')}{' '}
                  <select value={shown.key} onChange={(e) => setSel(e.currentTarget.value)}>
                    {lines.map((x) => <option key={x.key} value={x.key}>{x.level === 'dept' ? x.dept : x.level === 'kam' ? `  KAM ${x.kam}` : `    KAE ${x.kae} (${x.route})`}</option>)}
                  </select>
                </label>
              </div>
              <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="ka-packs">
                <thead><tr><th>{tc('pack')}</th><th class="num">{tc('kaAvgSales')}</th><th class="num">{tc('kaUpliftPct')}</th><th class="num">{tc('kaAdded')}</th><th class="num">{tc('kaKaTarget')}</th></tr></thead>
                <tbody>{packRows.map((p) => {
                  const b = shown.base[p] ?? 0;
                  const t = shown.target[p] ?? 0;
                  return (
                    <tr key={p}><td><bdi>{p}</bdi></td><td class="num">{fmtNum(Math.round(shown.avg[p] ?? 0))}</td>
                      <td class="num">{fmtPct(b > 0 ? t / b - 1 : null, 2)}</td>
                      <td class="num">{fmtNum(t - b)}</td><td class="num tot"><b>{fmtNum(t)}</b></td></tr>
                  );
                })}</tbody>
                <tfoot><tr class="sub l1"><td>{tc('total')}</td><td class="num">{fmtNum(avgTot(shown))}</td>
                  <td class="num">{fmtPct(pct(shown), 2)}</td><td class="num">{fmtNum(added(shown))}</td><td class="num">{fmtNum(total(shown.target))}</td></tr></tfoot>
              </table></div>
            </>
          )}
          <p class="small muted">{tc('kaPeopleHelp')}</p>
        </Section>
      )}
      {msg && <div class="banner ok" role="status" data-testid="calc-applied">{msg} <a class="btn primary" data-testid="go-ops-send" href={`/admin/cycle/ops/${period}?tab=control`}>{tc('nsKaSendFromOpsGo')}</a>{onNext ? null : null}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      {lines.length > 0 && (
        <div class="actions cy-end">
          <button type="button" class="btn" onClick={exportIt}>{tc('exportCalc')}</button>
          <button type="button" class="btn primary" data-testid="apply-calc" disabled={busy || min > max} onClick={() => void apply()}>{tc('applyN', { n: depts.length })}</button>
        </div>
      )}
    </>
  );
}
