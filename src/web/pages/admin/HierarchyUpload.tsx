// Admin › Hierarchy: the whole sales hierarchy in one upload (the layout of
// Hierarchy.xlsx: Channel Head, Sales Manager, Sales Supervisor, Route Code).
// Every Channel Head is a department; a preview shows, per Head, what will be
// added or moved and the rolled-up counts before anything is saved. Small
// changes (one or two routes, a new supervisor) stay on the tree below.
import { useState } from 'preact/hooks';
import type { DepartmentDto } from '../../../worker/services/masters';
import type { LeafDto, NodeDto } from '../../../worker/services/hierarchy';
import type { SyncPlan } from '../../../worker/services/hierarchySync';
import { api } from '../../api';
import { errText, TreeChangeBanner, type TreeChange } from '../../components/AdminBits';
import { readSheet, writeXlsx } from '../../excel';
import { fmtNum, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { HIERARCHY_COLUMNS, KA_HIERARCHY_COLUMNS, parseHierarchySheet, type HierarchyRow as Row } from '../../cycle/hierarchyFile';

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'preview'; file: string; rows: Row[]; plan: SyncPlan; depts: Record<string, number | 'new'>; ka: boolean }
  | { kind: 'done'; file: string; plan: SyncPlan; change: TreeChange | null };

export function HierarchyUpload({ depts, onApplied }: { depts: DepartmentDto[]; onApplied: () => void }) {
  useLang();
  const [st, setSt] = useState<State>({ kind: 'idle' });

  async function template() {
    // The current hierarchy, so the file is a full copy to edit (or the columns only when empty).
    const [{ nodes }, { leaves }] = await Promise.all([
      api<{ nodes: (NodeDto & { dept_id?: number })[] }>('GET', '/api/admin/nodes'),
      api<{ leaves: LeafDto[] }>('GET', '/api/admin/leaves'),
    ]);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const rows = leaves.map((l) => {
      const path: string[] = [];
      for (let n = byId.get(l.node_id); n; n = n.parent_id === null ? undefined : byId.get(n.parent_id)) path.unshift(n.name);
      const [head = '', manager = '', supervisor = ''] = path.length > 3 ? [path[0]!, path[1]!, path[path.length - 1]!] : path;
      return [head, manager, supervisor, l.route_code, l.delivery_system];
    }).sort((a, b) => a.join('|').localeCompare(b.join('|')));
    await writeXlsx('sales_hierarchy.xlsx', [...HIERARCHY_COLUMNS], rows.length ? rows : [['Head name', 'Manager name', 'Supervisor name', '314037', '']],
      ['string', 'string', 'string', 'string', 'string']);
  }

  async function preview(rows: Row[], file: string, chosen: Record<string, number | 'new'>, ka = false) {
    setSt({ kind: 'busy' });
    try {
      let plan = await api<SyncPlan>('POST', '/api/admin/hierarchy/sync/preview', { rows, depts: chosen });
      const picked = { ...chosen };
      for (const h of plan.heads) if (h.deptId !== null && picked[h.head] === undefined) picked[h.head] = h.deptId;
      // Key Account file: an MDM with no department yet becomes a new Key Account department.
      if (ka && plan.heads.some((h) => h.deptId === null && picked[h.head] === undefined)) {
        for (const h of plan.heads) if (h.deptId === null && picked[h.head] === undefined) picked[h.head] = 'new';
        plan = await api<SyncPlan>('POST', '/api/admin/hierarchy/sync/preview', { rows, depts: picked });
      }
      setSt({ kind: 'preview', file, rows, plan, depts: picked, ka });
    } catch (x) {
      setSt({ kind: 'error', message: errText(x) });
    }
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    setSt({ kind: 'busy' });
    let sheet: unknown[][];
    try {
      sheet = await readSheet(f);
    } catch {
      return setSt({ kind: 'error', message: tc('hsUnreadable') });
    }
    const parsed = parseHierarchySheet(sheet);
    if (parsed.error) return setSt({ kind: 'error', message: parsed.error === 'no_header' ? tc('hsNoHeader') : tc('hsEmpty') });
    await preview(parsed.rows, f.name, {}, parsed.ka);
  }

  async function apply() {
    if (st.kind !== 'preview') return;
    setSt({ kind: 'busy' });
    try {
      const out = await api<SyncPlan & { treeChange: TreeChange | null }>('POST', '/api/admin/hierarchy/sync/apply', { rows: st.rows, depts: st.depts, ...(st.ka ? { workspace: 'ka' } : {}) });
      setSt({ kind: 'done', file: st.file, plan: out, change: out.treeChange });
      onApplied();
    } catch (x) {
      setSt({ kind: 'error', message: errText(x) });
    }
  }

  const plan = st.kind === 'preview' || st.kind === 'done' ? st.plan : null;
  const sum = (k: 'newNodes' | 'movedNodes' | 'newRoutes' | 'movedRoutes') => (plan ? plan.heads.reduce((s, h) => s + h[k], 0) : 0);

  return (
    <div class="card ad-card" data-testid="hierarchy-upload">
      <h2>{tc('hsTitle')}</h2>
      <p class="small">{tc('hsIntro')}</p>
      <p class="small muted">{tc('hsColumns')} {HIERARCHY_COLUMNS.map((c, i) => <><b>{c}</b>{i < HIERARCHY_COLUMNS.length - 1 ? ', ' : '. '}</>)}{tc('hsColumnsHelp')}</p>
      <div class="actions">
        <button type="button" class="btn" onClick={() => void template().catch((x) => setSt({ kind: 'error', message: errText(x) }))}>{tc('hsTemplate')}</button>
        <button type="button" class="btn" onClick={() => void writeXlsx('key_account_hierarchy.xlsx', [...KA_HIERARCHY_COLUMNS], [['MDM name', '41232', 'KAM name', '41455', 'KAE name', '41461']], ['string', 'string', 'string', 'string', 'string', 'string'])}>{tc('hsKaTemplate')}</button>
        <span class="filepick">
          <input id="hier-file" type="file" class="visually-hidden" data-testid="hier-file" onChange={onFile}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={st.kind === 'busy'} />
          <label for="hier-file" class={`btn primary${st.kind === 'busy' ? ' disabled' : ''}`}>{tc('hsChoose')}</label>
        </span>
      </div>
      {st.kind === 'busy' && <p class="muted" role="status">{tc('loading')}</p>}
      {st.kind === 'error' && <div class="alert" role="alert" data-testid="hier-error">{st.message}</div>}
      {st.kind === 'done' && (
        <>
          <div class="banner ok" role="status" data-testid="hier-done">
            <b>{st.file}</b>: {tc('hsDone', { nodes: fmtNum(sum('newNodes')), routes: fmtNum(sum('newRoutes')) })}
          </div>
          <TreeChangeBanner change={st.change} />
        </>
      )}
      {plan && (
        <>
          {st.kind === 'preview' && <p class="small"><b>{st.file}</b>: {tc('hsRead', { n: fmtNum(plan.rows), heads: plan.heads.length })}</p>}
          {st.kind === 'preview' && st.ka && <p class="banner info small" data-testid="hier-ka">{tc('hsKaFile')}</p>}
          <div class="tablewrap"><table class="ad-table cy-table" data-testid="hier-plan">
            <thead><tr>
              <th>{tc('lvHead')}</th><th>{tc('hsDepartment')}</th>
              <th class="num">{tc('hsManagers')}</th><th class="num">{tc('hsSupervisors')}</th><th class="num">{tc('hsRoutes')}</th>
              <th class="num">{tc('hsNewNodes')}</th><th class="num">{tc('hsMovedNodes')}</th><th class="num">{tc('hsNewRoutes')}</th><th class="num">{tc('hsMovedRoutes')}</th>
              <th class="num">{tc('hsNotInFile')}</th>
            </tr></thead>
            <tbody>{plan.heads.map((h) => (
              <tr key={h.head}>
                <td>{h.head}</td>
                <td>
                  {st.kind === 'preview' ? (
                    <select aria-label={`${tc('hsDepartment')} ${h.head}`} value={st.depts[h.head] ?? ''}
                      onChange={(e) => { const v = e.currentTarget.value; const next = { ...st.depts }; if (v === 'new') next[h.head] = 'new'; else if (v) next[h.head] = Number(v); else delete next[h.head]; void preview(st.rows, st.file, next, st.ka); }}>
                      <option value="">{tc('hsPickDept')}</option>
                      <option value="new">{tc('hsNewDept', { name: h.head })}</option>
                      {depts.map((d) => <option key={d.id} value={d.id}>{`${d.code} — ${d.name}`}</option>)}
                    </select>
                  ) : depts.find((d) => d.id === h.deptId)?.code ?? '—'}
                </td>
                <td class="num">{fmtNum(h.managers)}</td><td class="num">{fmtNum(h.supervisors)}</td><td class="num">{fmtNum(h.routes)}</td>
                <td class="num">{fmtNum(h.newNodes)}</td><td class="num">{fmtNum(h.movedNodes)}</td><td class="num">{fmtNum(h.newRoutes)}</td><td class="num">{fmtNum(h.movedRoutes)}</td>
                <td class="num">{h.notInFile ? <span class="status warn">{fmtNum(h.notInFile)}</span> : '0'}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr class="sub l1">
              <td>{tc('total')}</td><td />
              <td class="num">{fmtNum(plan.heads.reduce((s, h) => s + h.managers, 0))}</td>
              <td class="num">{fmtNum(plan.heads.reduce((s, h) => s + h.supervisors, 0))}</td>
              <td class="num">{fmtNum(plan.heads.reduce((s, h) => s + h.routes, 0))}</td>
              <td class="num">{fmtNum(sum('newNodes'))}</td><td class="num">{fmtNum(sum('movedNodes'))}</td>
              <td class="num">{fmtNum(sum('newRoutes'))}</td><td class="num">{fmtNum(sum('movedRoutes'))}</td>
              <td class="num">{fmtNum(plan.heads.reduce((s, h) => s + h.notInFile, 0))}</td>
            </tr></tfoot>
          </table></div>
          {plan.heads.some((h) => h.notInFile > 0) && <p class="small muted">{tc('hsNotInFileHelp')}</p>}
          {plan.problems.length > 0 && (
            <div class="alert" role="alert" data-testid="hier-problems">
              <p><b>{tc('hsProblems', { n: plan.problems.length })}</b></p>
              <ul>{plan.problems.slice(0, 50).map((p, i) => <li key={i}>{p.line ? `${tc('hsLine', { n: p.line })}: ` : ''}{p.detail}</li>)}</ul>
            </div>
          )}
          {st.kind === 'preview' && (
            <div class="actions">
              <button type="button" class="btn primary" data-testid="hier-apply" disabled={plan.problems.length > 0} onClick={() => void apply()}>{tc('hsApply')}</button>
              <button type="button" class="btn" onClick={() => setSt({ kind: 'idle' })}>{tc('cancel')}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
