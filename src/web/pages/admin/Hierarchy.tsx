// Admin: hierarchy. One department at a time: its tree of nodes, the route mapping upload, and its routes (leaves).
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { DepartmentDto, UserDto } from '../../../worker/services/masters';
import type { LeafDto, NodeDto } from '../../../worker/services/hierarchy';
import { descendants } from '../../../shared/tree';
import { api, ApiError } from '../../api';
import {
  ConfirmButton, errText, Field, LoadError, PageHead, TreeChangeBanner, useResource, type TreeChange,
} from '../../components/AdminBits';
import { ImportPanel } from '../../components/ImportPanel';
import { HierarchyUpload } from './HierarchyUpload';
import { tc } from '../../cycle/i18n';
import { writeXlsx, readSheet } from '../../excel';
import { explainErrors, MAPPING_COLUMNS, MAPPING_MAX_ROWS, parseMappingSheet, type ExplainedError, type LineError } from '../../mapping';
import { t, tf, fmtNum, useLang, type TextKey } from '../../i18n';

const ROW_STEP = 200;

type Editor = { id: number | 'root'; mode: 'child' | 'rename' | 'move' | 'manager' } | null;
type MapState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'file'; message: string }
  | { kind: 'errors'; errors: ExplainedError[]; fileName: string }
  | { kind: 'done'; created: number; moved: number; unchanged: number; fileName: string };

const ERR_KEY: Record<string, TextKey> = {
  required: 'adMapErrRequired', unknownNode: 'adMapErrUnknownNode', duplicate: 'adMapErrDuplicate',
  otherDept: 'adMapErrOtherDept', tooLong: 'adMapErrTooLong', other: 'adMapErrOther',
};

type Flat = { node: NodeDto; depth: number; children: number };
type Run = (call: () => Promise<unknown>, ok: string) => Promise<boolean>;

function NodeEditor({ target, node, nodes, flat, managers, deptId, run, onCancel }: {
  target: NonNullable<Editor>; node: NodeDto | null; nodes: NodeDto[]; flat: Flat[]; managers: UserDto[];
  deptId: number | null; run: Run; onCancel: () => void;
}) {
  useLang();
  const [name, setName] = useState(target.mode === 'rename' ? node?.name ?? '' : '');
  const [pick, setPick] = useState<string>(
    target.mode === 'move' ? String(node?.parent_id ?? '') : target.mode === 'manager' ? String(node?.manager_user_id ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  const blocked = node ? new Set([node.id, ...descendants(nodes, node.id)]) : new Set<number>();
  const parentChoices = flat.filter((f) => !blocked.has(f.node.id));

  async function submit(e: Event) {
    e.preventDefault();
    setLocal(null);
    if ((target.mode === 'child' || target.mode === 'rename') && !name.trim()) return setLocal(t('adNodeErrName'));
    if (target.mode === 'move' && !pick) return setLocal(t('adNodeErrParent'));
    setBusy(true);
    let ok = false;
    if (target.mode === 'child') {
      ok = await run(() => api<{ node: NodeDto }>('POST', '/api/admin/nodes', {
        deptId, name: name.trim(), parentId: target.id === 'root' ? null : target.id,
      }), t('adNodeAdded'));
    } else if (target.mode === 'rename') {
      ok = await run(() => api('PATCH', `/api/admin/nodes/${node!.id}`, { name: name.trim() }), t('adSaved'));
    } else if (target.mode === 'move') {
      ok = await run(() => api('PATCH', `/api/admin/nodes/${node!.id}`, { parentId: Number(pick) }), t('adNodeMoved'));
    } else {
      ok = await run(() => api('PATCH', `/api/admin/nodes/${node!.id}`, { managerUserId: pick ? Number(pick) : null }), t('adManagerSaved'));
    }
    if (!ok) setBusy(false);
  }

  return (
    <form class="node-editor" onSubmit={submit} noValidate>
      {(target.mode === 'child' || target.mode === 'rename') && (
        <Field id="ne-name" label={t('adNodeName')} hint={target.mode === 'child' && node ? tf('adNodeUnder', { node: node.name }) : undefined}>
          <input id="ne-name" value={name} autofocus onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
      )}
      {target.mode === 'move' && (
        <Field id="ne-parent" label={t('adNodeNewParent')} hint={t('adNodeMoveHint')}>
          <select id="ne-parent" value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
            {parentChoices.map((f) => <option value={f.node.id}>{'  '.repeat(f.depth)}{f.node.name}</option>)}
          </select>
        </Field>
      )}
      {target.mode === 'manager' && (
        <Field id="ne-manager" label={t('adManager')} hint={t('adManagerHint')}>
          <select id="ne-manager" value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
            <option value="">{t('adNoManager')}</option>
            {managers.map((u) => <option value={u.id}>{`${u.name} (${u.username})`}</option>)}
          </select>
        </Field>
      )}
      <div class="actions">
        <button type="submit" class="btn primary" disabled={busy}>{t('adSave')}</button>
        <button type="button" class="btn" onClick={onCancel}>{t('dsCancel')}</button>
      </div>
      {local && <div class="alert" role="alert">{local}</div>}
    </form>
  );
}


function LeafEditor({ leaf, mode, flat, run, onClose }: {
  leaf: LeafDto; mode: 'move' | 'label'; flat: Flat[]; run: Run; onClose: () => void;
}) {
  useLang();
  const [node, setNode] = useState(String(leaf.node_id));
  const [label, setLabel] = useState(leaf.label);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  async function submit(e: Event) {
    e.preventDefault();
    if (mode === 'label' && !label.trim()) return setLocal(t('adLeafErrLabel'));
    setBusy(true);
    const ok = await run(
      () => api('PATCH', `/api/admin/leaves/${leaf.id}`, mode === 'move' ? { nodeId: Number(node) } : { label: label.trim() }),
      mode === 'move' ? t('adLeafMoved') : t('adSaved'));
    if (ok) onClose();
    else setBusy(false);
  }
  return (
    <form class="inline-form" onSubmit={submit} noValidate>
      {mode === 'move' ? (
        <>
          <label for={`lm-${leaf.id}`}>{t('adLeafMoveTo')}</label>
          <select id={`lm-${leaf.id}`} value={node} onChange={(e) => setNode(e.currentTarget.value)}>
            {flat.map((f) => <option value={f.node.id}>{'  '.repeat(f.depth)}{f.node.name}</option>)}
          </select>
        </>
      ) : (
        <>
          <label for={`ll-${leaf.id}`}>{t('adLabel')}</label>
          <input id={`ll-${leaf.id}`} value={label} onInput={(e) => setLabel(e.currentTarget.value)} />
        </>
      )}
      <button type="submit" class="btn primary" disabled={busy}>{t('adSave')}</button>
      <button type="button" class="btn" onClick={onClose}>{t('dsCancel')}</button>
      {local && <div class="alert" role="alert">{local}</div>}
    </form>
  );
}


/** Add one route by hand: route code, delivery system and the node it reports to. */
function AddRoute({ deptId, flat, channels, run }: { deptId: number | null; flat: Flat[]; channels: string[]; run: Run }) {
  const [open, setOpen] = useState(false);
  const [route, setRoute] = useState('');
  const [ds, setDs] = useState('');
  const [node, setNode] = useState('');
  const known = [...new Set(channels)].sort();
  if (deptId === null || flat.length === 0) return null;
  if (!open) return <div class="actions"><button type="button" class="btn" data-testid="add-route" onClick={() => setOpen(true)}>{tc('hsAddRoute')}</button></div>;
  async function save(e: Event) {
    e.preventDefault();
    const ok = await run(() => api('POST', '/api/admin/leaves', { deptId, nodeId: Number(node), deliverySystem: ds.trim(), routeCode: route.trim() }), tc('hsRouteAdded'));
    if (ok) { setRoute(''); setOpen(false); }
  }
  return (
    <form class="editor" onSubmit={save} data-testid="add-route-form">
      <div class="cy-grid">
        <label class="field"><span>{t('adRouteCode')}</span><input required value={route} onInput={(e) => setRoute(e.currentTarget.value)} /></label>
        <label class="field"><span>{t('adDeliverySystem')}</span>
          <input required list="ds-list" value={ds} onInput={(e) => setDs(e.currentTarget.value)} />
          <datalist id="ds-list">{known.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label class="field"><span>{t('node')}</span>
          <select required value={node} onChange={(e) => setNode(e.currentTarget.value)}>
            <option value="">—</option>
            {flat.map(({ node: n, depth }) => <option key={n.id} value={n.id}>{`${'\u00a0\u00a0'.repeat(depth)}${n.name}`}</option>)}
          </select>
        </label>
      </div>
      <div class="actions">
        <button type="submit" class="btn primary" disabled={!route.trim() || !ds.trim() || !node}>{t('adSave')}</button>
        <button type="button" class="btn" onClick={() => setOpen(false)}>{t('dsCancel')}</button>
      </div>
    </form>
  );
}

function initialDept(): number | null {
  const n = Number(new URLSearchParams(location.search).get('dept'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function Hierarchy() {
  useLang();
  const depts = useResource<{ departments: DepartmentDto[] }>('/api/admin/departments');
  const users = useResource<{ users: UserDto[] }>('/api/admin/users');
  const [wanted, setWanted] = useState<number | null>(initialDept);
  const deptList = depts.data?.departments ?? [];
  const deptId = deptList.some((d) => d.id === wanted) ? wanted : deptList[0]?.id ?? null;
  const dept = deptList.find((d) => d.id === deptId) ?? null;

  const nodesRes = useResource<{ nodes: NodeDto[] }>(deptId === null ? null : `/api/admin/nodes?dept=${deptId}`);
  const leavesRes = useResource<{ leaves: LeafDto[] }>(deptId === null ? null : `/api/admin/leaves?dept=${deptId}`);
  const nodes = nodesRes.data?.nodes ?? [];
  const leaves = leavesRes.data?.leaves ?? [];

  const [editor, setEditor] = useState<Editor>(null);
  const [change, setChange] = useState<TreeChange | null>(null);
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [map, setMap] = useState<MapState>({ kind: 'idle' });
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    setEditor(null);
    setChange(null);
    setFlash('');
    setErr(null);
    setMap({ kind: 'idle' });
  }, [deptId]);

  const reloadTree = () => {
    nodesRes.reload();
    leavesRes.reload();
  };

  /** Runs a write; shows the error or the tree-change banners; refreshes the lists. */
  async function run(call: () => Promise<unknown>, ok: string): Promise<boolean> {
    setErr(null);
    setChange(null);
    setFlash('');
    try {
      const out = await call();
      setChange((out as { treeChange?: TreeChange | null } | null)?.treeChange ?? null);
      setFlash(ok);
      setEditor(null);
      reloadTree();
      return true;
    } catch (x) {
      setErr(errText(x));
      return false;
    }
  }

  const managers = (users.data?.users ?? []).filter((u) => u.active && (u.role === 'manager' || u.role === 'admin'));
  const userById = useMemo(() => new Map((users.data?.users ?? []).map((u) => [u.id, u])), [users.data]);
  const nodeName = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);
  const leafCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of leaves) m.set(l.node_id, (m.get(l.node_id) ?? 0) + 1);
    return m;
  }, [leaves]);

  // Routes under each node, all levels down (the roll-up Head -> manager -> supervisor -> routes).
  const rolled = useMemo(() => {
    const m = new Map<number, number>();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const l of leaves) for (let n = byId.get(l.node_id); n; n = n.parent_id === null ? undefined : byId.get(n.parent_id)) m.set(n.id, (m.get(n.id) ?? 0) + 1);
    return m;
  }, [nodes, leaves]);

  // Tree order: depth-first, siblings by name.
  const flat = useMemo(() => {
    const kids = new Map<number | null, NodeDto[]>();
    for (const n of nodes) kids.set(n.parent_id, [...(kids.get(n.parent_id) ?? []), n]);
    const out: Flat[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const n of (kids.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ node: n, depth, children: kids.get(n.id)?.length ?? 0 });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [nodes]);
  const hasRoot = nodes.some((n) => n.parent_id === null);

  function pickDept(id: number) {
    setWanted(id);
    try {
      history.replaceState(null, '', `${location.pathname}?dept=${id}`);
    } catch { /* the URL is a convenience only */ }
  }

  // ---------- route mapping upload ----------
  async function downloadTemplate() {
    await writeXlsx('route-mapping-template.xlsx', [...MAPPING_COLUMNS], [
      [t('adTplSystem'), '1001', t('adTplNode'), t('adTplLabel')],
    ]);
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || deptId === null) return;
    setMap({ kind: 'busy' });
    setChange(null);
    setFlash('');
    let sheet: unknown[][];
    try {
      sheet = await readSheet(file);
    } catch {
      return setMap({ kind: 'file', message: t('adMapErrUnreadable') });
    }
    const parsed = parseMappingSheet(sheet);
    if (!parsed.ok) {
      const msg = parsed.reason === 'no_header' ? t('adMapErrHeader')
        : parsed.reason === 'no_rows' ? t('adMapErrEmpty')
        : tf('adMapErrTooMany', { n: fmtNum(parsed.count ?? 0), max: fmtNum(MAPPING_MAX_ROWS) });
      return setMap({ kind: 'file', message: msg });
    }
    try {
      const out = await api<{ created: number; moved: number; unchanged: number; treeChange: TreeChange | null }>(
        'POST', '/api/admin/leaves/bulk-map', { deptId, rows: parsed.rows });
      setChange(out.treeChange);
      setMap({ kind: 'done', created: out.created, moved: out.moved, unchanged: out.unchanged, fileName: file.name });
      reloadTree();
    } catch (x) {
      const list = x instanceof ApiError && x.status === 400 && Array.isArray(x.body.errors) ? (x.body.errors as LineError[]) : null;
      if (list) setMap({ kind: 'errors', errors: explainErrors(list, parsed.excelRows), fileName: file.name });
      else setMap({ kind: 'file', message: errText(x) });
    }
  }

  // ---------- leaves ----------
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(ROW_STEP);
  const [leafEdit, setLeafEdit] = useState<{ id: number; mode: 'move' | 'label' } | null>(null);
  const needle = q.trim().toLowerCase();
  const filtered = leaves.filter((l) => !needle ||
    [l.delivery_system, l.route_code, l.label, nodeName.get(l.node_id) ?? ''].some((s) => s.toLowerCase().includes(needle)));

  // ---------- render ----------
  if (depts.error) return <section><PageHead title={t('navHierarchy')} /><LoadError message={depts.error} onRetry={depts.reload} /></section>;
  if (!depts.data) return <section><PageHead title={t('navHierarchy')} /><p class="muted">{t('loading')}</p></section>;
  if (deptList.length === 0) {
    return (
      <section>
        <PageHead title={t('navHierarchy')} intro={t('adHierIntro')} />
        <p class="card muted">{t('adHierNoDept')} <a href="/admin/departments">{t('navDepartments')}</a></p>
      </section>
    );
  }

  return (
    <section data-testid="admin-hierarchy">
      <PageHead title={t('navHierarchy')} intro={t('adHierIntro')}>
        <button type="button" class="btn" aria-expanded={importing} onClick={() => setImporting(!importing)}>
          {importing ? t('imClose') : t('imOpen')}
        </button>
      </PageHead>
      {importing && (
        <ImportPanel kind="hierarchy" example={{ dept: dept?.code, parent: nodes.find((n) => n.parent_id === null)?.name }}
          onApplied={() => { reloadTree(); users.reload(); }} />
      )}
      <HierarchyUpload depts={deptList} onApplied={reloadTree} />
      <div class="toolbar">
        <label for="h-dept">{t('adDepartment')}</label>
        <select id="h-dept" value={deptId ?? ''} onChange={(e) => pickDept(Number(e.currentTarget.value))}>
          {deptList.map((d) => <option value={d.id}>{`${d.code} — ${d.name}`}</option>)}
        </select>
      </div>

      <TreeChangeBanner change={change} />
      {flash && <div class="banner ok" role="status">{flash}</div>}
      {err && <div class="alert" role="alert">{err}</div>}

      <div class="card ad-card">
        <div class="ad-card-head">
          <h2>{t('adTreeTitle')}</h2>
          {!hasRoot && nodesRes.data && (
            <button type="button" class="btn primary" onClick={() => setEditor({ id: 'root', mode: 'child' })}>{t('adAddTop')}</button>
          )}
        </div>
        <p class="muted small">{t('adTreeHelp')}</p>
        {nodesRes.error && <LoadError message={nodesRes.error} onRetry={nodesRes.reload} />}
        {!nodesRes.data && !nodesRes.error && <p class="muted">{t('loading')}</p>}
        {editor?.id === 'root' && <NodeEditor target={editor} node={null} nodes={nodes} flat={flat} managers={managers} deptId={deptId} run={run} onCancel={() => setEditor(null)} />}
        {nodesRes.data && nodes.length === 0 && editor?.id !== 'root' && <p class="muted" data-testid="tree-empty">{t('adTreeEmpty')}</p>}
        <div class="tree" role="tree">
          {flat.map(({ node, depth, children }) => {
            const routes = leafCount.get(node.id) ?? 0;
            const mgr = node.manager_user_id === null ? null : userById.get(node.manager_user_id);
            const isRoot = node.parent_id === null;
            const open = editor?.id === node.id ? editor : null;
            const deleteWhy = children > 0 ? t('adDeleteHasChildren') : routes > 0 ? t('adDeleteHasRoutes') : undefined;
            const act = (mode: NonNullable<Editor>['mode']) => () => { setFlash(''); setErr(null); setEditor({ id: node.id, mode }); };
            return (
              <div class="node" data-testid="node-row" key={node.id} role="treeitem" aria-level={depth + 1} style={{ '--depth': depth }}>
                <div class="node-line">
                  <span class="node-name">{node.name}</span>
                  <span class="node-meta" data-testid="node-manager">
                    {mgr ? `${mgr.name}${mgr.active ? '' : ` (${t('adDisabled')})`}` : <span class="muted">{t('adNoManager')}</span>}
                  </span>
                  <span class="node-meta muted" data-testid="node-routes">{tf('adRoutesCount', { n: fmtNum(routes) })}{(rolled.get(node.id) ?? 0) !== routes && ` · ${tc('hsRolled', { n: fmtNum(rolled.get(node.id) ?? 0) })}`}</span>
                  <span class="act">
                    <button type="button" class="btn" onClick={act('child')}>{t('adAddChild')}</button>
                    <button type="button" class="btn" onClick={act('rename')}>{t('adRename')}</button>
                    <button type="button" class="btn" disabled={isRoot} title={isRoot ? t('adMoveRootWhy') : undefined} onClick={act('move')}>{t('adMove')}</button>
                    <button type="button" class="btn" onClick={act('manager')}>{t('adAssignManager')}</button>
                    <ConfirmButton
                      label={t('adDelete')} question={tf('adDeleteNodeQ', { node: node.name })} yesLabel={t('adDeleteYes')}
                      disabled={deleteWhy !== undefined} title={deleteWhy}
                      onConfirm={async () => { await run(() => api<{ ok: true }>('DELETE', `/api/admin/nodes/${node.id}`), t('adNodeDeleted')); }}
                    />
                  </span>
                </div>
                {open && <NodeEditor key={open.mode} target={open} node={node} nodes={nodes} flat={flat} managers={managers} deptId={deptId} run={run} onCancel={() => setEditor(null)} />}
              </div>
            );
          })}
        </div>
      </div>

      <div class="card ad-card">
        <h2>{t('adMapTitle')}</h2>
        <p>{tf('adMapIntro', { dept: dept ? dept.code : '' })}</p>
        <ol class="small">
          <li>{t('adMapStep1')}</li>
          <li>{t('adMapStep2')}</li>
          <li>{t('adMapStep3')}</li>
        </ol>
        <p class="small muted">
          {t('adMapColumns')} {MAPPING_COLUMNS.map((c, i) => <><b>{c}</b>{i < 3 ? ', ' : '.'} </>)}{t('adMapLabelOptional')}
        </p>
        <div class="actions">
          <button type="button" class="btn" onClick={downloadTemplate}>{t('adMapTemplate')}</button>
          <span class="filepick">
            <input id="map-file" type="file" class="visually-hidden" data-testid="map-file" onChange={onFile}
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={map.kind === 'busy' || nodes.length === 0} />
            <label for="map-file" class={`btn primary${map.kind === 'busy' || nodes.length === 0 ? ' disabled' : ''}`}>{t('adMapChoose')}</label>
          </span>
        </div>
        {nodes.length === 0 && <p class="muted small">{t('adMapNeedTree')}</p>}
        {map.kind === 'busy' && <p class="muted" role="status">{t('adMapWorking')}</p>}
        {map.kind === 'file' && <div class="alert" role="alert" data-testid="map-file-error">{map.message}</div>}
        {map.kind === 'done' && (
          <div class="banner ok" role="status" data-testid="map-summary">
            <b>{map.fileName}</b>: {tf('adMapDone', { created: fmtNum(map.created), moved: fmtNum(map.moved), unchanged: fmtNum(map.unchanged) })}
          </div>
        )}
        {map.kind === 'errors' && (
          <div class="alert" role="alert" data-testid="map-errors">
            <p><b>{tf('adMapErrorsTitle', { n: fmtNum(map.errors.length) })}</b> {t('adMapNothingSaved')}</p>
            <ul>
              {map.errors.slice(0, 100).map((e) => (
                <li>{tf('adLine', { n: e.excelRow })}: {tf(ERR_KEY[e.kind] ?? 'adMapErrOther', e.vars)}</li>
              ))}
            </ul>
            {map.errors.length > 100 && <p>{tf('adMapMoreErrors', { n: fmtNum(map.errors.length - 100) })}</p>}
          </div>
        )}
      </div>

      <div class="card ad-card">
        <div class="ad-card-head">
          <h2>{t('adRoutesTitle')} <span class="muted">({fmtNum(leaves.length)})</span></h2>
        </div>
        <AddRoute deptId={deptId} flat={flat} channels={leaves.map((l) => l.delivery_system)} run={run} />
        <div class="toolbar">
          <div class="search">
            <input type="search" aria-label={t('adRoutesSearch')} placeholder={t('adRoutesSearch')} value={q}
              onInput={(e) => { setQ(e.currentTarget.value); setShown(ROW_STEP); }} />
          </div>
        </div>
        {leavesRes.error && <LoadError message={leavesRes.error} onRetry={leavesRes.reload} />}
        <div class="tablewrap">
          <table class="ad-table">
            <thead>
              <tr>
                <th class="s">{t('adDeliverySystem')}</th><th class="s">{t('adRouteCode')}</th><th class="s">{t('adLabel')}</th>
                <th class="s">{t('node')}</th><th class="s">{t('adActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && leavesRes.data && <tr><td class="empty" colSpan={5}>{leaves.length === 0 ? t('adRoutesEmpty') : t('adNothingFound')}</td></tr>}
              {filtered.slice(0, shown).map((l) => (
                <>
                  <tr key={l.id} data-testid="leaf-row">
                    <td class="s">{l.delivery_system}</td>
                    <td class="s">{l.route_code}</td>
                    <td class="s">{l.label}</td>
                    <td class="s">{nodeName.get(l.node_id) ?? '—'}</td>
                    <td class="s act">
                      <button type="button" class="btn" onClick={() => setLeafEdit({ id: l.id, mode: 'move' })}>{t('adMove')}</button>
                      <button type="button" class="btn" onClick={() => setLeafEdit({ id: l.id, mode: 'label' })}>{t('adEditLabel')}</button>
                      <ConfirmButton
                        label={t('adDelete')} question={tf('adDeleteRouteQ', { route: l.route_code })} yesLabel={t('adDeleteYes')}
                        onConfirm={async () => { await run(() => api<{ ok: true }>('DELETE', `/api/admin/leaves/${l.id}`), t('adRouteDeleted')); }}
                      />
                    </td>
                  </tr>
                  {leafEdit?.id === l.id && <tr key={`e${l.id}`}><td colSpan={5} class="s"><LeafEditor key={leafEdit.mode} leaf={l} mode={leafEdit.mode} flat={flat} run={run} onClose={() => setLeafEdit(null)} /></td></tr>}
                </>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > shown && (
          <p class="foot">
            {tf('adShowing', { n: fmtNum(shown), total: fmtNum(filtered.length) })}{' '}
            <button type="button" class="btn link" onClick={() => setShown(shown + ROW_STEP)}>{t('adShowMore')}</button>
          </p>
        )}
      </div>
    </section>
  );
}
