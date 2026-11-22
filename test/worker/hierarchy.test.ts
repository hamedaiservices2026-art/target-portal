import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';

type Json = Record<string, any>;

async function addUser(username: string, role: 'admin' | 'manager' = 'manager', active = 1): Promise<number> {
  const { hash, salt } = await hashPassword('password-123');
  const res = await run(
    env.DB,
    `INSERT INTO users(username, name, pw_hash, pw_salt, role, active) VALUES (?, ?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role, active,
  );
  return res.lastRowId;
}

async function sidFor(username: string): Promise<string> {
  const res = await SELF.fetch('http://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password-123' }),
  });
  expect(res.status).toBe(200);
  return /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

let sid: string;
let tt: number; // department ids
let kam: number;
let mgrId: number;

function call(method: string, path: string, body?: unknown, cookie: string | null = sid): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `sid=${cookie}`;
  return SELF.fetch(`http://x/api/admin${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : body === undefined ? '{}' : JSON.stringify(body),
  });
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

async function mkNode(deptId: number, name: string, parentId: number | null, managerUserId: number | null = null): Promise<number> {
  const res = await call('POST', '/nodes', { deptId, parentId, name, managerUserId });
  expect(res.status, name).toBe(201);
  return (await json(res)).node.id;
}
async function mkLeaf(deptId: number, nodeId: number, deliverySystem: string, routeCode: string, label?: string): Promise<number> {
  const res = await call('POST', '/leaves', { deptId, nodeId, deliverySystem, routeCode, label });
  expect(res.status, routeCode).toBe(201);
  return (await json(res)).leaf.id;
}
const count = async (table: string): Promise<number> => (await one<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM ${table}`))!.n;
const auditActions = async (): Promise<string[]> =>
  (await all<{ action: string }>(env.DB, `SELECT action FROM audit ORDER BY id`)).map((r) => r.action);

beforeEach(async () => {
  for (const t of ['audit', 'leaves', 'nodes', 'sessions', 'login_failures', 'packs', 'departments', 'users']) {
    await run(env.DB, `DELETE FROM ${t}`);
  }
  await addUser('boss', 'admin');
  mgrId = await addUser('mgr', 'manager');
  sid = await sidFor('boss');
  tt = (await run(env.DB, `INSERT INTO departments(code, name) VALUES ('TT', 'Traditional Trade')`)).lastRowId;
  kam = (await run(env.DB, `INSERT INTO departments(code, name) VALUES ('KAM', 'Key Accounts')`)).lastRowId;
});

describe('access control', () => {
  it('401 anonymous, 403 for a manager, on every route', async () => {
    const mgr = await sidFor('mgr');
    const routes: [string, string][] = [
      ['GET', '/nodes'], ['POST', '/nodes'], ['PATCH', '/nodes/1'], ['DELETE', '/nodes/1'],
      ['GET', '/leaves'], ['POST', '/leaves'], ['PATCH', '/leaves/1'], ['DELETE', '/leaves/1'],
      ['POST', '/leaves/bulk-map'], ['GET', '/people'], ['POST', '/hierarchy/sync/preview'], ['POST', '/hierarchy/sync/apply'],
    ];
    for (const [m, p] of routes) {
      expect((await call(m, p, {}, null)).status, `${m} ${p} anon`).toBe(401);
      expect((await call(m, p, {}, mgr)).status, `${m} ${p} manager`).toBe(403);
    }
  });
});

describe('nodes', () => {
  it('creates a tree and lists it flat, filtered by department', async () => {
    const root = await mkNode(tt, 'TT Head', null, mgrId);
    const area = await mkNode(tt, 'Riyadh', root);
    await mkNode(kam, 'KAM Head', null);
    const res = await call('GET', `/nodes?dept=${tt}`);
    expect(res.status).toBe(200);
    expect((await json(res)).nodes).toEqual([
      { id: root, parent_id: null, name: 'TT Head', manager_user_id: mgrId },
      { id: area, parent_id: root, name: 'Riyadh', manager_user_id: null },
    ]);
    expect((await json(await call('GET', '/nodes'))).nodes).toHaveLength(3);
    expect((await call('GET', '/nodes?dept=abc')).status).toBe(400);
    expect(await auditActions()).toEqual(['node.create', 'node.create', 'node.create']);
  });

  it('allows only one root per department (409), but one per department', async () => {
    await mkNode(tt, 'TT Head', null);
    const res = await call('POST', '/nodes', { deptId: tt, parentId: null, name: 'Second Head' });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('conflict');
    await mkNode(kam, 'KAM Head', null); // another department is fine
    expect(await count('nodes')).toBe(2);
  });

  it('409 on a duplicate name within a department, 400 on bad input', async () => {
    const root = await mkNode(tt, 'TT Head', null);
    await mkNode(tt, 'Riyadh', root);
    expect((await call('POST', '/nodes', { deptId: tt, parentId: root, name: 'Riyadh' })).status).toBe(409);
    const bads: unknown[] = [
      { deptId: tt, parentId: root, name: '  ' },
      { deptId: tt, parentId: root },
      { deptId: 'x', parentId: root, name: 'A' },
      { deptId: 99999, parentId: null, name: 'A' }, // unknown department
      { deptId: tt, parentId: 99999, name: 'A' }, // unknown parent
      { deptId: tt, parentId: root, name: 'A', managerUserId: 99999 },
      { deptId: tt, name: 'A' }, // parentId missing
    ];
    for (const b of bads) expect((await call('POST', '/nodes', b)).status, JSON.stringify(b)).toBe(400);
  });

  it('rejects a parent from another department and a non-active manager', async () => {
    const root = await mkNode(tt, 'TT Head', null);
    const kroot = await mkNode(kam, 'KAM Head', null);
    expect((await call('POST', '/nodes', { deptId: tt, parentId: kroot, name: 'X' })).status).toBe(400);
    const off = await addUser('off', 'manager', 0);
    const res = await call('POST', '/nodes', { deptId: tt, parentId: root, name: 'X', managerUserId: off });
    expect(res.status).toBe(400);
    const ok = await call('POST', '/nodes', { deptId: tt, parentId: root, name: 'X', managerUserId: mgrId });
    expect(ok.status).toBe(201);
  });

  it('rejects a cycle (self and descendant) and cross-department moves', async () => {
    const root = await mkNode(tt, 'TT Head', null);
    const a = await mkNode(tt, 'A', root);
    const b = await mkNode(tt, 'B', a);
    const c = await mkNode(tt, 'C', b);
    expect((await call('PATCH', `/nodes/${a}`, { parentId: a })).status).toBe(400);
    expect((await call('PATCH', `/nodes/${a}`, { parentId: c })).status).toBe(400);
    expect((await call('PATCH', `/nodes/${root}`, { parentId: c })).status).toBe(400);
    const kroot = await mkNode(kam, 'KAM Head', null);
    expect((await call('PATCH', `/nodes/${a}`, { parentId: kroot })).status).toBe(400);
    const rows = await all<{ id: number; parent_id: number | null }>(env.DB, `SELECT id, parent_id FROM nodes WHERE dept_id = ?`, tt);
    expect(rows.find((r) => r.id === a)!.parent_id).toBe(root);
  });

  it('moves a node, changes its manager and renames it; reports treeChange', async () => {
    const root = await mkNode(tt, 'TT Head', null);
    const a = await mkNode(tt, 'A', root);
    const b = await mkNode(tt, 'B', root);
    const move = await call('PATCH', `/nodes/${b}`, { parentId: a });
    expect(move.status).toBe(200);
    const mv = await json(move);
    expect(mv.node).toEqual({ id: b, parent_id: a, name: 'B', manager_user_id: null });
    expect(mv.treeChange).toEqual({ appliedMonths: [], skippedMonths: [] });

    const mgr = await json(await call('PATCH', `/nodes/${b}`, { managerUserId: mgrId, name: 'B2' }));
    expect(mgr.node).toEqual({ id: b, parent_id: a, name: 'B2', manager_user_id: mgrId });
    expect(mgr.treeChange).toEqual({ appliedMonths: [], skippedMonths: [] });

    const unset = await json(await call('PATCH', `/nodes/${b}`, { managerUserId: null }));
    expect(unset.node.manager_user_id).toBeNull();

    const rename = await json(await call('PATCH', `/nodes/${b}`, { name: 'B3' }));
    expect(rename.treeChange).toBeNull();

    // no-op writes no audit row
    const before = (await auditActions()).length;
    expect((await call('PATCH', `/nodes/${b}`, { name: 'B3' })).status).toBe(200);
    expect((await auditActions()).length).toBe(before);

    expect((await call('PATCH', `/nodes/${b}`, {})).status).toBe(400);
    expect((await call('PATCH', '/nodes/99999', { name: 'Z' })).status).toBe(404);
    expect((await call('PATCH', `/nodes/${b}`, { managerUserId: 99999 })).status).toBe(400);
    expect((await call('PATCH', `/nodes/${b}`, { name: 'A' })).status).toBe(409); // duplicate name
    expect((await call('PATCH', `/nodes/${b}`, { parentId: null })).status).toBe(409); // second root
  });

  it('refuses to delete a node with child nodes or leaves, deletes an empty one', async () => {
    const root = await mkNode(tt, 'TT Head', null);
    const a = await mkNode(tt, 'A', root);
    const b = await mkNode(tt, 'B', root);
    await mkLeaf(tt, b, 'Presell – TT', 'R1');
    expect((await call('DELETE', `/nodes/${root}`)).status).toBe(409);
    expect((await call('DELETE', `/nodes/${b}`)).status).toBe(409);
    expect(await count('nodes')).toBe(3);
    expect((await call('DELETE', `/nodes/${a}`)).status).toBe(200);
    expect(await count('nodes')).toBe(2);
    expect((await call('DELETE', `/nodes/${a}`)).status).toBe(404);
    expect(await auditActions()).toContain('node.delete');
  });
});

describe('leaves', () => {
  it('creates, lists, moves, relabels and deletes a leaf, keeping codes exactly', async () => {
    const root = await mkNode(tt, 'TT Head', null);
    const a = await mkNode(tt, 'A', root);
    const b = await mkNode(tt, 'B', root);
    const res = await call('POST', '/leaves', { deptId: tt, nodeId: a, deliverySystem: '  Presell – TT ', routeCode: ' r-01 ', label: 'Route 1' });
    expect(res.status).toBe(201);
    const leaf = (await json(res)).leaf;
    expect(leaf).toEqual({ id: leaf.id, dept_id: tt, delivery_system: 'Presell – TT', route_code: 'r-01', node_id: a, label: 'Route 1' });
    const noLabel = (await json(await call('POST', '/leaves', { deptId: tt, nodeId: a, deliverySystem: 'Presell – TT', routeCode: 'R2' }))).leaf;
    expect(noLabel.label).toBe('R2'); // label is NOT NULL; defaults to the route code

    expect((await json(await call('GET', `/leaves?dept=${tt}`))).leaves).toHaveLength(2);
    expect((await json(await call('GET', `/leaves?dept=${kam}`))).leaves).toHaveLength(0);

    const mv = await json(await call('PATCH', `/leaves/${leaf.id}`, { nodeId: b, label: 'Renamed' }));
    expect(mv.leaf).toMatchObject({ node_id: b, label: 'Renamed' });
    expect(mv.treeChange).toEqual({ appliedMonths: [], skippedMonths: [] });
    const lbl = await json(await call('PATCH', `/leaves/${leaf.id}`, { label: 'Again' }));
    expect(lbl.treeChange).toBeNull();

    expect((await call('DELETE', `/leaves/${leaf.id}`)).status).toBe(200);
    expect((await call('DELETE', `/leaves/${leaf.id}`)).status).toBe(404);
    expect(await auditActions()).toEqual([
      'node.create', 'node.create', 'node.create', 'leaf.create', 'leaf.create', 'leaf.update', 'leaf.update', 'leaf.delete',
    ]);
  });

  it('validates: duplicate route 409, node from another department 400, blanks 400', async () => {
    const root = await mkNode(tt, 'TT Head', null);
    const kroot = await mkNode(kam, 'KAM Head', null);
    await mkLeaf(tt, root, 'DS', 'R1');
    expect((await call('POST', '/leaves', { deptId: tt, nodeId: root, deliverySystem: 'DS', routeCode: 'R1' })).status).toBe(409);
    expect((await call('POST', '/leaves', { deptId: kam, nodeId: kroot, deliverySystem: 'DS', routeCode: 'R1' })).status).toBe(409);
    // case differs -> a different route (kept exactly)
    expect((await call('POST', '/leaves', { deptId: tt, nodeId: root, deliverySystem: 'ds', routeCode: 'R1' })).status).toBe(201);
    expect((await call('POST', '/leaves', { deptId: tt, nodeId: kroot, deliverySystem: 'DS', routeCode: 'R9' })).status).toBe(400);
    expect((await call('POST', '/leaves', { deptId: tt, nodeId: 99999, deliverySystem: 'DS', routeCode: 'R9' })).status).toBe(400);
    expect((await call('POST', '/leaves', { deptId: tt, nodeId: root, deliverySystem: ' ', routeCode: 'R9' })).status).toBe(400);
    expect((await call('POST', '/leaves', { deptId: tt, nodeId: root, deliverySystem: 'DS', routeCode: 5 })).status).toBe(400);
    const id = await mkLeaf(tt, root, 'DS', 'R2');
    expect((await call('PATCH', `/leaves/${id}`, { nodeId: kroot })).status).toBe(400);
    expect((await call('PATCH', `/leaves/${id}`, {})).status).toBe(400);
    expect((await call('PATCH', '/leaves/99999', { label: 'x' })).status).toBe(404);
  });
});

describe('bulk-map', () => {
  async function setup() {
    const root = await mkNode(tt, 'TT Head', null);
    const a = await mkNode(tt, 'Area A', root);
    const b = await mkNode(tt, 'Area B', root);
    return { root, a, b };
  }
  const leafRows = () =>
    all<{ delivery_system: string; route_code: string; node_id: number; label: string }>(
      env.DB, `SELECT delivery_system, route_code, node_id, label FROM leaves ORDER BY delivery_system, route_code`);

  it('maps rows, then a re-run moves leaves and reports counts', async () => {
    const { a, b } = await setup();
    const first = await call('POST', '/leaves/bulk-map', {
      deptId: tt,
      rows: [
        { deliverySystem: 'Presell – TT', routeCode: 'R1', nodeName: 'Area A', label: 'One' },
        { deliverySystem: 'Presell – TT', routeCode: 'R2', nodeName: 'Area A' },
        { deliverySystem: 'Van Sales', routeCode: 'R1', nodeName: 'Area B' },
      ],
    });
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({ created: 3, moved: 0, unchanged: 0, treeChange: null });
    expect(await leafRows()).toEqual([
      { delivery_system: 'Presell – TT', route_code: 'R1', node_id: a, label: 'One' },
      { delivery_system: 'Presell – TT', route_code: 'R2', node_id: a, label: 'R2' },
      { delivery_system: 'Van Sales', route_code: 'R1', node_id: b, label: 'R1' },
    ]);

    const second = await call('POST', '/leaves/bulk-map', {
      deptId: tt,
      rows: [
        { deliverySystem: 'Presell – TT', routeCode: 'R1', nodeName: 'Area B' }, // moved, label kept
        { deliverySystem: 'Presell – TT', routeCode: 'R2', nodeName: 'Area A' }, // unchanged
        { deliverySystem: 'Van Sales', routeCode: 'R9', nodeName: 'Area B', label: 'New' }, // created
      ],
    });
    expect(await json(second)).toEqual({ created: 1, moved: 1, unchanged: 1, treeChange: { appliedMonths: [], skippedMonths: [] } });
    expect(await leafRows()).toEqual([
      { delivery_system: 'Presell – TT', route_code: 'R1', node_id: b, label: 'One' },
      { delivery_system: 'Presell – TT', route_code: 'R2', node_id: a, label: 'R2' },
      { delivery_system: 'Van Sales', route_code: 'R1', node_id: b, label: 'R1' },
      { delivery_system: 'Van Sales', route_code: 'R9', node_id: b, label: 'New' },
    ]);
    const audit = await all<{ action: string; detail_json: string }>(env.DB, `SELECT action, detail_json FROM audit WHERE action = 'leaves.bulk_map' ORDER BY id`);
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[1]!.detail_json)).toMatchObject({ deptId: tt, created: 1, moved: 1, unchanged: 1 });
  });

  it('writes nothing and reports the line when one node name is unknown', async () => {
    await setup();
    const res = await call('POST', '/leaves/bulk-map', {
      deptId: tt,
      rows: [
        { deliverySystem: 'DS', routeCode: 'R1', nodeName: 'Area A' },
        { deliverySystem: 'DS', routeCode: 'R2', nodeName: 'Nowhere' },
        { deliverySystem: 'DS', routeCode: 'R3', nodeName: 'Area B' },
      ],
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.errors).toEqual([{ line: 3, detail: expect.stringContaining('Nowhere') }]);
    expect(await count('leaves')).toBe(0);
    expect(await auditActions()).not.toContain('leaves.bulk_map');
  });

  it('collects every error: blanks, duplicates in the payload, other-department routes', async () => {
    const { root } = await setup();
    const kroot = await mkNode(kam, 'KAM Head', null);
    await mkLeaf(kam, kroot, 'DS', 'TAKEN');
    const res = await call('POST', '/leaves/bulk-map', {
      deptId: tt,
      rows: [
        { deliverySystem: 'DS', routeCode: 'R1', nodeName: 'Area A' }, // ok (line 2)
        { deliverySystem: ' ', routeCode: 'R2', nodeName: 'Area A' }, // line 3
        { deliverySystem: 'DS', routeCode: 'R1', nodeName: 'Area B' }, // line 4 duplicate
        { deliverySystem: 'DS', routeCode: 'TAKEN', nodeName: 'Area A' }, // line 5 other dept
        { deliverySystem: 'DS', routeCode: 'R5' }, // line 6 nodeName missing
        'oops', // line 7
      ],
    });
    expect(res.status).toBe(400);
    const lines = ((await json(res)).errors as { line: number }[]).map((e) => e.line);
    expect(lines).toEqual([3, 4, 5, 6, 7]);
    expect(await count('leaves')).toBe(1); // only the pre-existing KAM leaf
    void root;
  });

  it('validates the envelope', async () => {
    await setup();
    expect((await call('POST', '/leaves/bulk-map', { deptId: tt, rows: [] })).status).toBe(400);
    expect((await call('POST', '/leaves/bulk-map', { deptId: tt, rows: 'x' })).status).toBe(400);
    expect((await call('POST', '/leaves/bulk-map', { deptId: 99999, rows: [{ deliverySystem: 'DS', routeCode: 'R', nodeName: 'Area A' }] })).status).toBe(400);
    const tooMany = Array.from({ length: 5001 }, (_, i) => ({ deliverySystem: 'DS', routeCode: `R${i}`, nodeName: 'Area A' }));
    expect((await call('POST', '/leaves/bulk-map', { deptId: tt, rows: tooMany })).status).toBe(400);
  });

  it('maps a whole department (2000 routes) atomically within the statement budget', async () => {
    const { a, b } = await setup();
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      deliverySystem: 'Presell – TT', routeCode: `R${String(i).padStart(4, '0')}`, nodeName: i % 2 ? 'Area A' : 'Area B', label: `Route number ${i}`,
    }));
    const res = await call('POST', '/leaves/bulk-map', { deptId: tt, rows });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ created: 2000, moved: 0, unchanged: 0, treeChange: null });
    expect(await count('leaves')).toBe(2000);
    const again = await json(await call('POST', '/leaves/bulk-map', { deptId: tt, rows }));
    expect(again).toEqual({ created: 0, moved: 0, unchanged: 2000, treeChange: null });
    const flipped = rows.map((r) => ({ ...r, nodeName: r.nodeName === 'Area A' ? 'Area B' : 'Area A' }));
    expect(await json(await call('POST', '/leaves/bulk-map', { deptId: tt, rows: flipped }))).toEqual({ created: 0, moved: 2000, unchanged: 0, treeChange: { appliedMonths: [], skippedMonths: [] } });
    expect((await one<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM leaves WHERE node_id = ?`, a))!.n).toBe(1000);
    expect((await one<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM leaves WHERE node_id = ?`, b))!.n).toBe(1000);
  });
});

describe('whole hierarchy from one file', () => {
  const rows = [
    { head: 'Amir Elnagar', manager: 'Hussain', supervisor: 'Mahdi', route: '314037' },
    { head: 'Amir Elnagar', manager: 'Hussain', supervisor: 'Mahdi', route: '314038' },
    { head: 'Amir Elnagar', manager: 'Hussain', supervisor: 'Ali', route: '314039' },
    { head: 'Samir Najm', manager: 'Samir Najm', supervisor: 'Omar', route: '514001' },
  ];

  it('previews, asks for unknown heads, then builds every level and is idempotent', async () => {
    let r = await json(await call('POST', '/hierarchy/sync/preview', { rows }));
    expect(r.problems.map((p: Json) => p.detail)).toEqual(['pick the department of Amir Elnagar', 'pick the department of Samir Najm']);
    expect((await call('POST', '/hierarchy/sync/apply', { rows })).status).toBe(400);
    expect(await count('nodes')).toBe(0);

    const depts = { 'Amir Elnagar': tt, 'Samir Najm': kam };
    r = await json(await call('POST', '/hierarchy/sync/preview', { rows, depts }));
    expect(r.problems).toEqual([]);
    const amir = r.heads.find((h: Json) => h.head === 'Amir Elnagar');
    expect(amir).toMatchObject({ managers: 1, supervisors: 2, routes: 3, newNodes: 4, newRoutes: 3 });

    const res = await call('POST', '/hierarchy/sync/apply', { rows, depts });
    expect(res.status, await res.clone().text()).toBe(200);
    const nodes = await all<{ name: string; parent: string | null; dept_id: number }>(env.DB,
      `SELECT n.name, p.name AS parent, n.dept_id FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id ORDER BY n.id`);
    expect(nodes.filter((n) => n.dept_id === tt).map((n) => [n.name, n.parent])).toEqual([
      ['Amir Elnagar', null], ['Hussain', 'Amir Elnagar'], ['Mahdi', 'Hussain'], ['Ali', 'Hussain'],
    ]);
    // A manager with the Head's own name: the supervisors go straight under the Head.
    expect(nodes.filter((n) => n.dept_id === kam).map((n) => [n.name, n.parent])).toEqual([['Samir Najm', null], ['Omar', 'Samir Najm']]);
    const leaves = await all<{ route_code: string; node: string }>(env.DB,
      `SELECT l.route_code, n.name AS node FROM leaves l JOIN nodes n ON n.id = l.node_id ORDER BY l.route_code`);
    expect(leaves).toEqual([
      { route_code: '314037', node: 'Mahdi' }, { route_code: '314038', node: 'Mahdi' },
      { route_code: '314039', node: 'Ali' }, { route_code: '514001', node: 'Omar' },
    ]);

    // The same file again changes nothing; the head is now found by the top node's name.
    r = await json(await call('POST', '/hierarchy/sync/preview', { rows }));
    expect(r.problems).toEqual([]);
    expect(r.heads.every((h: Json) => h.match === 'root' && h.newNodes === 0 && h.movedNodes === 0 && h.newRoutes === 0 && h.movedRoutes === 0)).toBe(true);

    // A route moved to another supervisor in the file is moved in the portal.
    const moved = rows.map((x) => (x.route === '314038' ? { ...x, supervisor: 'Ali' } : x));
    r = await json(await call('POST', '/hierarchy/sync/preview', { rows: moved }));
    expect(r.heads.find((h: Json) => h.head === 'Amir Elnagar').movedRoutes).toBe(1);
    expect((await call('POST', '/hierarchy/sync/apply', { rows: moved })).status).toBe(200);
    expect((await one<{ node: string }>(env.DB, `SELECT n.name AS node FROM leaves l JOIN nodes n ON n.id = l.node_id WHERE route_code = '314038'`))!.node).toBe('Ali');
  });

  it('creates a new department for a Channel Head when asked', async () => {
    const one1 = [{ head: 'Samir Najm', manager: 'Omar', supervisor: '', route: 'R9' }];
    const r = await json(await call('POST', '/hierarchy/sync/preview', { rows: one1, depts: { 'Samir Najm': 'new' } }));
    expect(r.problems).toEqual([]);
    expect(r.heads[0]).toMatchObject({ match: 'new', newNodes: 2, newRoutes: 1 });
    expect((await call('POST', '/hierarchy/sync/apply', { rows: one1, depts: { 'Samir Najm': 'new' } })).status).toBe(200);
    const d = await one<{ id: number; code: string }>(env.DB, `SELECT id, code FROM departments WHERE name = 'Samir Najm'`);
    expect(d!.code).toBe('SN');
    expect((await one<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM leaves WHERE dept_id = ?`, d!.id))!.n).toBe(1);
  });

  it('reports duplicate routes and a node under two parents', async () => {
    const bad = [
      { head: 'H', manager: 'M1', supervisor: 'S', route: 'R1' },
      { head: 'H', manager: 'M2', supervisor: 'S', route: 'R2' },
      { head: 'H', manager: 'M1', supervisor: 'S', route: 'R1' },
    ];
    const r = await json(await call('POST', '/hierarchy/sync/preview', { rows: bad, depts: { H: tt } }));
    const text = r.problems.map((p: Json) => p.detail).join(' | ');
    expect(text).toMatch(/route R1 is also on line 2/);
    expect(text).toMatch(/S is under two different parents/);
  });

  it('lists everyone by position for the Users screen', async () => {
    const res = await call('POST', '/hierarchy/sync/apply', { rows, depts: { 'Amir Elnagar': tt, 'Samir Najm': kam } });
    expect(res.status).toBe(200);
    const { people } = await json(await call('GET', '/people'));
    const by = (pos: string) => people.filter((p: Json) => p.position === pos).map((p: Json) => [p.name, p.parent, p.routes]);
    expect(by('head')).toEqual(expect.arrayContaining([['Amir Elnagar', null, 3], ['Samir Najm', null, 1]]));
    expect(by('manager')).toEqual(expect.arrayContaining([['Hussain', 'Amir Elnagar', 3], ['Omar', 'Samir Najm', 1]]));
    expect(by('supervisor')).toEqual(expect.arrayContaining([['Mahdi', 'Hussain', 2], ['Ali', 'Hussain', 1]]));
  });
});
