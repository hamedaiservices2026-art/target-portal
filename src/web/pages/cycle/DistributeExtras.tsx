// Extras on the distribution screen (handover section 7): the "By total"
// view per summary group, sales benchmarks per team member (3-month average,
// PAGO, YAGO, any months picked), and the supervisor's salesman corrections.
import { useMemo, useState } from 'preact/hooks';
import { editableGroupOf, EDITABLE_SUMMARY_GROUPS, RebalanceError, rebalanceGroup, summaryGroups, SUMMARY_GROUPS, type Category, type SummaryGroup } from '../../../shared/calc';
import { addMonths } from '../../../shared/calc/periods';
import type { Workspace } from '../../../worker/services/distribution';
import { api } from '../../api';
import { errText } from '../../components/AdminBits';
import type { PackInfo } from '../../components/DistributionTable';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { useAsync } from '../../cycle/load';
import { fmtGap, gapClass, NumCell } from '../../cycle/ui';

function useMaster(ws: Workspace): Map<string, Category> {
  return useMemo(() => new Map(ws.packs.map((p) => [p.code, p.grp as Category])), [ws]);
}

/** "By total": type a new group total for one person; the group's packs are rebalanced. */
export function ByTotal({ ws, codes, info, totals, editable, onApply }: {
  ws: Workspace; codes: string[]; ordered: Map<string, string[]>; info: (p: string) => PackInfo; totals: Record<string, number>;
  editable: boolean; onApply: (next: Record<string, string[]>) => void;
}) {
  useLang();
  const master = useMaster(ws);
  const [err, setErr] = useState<string | null>(null);
  const byGroup = useMemo(() => {
    const m = new Map<SummaryGroup, string[]>(SUMMARY_GROUPS.map((g) => [g, []]));
    for (const p of codes) for (const g of summaryGroups(p, master)) m.get(g)!.push(p);
    return m;
  }, [codes, master]);
  const people = ws.children;
  if (people.length === 0) return null;

  function change(g: SummaryGroup, who: number, n: number) {
    setErr(null);
    const packs = (byGroup.get(g) ?? []).filter((p) => editableGroupOf(p, master) === g);
    const vals = packs.map((p) => info(p).nums.map((x) => (Number.isFinite(x) ? x : 0)));
    try {
      const next = rebalanceGroup(packs.map((p) => totals[p] ?? 0), vals, who, n);
      onApply(Object.fromEntries(packs.map((p, i) => [p, next[i]!.map(String)])));
    } catch (e) {
      setErr(e instanceof RebalanceError ? e.message : errText(e));
    }
  }

  return (
    <details class="card cy-extra" data-testid="by-total">
      <summary><b>{tc('byTotal')}</b> <span class="muted small">{tc('byTotalHelp')}</span></summary>
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('group')}</th><th class="num">{tc('target')}</th>{people.map((c) => <th key={c.key} class="num"><bdi>{c.label}</bdi></th>)}</tr></thead>
        <tbody>{SUMMARY_GROUPS.map((g) => {
          const packs = byGroup.get(g) ?? [];
          if (!packs.length) return null;
          const canEdit = editable && EDITABLE_SUMMARY_GROUPS.includes(g);
          return (
            <tr key={g} class={canEdit ? '' : 'sub l2'}>
              <td>{g}</td>
              <td class="num">{fmtNum(packs.reduce((s, p) => s + (totals[p] ?? 0), 0))}</td>
              {people.map((c, i) => {
                const v = packs.reduce((s, p) => s + (Number.isFinite(info(p).nums[i]!) ? info(p).nums[i]! : 0), 0);
                return <td key={c.key} class="num">{canEdit ? <NumCell value={v} label={`${g} ${c.label}`} onChange={(n) => change(g, i, n)} /> : fmtNum(v)}</td>;
              })}
            </tr>
          );
        })}</tbody>
      </table></div>
    </details>
  );
}

type BenchRow = [string, string, number | null, number | null, number | null];

/** Sales benchmarks per team member for the packs on screen. */
export function Benchmarks({ ws, mid, nid, codes, info }: { ws: Workspace; mid: string; nid: string; codes: string[]; info: (p: string) => PackInfo }) {
  useLang();
  const period = ws.month.period;
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState<string[]>(() => [addMonths(period, -3), addMonths(period, -2), addMonths(period, -1)]);
  const [pack, setPack] = useState<string>('');
  const avail = useAsync(open ? () => api<{ months: string[] }>('GET', `/api/data/${ws.node.workspace}/sales-months`) : null, [open, ws.node.workspace]);
  const data = useAsync(open ? () => api<BenchRow[]>('GET', `/api/months/${mid}/nodes/${nid}/benchmarks?months=${months.join(',')}`) : null, [open, mid, nid, months.join(',')]);
  const have = new Set(avail.data?.months ?? []);
  const year = Number(period.slice(0, 4));
  const pickable = [year - 1, year].flatMap((y) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`));
  const toggle = (m: string) => setMonths((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m].sort()));

  const agg = useMemo(() => {
    const out = new Map<string, { avg: number; pago: number; yago: number }>();
    for (const [child, p, avg, pago, yago] of data.data ?? []) {
      if (pack && p !== pack) continue;
      const e = out.get(child) ?? { avg: 0, pago: 0, yago: 0 };
      e.avg += avg ?? 0;
      e.pago += pago ?? 0;
      e.yago += yago ?? 0;
      out.set(child, e);
    }
    return out;
  }, [data.data, pack]);
  const gap = (a: number, b: number) => (b > 0 ? a / b - 1 : null);

  return (
    <details class="card cy-extra" data-testid="benchmarks" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><b>{tc('benchTitle')}</b> <span class="muted small">{tc('benchHelp')}</span></summary>
      {open && (
        <>
          <div class="cy-months" role="group" aria-label={tc('avgMonthsPick')}>
            {pickable.map((m) => (
              <button type="button" key={m} class={`chip${months.includes(m) ? ' on' : ''}${have.has(m) ? '' : ' off'}`}
                aria-pressed={months.includes(m)} disabled={!have.has(m) && !months.includes(m)} title={have.has(m) ? '' : tc('noSalesData')} onClick={() => toggle(m)}>
                {m}
              </button>
            ))}
          </div>
          <label class="small">{tc('pack')}{' '}
            <select value={pack} onChange={(e) => setPack(e.currentTarget.value)}>
              <option value="">{tc('allPacks')}</option>
              {codes.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {data.error && <div class="alert">{data.error}</div>}
          <div class="tablewrap"><table class="ad-table cy-table">
            <thead><tr><th>{tc('member')}</th><th class="num">{tc('target')}</th><th class="num">{tc('avgSel')}</th><th class="num">{tc('vsAvg')}</th><th class="num">PAGO</th><th class="num">{tc('vsPago')}</th><th class="num">YAGO</th><th class="num">{tc('vsYago')}</th></tr></thead>
            <tbody>{ws.children.map((c, i) => {
              const tgt = (pack ? [pack] : codes).reduce((s, p) => s + (Number.isFinite(info(p).nums[i]!) ? info(p).nums[i]! : 0), 0);
              const b = agg.get(c.key) ?? { avg: 0, pago: 0, yago: 0 };
              const g = [gap(tgt, b.avg), gap(tgt, b.pago), gap(tgt, b.yago)];
              return (
                <tr key={c.key}>
                  <td><bdi>{c.label}</bdi>{c.sub && <div class="muted small">{c.sub}</div>}</td>
                  <td class="num">{fmtNum(tgt)}</td>
                  <td class="num">{fmtNum(Math.round(b.avg))}</td><td class="num"><span class={gapClass(g[0])}>{fmtGap(g[0])}</span></td>
                  <td class="num">{fmtNum(Math.round(b.pago))}</td><td class="num"><span class={gapClass(g[1])}>{fmtGap(g[1])}</span></td>
                  <td class="num">{fmtNum(Math.round(b.yago))}</td><td class="num"><span class={gapClass(g[2])}>{fmtGap(g[2])}</span></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </>
      )}
    </details>
  );
}

/** Supervisor extra: correct the salesman ID on their routes for this month. */
export function SalesmanPanel({ ws, mid, onChanged }: { ws: Workspace; mid: string; onChanged: () => void }) {
  useLang();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function save(key: string) {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      await api('PUT', `/api/months/${mid}/leaves/${key.slice(2)}/salesman`, { salesmanId: edits[key] ?? '' });
      setMsg(tc('salesmanSaved'));
      setEdits((e) => { const n = { ...e }; delete n[key]; return n; });
      onChanged();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(null);
    }
  }
  return (
    <details class="card cy-extra" data-testid="salesmen">
      <summary><b>{tc('salesmenTitle')}</b> <span class="muted small">{tc('salesmenHelp')}</span></summary>
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('route')}</th><th>{tc('salesman')}</th><th /></tr></thead>
        <tbody>{ws.children.map((c) => (
          <tr key={c.key}>
            <td><bdi>{c.label}</bdi></td>
            <td><input value={edits[c.key] ?? c.sub} aria-label={`${tc('salesman')} ${c.label}`} onInput={(e) => setEdits({ ...edits, [c.key]: e.currentTarget.value })} /></td>
            <td>{edits[c.key] !== undefined && edits[c.key] !== c.sub && (
              <button type="button" class="btn" disabled={busy === c.key} onClick={() => void save(c.key)}>{tc('save')}</button>
            )}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </details>
  );
}
