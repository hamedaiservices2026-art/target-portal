// Admin › Hierarchy, laid out like the v16 prototype ("Hierarchy · add / edit
// / delete"): add a Channel Head, Sales Manager, Sales Supervisor or route;
// rename in place, move with the "reports to" lists, delete what is empty.
// Above it, the whole hierarchy can be uploaded in one file (HierarchyUpload).
// Every Channel Head is the top of one department; moves stay inside it.
import { useMemo, useState } from 'preact/hooks';
import type { DepartmentDto } from '../../../worker/services/masters';
import type { LeafDto, NodeDto } from '../../../worker/services/hierarchy';
import { api } from '../../api';
import { errText, LoadError, PageHead, TreeChangeBanner, useResource, type TreeChange } from '../../components/AdminBits';
import { fmtNum, t, useLang } from '../../i18n';
import { tc } from '../../cycle/i18n';
import { HierarchyUpload } from './HierarchyUpload';

type Node = NodeDto & { dept_id: number; depth: number; head: Node | null; mgr: Node | null };

/** Department code from the Head's name: initials, made unique ("Amir Elnagar" → "AE"). */
export function codeFor(name: string, taken: Set<string>): string {
  const base = name.normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).map((w) => w[0] ?? '').join('').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'HEAD';
  let c = base;
  for (let i = 2; taken.has(c); i++) c = `${base}${i}`;
  return c;
}

export function Hierarchy() {
  useLang();
  const depts = useResource<{ departments: DepartmentDto[] }>('/api/admin/departments');
  const nodesRes = useResource<{ nodes: NodeDto[] }>('/api/admin/nodes');
  const leavesRes = useResource<{ leaves: LeafDto[] }>('/api/admin/leaves');
  const [change, setChange] = useState<TreeChange | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [arm, setArm] = useState<string | null>(null);
  const [f, setF] = useState('');
  const [add, setAdd] = useState({ head: '', headWs: 'ops', mgr: '', mgrP: '', sup: '', supP: '', route: '', label: '', ds: '', routeP: '' });

  const deptList = depts.data?.departments ?? [];
  const deptCode = new Map(deptList.map((d) => [d.id, d.code]));
  const leaves = leavesRes.data?.leaves ?? [];

  const { all, heads, managers, supervisors, byId } = useMemo(() => {
    const raw = nodesRes.data?.nodes ?? [];
    const byId = new Map<number, Node>();
    for (const n of raw) byId.set(n.id, { ...n, dept_id: n.dept_id ?? 0, depth: 0, head: null, mgr: null });
    for (const n of byId.values()) {
      const path: Node[] = [];
      for (let p = n.parent_id === null ? undefined : byId.get(n.parent_id); p; p = p.parent_id === null ? undefined : byId.get(p.parent_id)) path.unshift(p);
      n.depth = path.length;
      n.head = path[0] ?? null;
      n.mgr = path[1] ?? null;
    }
    const all = [...byId.values()];
    const by = (a: Node, b: Node) => a.name.localeCompare(b.name);
    return {
      all, byId,
      heads: all.filter((n) => n.depth === 0).sort(by),
      managers: all.filter((n) => n.depth === 1).sort((a, b) => (a.head?.name ?? '').localeCompare(b.head?.name ?? '') || by(a, b)),
      supervisors: all.filter((n) => n.depth >= 2).sort((a, b) => (a.mgr?.name ?? '').localeCompare(b.mgr?.name ?? '') || by(a, b)),
    };
  }, [nodesRes.data]);

  const kids = useMemo(() => {
    const m = new Map<number, number>();
    for (const n of all) if (n.parent_id !== null) m.set(n.parent_id, (m.get(n.parent_id) ?? 0) + 1);
    return m;
  }, [all]);
  const own = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of leaves) m.set(l.node_id, (m.get(l.node_id) ?? 0) + 1);
    return m;
  }, [leaves]);
  // Routes rolled up the tree: Head ← Manager ← Supervisor ← routes.
  const rolled = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of leaves) for (let n = byId.get(l.node_id); n; n = n.parent_id === null ? undefined : byId.get(n.parent_id)) m.set(n.id, (m.get(n.id) ?? 0) + 1);
    return m;
  }, [leaves, byId]);
  const countUnder = (id: number, depth: number) => all.filter((n) => n.depth === depth && (n.head?.id === id || n.mgr?.id === id)).length;

  const reload = () => { nodesRes.reload(); leavesRes.reload(); depts.reload(); };
  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    setChange(null);
    try {
      const out = await fn();
      setChange((out as { treeChange?: TreeChange | null } | null)?.treeChange ?? null);
      setMsg({ ok: true, text: ok });
      setArm(null);
      reload();
      return true;
    } catch (x) {
      setMsg({ ok: false, text: errText(x) });
      return false;
    }
  }
  const set = (k: keyof typeof add, v: string) => setAdd((a) => ({ ...a, [k]: v }));

  async function addHead() {
    const name = add.head.trim();
    if (!name) return setMsg({ ok: false, text: tc('hzNeedName') });
    const ok = await run(async () => {
      const { department } = await api<{ department: DepartmentDto }>('POST', '/api/admin/departments', { code: codeFor(name, new Set(deptList.map((d) => d.code))), name });
      if (add.headWs === 'ka') await api('PUT', `/api/admin/departments/${department.id}/workspace`, { workspace: 'ka' });
      return api('POST', '/api/admin/nodes', { deptId: department.id, parentId: null, name });
    }, tc('hzAdded', { name }));
    if (ok) set('head', '');
  }
  async function addUnder(kind: 'mgr' | 'sup') {
    const name = add[kind].trim();
    const parent = byId.get(Number(add[kind === 'mgr' ? 'mgrP' : 'supP']));
    if (!name || !parent) return setMsg({ ok: false, text: tc('hzNeedName') });
    const ok = await run(() => api('POST', '/api/admin/nodes', { deptId: parent.dept_id, parentId: parent.id, name }), tc('hzAdded', { name }));
    if (ok) set(kind, '');
  }
  async function addRoute() {
    const node = byId.get(Number(add.routeP));
    const code = add.route.trim();
    const ds = add.ds.trim() || leaves.find((l) => l.dept_id === node?.dept_id)?.delivery_system || node?.head?.name || '';
    if (!code || !node) return setMsg({ ok: false, text: tc('hzNeedRoute') });
    const ok = await run(() => api('POST', '/api/admin/leaves', { deptId: node.dept_id, nodeId: node.id, deliverySystem: ds, routeCode: code, label: add.label.trim() || code }), tc('hsRouteAdded'));
    if (ok) setAdd((a) => ({ ...a, route: '', label: '' }));
  }

  const rename = (n: Node, v: string) => { if (v.trim() && v.trim() !== n.name) void run(() => api('PATCH', `/api/admin/nodes/${n.id}`, { name: v.trim() }), t('adSaved')); };
  const move = (n: Node, parentId: number) => { if (parentId !== n.parent_id) void run(() => api('PATCH', `/api/admin/nodes/${n.id}`, { parentId }), t('adNodeMoved')); };
  const del = (key: string, fn: () => Promise<unknown>) => (arm === key ? void run(fn, t('adNodeDeleted')) : setArm(key));
  const delBtn = (key: string, blocked: string | null, fn: () => Promise<unknown>) => (
    <button type="button" class="btn link danger" disabled={!!blocked} title={blocked ?? undefined} onClick={() => del(key, fn)}>{arm === key ? tc('hzConfirmDelete') : t('adDelete')}</button>
  );
  const nameInput = (n: Node) => (
    <input class="hz-name" value={n.name} key={`${n.id}:${n.name}`} aria-label={`${tc('ppName')} ${n.name}`} onChange={(e) => rename(n, e.currentTarget.value)} />
  );
  const lab = (n: Node) => `${n.name} · ${n.mgr?.name ?? n.head?.name ?? deptCode.get(n.dept_id) ?? ''}`;
  const channels = [...new Set(leaves.map((l) => l.delivery_system))].sort();

  const needle = f.trim().toLowerCase();
  const routes = leaves
    .map((l) => ({ l, node: byId.get(l.node_id) }))
    .filter(({ l, node }) => !needle || [l.route_code, l.label, l.delivery_system, node?.name ?? '', node?.mgr?.name ?? '', node?.head?.name ?? ''].join(' ').toLowerCase().includes(needle))
    .sort((a, b) => a.l.route_code.localeCompare(b.l.route_code));

  const err = depts.error ?? nodesRes.error ?? leavesRes.error;
  return (
    <section data-testid="admin-hierarchy">
      <PageHead title={t('navHierarchy')} intro={tc('hzIntro')} />
      {err && <LoadError message={err} onRetry={reload} />}
      <HierarchyUpload depts={deptList} onApplied={reload} />
      <TreeChangeBanner change={change} />
      {msg && <div class={msg.ok ? 'banner ok' : 'alert'} role={msg.ok ? 'status' : 'alert'} data-testid="hz-msg">{msg.text}</div>}

      <div class="card ad-card hz-add" data-testid="hz-add">
        <h2>{tc('hzAdd')}</h2>
        <div class="row">
          <b>{tc('ppHead')}</b>
          <input aria-label={tc('hzNewHead')} placeholder={tc('ppName')} value={add.head} onInput={(e) => set('head', e.currentTarget.value)} />
          <select aria-label={tc('hzWorkspace')} value={add.headWs} onChange={(e) => set('headWs', e.currentTarget.value)}>
            <option value="ops">{tc('wsOps')}</option><option value="ka">{tc('wsKa')}</option>
          </select>
          <button type="button" class="btn primary" onClick={() => void addHead()}>{tc('hzAddBtn')}</button>
        </div>
        <div class="row">
          <b>{tc('ppManager')}</b>
          <input aria-label={tc('hzNewManager')} placeholder={tc('ppName')} value={add.mgr} onInput={(e) => set('mgr', e.currentTarget.value)} />
          <span class="muted">{tc('hzReportsTo')}</span>
          <select aria-label={tc('hzManagerParent')} value={add.mgrP} onChange={(e) => set('mgrP', e.currentTarget.value)}>
            <option value="">—</option>
            {heads.map((h) => <option key={h.id} value={h.id}>{`${h.name} · ${deptCode.get(h.dept_id) ?? ''}`}</option>)}
          </select>
          <button type="button" class="btn primary" onClick={() => void addUnder('mgr')}>{tc('hzAddBtn')}</button>
        </div>
        <div class="row">
          <b>{tc('ppSupervisor')}</b>
          <input aria-label={tc('hzNewSupervisor')} placeholder={tc('ppName')} value={add.sup} onInput={(e) => set('sup', e.currentTarget.value)} />
          <span class="muted">{tc('hzReportsTo')}</span>
          <select aria-label={tc('hzSupervisorParent')} value={add.supP} onChange={(e) => set('supP', e.currentTarget.value)}>
            <option value="">—</option>
            {managers.map((m) => <option key={m.id} value={m.id}>{`${m.name} · ${m.head?.name ?? ''}`}</option>)}
          </select>
          <button type="button" class="btn primary" onClick={() => void addUnder('sup')}>{tc('hzAddBtn')}</button>
        </div>
        <div class="row">
          <b>{tc('route')}</b>
          <input aria-label={tc('hzNewRoute')} placeholder={t('adRouteCode')} value={add.route} style={{ width: '120px' }} onInput={(e) => set('route', e.currentTarget.value)} />
          <input aria-label={tc('salesman')} placeholder={tc('salesman')} value={add.label} style={{ width: '120px' }} onInput={(e) => set('label', e.currentTarget.value)} />
          <input aria-label={t('adDeliverySystem')} placeholder={t('adDeliverySystem')} list="hz-ch" value={add.ds} style={{ width: '150px' }} onInput={(e) => set('ds', e.currentTarget.value)} />
          <span class="muted">{tc('hzUnder')}</span>
          <select aria-label={tc('hzRouteParent')} value={add.routeP} onChange={(e) => set('routeP', e.currentTarget.value)}>
            <option value="">—</option>
            {supervisors.map((s) => <option key={s.id} value={s.id}>{lab(s)}</option>)}
          </select>
          <button type="button" class="btn primary" onClick={() => void addRoute()}>{tc('hzAddBtn')}</button>
        </div>
        <datalist id="hz-ch">{channels.map((c) => <option key={c} value={c} />)}</datalist>
        <p class="muted small">{tc('hzAddHelp')}</p>
      </div>

      <div class="card ad-card">
        <h2>{tc('hzHeads')} <span class="muted">({fmtNum(heads.length)})</span></h2>
        <div class="tablewrap"><table class="ad-table" data-testid="hz-heads">
          <thead><tr><th>{tc('ppName')}</th><th>{tc('ppDept')}</th><th class="num">{tc('hzManagers')}</th><th class="num">{tc('hzSupervisors')}</th><th class="num">{tc('routes')}</th><th /></tr></thead>
          <tbody>{heads.map((h) => {
            const c = kids.get(h.id) ?? 0;
            return (
              <tr key={h.id} data-testid="hz-head">
                <td>{nameInput(h)}</td>
                <td>{deptCode.get(h.dept_id) ?? '—'}</td>
                <td class="num">{fmtNum(countUnder(h.id, 1))}</td>
                <td class="num">{fmtNum(countUnder(h.id, 2))}</td>
                <td class="num">{fmtNum(rolled.get(h.id) ?? 0)}</td>
                <td>{delBtn(`n${h.id}`, c || own.get(h.id) ? tc('hzMoveFirst') : null, () => api('DELETE', `/api/admin/nodes/${h.id}`))}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </div>

      <div class="card ad-card">
        <h2>{tc('hzManagers')} <span class="muted">({fmtNum(managers.length)})</span></h2>
        <div class="tablewrap"><table class="ad-table" data-testid="hz-managers">
          <thead><tr><th>{tc('ppName')}</th><th>{tc('ppHead')}</th><th class="num">{tc('hzSupervisors')}</th><th class="num">{tc('routes')}</th><th /></tr></thead>
          <tbody>{managers.map((m) => {
            const c = kids.get(m.id) ?? 0;
            return (
              <tr key={m.id} data-testid="hz-manager">
                <td>{nameInput(m)}</td>
                <td>{m.head?.name ?? '—'}</td>
                <td class="num">{fmtNum(c)}</td>
                <td class="num">{fmtNum(rolled.get(m.id) ?? 0)}</td>
                <td>{delBtn(`n${m.id}`, c || own.get(m.id) ? tc('hzMoveFirst') : null, () => api('DELETE', `/api/admin/nodes/${m.id}`))}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </div>

      <div class="card ad-card">
        <h2>{tc('hzSupervisors')} <span class="muted">({fmtNum(supervisors.length)})</span></h2>
        <div class="tablewrap" style={{ maxHeight: '440px' }}><table class="ad-table" data-testid="hz-supervisors">
          <thead><tr><th>{tc('ppName')}</th><th>{tc('ppManager')}</th><th class="num">{tc('routes')}</th><th /></tr></thead>
          <tbody>{supervisors.map((s) => {
            const c = kids.get(s.id) ?? 0;
            const options = all.filter((n) => n.dept_id === s.dept_id && n.depth === s.depth - 1);
            return (
              <tr key={s.id} data-testid="hz-supervisor">
                <td>{nameInput(s)}</td>
                <td>
                  <select aria-label={`${tc('ppManager')} ${s.name}`} value={s.parent_id ?? ''} onChange={(e) => move(s, Number(e.currentTarget.value))}>
                    {options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </td>
                <td class="num">{fmtNum(rolled.get(s.id) ?? 0)}</td>
                <td>{delBtn(`n${s.id}`, c || own.get(s.id) ? tc('hzMoveFirst') : null, () => api('DELETE', `/api/admin/nodes/${s.id}`))}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </div>

      <div class="card ad-card">
        <h2>{tc('routes')} <span class="muted">({fmtNum(leaves.length)})</span></h2>
        <div class="toolbar">
          <input type="search" aria-label={tc('hzFilter')} placeholder={tc('hzFilter')} value={f} onInput={(e) => setF(e.currentTarget.value)} style={{ flex: 1, maxWidth: '420px' }} />
          <span class="muted">{tc('hzOf', { n: fmtNum(routes.length), total: fmtNum(leaves.length) })}</span>
        </div>
        <div class="tablewrap" style={{ maxHeight: '480px' }}><table class="ad-table" data-testid="hz-routes">
          <thead><tr><th>{tc('route')}</th><th>{tc('salesman')}</th><th>{t('adDeliverySystem')}</th><th>{tc('ppSupervisor')}</th><th>{tc('ppManager')}</th><th /></tr></thead>
          <tbody>{routes.slice(0, 400).map(({ l, node }) => (
            <tr key={l.id} data-testid="hz-route">
              <td>{l.route_code}</td>
              <td><input value={l.label} key={`${l.id}:${l.label}`} style={{ width: '110px' }} aria-label={`${tc('salesman')} ${l.route_code}`}
                onChange={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== l.label) void run(() => api('PATCH', `/api/admin/leaves/${l.id}`, { label: v }), t('adSaved')); }} /></td>
              <td>{l.delivery_system}</td>
              <td>
                <select aria-label={`${tc('ppSupervisor')} ${l.route_code}`} value={l.node_id} onChange={(e) => { const v = Number(e.currentTarget.value); if (v !== l.node_id) void run(() => api('PATCH', `/api/admin/leaves/${l.id}`, { nodeId: v }), t('adSaved')); }}>
                  {all.filter((n) => n.dept_id === l.dept_id && (n.depth >= 2 || n.id === l.node_id)).sort((a, b) => a.name.localeCompare(b.name)).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              </td>
              <td class="muted">{node?.depth === 1 ? node.name : node?.mgr?.name ?? '—'}</td>
              <td>{delBtn(`l${l.id}`, null, () => api('DELETE', `/api/admin/leaves/${l.id}`))}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {routes.length > 400 && <p class="muted small">{tc('hzMore', { n: fmtNum(routes.length - 400) })}</p>}
      </div>
    </section>
  );
}
