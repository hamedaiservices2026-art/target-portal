// Head of Department approval (new target process): the recommended target
// Admin sent, as a summary by manager (open a manager to see the supervisors)
// and by pack; approve (the distribution to managers opens) or return with a
// comment.
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES, subCategoryByName, subsOf, type Category } from '../../../shared/calc/packs';
import type { Workspace } from '../../../worker/auth';
import type { HeadStatus } from '../../../worker/services/cycle';
import { api } from '../../api';
import { errText, PageHead } from '../../components/AdminBits';
import { fmtDateTime } from '../../format';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { useAsync } from '../../cycle/load';
import { fmtCases, Tabs, WS_LABEL } from '../../cycle/ui';

type Summary = {
  nodes: { id: number; parentId: number | null; name: string }[];
  leaves: { nodeId: number; routeCode: string; values: Record<string, number> }[];
};
type PackMeta = Record<string, { grp: string; sub: string | null }>;

function addInto(t: Record<string, number>, g: Record<string, number>) {
  for (const [p, n] of Object.entries(g)) t[p] = (t[p] ?? 0) + n;
}

/** The summary tables: by manager (expandable to supervisors) and by pack. */
function HeadSummary({ a, meta }: { a: Approval; meta: PackMeta }) {
  useLang();
  const [view, setView] = useState<'mgr' | 'pack'>('mgr');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const data = useAsync(() => api<Summary>('GET', `/api/cycle/${a.ws}/${a.period}/heads/${a.deptId}/summary`), [a.ws, a.period, a.deptId, a.sentAt]);
  const catOf = (p: string): Category => (meta[p]?.grp as Category) ?? 'LRB-Others';
  const subOf = (p: string) => meta[p]?.sub || subCategoryByName(p, catOf(p));
  const agg = useMemo(() => {
    const d = data.data;
    if (!d) return null;
    const kids = new Map<number | null, number[]>();
    for (const n of d.nodes) {
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId)!.push(n.id);
    }
    const own = new Map<number, Record<string, number>>();
    for (const l of d.leaves) addInto(own.get(l.nodeId) ?? (own.set(l.nodeId, {}), own.get(l.nodeId)!), l.values);
    const sums = new Map<number, Record<string, number>>();
    const walk = (id: number): Record<string, number> => {
      const t: Record<string, number> = { ...(own.get(id) ?? {}) };
      for (const k of kids.get(id) ?? []) addInto(t, walk(k));
      sums.set(id, t);
      return t;
    };
    const root = d.nodes.find((n) => n.parentId === null);
    if (root) walk(root.id);
    return { root, kids, sums, names: new Map(d.nodes.map((n) => [n.id, n.name])), routes: new Map<number, number>(d.leaves.reduce((m, l) => m.set(l.nodeId, (m.get(l.nodeId) ?? 0) + 1), new Map<number, number>())) };
  }, [data.data]);
  if (data.error) return <div class="alert">{data.error}</div>;
  if (!agg || !agg.root) return <p class="muted small">{data.data ? tc('noSummary') : tc('loading')}</p>;
  const catSum = (g: Record<string, number> | undefined, c: Category) => Object.entries(g ?? {}).reduce((s, [p, n]) => s + (catOf(p) === c ? n : 0), 0);
  const all = (g: Record<string, number> | undefined) => Object.values(g ?? {}).reduce((s, n) => s + n, 0);
  const managers = agg.kids.get(agg.root.id) ?? [];
  const rowOf = (id: number, depth: number): preact.JSX.Element[] => {
    const g = agg.sums.get(id);
    const subKids = agg.kids.get(id) ?? [];
    const isOpen = open.has(id);
    return [
      <tr key={id} class={depth === 0 ? 'sub l2' : ''}>
        <td>
          <span style={{ paddingInlineStart: `${depth * 16}px` }}>
            {depth === 0 && subKids.length > 0
              ? <button type="button" class="btn link" aria-expanded={isOpen} onClick={() => { const n = new Set(open); if (isOpen) n.delete(id); else n.add(id); setOpen(n); }}>{isOpen ? '▾' : '▸'} {agg.names.get(id)}</button>
              : agg.names.get(id)}
          </span>
        </td>
        {CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(catSum(g, c))}</td>)}
        <td class="num tot">{fmtNum(all(g))}</td>
      </tr>,
      ...(depth === 0 && isOpen ? subKids.flatMap((k) => rowOf(k, 1)) : []),
    ];
  };
  const rootSum = agg.sums.get(agg.root.id) ?? {};
  const packs = Object.keys(rootSum).filter((p) => rootSum[p]! > 0);
  return (
    <div class="cy-head-summary" data-testid="head-summary">
      <Tabs<'mgr' | 'pack'> value={view} onChange={setView} items={[{ id: 'mgr', label: tc('byManager') }, { id: 'pack', label: tc('byPack') }]} />
      {view === 'mgr' ? (
        <div class="tablewrap"><table class="ad-table cy-table">
          <thead><tr><th>{tc('lvManager')}</th>{CATEGORIES.map((c) => <th key={c} class="num">{c}</th>)}<th class="num">{tc('total')}</th></tr></thead>
          <tbody>
            {managers.flatMap((m) => rowOf(m, 0))}
            {(agg.routes.get(agg.root.id) ?? 0) > 0 && (
              <tr><td class="muted">{tc('routesUnderHead')}</td>{CATEGORIES.map((c) => <td key={c} class="num">—</td>)}<td /></tr>
            )}
          </tbody>
          <tfoot><tr class="sub l1"><td>{tc('total')}</td>{CATEGORIES.map((c) => <td key={c} class="num">{fmtNum(catSum(rootSum, c))}</td>)}<td class="num">{fmtNum(all(rootSum))}</td></tr></tfoot>
        </table></div>
      ) : (
        <div class="tablewrap cy-tall"><table class="ad-table cy-table">
          <thead><tr><th>{tc('pack')}</th><th class="num">{tc('target')}</th>{managers.map((m) => <th key={m} class="num">{agg.names.get(m)}</th>)}</tr></thead>
          <tbody>{CATEGORIES.flatMap((c) => {
            const inCat = packs.filter((p) => catOf(p) === c).sort();
            if (!inCat.length) return [];
            return [
              <tr key={c} class="sub l1"><td>{c}</td><td class="num">{fmtNum(catSum(rootSum, c))}</td>{managers.map((m) => <td key={m} class="num">{fmtNum(catSum(agg.sums.get(m), c))}</td>)}</tr>,
              ...subsOf(c, inCat, subOf).flatMap((sub) => {
                const ps = inCat.filter((p) => subOf(p) === sub);
                const sum = (g: Record<string, number> | undefined) => ps.reduce((s, p) => s + (g?.[p] ?? 0), 0);
                return [
                  ...(c === 'Water' ? [] : [<tr key={`${c}${sub}`} class="sub l2"><td>{sub}</td><td class="num">{fmtNum(sum(rootSum))}</td>{managers.map((m) => <td key={m} class="num">{fmtNum(sum(agg.sums.get(m)))}</td>)}</tr>]),
                  ...ps.map((p) => <tr key={p}><td><bdi>{p}</bdi></td><td class="num">{fmtNum(rootSum[p] ?? 0)}</td>{managers.map((m) => <td key={m} class="num">{fmtNum(agg.sums.get(m)?.[p] ?? 0)}</td>)}</tr>),
                ];
              }),
            ];
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}

type Approval = {
  ws: Workspace; period: string; deptId: number; deptName: string; status: HeadStatus; sentTotal: number | null;
  sentByCategory: Record<string, number> | null; sentAt: string | null; deadline: string | null; comment: string | null;
  monthId: number | null; rootNodeId: number | null; rootStatus: string | null;
};

function Item({ a, onDone, meta }: { a: Approval; onDone: () => void; meta: PackMeta }) {
  const [lang] = useLang();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/cycle/${a.ws}/${a.period}/heads/${a.deptId}`;
  async function act(kind: 'approve' | 'return') {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `${base}/${kind}`, kind === 'return' ? { comment } : {});
      onDone();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="card cy-section" data-testid="approval">
      <div class="cy-section-head">
        <h2>{a.deptName} · {a.period} <span class="muted small">{WS_LABEL(a.ws)}</span></h2>
        <span class={`pill ${a.status}`}>{tc(`hs_${a.status}` as 'hs_draft')}</span>
      </div>
      <p class="small muted">{tc('sentAt')}: {fmtDateTime(a.sentAt, lang)}{a.deadline && <> · {tc('deadline')}: {a.deadline}</>}</p>
      <div class="cy-cards">
        <div class="card cy-card"><h3>{tc('total')}</h3><p class="big">{fmtCases(a.sentTotal)}</p></div>
        {Object.entries(a.sentByCategory ?? {}).map(([c, n]) => <div key={c} class="card cy-card"><h3>{c}</h3><p class="big">{fmtNum(n)}</p></div>)}
      </div>
      {a.status !== 'draft' && <HeadSummary a={a} meta={meta} />}
      {a.status === 'pending' && (
        <>
          {a.rootStatus === 'in_progress' && a.monthId && a.rootNodeId && (
            <div class="banner info" data-testid="review-first">
              {tc('reviewFirst')}
              <a class="btn" href={`/m/${a.monthId}/n/${a.rootNodeId}`} data-testid="review-distribute">{tc('reviewDistribute')}</a>
            </div>
          )}
          <div class="actions">
            <button type="button" class="btn primary" disabled={busy} onClick={() => void act('approve')}>
              {a.rootStatus === 'in_progress' ? tc('approveSendMgrs') : tc('approveDistribute')}
            </button>
          </div>
          <textarea rows={2} value={comment} placeholder={tc('returnHeadHelp')} aria-label={tc('comment')} onInput={(e) => setComment(e.currentTarget.value)} />
          <div class="actions">
            <button type="button" class="btn danger" disabled={busy || !comment.trim()} onClick={() => void act('return')}>{tc('returnToAdmin')}</button>
          </div>
        </>
      )}
      {a.status === 'approved' && a.rootStatus === 'in_progress' && a.monthId && a.rootNodeId && (
        <div class="actions"><a class="btn primary" href={`/m/${a.monthId}/n/${a.rootNodeId}`}>{tc('reviewDistribute')}</a></div>
      )}
      {a.status === 'returned' && a.comment && <p class="small">{tc('yourComment')}: <q>{a.comment}</q></p>}
      {err && <div class="alert" role="alert">{err}</div>}
    </section>
  );
}

export function Approve() {
  useLang();
  const list = useAsync(() => api<{ approvals: Approval[] }>('GET', '/api/my/approvals'), []);
  const meta = useAsync(() => api<PackMeta>('GET', '/api/data/packs-sub'), []);
  const items = list.data?.approvals ?? [];
  return (
    <section class="cycle" data-testid="approve-page">
      <PageHead title={tc('approveTitle')} intro={tc('approveIntro')} />
      {list.error && <div class="alert" role="alert">{list.error}</div>}
      {list.data && items.length === 0 && <p class="card muted">{tc('noApprovals')}</p>}
      {items.map((a) => <Item key={`${a.ws}${a.period}${a.deptId}`} a={a} meta={meta.data ?? {}} onDone={list.reload} />)}
    </section>
  );
}
