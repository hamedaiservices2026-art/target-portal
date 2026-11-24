// The whole sales hierarchy from one file (Hierarchy.xlsx: Channel Head,
// Sales Manager, Sales Supervisor, Route Code). Each Channel Head is one
// department (the department's top node); managers go under it, supervisors
// under their manager and routes under their supervisor. Nothing is deleted:
// what the file does not mention stays, and is counted so Admin can tidy it
// on the Hierarchy page.
//
// A preview (`apply: false`) returns the plan and every problem. Applying
// re-checks and refuses while any problem remains; the writes then go through
// the same services as the manual edits (createNode / updateNode /
// bulkMapLeaves), so audits and open-month updates behave the same.
import type { Workspace } from '../auth';
import { all, one } from '../db';
import { bulkMapLeaves, createNode, updateNode } from './hierarchy';
import { ApiError, bad, createDepartment, writeBatch, type Obj } from './masters';
import { auditStatement } from './audit';
import type { TreeChangeResult } from './flow';

export const SYNC_MAX_ROWS = 20000;
const NAME_MAX = 200;

export type SyncRow = { head: string; manager: string; supervisor: string; route: string; ds: string | null; line: number; label?: string | null };
export type SyncProblem = { line: number | null; detail: string };
export type SyncHead = {
  head: string;
  deptId: number | null;
  /** How the department was found: the file, a name match, or not at all. */
  match: 'given' | 'root' | 'dept' | 'new' | 'none';
  managers: number;
  supervisors: number;
  routes: number;
  /** Routes of this department in the portal that the file does not list. */
  notInFile: number;
  newNodes: number;
  movedNodes: number;
  newRoutes: number;
  movedRoutes: number;
};
export type SyncPlan = {
  heads: SyncHead[]; problems: SyncProblem[]; rows: number;
  /** Replace mode: the workspace's Heads that are not in the file (deleted on apply). */
  removed?: { deptId: number; name: string }[];
  /** Replace mode: people and routes in the portal now (all taken out first, then the file is loaded). */
  replacing?: { nodes: number; routes: number };
};

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function parseRows(raw: unknown): { rows: SyncRow[]; problems: SyncProblem[] } {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('rows must be a non-empty array');
  if (raw.length > SYNC_MAX_ROWS) throw bad(`rows must have at most ${SYNC_MAX_ROWS} entries`);
  const rows: SyncRow[] = [];
  const problems: SyncProblem[] = [];
  const seen = new Map<string, number>();
  raw.forEach((r: unknown, i: number) => {
    const line = i + 2;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return void problems.push({ line, detail: 'row must be an object' });
    const o = r as Obj;
    const row: SyncRow = { head: str(o.head), manager: str(o.manager), supervisor: str(o.supervisor), route: str(o.route), ds: str(o.ds) || null, line };
    const miss = (['head', 'route'] as const).filter((k) => !row[k]);
    if (miss.length) return void problems.push({ line, detail: `${miss.map((k) => (k === 'head' ? 'Channel Head' : 'Route Code')).join(' and ')} missing` });
    if ([row.head, row.manager, row.supervisor, row.route].some((x) => x.length > NAME_MAX)) return void problems.push({ line, detail: `names must be at most ${NAME_MAX} characters` });
    const first = seen.get(row.route);
    if (first !== undefined) return void problems.push({ line, detail: `route ${row.route} is also on line ${first}` });
    seen.set(row.route, line);
    rows.push(row);
  });
  return { rows, problems };
}

type NodeRow = { id: number; dept_id: number; parent_id: number | null; name: string };
type LeafRow = { id: number; dept_id: number; delivery_system: string; route_code: string; node_id: number };
type DeptRow = { id: number; code: string; name: string };

/** The node path of a row inside its department: [manager?, supervisor?] without repeats of the head. */
function pathOf(r: SyncRow): string[] {
  const out: string[] = [];
  for (const n of [r.manager, r.supervisor]) {
    if (!n) continue;
    if (norm(n) === norm(r.head) || out.some((x) => norm(x) === norm(n))) continue;
    out.push(n);
  }
  return out;
}

async function plan(db: D1Database, body: Obj): Promise<{ plan: SyncPlan; rows: SyncRow[]; deptOf: Map<string, number>; nodes: NodeRow[]; leaves: LeafRow[]; channels: Map<number, string> }> {
  const parsed = parseRows(body.rows);
  const problems = parsed.problems;
  // Key Account ends at the KAM: the KAE is the name on the route (KAE ID), not a person with a team.
  const rows = body.workspace === 'ka' ? parsed.rows.map((r) => ({ ...r, label: r.supervisor || null, supervisor: '' })) : parsed.rows;
  const given = (body.depts && typeof body.depts === 'object' && !Array.isArray(body.depts) ? body.depts : {}) as Obj;
  // One workspace at a time: an Operation file never matches Key Account departments, and the other way round.
  const ws = body.workspace === 'ka' ? 'ka' : 'ops';
  let [depts, nodes, leaves, chans] = await Promise.all([
    all<DeptRow>(db, `SELECT id, code, name FROM departments WHERE workspace = ? ORDER BY id`, ws),
    all<NodeRow>(db, `SELECT n.id, n.dept_id, n.parent_id, n.name FROM nodes n JOIN departments d ON d.id = n.dept_id WHERE d.workspace = ?`, ws),
    all<LeafRow>(db, `SELECT l.id, l.dept_id, l.delivery_system, l.route_code, l.node_id FROM leaves l JOIN departments d ON d.id = l.dept_id WHERE d.workspace = ?`, ws),
    all<{ dept_id: number; channel: string }>(db, `SELECT dept_id, channel FROM dept_channels ORDER BY dept_id, sort, channel`),
  ]);
  const channels = new Map<number, string>();
  for (const c of chans) if (!channels.has(c.dept_id)) channels.set(c.dept_id, c.channel);
  const deptIds = new Set(depts.map((d) => d.id));
  const rootOf = new Map(nodes.filter((n) => n.parent_id === null).map((n) => [n.dept_id, n]));
  // Replace: the file is the whole hierarchy. Heads still match their department, but the
  // people and routes start empty (taken out on apply), so old names do not stay.
  const replace = body.replace === true;
  const replacing = replace ? { nodes: nodes.length, routes: leaves.length } : undefined;
  if (replace) { nodes = []; leaves = []; }

  // Channel Head -> department.
  const heads = [...new Map(rows.map((r) => [norm(r.head), r.head])).values()];
  const deptOf = new Map<string, number>();
  const out: SyncHead[] = [];
  for (const head of heads) {
    let deptId: number | null = null;
    let match: SyncHead['match'] = 'none';
    const g = given[head];
    if (typeof g === 'number' && deptIds.has(g)) { deptId = g; match = 'given'; }
    else if (g === 'new') match = 'new';
    else if (g !== undefined && g !== null && g !== '') problems.push({ line: null, detail: `department ${String(g)} for ${head} does not exist` });
    if (deptId === null && match !== 'new') {
      const byRoot = [...rootOf.values()].find((n) => norm(n.name) === norm(head));
      if (byRoot) { deptId = byRoot.dept_id; match = 'root'; }
    }
    if (deptId === null && match !== 'new') {
      const byDept = depts.find((d) => norm(d.name) === norm(head) || norm(d.code) === norm(head));
      if (byDept) { deptId = byDept.id; match = 'dept'; }
    }
    if (deptId === null && match !== 'new') problems.push({ line: null, detail: `pick the department of ${head}` });
    else if (deptId !== null) deptOf.set(norm(head), deptId);
    out.push({ head, deptId, match, managers: 0, supervisors: 0, routes: 0, notInFile: 0, newNodes: 0, movedNodes: 0, newRoutes: 0, movedRoutes: 0 });
  }
  const twice = new Map<number, string[]>();
  for (const h of out) if (h.deptId !== null) twice.set(h.deptId, [...(twice.get(h.deptId) ?? []), h.head]);
  for (const [, hs] of twice) if (hs.length > 1) problems.push({ line: null, detail: `${hs.join(' and ')} point to the same department` });

  // Per department: the wanted parent of every node, then the routes.
  const leafByRoute = new Map(leaves.map((l) => [l.route_code, l]));
  for (const h of out) {
    if (h.deptId === null) {
      if (h.match !== 'new') continue;
      // A new department: everything in the file is new; routes already mapped elsewhere cannot move in.
      const mine = rows.filter((r) => norm(r.head) === norm(h.head));
      const names = new Set<string>();
      for (const r of mine) pathOf(r).forEach((n, i) => names.add(`${i}|${norm(n)}`));
      h.managers = [...names].filter((n) => n.startsWith('0|')).length;
      h.supervisors = names.size - h.managers;
      h.newNodes = 1 + names.size;
      h.routes = mine.length;
      for (const r of mine) {
        if (leafByRoute.has(r.route)) problems.push({ line: r.line, detail: `route ${r.route} belongs to another department; move or delete it there first` });
        else h.newRoutes++;
      }
      continue;
    }
    const mine = rows.filter((r) => norm(r.head) === norm(h.head));
    const existing = new Map(nodes.filter((n) => n.dept_id === h.deptId).map((n) => [norm(n.name), n]));
    const root = rootOf.get(h.deptId);
    if (root && norm(root.name) !== norm(h.head) && existing.has(norm(h.head))) {
      problems.push({ line: null, detail: `${h.head} is already a node below the top of its department; rename or move it first` });
    }
    if (!root) h.newNodes++;
    const parentOf = new Map<string, { parent: string; line: number }>(); // node -> wanted parent ('' = head)
    for (const r of mine) {
      const p = pathOf(r);
      p.forEach((n, i) => {
        const parent = i === 0 ? '' : norm(p[i - 1]!);
        const cur = parentOf.get(norm(n));
        if (cur && cur.parent !== parent) problems.push({ line: r.line, detail: `${n} is under two different parents (also on line ${cur.line})` });
        else if (!cur) parentOf.set(norm(n), { parent, line: r.line });
      });
    }
    h.managers = [...parentOf.values()].filter((v) => v.parent === '').length;
    h.supervisors = parentOf.size - h.managers;
    for (const [n, { parent }] of parentOf) {
      const ex = existing.get(n);
      if (!ex) { h.newNodes++; continue; }
      if (ex.parent_id === null) { problems.push({ line: null, detail: `${ex.name} is the top node of the department; it cannot also be a manager or supervisor` }); continue; }
      const wantParent = parent === '' ? root?.id : existing.get(parent)?.id;
      if (wantParent === undefined || ex.parent_id !== wantParent) h.movedNodes++;
    }
    const inFile = new Set<string>();
    for (const r of mine) {
      inFile.add(r.route);
      const l = leafByRoute.get(r.route);
      if (!l) { h.newRoutes++; continue; }
      if (l.dept_id !== h.deptId) {
        problems.push({ line: r.line, detail: `route ${r.route} belongs to another department; move or delete it there first` });
        continue;
      }
      const p = pathOf(r);
      const want = p.length ? existing.get(norm(p[p.length - 1]!))?.id : root?.id;
      if (want === undefined || l.node_id !== want) h.movedRoutes++;
    }
    h.routes = inFile.size;
    h.notInFile = leaves.filter((l) => l.dept_id === h.deptId && !inFile.has(l.route_code)).length;
  }
  const removed = replace ? depts.filter((d) => !out.some((h) => h.deptId === d.id)).map((d) => ({ deptId: d.id, name: d.name })) : undefined;
  return { plan: { heads: out, problems, rows: rows.length, ...(replace ? { removed, replacing } : {}) }, rows, deptOf, nodes, leaves, channels };
}

export async function previewHierarchySync(db: D1Database, body: Obj): Promise<SyncPlan> {
  return (await plan(db, body)).plan;
}

export async function applyHierarchySync(
  db: D1Database, actorId: number, body: Obj,
): Promise<SyncPlan & { treeChange: TreeChangeResult | null }> {
  let p = await plan(db, body);
  if (p.plan.problems.length) {
    throw new ApiError(400, { error: 'invalid_request', detail: `${p.plan.problems.length} problem(s); nothing was saved: ${p.plan.problems.slice(0, 5).map((x) => x.detail).join('; ')}` });
  }
  // Replace: keep who manages each name, take out the workspace's people and routes and the Heads not in the file.
  const ws: Workspace = body.workspace === 'ka' ? 'ka' : 'ops';
  let managers: Map<string, number> | null = null;
  if (body.replace === true) {
    const had = await all<{ dept_id: number; name: string; u: number }>(db,
      `SELECT n.dept_id, n.name, n.manager_user_id AS u FROM nodes n JOIN departments d ON d.id = n.dept_id
       WHERE d.workspace = ? AND n.manager_user_id IS NOT NULL`, ws);
    managers = new Map(had.map((n) => [`${n.dept_id}|${norm(n.name)}`, n.u]));
    // Pin every matched Head to its department: after the clear the top-node names are gone.
    const pinned = { ...((body.depts ?? {}) as Obj) };
    for (const h of p.plan.heads) if (h.deptId !== null) pinned[h.head] = h.deptId;
    body = { ...body, depts: pinned };
    for (const r of p.plan.removed ?? []) await deleteHead(db, actorId, r.deptId);
    await clearTrees(db, actorId, ws);
  }
  // New departments first (named after the Channel Head, with a free code), then plan again with their ids.
  const news = p.plan.heads.filter((h) => h.match === 'new');
  if (news.length) {
    const depts = { ...((body.depts ?? {}) as Obj) };
    const codes = new Set((await all<{ code: string }>(db, `SELECT code FROM departments`)).map((d) => d.code));
    for (const h of news) {
      const base = h.head.split(/\s+/).map((w) => w[0] ?? '').join('').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'DEPT';
      let code = base;
      for (let i = 2; codes.has(code); i++) code = `${base}${i}`;
      codes.add(code);
      const made = await createDepartment(db, actorId, { code, name: h.head });
      // A Key Account file (MDM, KAM, KAE) makes Key Account departments.
      if (body.workspace === 'ka') await db.prepare(`UPDATE departments SET workspace = 'ka' WHERE id = ?`).bind(made.id).run();
      depts[h.head] = made.id;
    }
    body = { ...body, depts };
    p = await plan(db, body);
  }
  if (p.plan.problems.length) {
    throw new ApiError(400, { error: 'invalid_request', detail: `${p.plan.problems.length} problem(s); nothing was saved: ${p.plan.problems.slice(0, 5).map((x) => x.detail).join('; ')}` });
  }
  const changes: TreeChangeResult[] = [];
  const keep = (t: TreeChangeResult | null) => { if (t) changes.push(t); };
  for (const h of p.plan.heads) {
    const deptId = h.deptId!;
    const mine = p.rows.filter((r) => norm(r.head) === norm(h.head));
    const byName = new Map(p.nodes.filter((n) => n.dept_id === deptId).map((n) => [norm(n.name), n.id]));
    // 1. The top node carries the Channel Head's name.
    let root = p.nodes.find((n) => n.dept_id === deptId && n.parent_id === null);
    if (!root) {
      const made = await createNode(db, actorId, { deptId, parentId: null, name: h.head });
      root = { ...made, dept_id: deptId };
    } else if (root.name !== h.head) {
      await updateNode(db, actorId, root.id, { name: h.head });
    }
    byName.set(norm(h.head), root.id);
    // 2. Managers, then supervisors (a path is at most two deep).
    for (const depth of [0, 1]) {
      const done = new Set<string>();
      for (const r of mine) {
        const path = pathOf(r);
        const n = path[depth];
        if (!n || done.has(norm(n))) continue;
        done.add(norm(n));
        const parentId = depth === 0 ? root.id : byName.get(norm(path[0]!))!;
        const id = byName.get(norm(n));
        if (id === undefined) {
          const made = await createNode(db, actorId, { deptId, parentId, name: n });
          byName.set(norm(n), made.id);
        } else {
          const cur = p.nodes.find((x) => x.id === id);
          if (cur && cur.parent_id !== parentId) keep((await updateNode(db, actorId, id, { parentId })).treeChange);
        }
      }
    }
    // 3. Routes: one bulk mapping per department (new routes get the department's first channel).
    const leafOf = new Map(p.leaves.filter((l) => l.dept_id === deptId).map((l) => [l.route_code, l]));
    const fallbackDs = p.channels.get(deptId) ?? h.head;
    const nameOf = new Map([...byName.entries()].map(([k, v]) => [v, k]));
    const original = new Map<string, string>();
    for (const r of mine) for (const n of [r.head, ...pathOf(r)]) original.set(norm(n), n);
    const rows = mine.map((r) => {
      const path = pathOf(r);
      const target = path.length ? path[path.length - 1]! : h.head;
      const id = byName.get(norm(target))!;
      return {
        deliverySystem: leafOf.get(r.route)?.delivery_system ?? r.ds ?? fallbackDs,
        routeCode: r.route,
        nodeName: original.get(nameOf.get(id)!) ?? target,
        ...(r.label ? { label: r.label } : {}),
      };
    });
    // bulkMapLeaves matches nodes by their exact name: read them back once.
    const live = await all<{ id: number; name: string }>(db, `SELECT id, name FROM nodes WHERE dept_id = ?`, deptId);
    const exact = new Map(live.map((n) => [norm(n.name), n.name]));
    for (const row of rows) row.nodeName = exact.get(norm(row.nodeName)) ?? row.nodeName;
    keep((await bulkMapLeaves(db, actorId, { deptId, rows })).treeChange);
  }
  if (managers && managers.size) {
    // The same person keeps their account on the new tree (matched by Head and name).
    const now = await all<{ id: number; dept_id: number; name: string }>(db,
      `SELECT n.id, n.dept_id, n.name FROM nodes n JOIN departments d ON d.id = n.dept_id WHERE d.workspace = ? AND n.manager_user_id IS NULL`, ws);
    const sets = now.flatMap((n) => { const u = managers!.get(`${n.dept_id}|${norm(n.name)}`); return u ? [{ id: n.id, u }] : []; });
    if (sets.length) {
      await db.prepare(`UPDATE nodes SET manager_user_id = (SELECT json_extract(value, '$.u') FROM json_each(?1) WHERE json_extract(value, '$.id') = nodes.id)
        WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`).bind(JSON.stringify(sets)).run();
    }
  }
  const fresh = await previewHierarchySync(db, { ...body, replace: false });
  const merged: TreeChangeResult | null = changes.length
    ? {
      appliedMonths: [...new Set(changes.flatMap((c) => c.appliedMonths))],
      skippedMonths: [...new Set(changes.flatMap((c) => c.skippedMonths))],
      ...(changes.some((c) => c.error) ? { error: changes.map((c) => c.error).filter(Boolean).join('; ') } : {}),
    }
    : null;
  return { ...fresh, treeChange: merged };
}

// ---------- delete a Head, clear a workspace ----------

/**
 * Deletes one Head of Department with its people, routes, channels and its
 * rows in the months and the target cycle. Key Account departments linked to
 * it lose the link.
 */
export async function deleteHead(db: D1Database, actorId: number, deptId: number): Promise<void> {
  const d = await one<{ id: number; name: string; workspace: Workspace }>(db, `SELECT id, name, workspace FROM departments WHERE id = ?`, deptId);
  if (!d) throw new ApiError(404, { error: 'not_found' });
  await writeBatch(db, [
    db.prepare(`DELETE FROM month_leaves WHERE dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM month_nodes WHERE dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM month_files WHERE dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM month_depts WHERE dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM head_approvals WHERE dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM leaves WHERE dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM nodes WHERE dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM dept_channels WHERE dept_id = ?`).bind(deptId),
    db.prepare(`UPDATE departments SET ops_dept_id = NULL WHERE ops_dept_id = ?`).bind(deptId),
    db.prepare(`DELETE FROM departments WHERE id = ?`).bind(deptId),
    auditStatement(db, actorId, 'dept.delete', {}, { deptId, name: d.name, workspace: d.workspace }),
  ], 'conflict');
}

/** Takes out every person and route of a workspace; the Heads (departments) and their channels stay. */
async function clearTrees(db: D1Database, actorId: number, ws: Workspace): Promise<{ nodes: number; routes: number }> {
  const inWs = `SELECT id FROM departments WHERE workspace = ?`;
  const res = await writeBatch(db, [
    db.prepare(`DELETE FROM leaves WHERE dept_id IN (${inWs})`).bind(ws),
    db.prepare(`DELETE FROM nodes WHERE dept_id IN (${inWs})`).bind(ws),
  ], 'conflict');
  const out = { routes: res[0]!.meta.changes ?? 0, nodes: res[1]!.meta.changes ?? 0 };
  await db.prepare(`INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json) VALUES (?, ?, 'hierarchy.clear', NULL, NULL, ?)`)
    .bind(new Date().toISOString(), actorId, JSON.stringify({ ws, ...out })).run();
  return out;
}

/** Deletes a whole workspace hierarchy: every Head with its people and routes. */
export async function deleteHierarchy(db: D1Database, actorId: number, body: Obj): Promise<{ heads: number }> {
  const ws = body.workspace;
  if (ws !== 'ops' && ws !== 'ka') throw bad('workspace must be ops or ka');
  const depts = await all<{ id: number }>(db, `SELECT id FROM departments WHERE workspace = ?`, ws);
  for (const d of depts) await deleteHead(db, actorId, d.id);
  return { heads: depts.length };
}

// ---------- people by position (Admin › Users) ----------

export type Position = 'cd' | 'head' | 'manager' | 'supervisor';
export type PersonDto = {
  position: Position;
  /** The node (null for a Commercial Director, who is a role on a user). */
  nodeId: number | null;
  name: string;
  deptId: number | null;
  dept: string | null;
  /** The node it reports to. */
  parent: string | null;
  userId: number | null;
  routes: number;
  workspaces?: string[];
};

/** Every node of the hierarchy as a position (top = Channel Head, then Sales Manager, then Sales Supervisor), plus the CDs. */
export async function listPeople(db: D1Database): Promise<PersonDto[]> {
  const [nodes, depts, leaves, cds] = await Promise.all([
    all<NodeRow & { manager_user_id: number | null }>(db, `SELECT id, dept_id, parent_id, name, manager_user_id FROM nodes`),
    all<DeptRow>(db, `SELECT id, code, name FROM departments`),
    all<{ node_id: number }>(db, `SELECT node_id FROM leaves`),
    all<{ user_id: number; name: string; workspace: string }>(db,
      `SELECT r.user_id, u.name, r.workspace FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.role = 'cd' ORDER BY u.name, r.workspace`),
  ]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deptName = new Map(depts.map((d) => [d.id, d.code]));
  const routes = new Map<number, number>();
  for (const l of leaves) for (let n = byId.get(l.node_id); n; n = n.parent_id === null ? undefined : byId.get(n.parent_id)) routes.set(n.id, (routes.get(n.id) ?? 0) + 1);
  const depth = (n: NodeRow) => { let d = 0; for (let p = n.parent_id; p !== null; p = byId.get(p)?.parent_id ?? null) d++; return d; };
  const out: PersonDto[] = [];
  const cdUsers = new Map<number, { name: string; ws: string[] }>();
  for (const c of cds) cdUsers.set(c.user_id, { name: c.name, ws: [...(cdUsers.get(c.user_id)?.ws ?? []), c.workspace] });
  for (const [id, c] of cdUsers) out.push({ position: 'cd', nodeId: null, name: c.name, deptId: null, dept: null, parent: null, userId: id, routes: 0, workspaces: c.ws });
  for (const n of nodes) {
    const d = depth(n);
    out.push({
      position: d === 0 ? 'head' : d === 1 ? 'manager' : 'supervisor',
      nodeId: n.id, name: n.name, deptId: n.dept_id, dept: deptName.get(n.dept_id) ?? null,
      parent: n.parent_id === null ? null : byId.get(n.parent_id)?.name ?? null,
      userId: n.manager_user_id, routes: routes.get(n.id) ?? 0,
    });
  }
  const order: Record<Position, number> = { cd: 0, head: 1, manager: 2, supervisor: 3 };
  return out.sort((a, b) => order[a.position] - order[b.position] || (a.dept ?? '').localeCompare(b.dept ?? '') || a.name.localeCompare(b.name));
}

// ---------- clean-up: a Key Account file that landed in Operation ----------

export type KaCleanup = {
  leaves: { id: number; route: string; node: string; dept: string }[];
  nodes: { id: number; name: string; dept: string }[];
  /** Names of the file found in Operation but kept: they still hold Operation routes or people. */
  kept: string[];
};

/**
 * The KAMs, KAEs and KAE routes of a Key Account hierarchy file that were
 * added to Operation departments (before the Hierarchy screen had one upload
 * per workspace). Preview with `apply: false`; `apply: true` removes them.
 * Only non-top nodes named in the file are touched, and a node is kept when it
 * still has Operation routes or people under it.
 */
export async function removeKaFromOps(db: D1Database, actorId: number, body: Obj): Promise<KaCleanup & { applied: boolean }> {
  let names: Set<string>;
  let routes: Set<string>;
  if (body.fromKa === true) {
    // The Key Account hierarchy already on the Key Account tab: its people (below the Head) and its routes.
    const [kn, kl] = await Promise.all([
      all<{ name: string }>(db, `SELECT n.name FROM nodes n JOIN departments d ON d.id = n.dept_id WHERE d.workspace = 'ka' AND n.parent_id IS NOT NULL`),
      all<{ route_code: string }>(db, `SELECT l.route_code FROM leaves l JOIN departments d ON d.id = l.dept_id WHERE d.workspace = 'ka'`),
    ]);
    if (!kn.length && !kl.length) throw bad('the Key Account hierarchy is empty: upload it on the Key Account tab first');
    names = new Set(kn.map((n) => norm(n.name)));
    routes = new Set(kl.map((l) => l.route_code));
  } else {
    const { rows } = parseRows(body.rows);
    if (!rows.length) throw bad('rows must list the Key Account hierarchy');
    names = new Set(rows.flatMap((r) => [r.manager, r.supervisor]).filter(Boolean).map(norm));
    routes = new Set(rows.map((r) => r.route).filter(Boolean));
  }
  const [depts, nodes, leaves] = await Promise.all([
    all<DeptRow>(db, `SELECT id, code, name FROM departments WHERE workspace = 'ops'`),
    all<NodeRow>(db, `SELECT n.id, n.dept_id, n.parent_id, n.name FROM nodes n JOIN departments d ON d.id = n.dept_id WHERE d.workspace = 'ops'`),
    all<LeafRow & { label: string }>(db, `SELECT l.id, l.dept_id, l.delivery_system, l.route_code, l.node_id, l.label FROM leaves l JOIN departments d ON d.id = l.dept_id WHERE d.workspace = 'ops'`),
  ]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const named = nodes.filter((n) => n.parent_id !== null && names.has(norm(n.name)));
  const namedIds = new Set(named.map((n) => n.id));
  const goLeaves = leaves.filter((l) => routes.has(l.route_code) && namedIds.has(l.node_id));
  const goLeafIds = new Set(goLeaves.map((l) => l.id));
  // Keep a node that still has other routes or children that stay.
  const go = new Set(namedIds);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...go]) {
      const busy = leaves.some((l) => l.node_id === id && !goLeafIds.has(l.id)) || nodes.some((c) => c.parent_id === id && !go.has(c.id));
      if (busy) { go.delete(id); changed = true; }
    }
  }
  const out: KaCleanup = {
    leaves: goLeaves.map((l) => ({ id: l.id, route: l.route_code, node: nodeById.get(l.node_id)?.name ?? '', dept: deptName.get(l.dept_id) ?? '' })),
    nodes: named.filter((n) => go.has(n.id)).map((n) => ({ id: n.id, name: n.name, dept: deptName.get(n.dept_id) ?? '' })),
    kept: [...new Set(named.filter((n) => !go.has(n.id)).map((n) => n.name))],
  };
  if (body.apply !== true || (!out.leaves.length && !out.nodes.length)) return { ...out, applied: false };
  const leafIds = JSON.stringify(out.leaves.map((l) => l.id));
  const nodeIds = JSON.stringify(out.nodes.map((n) => n.id));
  await writeBatch(db, [
    db.prepare(`DELETE FROM month_leaves WHERE leaf_id IN (SELECT value FROM json_each(?))`).bind(leafIds),
    db.prepare(`DELETE FROM leaves WHERE id IN (SELECT value FROM json_each(?))`).bind(leafIds),
    db.prepare(`DELETE FROM month_nodes WHERE node_id IN (SELECT value FROM json_each(?))`).bind(nodeIds),
    db.prepare(`DELETE FROM nodes WHERE id IN (SELECT value FROM json_each(?))`).bind(nodeIds),
    auditStatement(db, actorId, 'hierarchy.remove_ka_from_ops', {}, { leaves: out.leaves, nodes: out.nodes }),
  ], 'conflict');
  return { ...out, applied: true };
}
