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
import { deptPack, type Grid } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { NumCell } from '../../cycle/ui';
import { BenchCells, BenchHead, sumBench } from './DistributeExtras';

type Bench = { avg: number; pago: number; yago: number };
export type CdHead = { id: string; name: string; chans: string[] };

/** A Head's new cases of one pack spread over its channels (in proportion to the current cases, else evenly). */
function spread(cur: Record<string, Grid>, chans: string[], p: string, v: number): Record<string, number> {
  const old = chans.map((c) => cur[c]?.[p] ?? 0);
  const any = old.some((x) => x > 0);
  const r = largestRemainder(chans.map((c, i) => ({ key: c, value: any ? old[i]! : 1 })), v);
  return Object.fromEntries(chans.map((c) => [c, r[c] ?? 0]));
}

export function CdByCategory({ work, heads, cats, subOf, bench, editable, setWork }: {
  work: CdWork; heads: CdHead[]; cats: Map<string, Category>; subOf: (p: string) => string;
  bench: (p: string, head: CdHead) => Bench; editable: boolean; setWork: (w: CdWork) => void;
}) {
  useLang();
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const packs = Object.keys(work.nt).filter((p) => (work.nt[p] ?? 0) > 0);
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

  const row = (key: string, label: preact.ComponentChild, list: string[], cls: string) => {
    const tgt = list.reduce((s, p) => s + (work.nt[p] ?? 0), 0);
    return (
      <tr key={key} class={cls}>
        <td>{label}</td>
        <td class="num">{fmtNum(tgt)}</td>
        <BenchCells v={tgt} b={sumBench(list.flatMap((p) => heads.map((h) => bench(p, h))))} team />
        {heads.map((h, i) => {
          const v = list.reduce((s, p) => s + val(p, h), 0);
          return [
            <td key={h.id} class="num">
              {editable && heads.length > 1 ? <NumCell value={v} label={`${key} ${h.name}`} onChange={(n) => change(list, i, n)} /> : fmtNum(v)}
            </td>,
            <BenchCells key={`b${h.id}`} v={v} b={sumBench(list.map((p) => bench(p, h)))} />,
          ];
        })}
      </tr>
    );
  };

  return (
    <section class="card cy-extra" data-testid="cd-by-category">
      <div class="cy-section-head">
        <h2><span class="n">1</span> {tc('distByCategory')}</h2>
        <span class="muted small">{tc('cdByCategoryHelp')}</span>
      </div>
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr><th>{tc('category')}</th><th class="num">{tc('target')}</th><BenchHead team />{heads.map((h) => [<th key={h.id} class="num"><bdi>{h.name}</bdi></th>, <BenchHead key={`b${h.id}`} />])}</tr></thead>
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
            row(c, label, list, 'sub l1'),
            ...(isOpen ? subs.map((s) => row(`${c}/${s}`, <span style={{ paddingInlineStart: '18px' }}>{s}</span>, list.filter((p) => subOf(p) === s), '')) : []),
          ];
        })}</tbody>
      </table></div>
    </section>
  );
}
