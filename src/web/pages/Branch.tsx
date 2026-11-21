// Read-only branch: the node's whole subtree as an indented tree, with each
// node's status, manager and per-group totals. A name opens that node's
// workspace (read-only for ancestors, decided by the server).
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { PackGroup } from '../../shared/types';
import type { BranchNode, Workspace } from '../../worker/services/distribution';
import { api, ApiError } from '../api';
import { StatusPill } from '../components/StatusPill';
import { fmtPeriod } from '../format';
import { fmtNum, t, useLang, type TextKey } from '../i18n';

const GROUPS: { grp: PackGroup; label: TextKey; id: string }[] = [
  { grp: 'CSD', label: 'dsTabCSD', id: 'csd' },
  { grp: 'Water', label: 'dsTabWater', id: 'water' },
  { grp: 'LRB-Others', label: 'dsTabLRB', id: 'lrb' },
];

type Row = { node: BranchNode; depth: number; sums: Record<PackGroup, number>; total: number };

/** Preorder rows with depth, built from parentId (the subtree root is the node asked for). */
function buildRows(nodes: BranchNode[], groupOf: (code: string) => PackGroup): Row[] {
  const kids = new Map<number | null, BranchNode[]>();
  const ids = new Set(nodes.map((n) => n.nodeId));
  for (const n of nodes) {
    const key = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null;
    kids.set(key, [...(kids.get(key) ?? []), n]);
  }
  const rows: Row[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const node of kids.get(parent) ?? []) {
      const sums: Record<PackGroup, number> = { CSD: 0, Water: 0, 'LRB-Others': 0 };
      for (const [code, n] of Object.entries(node.totals)) sums[groupOf(code)] += n;
      rows.push({ node, depth, sums, total: sums.CSD + sums.Water + sums['LRB-Others'] });
      walk(node.nodeId, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function Branch({ mid = '', nid = '' }: { mid?: string; nid?: string }) {
  const [lang] = useLang();
  const [data, setData] = useState<{ nodes: BranchNode[]; ws: Workspace } | null>(null);
  const [err, setErr] = useState<TextKey | null>(null);

  const load = () => {
    setErr(null);
    Promise.all([
      api<BranchNode[]>('GET', `/api/months/${mid}/nodes/${nid}/branch`),
      api<Workspace>('GET', `/api/months/${mid}/nodes/${nid}`), // for the pack -> group mapping and the month
    ]).then(([nodes, ws]) => setData({ nodes, ws })).catch((e) => {
      if (e instanceof ApiError && e.status === 401) return;
      setErr(e instanceof ApiError && (e.status === 403 || e.status === 404) ? 'dsNoAccess' : 'branchLoadError');
    });
  };
  useEffect(() => {
    setData(null);
    load();
  }, [mid, nid]);

  const rows = useMemo(() => {
    if (!data) return [];
    const grp = new Map(data.ws.packs.map((p) => [p.code, p.grp as PackGroup]));
    return buildRows(data.nodes, (code) => grp.get(code) ?? 'LRB-Others');
  }, [data]);

  if (err) {
    return (
      <section class="card">
        <h1>{t('branchTitle')}</h1>
        <div class="alert" role="alert">{t(err)}</div>
        <p><button type="button" class="btn" onClick={load}>{t('dsRetry')}</button></p>
      </section>
    );
  }
  if (!data) {
    return (
      <section class="card">
        <h1>{t('branchTitle')}</h1>
        <p class="muted">{t('loading')}</p>
      </section>
    );
  }

  const { ws } = data;
  return (
    <section class="branch">
      <div class="ds-head">
        <div>
          <p class="crumbs muted">{fmtPeriod(ws.month.period, lang)} › {ws.node.deptCode} › {ws.node.name}</p>
          <h1>{t('branchTitle')}</h1>
        </div>
        <a class="btn" href={`/m/${mid}/n/${nid}`}>{t('backToDistribution')}</a>
      </div>
      <div class="card tablewrap">
        <table class="branch-table" data-testid="branch-table">
          <thead>
            <tr>
              <th scope="col">{t('node')}</th>
              <th scope="col">{t('dsColStatus')}</th>
              {GROUPS.map((g) => <th scope="col" class="num">{t(g.label)}</th>)}
              <th scope="col" class="num">{t('branchTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth, sums, total }) => (
              <tr key={node.nodeId} data-testid={`branch-row-${node.nodeId}`}>
                <th scope="row" class="branch-name" style={{ paddingInlineStart: `${12 + depth * 22}px` }}>
                  <a href={`/m/${mid}/n/${node.nodeId}`}>{node.name}</a>
                  {node.manager && <span class="muted"> · {node.manager}</span>}
                </th>
                <td><StatusPill status={node.status} testId="branch-status" /></td>
                {GROUPS.map((g) => <td class="num" data-testid={`branch-${g.id}`}>{fmtNum(sums[g.grp])}</td>)}
                <td class="num"><b data-testid="branch-total">{fmtNum(total)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
