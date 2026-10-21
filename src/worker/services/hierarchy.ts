// Live hierarchy: nodes (the tree), leaves (routes) and the bulk route mapping.
// Same conventions as masters.ts: validation here, routes only map HTTP onto
// it, and every write is ONE db.batch() (change + audit row, atomic).
//
// After a successful move or manager change (and bulk-map moves) the open
// months are told through applyTreeChangeToOpenMonths (services/flow.ts). The
// live change is committed first and stands even if that fails: the failure
// is reported as `treeChange.error`, not as an error response.
import { descendants } from '../../shared/tree';
import { all, MAX_STATEMENTS_PER_REQUEST, one } from '../db';
import { auditStatement } from './audit';
import {
  applyTreeChangeToOpenMonths, type LeafMove, type TreeChange, type TreeChangeResult,
} from './flow';
import { ApiError, bad, int, notFound, text, writeBatch, type Obj } from './masters';

const NAME_MAX = 200;

/** A positive integer id from a request body. */
function ref(v: unknown, field: string): number {
  const n = int(v, field);
  if (n < 1) throw bad(`${field} must be a positive integer`);
  return n;
}

/** Query-string `dept`: absent means all departments. */
export function optionalDept(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) throw bad('dept must be a positive integer');
  return Number(raw);
}

function mergeChanges(results: TreeChangeResult[]): TreeChangeResult | null {
  if (results.length === 0) return null;
  return {
    appliedMonths: [...new Set(results.flatMap((r) => r.appliedMonths))],
    skippedMonths: [...new Set(results.flatMap((r) => r.skippedMonths))],
  };
}

async function notify(db: D1Database, actorId: number, changes: TreeChange[]): Promise<TreeChangeResult | null> {
  const results: TreeChangeResult[] = [];
  try {
    for (const c of changes) results.push(await applyTreeChangeToOpenMonths(db, c, actorId));
  } catch (e) {
    const merged = mergeChanges(results) ?? { appliedMonths: [], skippedMonths: [] };
    return { ...merged, error: e instanceof Error ? e.message : String(e) };
  }
  return mergeChanges(results);
}

async function requireDept(db: D1Database, id: number): Promise<void> {
  if (!(await one(db, `SELECT 1 FROM departments WHERE id = ?`, id))) throw bad('deptId does not exist');
}

/** A manager must be an existing active user (roles are only admin/manager). */
async function requireManager(db: D1Database, id: number): Promise<void> {
  const u = await one<{ active: number; role: string }>(db, `SELECT active, role FROM users WHERE id = ?`, id);
  if (!u) throw bad('managerUserId does not exist');
  if (u.active !== 1) throw bad('managerUserId must be an active user');
  if (u.role !== 'manager' && u.role !== 'admin') throw bad('managerUserId must be a manager or admin');
}

// ---------- nodes ----------

export type NodeDto = { id: number; parent_id: number | null; name: string; manager_user_id: number | null };
type NodeRow = NodeDto & { dept_id: number };
const NODE_COLS = 'id, parent_id, name, manager_user_id';
const toNode = ({ id, parent_id, name, manager_user_id }: NodeRow): NodeDto => ({ id, parent_id, name, manager_user_id });

const nodeConflict = (msg: string): string =>
  /nodes\.name/.test(msg) ? 'a node with this name already exists in the department' : 'the department already has a root node';

export async function listNodes(db: D1Database, dept: number | null): Promise<NodeDto[]> {
  return dept === null
    ? all<NodeDto>(db, `SELECT ${NODE_COLS} FROM nodes ORDER BY id`)
    : all<NodeDto>(db, `SELECT ${NODE_COLS} FROM nodes WHERE dept_id = ? ORDER BY id`, dept);
}

export async function createNode(db: D1Database, actorId: number, body: Obj): Promise<NodeDto> {
  const deptId = ref(body.deptId, 'deptId');
  const name = text(body.name, 'name', NAME_MAX);
  if (body.parentId === undefined) throw bad('parentId is required (null for the root)');
  const parentId = body.parentId === null ? null : ref(body.parentId, 'parentId');
  const managerUserId = body.managerUserId === undefined || body.managerUserId === null
    ? null : ref(body.managerUserId, 'managerUserId');

  await requireDept(db, deptId);
  if (parentId !== null) {
    const parent = await one<{ dept_id: number }>(db, `SELECT dept_id FROM nodes WHERE id = ?`, parentId);
    if (!parent) throw bad('parentId does not exist');
    if (parent.dept_id !== deptId) throw bad('parent must be in the same department');
  }
  if (managerUserId !== null) await requireManager(db, managerUserId);

  const [ins] = await writeBatch(db, [
    db.prepare(
      `INSERT INTO nodes(dept_id, parent_id, name, manager_user_id) VALUES (?, ?, ?, ?) RETURNING ${NODE_COLS}`,
    ).bind(deptId, parentId, name, managerUserId),
    auditStatement(db, actorId, 'node.create', {}, { deptId, parentId, name, managerUserId }, { lastInsertIdAs: 'id' }),
  ], nodeConflict);
  return ins!.results[0] as NodeDto;
}

export async function updateNode(
  db: D1Database, actorId: number, id: number, body: Obj,
): Promise<{ node: NodeDto; treeChange: TreeChangeResult | null }> {
  const patch: { name?: string; parentId?: number | null; managerUserId?: number | null } = {};
  if (body.name !== undefined) patch.name = text(body.name, 'name', NAME_MAX);
  if (body.parentId !== undefined) patch.parentId = body.parentId === null ? null : ref(body.parentId, 'parentId');
  if (body.managerUserId !== undefined) {
    patch.managerUserId = body.managerUserId === null ? null : ref(body.managerUserId, 'managerUserId');
  }
  if (Object.keys(patch).length === 0) throw bad('no updatable fields given');

  const row = await one<NodeRow>(db, `SELECT dept_id, ${NODE_COLS} FROM nodes WHERE id = ?`, id);
  if (!row) throw notFound();
  const before = toNode(row);

  const moves = patch.parentId !== undefined && patch.parentId !== before.parent_id;
  if (moves && patch.parentId !== null) {
    const nodes = await all<{ id: number; parent_id: number | null }>(
      db, `SELECT id, parent_id FROM nodes WHERE dept_id = ?`, row.dept_id);
    if (!nodes.some((n) => n.id === patch.parentId)) {
      const elsewhere = await one(db, `SELECT 1 FROM nodes WHERE id = ?`, patch.parentId!);
      throw bad(elsewhere ? 'parent must be in the same department' : 'parentId does not exist');
    }
    if (patch.parentId === id || descendants(nodes, id).includes(patch.parentId!)) {
      throw bad('a node cannot be moved under itself or one of its descendants');
    }
  }
  const managerChanges = patch.managerUserId !== undefined && patch.managerUserId !== before.manager_user_id;
  if (managerChanges && patch.managerUserId !== null) await requireManager(db, patch.managerUserId!);

  const after: NodeDto = {
    ...before,
    name: patch.name ?? before.name,
    parent_id: patch.parentId === undefined ? before.parent_id : patch.parentId,
    manager_user_id: patch.managerUserId === undefined ? before.manager_user_id : patch.managerUserId,
  };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ['name', 'parent_id', 'manager_user_id'] as const) {
    if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
  }
  if (Object.keys(changes).length === 0) return { node: before, treeChange: null };

  await writeBatch(db, [
    db.prepare(`UPDATE nodes SET name = ?, parent_id = ?, manager_user_id = ? WHERE id = ?`)
      .bind(after.name, after.parent_id, after.manager_user_id, id),
    auditStatement(db, actorId, 'node.update', { nodeId: id }, { id, changes }),
  ], nodeConflict);

  const events: TreeChange[] = [];
  if (moves && before.parent_id !== null && after.parent_id !== null) {
    events.push({ kind: 'move_node', id, fromParent: before.parent_id, toParent: after.parent_id });
  }
  if (managerChanges) events.push({ kind: 'manager', nodeId: id, userId: after.manager_user_id });
  return { node: after, treeChange: await notify(db, actorId, events) };
}

export async function deleteNode(db: D1Database, actorId: number, id: number): Promise<void> {
  const row = await one<NodeRow & { children: number; leaves: number }>(
    db,
    `SELECT dept_id, ${NODE_COLS},
            (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = nodes.id) AS children,
            (SELECT COUNT(*) FROM leaves l WHERE l.node_id = nodes.id) AS leaves
     FROM nodes WHERE id = ?`,
    id,
  );
  if (!row) throw notFound();
  if (row.children > 0 || row.leaves > 0) {
    throw new ApiError(409, { error: 'conflict', detail: 'node still has child nodes or leaves' });
  }
  await writeBatch(db, [
    // The guard repeats in SQL so a concurrent insert under this node cannot slip in (FK would also stop it).
    db.prepare(
      `DELETE FROM nodes WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = ?)
         AND NOT EXISTS (SELECT 1 FROM leaves l WHERE l.node_id = ?)`,
    ).bind(id, id, id),
    auditStatement(db, actorId, 'node.delete', { nodeId: id }, {
      id, deptId: row.dept_id, parentId: row.parent_id, name: row.name,
    }),
  ], 'conflict');
}

// ---------- leaves ----------

export type LeafDto = {
  id: number; dept_id: number; delivery_system: string; route_code: string; node_id: number; label: string;
};
const LEAF_COLS = 'id, dept_id, delivery_system, route_code, node_id, label';

const leafConflict = 'this delivery system and route code are already mapped';

export async function listLeaves(db: D1Database, dept: number | null): Promise<LeafDto[]> {
  return dept === null
    ? all<LeafDto>(db, `SELECT ${LEAF_COLS} FROM leaves ORDER BY id`)
    : all<LeafDto>(db, `SELECT ${LEAF_COLS} FROM leaves WHERE dept_id = ? ORDER BY id`, dept);
}

async function requireNodeInDept(db: D1Database, nodeId: number, deptId: number): Promise<void> {
  const node = await one<{ dept_id: number }>(db, `SELECT dept_id FROM nodes WHERE id = ?`, nodeId);
  if (!node) throw bad('nodeId does not exist');
  if (node.dept_id !== deptId) throw bad('node must be in the leaf\'s department');
}

export async function createLeaf(db: D1Database, actorId: number, body: Obj): Promise<LeafDto> {
  const deptId = ref(body.deptId, 'deptId');
  const nodeId = ref(body.nodeId, 'nodeId');
  const deliverySystem = text(body.deliverySystem, 'deliverySystem');
  const routeCode = text(body.routeCode, 'routeCode');
  // leaves.label is NOT NULL: an omitted label falls back to the route code.
  const label = body.label === undefined || body.label === null ? routeCode : text(body.label, 'label');

  await requireDept(db, deptId);
  await requireNodeInDept(db, nodeId, deptId);
  const [ins] = await writeBatch(db, [
    db.prepare(
      `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label)
       VALUES (?, ?, ?, ?, ?) RETURNING ${LEAF_COLS}`,
    ).bind(deptId, deliverySystem, routeCode, nodeId, label),
    auditStatement(db, actorId, 'leaf.create', { nodeId }, { deptId, deliverySystem, routeCode, nodeId, label }, { lastInsertIdAs: 'id' }),
  ], leafConflict);
  return ins!.results[0] as LeafDto;
}

export async function updateLeaf(
  db: D1Database, actorId: number, id: number, body: Obj,
): Promise<{ leaf: LeafDto; treeChange: TreeChangeResult | null }> {
  const patch: { nodeId?: number; label?: string } = {};
  if (body.nodeId !== undefined) patch.nodeId = ref(body.nodeId, 'nodeId');
  if (body.label !== undefined) patch.label = text(body.label, 'label');
  if (Object.keys(patch).length === 0) throw bad('no updatable fields given');

  const before = await one<LeafDto>(db, `SELECT ${LEAF_COLS} FROM leaves WHERE id = ?`, id);
  if (!before) throw notFound();
  const after: LeafDto = { ...before, node_id: patch.nodeId ?? before.node_id, label: patch.label ?? before.label };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ['node_id', 'label'] as const) if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
  if (Object.keys(changes).length === 0) return { leaf: before, treeChange: null };

  const moves = after.node_id !== before.node_id;
  if (moves) await requireNodeInDept(db, after.node_id, before.dept_id);
  await writeBatch(db, [
    db.prepare(`UPDATE leaves SET node_id = ?, label = ? WHERE id = ?`).bind(after.node_id, after.label, id),
    auditStatement(db, actorId, 'leaf.update', { nodeId: after.node_id }, { id, changes }),
  ], leafConflict);

  const treeChange = moves
    ? await notify(db, actorId, [{ kind: 'move_leaf', id, fromParent: before.node_id, toParent: after.node_id }])
    : null;
  return { leaf: after, treeChange };
}

export async function deleteLeaf(db: D1Database, actorId: number, id: number): Promise<void> {
  const before = await one<LeafDto>(db, `SELECT ${LEAF_COLS} FROM leaves WHERE id = ?`, id);
  if (!before) throw notFound();
  await writeBatch(db, [
    db.prepare(`DELETE FROM leaves WHERE id = ?`).bind(id),
    auditStatement(db, actorId, 'leaf.delete', { nodeId: before.node_id }, before),
  ], 'conflict');
}

// ---------- bulk route mapping ----------

/** A whole department's routes fit comfortably; more than this is a mistake. */
export const BULK_MAX_ROWS = 5000;
/** Rows per upsert statement: keeps each bound JSON far below D1's 100 KB statement limit. */
const BULK_CHUNK = 500;

type BulkRow = { ds: string; rc: string; nodeId: number; label: string | null };
type LineError = { line: number; detail: string };

export async function bulkMapLeaves(
  db: D1Database, actorId: number, body: Obj,
): Promise<{ created: number; moved: number; unchanged: number; treeChange: TreeChangeResult | null }> {
  const deptId = ref(body.deptId, 'deptId');
  if (!Array.isArray(body.rows) || body.rows.length === 0) throw bad('rows must be a non-empty array');
  if (body.rows.length > BULK_MAX_ROWS) throw bad(`rows must have at most ${BULK_MAX_ROWS} entries`);
  await requireDept(db, deptId);

  const nodes = await all<{ id: number; name: string }>(db, `SELECT id, name FROM nodes WHERE dept_id = ?`, deptId);
  const nodeByName = new Map(nodes.map((n) => [n.name, n.id]));

  // Pass 1: shape and node names. line = index + 2 (an Excel sheet with a header row).
  const errors: LineError[] = [];
  const parsed: (BulkRow & { line: number })[] = [];
  const seen = new Map<string, number>();
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  body.rows.forEach((raw: unknown, i: number) => {
    const line = i + 2;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ line, detail: 'row must be an object' });
      return;
    }
    const r = raw as Obj;
    const ds = str(r.deliverySystem);
    const rc = str(r.routeCode);
    const nodeName = str(r.nodeName);
    const problems: string[] = [];
    if (!ds) problems.push('deliverySystem is required');
    if (!rc) problems.push('routeCode is required');
    if (!nodeName) problems.push('nodeName is required');
    let label: string | null = null;
    if (r.label !== undefined && r.label !== null && r.label !== '') {
      label = str(r.label);
      if (!label || label.length > NAME_MAX) problems.push(`label must be a non-blank string of at most ${NAME_MAX} characters`);
    }
    if (ds && ds.length > NAME_MAX) problems.push(`deliverySystem must be at most ${NAME_MAX} characters`);
    if (rc && rc.length > NAME_MAX) problems.push(`routeCode must be at most ${NAME_MAX} characters`);
    let nodeId: number | undefined;
    if (nodeName) {
      nodeId = nodeByName.get(nodeName);
      if (nodeId === undefined) problems.push(`unknown node "${nodeName}" in this department`);
    }
    if (ds && rc) {
      const key = `${ds}\u0000${rc}`;
      const first = seen.get(key);
      if (first !== undefined) problems.push(`duplicate of line ${first} (same delivery system and route code)`);
      else seen.set(key, line);
    }
    if (problems.length) errors.push({ line, detail: problems.join('; ') });
    else parsed.push({ line, ds: ds!, rc: rc!, nodeId: nodeId!, label });
  });

  // Pass 2: compare with what is already mapped (one read) for the other-department check and the counts.
  const systems = [...new Set(parsed.map((r) => r.ds))];
  const existing = systems.length === 0 ? [] : await all<{ id: number; delivery_system: string; route_code: string; dept_id: number; node_id: number }>(
    db,
    `SELECT id, delivery_system, route_code, dept_id, node_id FROM leaves
     WHERE delivery_system IN (SELECT value FROM json_each(?))`,
    JSON.stringify(systems),
  );
  const current = new Map(existing.map((l) => [`${l.delivery_system}\u0000${l.route_code}`, l]));
  let created = 0, unchanged = 0;
  const moves: LeafMove[] = [];
  for (const r of parsed) {
    const cur = current.get(`${r.ds}\u0000${r.rc}`);
    if (!cur) created++;
    else if (cur.dept_id !== deptId) {
      errors.push({ line: r.line, detail: 'route is already mapped in a different department' });
    } else if (cur.node_id !== r.nodeId) moves.push({ leafId: cur.id, fromParent: cur.node_id, toParent: r.nodeId });
    else unchanged++;
  }
  const moved = moves.length;
  if (errors.length) {
    errors.sort((a, b) => a.line - b.line);
    throw new ApiError(400, { error: 'invalid_request', detail: `${errors.length} row(s) have errors; nothing was saved`, errors });
  }

  // Write: set-based upserts (one statement per chunk) + one audit row, in ONE atomic batch.
  // A label that is not given keeps the existing one (new leaves default to the route code).
  const upsert = `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label)
    SELECT ?, ds, rc, node_id,
           COALESCE(label, (SELECT l.label FROM leaves l WHERE l.delivery_system = ds AND l.route_code = rc), rc)
    FROM (SELECT json_extract(value, '$.ds') AS ds, json_extract(value, '$.rc') AS rc,
                 json_extract(value, '$.n') AS node_id, json_extract(value, '$.l') AS label
          FROM json_each(?))
    WHERE true
    ON CONFLICT(delivery_system, route_code) DO UPDATE SET node_id = excluded.node_id, label = excluded.label
      WHERE leaves.dept_id = excluded.dept_id`;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < parsed.length; i += BULK_CHUNK) {
    const chunk = parsed.slice(i, i + BULK_CHUNK).map((r) => ({ ds: r.ds, rc: r.rc, n: r.nodeId, l: r.label }));
    stmts.push(db.prepare(upsert).bind(deptId, JSON.stringify(chunk)));
  }
  stmts.push(auditStatement(db, actorId, 'leaves.bulk_map', {}, { deptId, rows: parsed.length, created, moved, unchanged }));
  if (stmts.length > MAX_STATEMENTS_PER_REQUEST) throw bad('too many rows');
  await writeBatch(db, stmts, leafConflict);
  // Ruling R13: the moved leaves go to the open months as ONE set-based change.
  const treeChange = moves.length ? await notify(db, actorId, [{ kind: 'move_leaves', moves }]) : null;
  return { created, moved, unchanged, treeChange };
}
