// Reports › CD dashboard: the New Target against the average sales of the
// months ticked, and against the AOP, as percentages, by department
// (channel), Head, manager, supervisor and route. The target is the route
// target the Admin calculated; before that, the CD's split by department.
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES, type Category } from '../../../shared/calc/packs';
import { addMonths } from '../../../shared/calc/periods';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto } from '../../../worker/services/cycle';
import type { OrgDto } from '../../../worker/services/cycleData';
import { api } from '../../api';
import { downloadCsv, MonthPicker, Section, Tabs } from '../../cycle/ui';
import { fmtNum, useLang } from '../../i18n';
import { catMap, NO_CHANNEL, routeIndex, type Grid } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { loadMonthData, loadRouteData, useAsync } from '../../cycle/load';

type Lvl = 'dep' | 'head' | 'manager' | 'supervisor' | 'route';
type Row = { key: string; name: string; under: string; target: number; sales: number | null; aop: number | null };
const pct = (a: number, b: number | null) => (b && b > 0 ? a / b - 1 : null);
const fmtPct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

/** One diverging bar: right of the centre line when the target is above, left when below. */
function Bar({ v, max, cls, label }: { v: number | null; max: number; cls: string; label: string }) {
  if (v === null) return <span class="cdd-na">—</span>;
  const w = Math.min(Math.abs(v) / max, 1) * 50;
  return (
    <span class="cdd-bar" title={`${label}: ${fmtPct(v)}`}>
      <span class="cdd-track"><span class={`cdd-fill ${cls}${v < 0 ? ' neg' : ''}`} style={{ width: `${w}%`, [v < 0 ? 'right' : 'left']: '50%' }} /></span>
      <b class="cdd-val">{fmtPct(v)}</b>
    </span>
  );
}

export function CdDashboard({ ws, cycle, org }: { ws: Workspace; cycle: CycleDto; org: OrgDto }) {
  useLang();
  const period = cycle.period;
  const [lvl, setLvl] = useState<Lvl>('head');
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [under, setUnder] = useState('');
  const [months, setMonths] = useState<string[]>(() => [addMonths(period, -3), addMonths(period, -2), addMonths(period, -1)]);
  const avail = useAsync(() => api<{ months: string[] }>('GET', `/api/data/${ws}/sales-months`), [ws]);
  const calc = useAsync(() => api<Record<string, Record<string, Grid>>>('GET', `/api/cycle/${ws}/${period}/calc`), [ws, period]);
  const sales = useAsync(months.length ? () => loadRouteData(ws, 'sales', months).then((r) => r.data) : null, [ws, months.join(',')]);
  const aopDept = useAsync(() => loadMonthData<Record<string, Grid> | { byChannel: Record<string, Grid> }>(ws, 'aop_dept'), [ws]);
  const aopPack = useAsync(() => loadMonthData<Record<string, { cases: number }>>(ws, 'aop'), [ws]);

  const cats = catMap(org);
  const inCat = (p: string) => cat === 'all' || (cats.get(p) ?? 'LRB-Others') === cat;
  const sum = (g: Grid | undefined) => Object.entries(g ?? {}).reduce((s, [p, n]) => s + (inCat(p) ? n : 0), 0);

  const data = useMemo(() => {
    const idx = routeIndex(org);
    const byId = new Map(org.nodes.map((n) => [n.id, n]));
    const deptName = new Map(org.depts.map((d) => [d.id, d.name]));
    const depth = (id: number) => { let d = 0; for (let p = byId.get(id)?.parentId ?? null; p !== null; p = byId.get(p)?.parentId ?? null) d++; return d; };
    const path = (id: number) => { const out: string[] = []; for (let n = byId.get(id); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) out.unshift(n.name); return out; };
    // Target per route (the calculation), else per department & channel (the CD split).
    const routeT = new Map<string, number>();
    for (const routes of Object.values(calc.data ?? {})) for (const [r, g] of Object.entries(routes)) routeT.set(r, (routeT.get(r) ?? 0) + sum(g));
    const hasRoutes = routeT.size > 0;
    // Average sales of the months ticked, per route.
    const ms = months.filter((m) => sales.data?.[m]);
    const routeS = new Map<string, number>();
    for (const m of ms) for (const [r, g] of Object.entries(sales.data?.[m] ?? {})) routeS.set(r, (routeS.get(r) ?? 0) + sum(g) / ms.length);
    const noSales = ms.length === 0;
    // AOP: by channel (AOP by pack and department), else the company total by pack.
    const ad = aopDept.data?.[period];
    const aopCh: Record<string, Grid> | null = ad ? ('byChannel' in ad ? (ad as { byChannel: Record<string, Grid> }).byChannel : (ad as Record<string, Grid>)) : null;
    const aopTotal = aopCh ? Object.values(aopCh).reduce((s, g) => s + sum(g), 0)
      : aopPack.data?.[period] ? Object.entries(aopPack.data[period]!).reduce((s, [p, v]) => s + (inCat(p) ? v.cases : 0), 0) : null;

    const add = (m: Map<string, Row>, key: string, name: string, underTxt: string, t: number, s: number) => {
      const r = m.get(key) ?? { key, name, under: underTxt, target: 0, sales: noSales ? null : 0, aop: null };
      r.target += t;
      if (r.sales !== null) r.sales += s;
      m.set(key, r);
    };
    const out: Record<Lvl, Row[]> = { dep: [], head: [], manager: [], supervisor: [], route: [] };
    const dep = new Map<string, Row>(), head = new Map<string, Row>(), mgr = new Map<string, Row>(), sup = new Map<string, Row>(), rt = new Map<string, Row>();
    for (const leaf of org.leaves) {
      const t = routeT.get(leaf.routeCode) ?? 0;
      const s = routeS.get(leaf.routeCode) ?? 0;
      if (!t && !s) continue;
      const ch = idx.get(leaf.routeCode)?.channel ?? NO_CHANNEL;
      const dn = deptName.get(leaf.deptId) ?? '';
      const chName = ch === NO_CHANNEL ? dn : ch;
      if (hasRoutes) {
        add(dep, `${leaf.deptId}|${ch}`, chName, dn, t, s);
        add(head, String(leaf.deptId), dn, '', t, s);
      } else {
        add(dep, `${leaf.deptId}|${ch}`, chName, dn, 0, s);
        add(head, String(leaf.deptId), dn, '', 0, s);
      }
      if (!hasRoutes) continue;
      const p = path(leaf.nodeId);
      for (let n = byId.get(leaf.nodeId); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) {
        const d = depth(n.id);
        const under2 = path(n.id).slice(0, -1).join(' › ');
        if (d === 1) add(mgr, String(n.id), n.name, under2, t, s);
        if (d >= 2) add(sup, String(n.id), n.name, under2, t, s);
      }
      add(rt, leaf.routeCode, leaf.label && leaf.label !== leaf.routeCode ? `${leaf.routeCode} · ${leaf.label}` : leaf.routeCode, p.join(' › '), t, s);
    }
    // Before the route calculation: the CD's split by department and channel.
    if (!hasRoutes && cycle.cd) {
      for (const [d, chans] of Object.entries(cycle.cd.dm)) for (const [c, g] of Object.entries(chans)) {
        const dn = deptName.get(Number(d)) ?? d;
        add(dep, `${d}|${c}`, c === NO_CHANNEL ? dn : c, dn, sum(g), 0);
        add(head, d, dn, '', sum(g), 0);
      }
    }
    if (aopCh) {
      for (const r of dep.values()) { const c = r.key.split('|')[1]!; r.aop = sum(aopCh[c]); }
      for (const r of head.values()) {
        const d = org.depts.find((x) => String(x.id) === r.key);
        r.aop = d ? d.channels.reduce((s, c) => s + sum(aopCh[c.channel]), 0) : null;
      }
    }
    out.dep = [...dep.values()]; out.head = [...head.values()]; out.manager = [...mgr.values()]; out.supervisor = [...sup.values()]; out.route = [...rt.values()];
    for (const k of Object.keys(out) as Lvl[]) out[k].sort((a, b) => a.under.localeCompare(b.under) || a.name.localeCompare(b.name));
    const total: Row = { key: 'total', name: tc('total'), under: '', target: out.head.reduce((s, r) => s + r.target, 0), sales: noSales ? null : out.head.reduce((s, r) => s + (r.sales ?? 0), 0), aop: aopTotal };
    return { out, total, hasRoutes };
  }, [org, cycle, calc.data, sales.data, aopDept.data, aopPack.data, cat, months.join(',')]);

  const loading = calc.loading || (months.length > 0 && sales.loading);
  const all = data.out[lvl];
  const unders = [...new Set(all.map((r) => r.under.split(' › ')[0] ?? '').filter(Boolean))];
  const list = under ? all.filter((r) => r.under === under || r.under.startsWith(`${under} › `)) : all;
  const vals = list.flatMap((r) => [pct(r.target, r.sales), pct(r.target, r.aop)]).filter((v): v is number => v !== null);
  const max = Math.max(0.1, ...vals.map(Math.abs));
  const t = data.total;
  const labels: Record<Lvl, string> = { dep: tc('lvDep'), head: tc('lvHead'), manager: ws === 'ka' ? 'KAM' : tc('lvManager'), supervisor: tc('lvSupervisor'), route: tc('route') };
  const levels: Lvl[] = ws === 'ka' ? ['head', 'manager', 'route'] : ['dep', 'head', 'manager', 'supervisor', 'route'];

  return (
    <Section title={tc('cddTitle')} right={
      <button type="button" class="btn" onClick={() => downloadCsv(`cd_dashboard_${lvl}_${ws}_${period}.csv`, [labels[lvl], tc('fsUnder'), tc('newTarget'), tc('cddVsSales'), tc('cddVsAop'), tc('cddAopVsSales')],
        list.map((r) => [r.name, r.under, r.target, fmtPct(pct(r.target, r.sales)), fmtPct(pct(r.target, r.aop)), fmtPct(r.aop === null ? null : pct(r.aop, r.sales))]))}>{tc('downloadCsv')}</button>
    }>
      <p class="small muted">{tc('cddHelp')}</p>
      <MonthPicker period={period} months={months} onChange={setMonths} available={avail.data ? new Set(avail.data.months) : null} title={tc('cddMonths')} />
      {!months.length && <p class="small muted">{tc('pickMonths')}</p>}
      <div class="cdd-kpis" data-testid="cdd-kpis">
        <div class="cdd-kpi"><span>{tc('newTarget')}</span><b>{fmtNum(Math.round(t.target))}</b></div>
        <div class="cdd-kpi"><span>{tc('cddVsSales')}</span><b>{fmtPct(pct(t.target, t.sales))}</b></div>
        <div class="cdd-kpi"><span>{tc('cddVsAop')}</span><b>{fmtPct(pct(t.target, t.aop))}</b></div>
        <div class="cdd-kpi"><span>{tc('cddAopVsSales')}</span><b>{fmtPct(t.aop === null ? null : pct(t.aop, t.sales))}</b></div>
      </div>
      <div class="toolbar cdd-filters">
        <Tabs<Lvl> value={lvl} onChange={(v) => { setLvl(v); setUnder(''); }} items={levels.map((x) => ({ id: x, label: labels[x] }))} />
        <label class="small">{tc('category')}{' '}
          <select value={cat} onChange={(e) => setCat(e.currentTarget.value as Category | 'all')}>
            <option value="all">{tc('allWord')}</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {unders.length > 1 && (
          <label class="small">{tc('fsUnder')}{' '}
            <select value={under} onChange={(e) => setUnder(e.currentTarget.value)}>
              <option value="">{tc('allWord')}</option>
              {unders.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
        )}
        <span class="cdd-legend"><i class="sw sales" />{tc('cddVsSales')}<i class="sw aop" />{tc('cddVsAop')}</span>
      </div>
      {loading && <p class="muted">{tc('loading')}</p>}
      {!data.hasRoutes && (lvl === 'manager' || lvl === 'supervisor' || lvl === 'route') && <p class="banner warn small">{tc('cddNoRoutes')}</p>}
      {(lvl === 'manager' || lvl === 'supervisor' || lvl === 'route') && <p class="small muted">{tc('cddNoAopBelow')}</p>}
      <div class="tablewrap cy-tall"><table class="ad-table cy-table cdd-table" data-testid="cd-dashboard">
        <thead><tr>
          <th>{labels[lvl]}</th>{lvl !== 'head' && <th>{tc('fsUnder')}</th>}<th class="num">{tc('newTarget')}</th>
          <th class="cdd-col">{tc('cddVsSales')}</th><th class="cdd-col">{tc('cddVsAop')}</th><th class="num">{tc('cddAopVsSales')}</th>
        </tr></thead>
        <tbody>{list.map((r) => (
          <tr key={r.key}>
            <td><bdi>{r.name}</bdi></td>{lvl !== 'head' && <td class="small muted">{r.under}</td>}
            <td class="num">{fmtNum(Math.round(r.target))}</td>
            <td><Bar v={pct(r.target, r.sales)} max={max} cls="sales" label={tc('cddVsSales')} /></td>
            <td><Bar v={pct(r.target, r.aop)} max={max} cls="aop" label={tc('cddVsAop')} /></td>
            <td class="num small">{fmtPct(r.aop === null ? null : pct(r.aop, r.sales))}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </Section>
  );
}
