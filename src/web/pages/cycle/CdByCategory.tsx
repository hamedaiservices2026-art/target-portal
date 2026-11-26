// The CD's "Distribute by category" (as on the Head of Department screen):
// categories open to their sub categories, one column per Head with Avg
// sales, PAGO and YAGO. Typing a Head's total for a row rebalances that row's
// packs across the Heads (each pack keeps its New Target); inside a Head the
// change is spread over its channels in proportion to their current cases.
import { useState } from 'preact/hooks';
import { CATEGORIES, RebalanceError, rebalanceGroup, type Category } from '../../../shared/calc';
import { subsOf } from '../../../shared/calc/packs';
import { largestRemainder } from '../../../shared/rounding';
import type { CdWork } from '../../../shared/calc/cd';
import { errText } from '../../components/AdminBits';
import { fmtNum, useLang } from '../../i18n';
import { deptPack, rescalePack, type Grid } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { NumCell } from '../../cycle/ui';
import { BenchCells, BenchHead, sumBench } from './DistributeExtras';

type Bench = { avg: number; pago: number; yago: number };
export type CdHead = { id: string; name: string; chans: string[] };
type Snap = { nt: Grid; dm: CdWork['dm'] };

/** A Head's new cases of one pack spread over its channels (in proportion to the current cases, else evenly). */
function spread(cur: Record<string, Grid>, chans: string[], p: string, v: number): Record<string, number> {
  const old = chans.map((c) => cur[c]?.[p] ?? 0);
  const any = old.some((x) => x > 0);
  const r = largestRemainder(chans.map((c, i) => ({ key: c, value: any ? old[i]! : 1 })), v);
  return Object.fromEntries(chans.map((c) => [c, r[c] ?? 0]));
}

export function CdByCategory({ work, heads, cats, subOf, bench, editable, setWork, baseKey }: {
  baseKey: string; work: CdWork; heads: CdHead[]; cats: Map<string, Category>; subOf: (p: string) => string;
  bench: (p: string, head: CdHead) => Bench; editable: boolean; setWork: (w: CdWork) => void;
}) {
  useLang();
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [upPct, setUpPct] = useState('');
  const [upScope, setUpScope] = useState<'all' | Category>('all');
  const [showB, setShowB] = useState(() => { try { return localStorage.getItem('cd-cat-bench') !== '0'; } catch { return true; } });
  const toggleB = (on: boolean) => { setShowB(on); try { localStorage.setItem('cd-cat-bench', on ? '1' : '0'); } catch { /* ignore */ } };
  // The starting point for Reset: the target and split as first opened (kept for this month while this browser tab is open).
  const [base] = useState<Snap>(() => {
    const k = `cd-cat-base-${baseKey}`;
    try { const v = sessionStorage.getItem(k); if (v) return JSON.parse(v) as Snap; } catch { /* ignore */ }
    const snap = { nt: { ...work.nt }, dm: structuredClone(work.dm) };
    try { sessionStorage.setItem(k, JSON.stringify(snap)); } catch { /* ignore */ }
    return snap;
  });
  // Before the first uplift (since the last Reset uplift): what Reset uplift goes back to.
  const [preUp, setPreUp] = useState<{ snap: Snap; packs: string[] } | null>(null);
  const packs = Object.keys(work.nt).filter((p) => (work.nt[p] ?? 0) > 0 || (base.nt[p] ?? 0) > 0);
  const inCat = (c: Category) => packs.filter((p) => (cats.get(p) ?? 'LRB-Others') === c);
  const val = (p: string, h: CdHead) => deptPack(work.dm, h.id, p);

  function change(list: string[], who: number, n: number) {
    setErr(null);
    try {
      const next = rebalanceGroup(list.map((p) => work.nt[p] ?? 0), list.map((p) => heads.map((h) => val(p, h))), who, n);
      const dm = structuredClone(work.dm);
      list.forEach((p, i) => heads.forEach((h, j) => {
        if (next[i]![j] === val(p, h)) return;
        const s = spread(dm[h.id] ?? {}, h.chans, p, next[i]![j]!);
        for (const [c, x] of Object.entries(s)) ((dm[h.id] ??= {})[c] ??= {})[p] = x;
      }));
      setWork({ ...work, dm });
    } catch (e) {
      setErr(e instanceof RebalanceError ? e.message : errText(e));
    }
  }

  /** A new total for a group of packs: spread over its packs (by their target), each pack keeps its split by Head and channel. */
  function setTotal(list: string[], n: number) {
    setErr(null);
    const cur = list.map((p) => work.nt[p] ?? 0);
    const any = cur.some((x) => x > 0);
    const per = largestRemainder(list.map((p, i) => ({ key: p, value: any ? cur[i]! : 1 })), Math.max(0, Math.round(n)));
    const dm = structuredClone(work.dm);
    const nt = { ...work.nt };
    for (const p of list) {
      const v = per[p] ?? 0;
      if (v === (work.nt[p] ?? 0)) continue;
      // A pack with no split yet goes to the Heads evenly (first channel of each).
      if (!heads.some((h) => val(p, h) > 0)) heads.forEach((h) => { const c = h.chans[0]; if (c) ((dm[h.id] ??= {})[c] ??= {})[p] = 1; });
      rescalePack(dm, p, v);
      nt[p] = v;
    }
    setWork({ ...work, nt, splitNt: { ...nt }, dm });
  }
  function uplift() {
    const pct = Number(upPct.replace(',', '.'));
    if (!Number.isFinite(pct) || pct === 0) return;
    const list = upScope === 'all' ? packs : inCat(upScope);
    const tgt = list.reduce((s, p) => s + (work.nt[p] ?? 0), 0);
    setPreUp(preUp ? { snap: preUp.snap, packs: [...new Set([...preUp.packs, ...list])] } : { snap: { nt: { ...work.nt }, dm: structuredClone(work.dm) }, packs: list });
    setTotal(list, tgt * (1 + pct / 100));
    setUpPct('');
  }
  /** The packs given back to their target and split in the snapshot. */
  function restore(list: string[], snap: Snap) {
    setErr(null);
    const dm = structuredClone(work.dm);
    const nt = { ...work.nt };
    for (const p of list) {
      for (const ch of Object.values(dm)) for (const g of Object.values(ch)) delete g[p];
      for (const [d, ch] of Object.entries(snap.dm)) for (const [c, g] of Object.entries(ch)) if (p in g) ((dm[d] ??= {})[c] ??= {})[p] = g[p]!;
      nt[p] = snap.nt[p] ?? 0;
    }
    setWork({ ...work, nt, splitNt: { ...nt }, dm });
  }
  function resetUplift() {
    if (!preUp) return;
    restore(preUp.packs, preUp.snap);
    setPreUp(null);
  }
  const changed = (list: string[]) => list.some((p) => (work.nt[p] ?? 0) !== (base.nt[p] ?? 0) || heads.some((h) => val(p, h) !== deptPack(base.dm, h.id, p)));

  const row = (key: string, label: preact.ComponentChild, list: string[], cls: string, reset = false) => {
    const tgt = list.reduce((s, p) => s + (work.nt[p] ?? 0), 0);
    return (
      <tr key={key} class={cls}>
        <td>{label}</td>
        <td class="num">{editable ? <NumCell value={tgt} label={`${key} ${tc('target')}`} onChange={(n) => setTotal(list, n)} /> : fmtNum(tgt)}</td>
        {showB && <BenchCells v={tgt} b={sumBench(list.flatMap((p) => heads.map((h) => bench(p, h))))} team />}
        {heads.map((h, i) => {
          const v = list.reduce((s, p) => s + val(p, h), 0);
          return [
            <td key={h.id} class="num">
              {editable && heads.length > 1 ? <NumCell value={v} label={`${key} ${h.name}`} onChange={(n) => change(list, i, n)} /> : fmtNum(v)}
            </td>,
            showB ? <BenchCells key={`b${h.id}`} v={v} b={sumBench(list.map((p) => bench(p, h)))} /> : null,
          ];
        })}
        {editable && <td>{reset && <button type="button" class="btn link" data-testid={`cat-reset-${key}`} title={tc('catResetHelp')} disabled={!changed(list)} onClick={() => restore(list, base)}>{tc('catReset')}</button>}</td>}
      </tr>
    );
  };

  return (
    <section class="card cy-extra" data-testid="cd-by-category">
      <div class="cy-section-head">
        <h2><span class="n">1</span> {tc('distByCategory')}</h2>
        <span class="muted small">{tc('cdByCategoryHelp')}</span>
      </div>
      {editable && (
        <div class="toolbar cy-uplift" data-testid="cd-uplift">
          <b class="small">{tc('upliftTitle')}</b>
          <select value={upScope} aria-label={tc('upliftScope')} onChange={(e) => setUpScope(e.currentTarget.value as 'all' | Category)}>
            <option value="all">{tc('upliftAll')}</option>
            {CATEGORIES.filter((c) => inCat(c).length).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="text" inputMode="decimal" style={{ width: '6em' }} value={upPct} placeholder="+5 / -3" aria-label={tc('upliftPct')} data-testid="uplift-pct" onInput={(e) => setUpPct(e.currentTarget.value)} />
          <span class="small">%</span>
          <button type="button" class="btn primary" data-testid="uplift-apply" disabled={!upPct.trim() || !Number.isFinite(Number(upPct.replace(',', '.')))} onClick={uplift}>{tc('upliftApply')}</button>
          <button type="button" class="btn" data-testid="uplift-reset" disabled={!preUp} title={tc('upliftResetHelp')} onClick={resetUplift}>{tc('upliftReset')}</button>
          <span class="muted small">{tc('upliftHelp')}</span>
        </div>
      )}
      <label class="small cy-bench-toggle">
        <input type="checkbox" data-testid="cd-cat-bench" checked={showB} onChange={(e) => toggleB(e.currentTarget.checked)} />{' '}{tc('showBench')}
      </label>
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('category')}</th><th class="num">{tc('target')}</th>{showB && <BenchHead team />}{heads.map((h) => [<th key={h.id} class="num"><bdi>{h.name}</bdi></th>, showB ? <BenchHead key={`b${h.id}`} /> : null])}{editable && <th><span class="visually-hidden">{tc('catReset')}</span></th>}</tr></thead>
        <tbody>{CATEGORIES.flatMap((c) => {
          const list = inCat(c);
          if (!list.length) return [];
          const subs = subsOf(c, list, subOf);
          const expandable = subs.length > 1 || (subs.length === 1 && subs[0] !== c);
          const isOpen = open.has(c);
          const label = expandable
            ? <button type="button" class="btn link" aria-expanded={isOpen} onClick={() => { const n = new Set(open); if (isOpen) n.delete(c); else n.add(c); setOpen(n); }}>{isOpen ? '▾' : '▸'} {c}</button>
            : c;
          return [
            row(c, label, list, 'sub l1', true),
            ...(isOpen ? subs.map((s) => row(`${c}/${s}`, <span style={{ paddingInlineStart: '18px' }}>{s}</span>, list.filter((p) => subOf(p) === s), '')) : []),
          ];
        })}
        {packs.length > 0 && row('all', <b>{tc('total')}</b>, packs, 'sub l1 cd-cat-total', true)}</tbody>
      </table></div>
    </section>
  );
}
