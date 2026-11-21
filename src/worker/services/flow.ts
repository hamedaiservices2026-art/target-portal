// Month flow, admin side (spec sections 5 and 8): the status board, reopen,
// push forward, and carrying live-tree edits into open months.
//
// Same D1 conventions as distribution.ts: one batch of reads, work in memory,
// one atomic batch of guarded, set-based writes. Totals never change here:
// reopen and push only change node states (push runs the normal submit), and
// a tree move only re-parents rows while nobody on the affected paths has
// started, so every node's total that anyone has seen stays the same.
import { ancestors, lowestCommonAncestor, type TreeNode } from '../../shared/tree';
import { batch } from '../db';
import type { Env } from '../index';
import {
  auditIf, conflict, guard, heldChildPlan, loadDept, notifyTurnOpened, setNodesIf, stale, submitWith, type SubmitResult,
} from './distribution';
import { notFound } from './masters';
import { childGrids, subtreeTotals } from './plan';

// ---------- board ----------

export type BoardRow = {
  nodeId: number; name: string; parentId: number | null; manager: string | null; managerEmail: string | null;
  status: string; openedAt: string | null; submittedAt: string | null; link: string;
};

/** Every month_node of the department in tree order (parents first, siblings by name), with its screen link. */
export async function monthBoard(db: D1Database, appUrl: string, monthId: number, deptId: number): Promise<BoardRow[]> {
  const [head, rows] = await batch(db, [
    db.prepare(`SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`).bind(monthId, deptId),
    db.prepare(
      `SELECT mn.node_id AS nodeId, mn.name, mn.parent_id AS parentId, u.name AS manager, u.email AS managerEmail,
              mn.status, mn.opened_at AS openedAt, mn.submitted_at AS submittedAt
       FROM month_nodes mn LEFT JOIN users u ON u.id = mn.manager_user_id
       WHERE mn.month_id = ? AND mn.dept_id = ?
       ORDER BY mn.name, mn.node_id`,
    ).bind(monthId, deptId),
  ]);
  if (head!.results.length === 0) throw notFound();
  const list = rows!.results as Omit<BoardRow, 'link'>[];
  const byId = new Map(list.map((r) => [r.nodeId, r]));
  const kids = new Map<number | null, number[]>();
  for (const r of list) {
    const p = r.parentId !== null && byId.has(r.parentId) ? r.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), r.nodeId]);
  }
  const order: number[] = [];
  const stack = [...(kids.get(null) ?? [])].reverse();
  while (stack.length) {
    const id = stack.pop()!;
    order.push(id);
    stack.push(...[...(kids.get(id) ?? [])].reverse());
  }
  const base = appUrl.replace(/\/+$/, '');
  return order.map((id) => ({ ...byId.get(id)!, link: `${base}/m/${monthId}/n/${id}` }));
}

// ---------- reopen ----------

/** The node's descendants (month_node ids), as a recursive CTE `sub(id)`; binds monthId, nodeId, monthId. */
const SUBTREE = `WITH RECURSIVE sub(id) AS (
    SELECT node_id FROM month_nodes WHERE month_id = ? AND parent_id = ?
    UNION SELECT mn.node_id FROM month_nodes mn JOIN sub ON mn.parent_id = sub.id WHERE mn.month_id = ?)`;
const heldBelow = (monthId: number, nodeId: number) => ({
  sql: `EXISTS (${SUBTREE} SELECT 1 FROM month_nodes h WHERE h.month_id = ? AND h.node_id IN (SELECT id FROM sub) AND h.held_status IS NOT NULL)`,
  args: [monthId, nodeId, monthId, monthId],
});

/**
 * Reopens a submitted node: it goes back to in_progress with its baseline
 * kept (spec section 6: never reset by a reopen) and its draft = the values
 * it submitted; every descendant gets held_status = its status, status
 * waiting and version+1 (so any in-flight draft or submit below fails its
 * version guard). The node's resubmit then restores or clears each child's
 * subtree (see submitWith / heldChildPlan). A complete department runs again.
 *
 * Refused (409 reopen_pending_below) while a reopen below the node is still
 * pending (some descendant is held): holds do not nest.
 */
export async function reopenNode(
  db: D1Database, env: Env, actorId: number, monthId: number, nodeId: number,
): Promise<{ status: 'in_progress'; version: number }> {
  const held = heldBelow(monthId, nodeId);
  const [r] = await batch(db, [
    db.prepare(
      `SELECT n.status, n.version, n.dept_id, ${held.sql} AS held_below
       FROM month_nodes n WHERE n.month_id = ? AND n.node_id = ?`,
    ).bind(...held.args, monthId, nodeId),
  ]);
  const node = r!.results[0] as { status: string; version: number; dept_id: number; held_below: number } | undefined;
  if (!node) throw notFound();
  if (node.status !== 'submitted') throw conflict('not_submitted');
  if (node.held_below) throw conflict('reopen_pending_below');

  const now = new Date().toISOString();
  const v = node.version;
  // The audit row and the node's UPDATE are guarded by the node as read and
  // nothing held below; the rest only run once the node is reopened at v+1,
  // and each descendant only if not already held (a racing reopen).
  const asRead = guard(monthId, nodeId, v, 'submitted');
  const notHeld = { sql: `NOT ${held.sql}`, args: held.args };
  const reopened = guard(monthId, nodeId, v + 1, 'in_progress');
  const res = await batch(db, [
    auditIf(db, { sql: `(${asRead.sql} AND ${notHeld.sql})`, args: [...asRead.args, ...notHeld.args] },
      actorId, 'node.reopen', monthId, nodeId, { version: v + 1 }, now),
    db.prepare(
      `UPDATE month_nodes SET status = 'in_progress', opened_at = ?, submitted_at = NULL, version = version + 1
       WHERE month_id = ? AND node_id = ? AND version = ? AND status = 'submitted' AND ${notHeld.sql}`,
    ).bind(now, monthId, nodeId, v, ...notHeld.args),
    db.prepare(
      `${SUBTREE}
       UPDATE month_nodes SET held_status = status, status = 'waiting', version = version + 1
       WHERE month_id = ? AND node_id IN (SELECT id FROM sub) AND held_status IS NULL AND ${reopened.sql}`,
    ).bind(monthId, nodeId, monthId, monthId, ...reopened.args),
    db.prepare(
      `UPDATE month_depts SET state = 'running' WHERE month_id = ? AND dept_id = ? AND state = 'complete' AND ${reopened.sql}`,
    ).bind(monthId, node.dept_id, ...reopened.args),
  ]);
  if ((res[1]!.meta.changes ?? 0) !== 1) throw stale();
  await notifyTurnOpened(env, monthId, [nodeId]);
  return { status: 'in_progress', version: v + 1 };
}

// ---------- push forward ----------

/**
 * Admin push of an in_progress node: submits its saved draft when that passes
 * the rules, else its baseline (the starting numbers), through the normal
 * submit (rescaling, held children, completion). The own-manager check is
 * skipped on this path only, so a node without a manager can still progress.
 */
export async function pushNode(
  db: D1Database, env: Env, actorId: number, monthId: number, nodeId: number,
): Promise<SubmitResult & { used: 'draft' | 'baseline' }> {
  const { result, used } = await submitWith(db, env, monthId, nodeId, actorId, 'auto', {
    audit: (u) => ({ action: 'node.push', detail: { used: u } }),
  });
  return { used, ...result };
}

// ---------- live-tree changes in open months ----------

export type LeafMove = { leafId: number; fromParent: number; toParent: number };

export type TreeChange =
  | { kind: 'move_leaf' | 'move_node'; id: number; fromParent: number; toParent: number }
  | { kind: 'move_leaves'; moves: LeafMove[] }
  | { kind: 'manager'; nodeId: number; userId: number | null }
  /** Bulk variant of 'manager' (bulk import): same rule, one set-based batch for every node. */
  | { kind: 'managers'; changes: { nodeId: number; userId: number | null }[] };

export type TreeChangeResult = { appliedMonths: number[]; skippedMonths: number[]; error?: string };

const EMPTY: TreeChangeResult = { appliedMonths: [], skippedMonths: [] };

/**
 * Carries a live-tree edit into the months that are open (owner decision,
 * spec section 5):
 *   manager -> applied to every running and loading month containing the
 *     node (so a replaced manager loses his edit rights at once);
 *   moves -> a loading month always takes it; a running month only when every
 *     month_node on the paths from the old and the new parent up to and
 *     including their lowest common ancestor is waiting and not held (a held
 *     node is a started one); else, and in complete months, it is skipped
 *     (it applies from the next month). Each month is judged on its own copy
 *     of the tree: its own current parent, and a new parent the month does
 *     not have means skipped.
 * One audit row 'tree.apply_month' {appliedMonths, skippedMonths}.
 */
export async function applyTreeChangeToOpenMonths(
  db: D1Database, change: TreeChange, actorId: number | null = null,
): Promise<TreeChangeResult> {
  if (change.kind === 'manager') return applyManager(db, change.nodeId, change.userId, actorId);
  if (change.kind === 'managers') return applyManagers(db, change.changes, actorId);
  if (change.kind === 'move_node') return applyMoves(db, 'node', [{ id: change.id, to: change.toParent }], actorId, change.id);
  const moves = change.kind === 'move_leaves'
    ? change.moves.map((m) => ({ id: m.leafId, to: m.toParent }))
    : [{ id: change.id, to: change.toParent }];
  return applyMoves(db, 'leaf', moves, actorId, null);
}

const parseResult = (json: string): TreeChangeResult => JSON.parse(json) as TreeChangeResult;

async function applyManager(db: D1Database, nodeId: number, userId: number | null, actorId: number | null): Promise<TreeChangeResult> {
  const months = (state: string) =>
    `json((SELECT json_group_array(month_id) FROM (
       SELECT mn.month_id FROM month_nodes mn JOIN month_depts md ON md.month_id = mn.month_id AND md.dept_id = mn.dept_id
       WHERE mn.node_id = ? AND md.state ${state} ORDER BY mn.month_id)))`;
  const [audit] = await batch(db, [
    // First, so it sees the months the UPDATE below changes.
    db.prepare(
      `INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json)
       SELECT ?, ?, 'tree.apply_month', NULL, ?,
              json_object('appliedMonths', ${months(`IN ('running', 'loading')`)}, 'skippedMonths', ${months(`= 'complete'`)})
       WHERE EXISTS (SELECT 1 FROM month_nodes WHERE node_id = ?)
       RETURNING detail_json`,
    ).bind(new Date().toISOString(), actorId, nodeId, nodeId, nodeId, nodeId),
    db.prepare(
      `UPDATE month_nodes SET manager_user_id = ?
       WHERE node_id = ? AND EXISTS (SELECT 1 FROM month_depts md WHERE md.month_id = month_nodes.month_id
                                       AND md.dept_id = month_nodes.dept_id AND md.state IN ('running', 'loading'))`,
    ).bind(userId, nodeId),
  ]);
  const row = audit!.results[0] as { detail_json: string } | undefined;
  return row ? parseResult(row.detail_json) : { ...EMPTY };
}

/**
 * applyManager for many nodes at once: two statements whatever the count (the
 * audit row, node_id NULL, listing the months; then the UPDATE). Applied to
 * every running and loading month containing the node, like a single change.
 */
async function applyManagers(
  db: D1Database, changes: { nodeId: number; userId: number | null }[], actorId: number | null,
): Promise<TreeChangeResult> {
  if (changes.length === 0) return { ...EMPTY };
  const payload = JSON.stringify(changes.map((c) => ({ n: c.nodeId, u: c.userId })));
  const nodeIds = `(SELECT json_extract(value, '$.n') FROM json_each(?))`;
  const months = (state: string) =>
    `json((SELECT json_group_array(month_id) FROM (
       SELECT DISTINCT mn.month_id FROM month_nodes mn JOIN month_depts md ON md.month_id = mn.month_id AND md.dept_id = mn.dept_id
       WHERE mn.node_id IN ${nodeIds} AND md.state ${state} ORDER BY mn.month_id)))`;
  const [audit] = await batch(db, [
    db.prepare(
      `INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json)
       SELECT ?, ?, 'tree.apply_month', NULL, NULL,
              json_object('appliedMonths', ${months(`IN ('running', 'loading')`)}, 'skippedMonths', ${months(`= 'complete'`)})
       WHERE EXISTS (SELECT 1 FROM month_nodes WHERE node_id IN ${nodeIds})
       RETURNING detail_json`,
    ).bind(new Date().toISOString(), actorId, payload, payload, payload),
    db.prepare(
      `WITH j AS MATERIALIZED (SELECT json_extract(value, '$.n') AS n, json_extract(value, '$.u') AS u FROM json_each(?))
       UPDATE month_nodes SET manager_user_id = j.u FROM j
       WHERE month_nodes.node_id = j.n AND EXISTS (SELECT 1 FROM month_depts md WHERE md.month_id = month_nodes.month_id
                                                     AND md.dept_id = month_nodes.dept_id AND md.state IN ('running', 'loading'))`,
    ).bind(payload),
  ]);
  const row = audit!.results[0] as { detail_json: string } | undefined;
  return row ? parseResult(row.detail_json) : { ...EMPTY };
}

type Target = { month_id: number; id: number; cur: number; dept_id: number; state: string };
type MonthNode = { month_id: number; node_id: number; parent_id: number | null; status: string; held_status: string | null };
/** One (month, from, to) move group: `ok` is the in-memory verdict, re-checked in SQL; `ids` are the leaves/node it moves. */
type Group = { m: number; d: number; st: string; f: number; t: number; ok: 0 | 1; path: number[]; ids: number[] };

/**
 * Set-based moves: targets are grouped by (month, current parent, new parent)
 * and each distinct group's paths are checked once, in memory, on the month's
 * own tree. Writes are three statements whatever the number of leaves: the
 * audit row (whose detail SQLite computes from the same re-check, so it is
 * exactly what the move does), a version bump of every node on an applied
 * path (so an in-flight submit or open above it fails its guard), the move.
 */
async function applyMoves(
  db: D1Database, what: 'leaf' | 'node', moves: { id: number; to: number }[], actorId: number | null, auditNode: number | null,
): Promise<TreeChangeResult> {
  if (moves.length === 0) return { ...EMPTY };
  const toById = new Map(moves.map((m) => [m.id, m.to]));
  const ids = JSON.stringify([...toById.keys()]);
  // Only open (running/loading) months are read and sent: complete months
  // only need to be named as skipped, so they cost one EXISTS probe each and
  // nothing grows with the leaf count times the month history. CROSS JOIN
  // keeps month_depts as the outer loop, so the target rows are found by
  // primary key (month_id, leaf_id / node_id) in open months only.
  const [table, idCol, curCol, live] = what === 'leaf'
    ? ['month_leaves', 'leaf_id', 'node_id', 'leaves'] as const
    : ['month_nodes', 'node_id', 'parent_id', 'nodes'] as const;
  const deptOf = `(SELECT DISTINCT dept_id FROM ${live} WHERE id IN (SELECT value FROM json_each(?)))`;
  const targetSql =
    `SELECT t.month_id, t.${idCol} AS id, t.${curCol} AS cur, t.dept_id, md.state
     FROM month_depts md CROSS JOIN ${table} t
     WHERE md.state IN ('running', 'loading') AND md.dept_id IN ${deptOf}
       AND t.month_id = md.month_id AND t.${idCol} IN (SELECT value FROM json_each(?))`;
  const [targetsRes, treeRes, completeRes] = await batch(db, [
    db.prepare(targetSql).bind(ids, ids),
    db.prepare(
      `SELECT mn.month_id, mn.node_id, mn.parent_id, mn.status, mn.held_status
       FROM month_depts md CROSS JOIN month_nodes mn
       WHERE md.state IN ('running', 'loading') AND md.dept_id IN ${deptOf}
         AND mn.month_id = md.month_id AND mn.dept_id = md.dept_id
         AND md.month_id IN (SELECT t.month_id FROM (${targetSql}) t)`,
    ).bind(ids, ids, ids),
    db.prepare(
      `SELECT md.month_id FROM month_depts md
       WHERE md.state = 'complete' AND md.dept_id IN ${deptOf}
         AND EXISTS (SELECT 1 FROM ${table} t WHERE t.month_id = md.month_id AND t.${idCol} IN (SELECT value FROM json_each(?)))
       ORDER BY md.month_id`,
    ).bind(ids, ids),
  ]);
  const targets = targetsRes!.results as Target[];
  const completeMonths = (completeRes!.results as { month_id: number }[]).map((r) => r.month_id);
  const trees = new Map<number, MonthNode[]>();
  for (const n of treeRes!.results as MonthNode[]) trees.set(n.month_id, [...(trees.get(n.month_id) ?? []), n]);

  const groups = new Map<string, Group>();
  for (const t of targets) {
    const to = toById.get(t.id)!;
    if (t.cur === to) continue; // already there
    const key = `${t.month_id}:${t.cur}:${to}`;
    let g = groups.get(key);
    if (!g) {
      g = { m: t.month_id, d: t.dept_id, st: t.state, f: t.cur, t: to, ok: 0, path: [], ids: [] };
      judge(g, trees.get(t.month_id) ?? [], what === 'node' ? t.id : null);
      groups.set(key, g);
    }
    g.ids.push(t.id);
  }
  if (groups.size === 0 && completeMonths.length === 0) return { ...EMPTY };

  const payload = JSON.stringify([...groups.values()]);
  const cte = `WITH g AS MATERIALIZED (
      SELECT json_extract(value, '$.m') AS m, json_extract(value, '$.d') AS d, json_extract(value, '$.st') AS st,
             json_extract(value, '$.f') AS f, json_extract(value, '$.t') AS t, json_extract(value, '$.ok') AS ok,
             json_extract(value, '$.path') AS path, json_extract(value, '$.ids') AS ids
      FROM json_each(?)),
    gok AS MATERIALIZED (
      SELECT * FROM g WHERE g.ok = 1
        AND EXISTS (SELECT 1 FROM month_depts md WHERE md.month_id = g.m AND md.dept_id = g.d AND md.state = g.st)
        AND EXISTS (SELECT 1 FROM month_nodes n WHERE n.month_id = g.m AND n.node_id = g.t)
        AND NOT EXISTS (SELECT 1 FROM json_each(g.path) x JOIN month_nodes p ON p.month_id = g.m AND p.node_id = x.value
                        WHERE p.status <> 'waiting' OR p.held_status IS NOT NULL))`;
  const months = (from: string) => `json((SELECT json_group_array(m) FROM (SELECT DISTINCT m FROM ${from} ORDER BY m)))`;
  const moveSql = what === 'leaf'
    ? `UPDATE month_leaves SET node_id = j.t FROM j
       WHERE month_leaves.month_id = j.m AND month_leaves.leaf_id = j.id AND month_leaves.node_id = j.f`
    : `UPDATE month_nodes SET parent_id = j.t FROM j
       WHERE month_nodes.month_id = j.m AND month_nodes.node_id = j.id AND month_nodes.parent_id = j.f`;
  const [audit] = await batch(db, [
    db.prepare(
      `${cte}
       INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json)
       SELECT ?, ?, 'tree.apply_month', NULL, ?, json_object(
         'appliedMonths', ${months('gok')},
         'skippedMonths', ${months(`(SELECT m FROM g WHERE NOT EXISTS (SELECT 1 FROM gok WHERE gok.m = g.m AND gok.f = g.f AND gok.t = g.t))
                                     UNION SELECT value AS m FROM json_each(?)`)})
       RETURNING detail_json`,
    ).bind(payload, new Date().toISOString(), actorId, auditNode, JSON.stringify(completeMonths)),
    db.prepare(
      `${cte}, x AS MATERIALIZED (SELECT DISTINCT gok.m AS m, p.value AS id FROM gok, json_each(gok.path) p)
       UPDATE month_nodes SET version = version + 1 FROM x
       WHERE month_nodes.month_id = x.m AND month_nodes.node_id = x.id`,
    ).bind(payload),
    db.prepare(
      `${cte}, j AS MATERIALIZED (SELECT gok.m AS m, gok.f AS f, gok.t AS t, i.value AS id FROM gok, json_each(gok.ids) i)
       ${moveSql}`,
    ).bind(payload),
  ]);
  return parseResult((audit!.results[0] as { detail_json: string }).detail_json);
}

/** Sets `g.ok` and `g.path` for a loading or running month. `moving`: the node being moved (cycle check). */
function judge(g: Group, tree: MonthNode[], moving: number | null): void {
  const nodes: TreeNode[] = tree.map((n) => ({ id: n.node_id, parent_id: n.parent_id }));
  const byId = new Map(tree.map((n) => [n.node_id, n]));
  if (!byId.has(g.t) || !byId.has(g.f)) return; // the month does not have the new parent
  if (moving !== null && (g.t === moving || ancestors(nodes, g.t).includes(moving))) return; // would be a cycle here
  if (g.st === 'loading') {
    g.ok = 1;
    return;
  }
  const lca = lowestCommonAncestor(nodes, g.f, g.t);
  if (lca === null) return;
  const upTo = (from: number): number[] => {
    const chain = [from, ...ancestors(nodes, from)];
    return chain.slice(0, chain.indexOf(lca) + 1);
  };
  g.path = [...new Set([...upTo(g.f), ...upTo(g.t)])];
  g.ok = g.path.every((id) => byId.get(id)!.status === 'waiting' && byId.get(id)!.held_status === null) ? 1 : 0;
}
