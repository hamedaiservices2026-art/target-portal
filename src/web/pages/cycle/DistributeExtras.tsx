// Extras on the distribution screen (new target process): step 1 "By
// category" (categories open to their sub categories), the "Show average
// sales, YAGO and PAGO" benchmarks per team member, and the supervisor's
// salesman corrections.
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES, RebalanceError, rebalanceGroup, type Category } from '../../../shared/calc';
import { subCategoryByName, subsOf } from '../../../shared/calc/packs';
import { addMonths } from '../../../shared/calc/periods';
import type { Workspace } from '../../../worker/services/distribution';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import type { PackInfo } from '../../components/DistributionTable';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { useAsync } from '../../cycle/load';
import { fmtGap, gapClass, MonthPicker, NumCell } from '../../cycle/ui';

type PackMeta = Record<string, { grp: string; sub: string | null }>;
type Bench = { avg: number; pago: number; yago: number };
type BenchRow = [string, string, number | null, number | null, number | null];
/** A member's sales benchmark for a pack (or undefined when the benchmarks are off). */
export type BenchFn = (pack: string, i: number) => Bench | undefined;

const ZERO: Bench = { avg: 0, pago: 0, yago: 0 };
const fin = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? x : 0);

/** Category of each pack and its sub category (SSNR / MSPET / PMIX / Water / LIT / LRB_Other). */
function usePackMeta(ws: Workspace) {
  const meta = useAsync(() => api<PackMeta>('GET', '/api/data/packs-sub'), []);
  return useMemo(() => {
    const cat = new Map<string, Category>(ws.packs.map((p) => [p.code, p.grp as Category]));
    const sub = (p: string) => meta.data?.[p]?.sub || subCategoryByName(p, cat.get(p) ?? 'LRB-Others');
    return { cat, sub };
  }, [ws, meta.data]);
}

/**
 * The sales benchmarks behind "Show average sales, YAGO and PAGO": the months
 * picked (default: the 3 months before the period), loaded only while on.
 */
export function useBench(ws: Workspace | null, mid: string, nid: string) {
  const period = ws?.month.period ?? '';
  const [on, setOn] = useState(true);
  const [picked, setMonths] = useState<string[] | null>(null);
  const months = picked ?? (period ? [addMonths(period, -3), addMonths(period, -2), addMonths(period, -1)] : []);
  const wsName = ws?.node.workspace ?? '';
  const avail = useAsync(on && wsName ? () => api<{ months: string[] }>('GET', `/api/data/${wsName}/sales-months`) : null, [on, wsName]);
  const data = useAsync(on && months.length ? () => api<BenchRow[]>('GET', `/api/months/${mid}/nodes/${nid}/benchmarks?months=${months.join(',')}`) : null, [on, mid, nid, months.join(',')]);
  const fn = useMemo<BenchFn | undefined>(() => {
    if (!on || !data.data || !ws) return undefined;
    const idx = new Map<string, number>(ws.children.map((c, i) => [c.key, i]));
    const m = new Map<string, Bench>();
    for (const [child, p, avg, pago, yago] of data.data) {
      const i = idx.get(child);
      if (i !== undefined) m.set(`${p}|${i}`, { avg: avg ?? 0, pago: pago ?? 0, yago: yago ?? 0 });
    }
    return (p, i) => m.get(`${p}|${i}`) ?? ZERO;
  }, [on, data.data, ws]);
  return { on, setOn, months, setMonths, available: avail.data ? new Set(avail.data.months) : null, error: data.error, fn };
}

export type BenchState = ReturnType<typeof useBench>;

/** The checkbox and the month picker. */
export function BenchControls({ ws, b }: { ws: Workspace; b: BenchState }) {
  useLang();
  return (
    <div class="cy-bench-controls" data-testid="benchmarks">
      <label class="small">
        <input type="checkbox" checked={b.on} onChange={(e) => b.setOn(e.currentTarget.checked)} />{' '}{tc('showBench')}
      </label>
      {b.on && <MonthPicker period={ws.month.period} months={b.months} onChange={b.setMonths} available={b.available} title={tc('benchTitle')} />}
      {b.on && !b.months.length && <p class="small muted">{tc('pickMonths')}</p>}
      {b.error && <div class="alert">{b.error}</div>}
    </div>
  );
}

export function sumBench(list: (Bench | undefined)[]): Bench {
  const t = { avg: 0, pago: 0, yago: 0 };
  for (const b of list) if (b) { t.avg += b.avg; t.pago += b.pago; t.yago += b.yago; }
  return t;
}

/** The three benchmark column headers (after the target, and after each team member). */
export function BenchHead({ team }: { team?: boolean }) {
  useLang();
  return (
    <>
      <th scope="col" class={`bench${team ? '' : ' pb'}`}>{tc('avgSales')}</th>
      <th scope="col" class={`bench${team ? '' : ' pb'}`}>PAGO</th>
      <th scope="col" class={`bench${team ? '' : ' pb'}`}>YAGO</th>
    </>
  );
}

/** Avg sales, PAGO and YAGO as three cells, each with the gap of the number against it. */
export function BenchCells({ v, b, team }: { v: number; b: Bench; team?: boolean }) {
  const cell = (x: number, k: string) => {
    const g = x > 0 ? v / x - 1 : null;
    return (
      <td key={k} class={`num bench${team ? '' : ' pb'}`}>
        {fmtNum(Math.round(x))}
        {x > 0 && <span class={`gsub ${gapClass(g)}`}>{fmtGap(g)}</span>}
      </td>
    );
  };
  return <>{cell(b.avg, 'a')}{cell(b.pago, 'p')}{cell(b.yago, 'y')}</>;
}

/** "Avg · PAGO · YAGO" under a number, each with the gap of the target against it. */
export function BenchLine({ v, b }: { v: number; b: Bench }) {
  const gap = (x: number) => (x > 0 ? v / x - 1 : null);
  const part = (label: string, x: number) => {
    const g = gap(x);
    return <span title={`${label} ${fmtNum(Math.round(x))}`}>{label} {fmtNum(Math.round(x))} <span class={gapClass(g)}>{fmtGap(g)}</span></span>;
  };
  return <span class="cy-bench">{part(tc('avgSel'), b.avg)}{part('PAGO', b.pago)}{part('YAGO', b.yago)}</span>;
}

/**
 * Step 1 of the distribution: by category. Each category opens to its sub
 * categories; type a new total for one person and the packs of that row are
 * rebalanced across the team (the pack totals stay locked).
 */
export function ByCategory({ ws, codes, info, totals, editable, onApply, bench }: {
  ws: Workspace; codes: string[]; info: (p: string) => PackInfo; totals: Record<string, number>;
  editable: boolean; onApply: (next: Record<string, string[]>) => void; bench?: BenchFn;
}) {
  useLang();
  const { cat, sub } = usePackMeta(ws);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const people = ws.children;
  if (people.length === 0) return null;
  const inCat = (c: Category) => codes.filter((p) => (cat.get(p) ?? 'LRB-Others') === c && (totals[p] ?? 0) > 0);

  function change(packs: string[], who: number, n: number) {
    setErr(null);
    const vals = packs.map((p) => info(p).nums.map(fin));
    try {
      const next = rebalanceGroup(packs.map((p) => totals[p] ?? 0), vals, who, n);
      onApply(Object.fromEntries(packs.map((p, i) => [p, next[i]!.map(String)])));
    } catch (e) {
      setErr(e instanceof RebalanceError ? e.message : errText(e));
    }
  }

  const row = (key: string, label: preact.ComponentChild, packs: string[], cls: string) => {
    const canEdit = editable && people.length > 1;
    const tgt = packs.reduce((s, p) => s + (totals[p] ?? 0), 0);
    return (
      <tr key={key} class={cls}>
        <td>{label}</td>
        <td class="num">{fmtNum(tgt)}</td>
        {bench && <BenchCells v={tgt} b={sumBench(packs.flatMap((p) => people.map((_c, i) => bench(p, i))))} team />}
        {people.map((c, i) => {
          const v = packs.reduce((s, p) => s + fin(info(p).nums[i]), 0);
          return [
            <td key={c.key} class="num">
              {canEdit ? <NumCell value={v} label={`${key} ${c.label}`} onChange={(n) => change(packs, i, n)} /> : fmtNum(v)}
            </td>,
            bench ? <BenchCells key={`b${c.key}`} v={v} b={sumBench(packs.map((p) => bench(p, i)))} /> : null,
          ];
        })}
      </tr>
    );
  };

  return (
    <section class="card cy-extra" data-testid="by-category">
      <div class="cy-section-head">
        <h2><span class="n">1</span> {tc('distByCategory')}</h2>
        <span class="muted small">{tc('distByCategoryHelp')}</span>
      </div>
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('category')}</th><th class="num">{tc('target')}</th>{bench && <BenchHead team />}{people.map((c) => [<th key={c.key} class="num"><bdi>{c.label}</bdi>{c.sub && <div class="muted small">{c.sub}</div>}</th>, bench ? <BenchHead key={`b${c.key}`} /> : null])}</tr></thead>
        <tbody>{CATEGORIES.flatMap((c) => {
          const packs = inCat(c);
          if (!packs.length) return [];
          const subs = subsOf(c, packs, sub);
          const expandable = subs.length > 1 || (subs.length === 1 && subs[0] !== c);
          const isOpen = open.has(c);
          const label = expandable
            ? <button type="button" class="btn link" aria-expanded={isOpen} onClick={() => { const n = new Set(open); if (isOpen) n.delete(c); else n.add(c); setOpen(n); }}>{isOpen ? '▾' : '▸'} {c}</button>
            : c;
          return [
            row(c, label, packs, 'sub l1'),
            ...(isOpen ? subs.map((s) => row(`${c}/${s}`, <span style={{ paddingInlineStart: '18px' }}>{s}</span>, packs.filter((p) => sub(p) === s), '')) : []),
          ];
        })}</tbody>
      </table></div>
    </section>
  );
}

/** Supervisor: assign the salesman ID of each route under them for this month (goes into the final target export). */
export function SalesmanPanel({ ws, mid, onChanged }: { ws: Workspace; mid: string; onChanged: () => void }) {
  useLang();
  const routes = ws.children.filter((c) => c.key.startsWith('l:'));
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!routes.length) return null;
  const changed = routes.filter((c) => edits[c.key] !== undefined && edits[c.key]!.trim() !== (c.sub ?? ''));
  const missing = routes.filter((c) => !(edits[c.key] ?? c.sub ?? '').trim()).length;
  async function saveAll() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      for (const c of changed) await api('PUT', `/api/months/${mid}/leaves/${c.key.slice(2)}/salesman`, { salesmanId: edits[c.key] ?? '' });
      setMsg(tc('salesmanSaved'));
      setEdits({});
      onChanged();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="card cy-extra" data-testid="salesmen">
      <div class="cy-section-head">
        <h2>{tc('salesmenTitle')}</h2>
        <span class="muted small">{tc('salesmenHelp')}</span>
      </div>
      {missing > 0 && <p class="banner warn small">{tc('salesmenMissing', { n: missing })}</p>}
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('route')}</th><th>{tc('salesman')}</th></tr></thead>
        <tbody>{routes.map((c) => (
          <tr key={c.key}>
            <td><bdi>{c.label}</bdi></td>
            <td><input value={edits[c.key] ?? c.sub ?? ''} placeholder={tc('salesmanPh')} aria-label={`${tc('salesman')} ${c.label}`} onInput={(e) => setEdits({ ...edits, [c.key]: e.currentTarget.value })} /></td>
          </tr>
        ))}</tbody>
      </table></div>
      <div class="actions">
        <button type="button" class="btn primary" data-testid="salesmen-save" disabled={busy || !changed.length} onClick={() => void saveAll()}>{tc('salesmenSave', { n: changed.length })}</button>
      </div>
    </section>
  );
}
