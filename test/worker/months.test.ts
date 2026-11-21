import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';

type Json = Record<string, any>;

async function addUser(username: string, role: 'admin' | 'manager' = 'manager'): Promise<number> {
  const { hash, salt } = await hashPassword('password-123');
  const res = await run(
    env.DB,
    `INSERT INTO users(username, name, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role,
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
let mgrId: number;
let tt: number;
let mt: number;
let ttRoot: number;
let ttArea: number;
let r1: number; // TT leaves
let r2: number;
let r3: number;

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

const PACKS = ['A', 'B', 'C'];
const grid = (leafId: number, a = 1, b = 2, c = 3, extra: Json = {}): Json => ({
  leafId, deliverySystem: 'DS', routeCode: `R${leafId}`, salesmanId: `S${leafId}`, values: { A: a, B: b, C: c }, ...extra,
});

async function mkDept(code: string): Promise<number> {
  return (await run(env.DB, `INSERT INTO departments(code, name) VALUES (?, ?)`, code, code)).lastRowId;
}
async function mkNode(dept: number, name: string, parent: number | null, mgr: number | null = null): Promise<number> {
  return (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name, manager_user_id) VALUES (?, ?, ?, ?)`, dept, parent, name, mgr)).lastRowId;
}
async function mkLeaf(dept: number, node: number, route: string): Promise<number> {
  return (await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'DS', ?, ?, ?)`, dept, route, node, route)).lastRowId;
}
async function openMonth(period = '2026-10'): Promise<number> {
  const res = await call('POST', '/months', { period });
  expect(res.status).toBe(201);
  return (await json(res)).month.id;
}
async function mkFile(month: number, dept: number, name = 'file'): Promise<number> {
  const res = await call('POST', `/months/${month}/files`, { deptId: dept, name });
  expect(res.status).toBe(201);
  return (await json(res)).fileId;
}
const batchOf = (month: number, file: number, grids: Json[]) => call('POST', `/months/${month}/files/${file}/batch`, { grids });
const count = async (table: string): Promise<number> => (await one<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM ${table}`))!.n;
const auditActions = async (): Promise<string[]> =>
  (await all<{ action: string }>(env.DB, `SELECT action FROM audit ORDER BY id`)).map((r) => r.action);

beforeEach(async () => {
  for (const t of ['audit', 'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months', 'leaves', 'nodes',
    'sessions', 'login_failures', 'packs', 'departments', 'users']) {
    await run(env.DB, `DELETE FROM ${t}`);
  }
  await addUser('boss', 'admin');
  mgrId = await addUser('mgr');
  sid = await sidFor('boss');
  tt = await mkDept('TT');
  mt = await mkDept('MT');
  ttRoot = await mkNode(tt, 'TT head', null, mgrId);
  ttArea = await mkNode(tt, 'TT area', ttRoot);
  r1 = await mkLeaf(tt, ttArea, 'R1');
  r2 = await mkLeaf(tt, ttArea, 'R2');
  r3 = await mkLeaf(tt, ttRoot, 'R3');
  for (const [i, code] of PACKS.entries()) {
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES (?, 'CSD', 1, ?)`, code, i);
  }
  await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('OFF', 'Water', 0, 9)`);
});

describe('access control', () => {
  it('401 anonymous, 403 for a manager, on every route', async () => {
    const mgr = await sidFor('mgr');
    const routes: [string, string][] = [
      ['GET', '/months'], ['POST', '/months'], ['PATCH', '/months/1'], ['GET', '/months/1/context?dept=1'],
      ['POST', '/months/1/files'], ['POST', '/months/1/files/1/batch'],
      ['POST', '/months/1/depts/1/reset'], ['POST', '/months/1/depts/1/refresh-tree'], ['POST', '/months/1/depts/1/start'],
    ];
    for (const [m, p] of routes) {
      expect((await call(m, p, {}, null)).status, `${m} ${p} anon`).toBe(401);
      expect((await call(m, p, {}, mgr)).status, `${m} ${p} manager`).toBe(403);
    }
  });
});

describe('create / update / list', () => {
  it('snapshots active packs, copies the tree as waiting and every department as loading', async () => {
    const res = await call('POST', '/months', { period: '2026-10', deadline: '2026-10-25' });
    expect(res.status).toBe(201);
    const month = (await json(res)).month;
    expect(month).toMatchObject({ period: '2026-10', deadline: '2026-10-25' });

    const row = await one<{ packs_json: string }>(env.DB, `SELECT packs_json FROM months WHERE id = ?`, month.id);
    expect(JSON.parse(row!.packs_json)).toEqual([
      { code: 'A', grp: 'CSD', sort: 0 }, { code: 'B', grp: 'CSD', sort: 1 }, { code: 'C', grp: 'CSD', sort: 2 },
    ]);
    const nodes = await all<Json>(env.DB, `SELECT node_id, dept_id, parent_id, name, manager_user_id, status, version FROM month_nodes WHERE month_id = ? ORDER BY node_id`, month.id);
    expect(nodes).toEqual([
      { node_id: ttRoot, dept_id: tt, parent_id: null, name: 'TT head', manager_user_id: mgrId, status: 'waiting', version: 0 },
      { node_id: ttArea, dept_id: tt, parent_id: ttRoot, name: 'TT area', manager_user_id: null, status: 'waiting', version: 0 },
    ]);
    const depts = await all<Json>(env.DB, `SELECT dept_id, state FROM month_depts WHERE month_id = ? ORDER BY dept_id`, month.id);
    expect(depts).toEqual([{ dept_id: tt, state: 'loading' }, { dept_id: mt, state: 'loading' }]);
    expect(await auditActions()).toEqual(['month.create']);
    expect((await one<Json>(env.DB, `SELECT month_id, user_id FROM audit`))).toMatchObject({ month_id: month.id });
  });

  it('copies a large tree without a statement per row (budget is 40)', async () => {
    const root = await mkNode(mt, 'MT head', null);
    await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120) SELECT ?, ?, 'sub' || i FROM n`, mt, root);
    const id = await openMonth();
    expect((await one<{ n: number }>(env.DB, `SELECT COUNT(*) n FROM month_nodes WHERE month_id = ?`, id))!.n).toBe(2 + 1 + 120);
  });

  it('a second month for the same period is 409 and changes nothing', async () => {
    await openMonth();
    const before = [await count('months'), await count('month_nodes'), await count('audit')];
    const res = await call('POST', '/months', { period: '2026-10' });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('conflict');
    expect([await count('months'), await count('month_nodes'), await count('audit')]).toEqual(before);
  });

  it('validates period and deadline', async () => {
    for (const body of [
      {}, { period: '2026-13' }, { period: '2026-00' }, { period: '26-10' }, { period: 202610 },
      { period: '2026-10', deadline: '2026-02-30' }, { period: '2026-10', deadline: '25/10/2026' }, { period: '2026-10', deadline: 5 },
    ]) {
      expect((await call('POST', '/months', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await count('months')).toBe(0);
    expect((await call('POST', '/months', { period: '2026-10' })).status).toBe(201); // deadline optional
  });

  it('refuses to open a month with no active packs', async () => {
    await run(env.DB, `UPDATE packs SET active = 0`);
    expect((await call('POST', '/months', { period: '2026-10' })).status).toBe(400);
  });

  it('PATCH sets and clears the deadline, audits, 404 for an unknown month', async () => {
    const id = await openMonth();
    const res = await call('PATCH', `/months/${id}`, { deadline: '2026-11-02' });
    expect(res.status).toBe(200);
    expect((await json(res)).month.deadline).toBe('2026-11-02');
    expect((await call('PATCH', `/months/${id}`, { deadline: null })).status).toBe(200);
    expect((await one<Json>(env.DB, `SELECT deadline FROM months WHERE id = ?`, id))!.deadline).toBeNull();
    expect((await call('PATCH', `/months/${id}`, { deadline: 'soon' })).status).toBe(400);
    expect((await call('PATCH', `/months/${id}`, {})).status).toBe(400);
    expect((await call('PATCH', '/months/999', { deadline: null })).status).toBe(404);
    expect(await auditActions()).toEqual(['month.create', 'month.update', 'month.update']);
  });

  it('lists months with department states and counts', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    await batchOf(id, f, [grid(r1)]);
    const res = await call('GET', '/months');
    expect(res.status).toBe(200);
    const { months } = await json(res);
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ id, period: '2026-10' });
    expect(months[0].depts).toEqual([
      { deptId: mt, code: 'MT', name: 'MT', state: 'loading', files: 0, leaves: 0 },
      { deptId: tt, code: 'TT', name: 'TT', state: 'loading', files: 1, leaves: 1 },
    ]);
  });
});

describe('context', () => {
  it('returns snapshot packs, the department\'s live leaves and every taken leaf id', async () => {
    const mtNode = await mkNode(mt, 'MT head', null);
    const m1 = await mkLeaf(mt, mtNode, 'M1');
    const id = await openMonth();
    const f = await mkFile(id, tt);
    await batchOf(id, f, [grid(r2)]);
    const res = await call('GET', `/months/${id}/context?dept=${tt}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      period: '2026-10',
      packs: [{ code: 'A', grp: 'CSD', sort: 0 }, { code: 'B', grp: 'CSD', sort: 1 }, { code: 'C', grp: 'CSD', sort: 2 }],
      leaves: [
        { leafId: r1, deliverySystem: 'DS', routeCode: 'R1' },
        { leafId: r2, deliverySystem: 'DS', routeCode: 'R2' },
        { leafId: r3, deliverySystem: 'DS', routeCode: 'R3' },
      ],
      takenLeafIds: [r2],
    });
    // takenLeafIds covers any file of the month, whichever department asks.
    const other = await json(await call('GET', `/months/${id}/context?dept=${mt}`));
    expect(other.leaves).toEqual([{ leafId: m1, deliverySystem: 'DS', routeCode: 'M1' }]);
    expect(other.takenLeafIds).toEqual([r2]);
  });

  it('rejects a missing dept (400), unknown month (404), department not in the month (404)', async () => {
    const id = await openMonth();
    expect((await call('GET', `/months/${id}/context`)).status).toBe(400);
    expect((await call('GET', `/months/${id}/context?dept=abc`)).status).toBe(400);
    expect((await call('GET', `/months/999/context?dept=${tt}`)).status).toBe(404);
    expect((await call('GET', `/months/${id}/context?dept=9999`)).status).toBe(404);
  });

  it('Review Focus 5: deactivating a pack after the month opened does not change the month\'s packs', async () => {
    const id = await openMonth();
    await run(env.DB, `UPDATE packs SET active = 0 WHERE code = 'C'`);
    await run(env.DB, `UPDATE packs SET active = 1 WHERE code = 'OFF'`);
    const ctx = await json(await call('GET', `/months/${id}/context?dept=${tt}`));
    expect(ctx.packs.map((p: Json) => p.code)).toEqual(['A', 'B', 'C']);

    const f = await mkFile(id, tt);
    // The grid must keep C and must not take the later-activated pack.
    expect((await batchOf(id, f, [{ ...grid(r1), values: { A: 1, B: 2 } }])).status).toBe(400);
    expect((await batchOf(id, f, [{ ...grid(r1), values: { A: 1, B: 2, C: 3, OFF: 4 } }])).status).toBe(400);
    expect((await batchOf(id, f, [grid(r1)])).status).toBe(200);
    const row = await one<{ values_json: string }>(env.DB, `SELECT values_json FROM month_leaves WHERE month_id = ?`, id);
    expect(JSON.parse(row!.values_json)).toEqual({ A: 1, B: 2, C: 3 });
  });
});

describe('files', () => {
  it('creates a file with optional sheet1 and audits it', async () => {
    const id = await openMonth();
    const res = await call('POST', `/months/${id}/files`, { deptId: tt, name: 'TT DMM', sheet1: { A: 10, B: 20 } });
    expect(res.status).toBe(201);
    const { fileId } = await json(res);
    const row = await one<Json>(env.DB, `SELECT dept_id, name, sheet1_json, uploaded_by FROM month_files WHERE id = ?`, fileId);
    expect(row).toMatchObject({ dept_id: tt, name: 'TT DMM' });
    expect(JSON.parse(row!.sheet1_json)).toEqual({ A: 10, B: 20 });
    const audit = await one<Json>(env.DB, `SELECT action, month_id, detail_json FROM audit WHERE action = 'month.file_add'`);
    expect(audit).toMatchObject({ month_id: id });
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ fileId, deptId: tt, name: 'TT DMM' });
  });

  it('validates the body, the month and the department', async () => {
    const id = await openMonth();
    expect((await call('POST', `/months/${id}/files`, { name: 'x' })).status).toBe(400);
    expect((await call('POST', `/months/${id}/files`, { deptId: tt })).status).toBe(400);
    expect((await call('POST', `/months/${id}/files`, { deptId: 9999, name: 'x' })).status).toBe(400);
    expect((await call('POST', `/months/999/files`, { deptId: tt, name: 'x' })).status).toBe(404);
    expect((await call('POST', `/months/${id}/files`, { deptId: tt, name: 'x', sheet1: { ZZ: 1 } })).status).toBe(400);
    expect((await call('POST', `/months/${id}/files`, { deptId: tt, name: 'x', sheet1: { A: -1 } })).status).toBe(400);
    expect(await count('month_files')).toBe(0);
  });

  it('refuses a new file once the department is running (reset first)', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    await batchOf(id, f, [grid(r1), grid(r2), grid(r3)]);
    expect((await call('POST', `/months/${id}/depts/${tt}/start`)).status).toBe(200);
    const res = await call('POST', `/months/${id}/files`, { deptId: tt, name: 'late' });
    expect(res.status).toBe(409);
    expect((await batchOf(id, f, [grid(r1, 9, 9, 9)])).status).toBe(409);
  });
});

describe('batch upload', () => {
  it('stores the full grid per leaf with node, department, file and salesman', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    const res = await batchOf(id, f, [grid(r1, 5, 0, 7), { ...grid(r3), salesmanId: '  ' }]);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ count: 2 });
    const rows = await all<Json>(env.DB, `SELECT * FROM month_leaves WHERE month_id = ? ORDER BY leaf_id`, id);
    expect(rows).toEqual([
      { month_id: id, leaf_id: r1, node_id: ttArea, dept_id: tt, file_id: f, delivery_system: 'DS', route_code: 'R1', salesman_id: `S${r1}`, values_json: '{"A":5,"B":0,"C":7}' },
      { month_id: id, leaf_id: r3, node_id: ttRoot, dept_id: tt, file_id: f, delivery_system: 'DS', route_code: 'R3', salesman_id: null, values_json: '{"A":1,"B":2,"C":3}' },
    ]);
    const audit = await one<Json>(env.DB, `SELECT month_id, detail_json FROM audit WHERE action = 'month.batch'`);
    expect(audit!.month_id).toBe(id);
    expect(JSON.parse(audit!.detail_json)).toEqual({ fileId: f, count: 2 });
  });

  it('re-sending a batch for the same file replaces its values', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    await batchOf(id, f, [grid(r1, 1, 1, 1)]);
    expect((await batchOf(id, f, [grid(r1, 4, 5, 6)])).status).toBe(200);
    expect(await count('month_leaves')).toBe(1);
    expect((await one<Json>(env.DB, `SELECT values_json FROM month_leaves`))!.values_json).toBe('{"A":4,"B":5,"C":6}');
  });

  it('201 grids is 413 too_many_rows and writes nothing', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    const grids = Array.from({ length: 201 }, (_, i) => grid(r1 + i));
    const res = await batchOf(id, f, grids);
    expect(res.status).toBe(413);
    expect((await json(res)).error).toBe('too_many_rows');
    expect(await count('month_leaves')).toBe(0);
  });

  it('a leaf already in another file of the month is 409 and the batch is all-or-nothing', async () => {
    const id = await openMonth();
    const f1 = await mkFile(id, tt, 'one');
    const f2 = await mkFile(id, tt, 'two');
    await batchOf(id, f1, [grid(r1, 1, 1, 1)]);
    const res = await batchOf(id, f2, [grid(r2), grid(r1, 9, 9, 9)]);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toMatchObject({ error: 'conflict', detail: 'leaf_in_other_file', leafIds: [r1] });
    const rows = await all<Json>(env.DB, `SELECT leaf_id, file_id, values_json FROM month_leaves`);
    expect(rows).toEqual([{ leaf_id: r1, file_id: f1, values_json: '{"A":1,"B":1,"C":1}' }]);
  });

  it('400 for bad values, unknown/foreign leaves, duplicates; error lines point at the grid', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    const mtNode = await mkNode(mt, 'MT head', null);
    const foreign = await mkLeaf(mt, mtNode, 'M1');
    const bads: [string, Json[]][] = [
      ['fraction', [grid(r1, 1.5)]],
      ['negative', [grid(r1, -1)]],
      ['string', [grid(r1, '3' as any)]],
      ['missing pack', [{ ...grid(r1), values: { A: 1, B: 2 } }]],
      ['unknown pack', [{ ...grid(r1), values: { A: 1, B: 2, C: 3, Z: 1 } }]],
      ['no values', [{ leafId: r1 }]],
      ['unknown leaf', [grid(99999)]],
      ['leaf of another department', [grid(foreign)]],
      ['duplicate leaf', [grid(r1), grid(r1)]],
      ['empty', []],
    ];
    for (const [name, grids] of bads) {
      expect((await batchOf(id, f, grids)).status, name).toBe(400);
    }
    const res = await batchOf(id, f, [grid(r1), grid(r2, 1, -5)]);
    expect((await json(res)).errors[0].line).toBe(2);
    expect(await count('month_leaves')).toBe(0);
  });

  it('404 for a file of another month or an unknown file', async () => {
    const id = await openMonth();
    const other = await openMonth('2026-11');
    const f = await mkFile(id, tt);
    expect((await batchOf(other, f, [grid(r1)])).status).toBe(404);
    expect((await batchOf(id, 9999, [grid(r1)])).status).toBe(404);
    expect((await call('POST', `/months/${id}/files/${f}/batch`, { grids: 'no' })).status).toBe(400);
  });

  it('409 leaf_node_not_in_month when the leaf sits under a node created after the month opened', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    const lateNode = await mkNode(tt, 'late area', ttRoot);
    const late = await mkLeaf(tt, lateNode, 'LATE');
    const res = await batchOf(id, f, [grid(r1), grid(late)]);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ detail: 'leaf_node_not_in_month', leafIds: [late] });
    expect(await count('month_leaves')).toBe(0);
  });

  it('accepts exactly 200 grids of 42 packs in one request', async () => {
    await run(env.DB, `DELETE FROM packs`);
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 42) SELECT 'PACK_' || printf('%02d', i), 'CSD', 1, i FROM n`);
    const many = await mkDept('MANY');
    const root = await mkNode(many, 'MANY head', null);
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) SELECT ?, 'DS', 'ROUTE' || i, ?, 'r' FROM n`, many, root);
    const id = await openMonth();
    const f = await mkFile(id, many);
    const ctx = await json(await call('GET', `/months/${id}/context?dept=${many}`));
    expect(ctx.packs).toHaveLength(42);
    expect(ctx.leaves).toHaveLength(200);
    const grids = ctx.leaves.map((l: Json, i: number) => ({
      leafId: l.leafId, deliverySystem: l.deliverySystem, routeCode: l.routeCode, salesmanId: `S${i}`,
      values: Object.fromEntries(ctx.packs.map((p: Json, j: number) => [p.code, (i * 7 + j) % 300])),
    }));
    const res = await batchOf(id, f, grids);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ count: 200 });
    expect(await count('month_leaves')).toBe(200);
    const sample = await one<Json>(env.DB, `SELECT values_json FROM month_leaves WHERE leaf_id = ?`, ctx.leaves[199].leafId);
    expect(Object.keys(JSON.parse(sample!.values_json))).toHaveLength(42);
    expect(JSON.parse(sample!.values_json).PACK_03).toBe((199 * 7 + 2) % 300);
    // the department can then start from its single file
    expect((await call('POST', `/months/${id}/depts/${many}/start`)).status).toBe(200);
  });
});

describe('start', () => {
  it('is refused while a mapped leaf has no grid, naming the leaf', async () => {
    const id = await openMonth();
    const f = await mkFile(id, tt);
    await batchOf(id, f, [grid(r1), grid(r2)]);
    const res = await call('POST', `/months/${id}/depts/${tt}/start`);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'conflict', detail: 'missing_leaves', leafIds: [r3] });
    expect((await one<Json>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, id, tt))!.state).toBe('loading');
    expect((await one<Json>(env.DB, `SELECT status FROM month_nodes WHERE node_id = ?`, ttRoot))!.status).toBe('waiting');
  });

  it('is refused without any file and when the department is not loading', async () => {
    const id = await openMonth();
    expect(await json(await call('POST', `/months/${id}/depts/${tt}/start`))).toMatchObject({ detail: 'no_files' });
    const f = await mkFile(id, tt);
    await batchOf(id, f, [grid(r1), grid(r2), grid(r3)]);
    expect((await call('POST', `/months/${id}/depts/${tt}/start`)).status).toBe(200);
    const again = await call('POST', `/months/${id}/depts/${tt}/start`);
    expect(again.status).toBe(409);
    expect((await json(again)).detail).toBe('department_not_loading');
    expect((await call('POST', `/months/${id}/depts/9999/start`)).status).toBe(404);
    expect((await call('POST', `/months/999/depts/${tt}/start`)).status).toBe(404);
  });

  it('is refused when the department has no root node in the month', async () => {
    const id = await openMonth();
    const f = await mkFile(id, mt);
    expect(await json(await call('POST', `/months/${id}/depts/${mt}/start`))).toMatchObject({ detail: 'no_root_node' });
    expect(f).toBeGreaterThan(0);
  });

  it('sets running, opens the root node and audits; leaves added after the month do not block it', async () => {
    const id = await openMonth();
    const lateNode = await mkNode(tt, 'late area', ttRoot);
    await mkLeaf(tt, lateNode, 'LATE'); // not in this month's tree
    const f = await mkFile(id, tt);
    await batchOf(id, f, [grid(r1), grid(r2), grid(r3)]);
    const res = await call('POST', `/months/${id}/depts/${tt}/start`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ state: 'running' });
    expect((await one<Json>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, id, tt))!.state).toBe('running');
    const nodes = await all<Json>(env.DB, `SELECT node_id, status FROM month_nodes WHERE month_id = ? ORDER BY node_id`, id);
    expect(nodes).toEqual([{ node_id: ttRoot, status: 'in_progress' }, { node_id: ttArea, status: 'waiting' }]);
    // openTurn (distribution) audits the root's turn after the start itself.
    expect((await auditActions()).slice(-2)).toEqual(['month.dept_start', 'node.open']);
    // MT is untouched
    expect((await one<Json>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, id, mt))!.state).toBe('loading');
  });
});

describe('reset', () => {
  it('clears the department\'s uploads and work, bumps versions, returns to loading, leaves other departments alone', async () => {
    const mtNode = await mkNode(mt, 'MT head', null);
    const m1 = await mkLeaf(mt, mtNode, 'M1');
    const id = await openMonth();
    const f = await mkFile(id, tt);
    const fm = await mkFile(id, mt);
    await batchOf(id, f, [grid(r1), grid(r2), grid(r3)]);
    await batchOf(id, fm, [grid(m1)]);
    expect((await call('POST', `/months/${id}/depts/${tt}/start`)).status).toBe(200);
    await run(env.DB, `UPDATE month_nodes SET status = 'submitted', held_status = 'waiting', baseline_json = '{}', draft_json = '{}', opened_at = 'x', submitted_at = 'y' WHERE month_id = ?`, id);

    const res = await call('POST', `/months/${id}/depts/${tt}/reset`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ state: 'loading' });

    expect(await all<Json>(env.DB, `SELECT leaf_id FROM month_leaves WHERE month_id = ?`, id)).toEqual([{ leaf_id: m1 }]);
    expect(await all<Json>(env.DB, `SELECT id FROM month_files WHERE month_id = ?`, id)).toEqual([{ id: fm }]);
    const nodes = await all<Json>(env.DB, `SELECT node_id, status, held_status, baseline_json, draft_json, opened_at, submitted_at, version FROM month_nodes WHERE month_id = ? ORDER BY node_id`, id);
    const clear = { status: 'waiting', held_status: null, baseline_json: null, draft_json: null, opened_at: null, submitted_at: null };
    // The root's turn was opened (version 1) before the reset bumped it again.
    expect(nodes[0]).toMatchObject({ node_id: ttRoot, ...clear, version: 2 });
    expect(nodes[1]).toMatchObject({ node_id: ttArea, ...clear, version: 1 });
    expect(nodes[2]).toMatchObject({ node_id: mtNode, status: 'submitted', version: 0 });
    const states = await all<Json>(env.DB, `SELECT dept_id, state FROM month_depts WHERE month_id = ? ORDER BY dept_id`, id);
    expect(states).toEqual([{ dept_id: tt, state: 'loading' }, { dept_id: mt, state: 'loading' }]);
    const audit = await one<Json>(env.DB, `SELECT month_id, detail_json FROM audit WHERE action = 'month.dept_reset'`);
    expect(audit!.month_id).toBe(id);
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ deptId: tt, previousState: 'running', files: 1, leaves: 3 });

    // the department can be loaded again and the same leaves are free
    const f2 = await mkFile(id, tt, 'again');
    expect((await batchOf(id, f2, [grid(r1)])).status).toBe(200);
  });

  it('works from loading and for unknown targets', async () => {
    const id = await openMonth();
    expect((await call('POST', `/months/${id}/depts/${tt}/reset`)).status).toBe(200);
    expect((await call('POST', `/months/${id}/depts/9999/reset`)).status).toBe(404);
    expect((await call('POST', `/months/999/depts/${tt}/reset`)).status).toBe(404);
  });
});

describe('refresh tree', () => {
  const refresh = (month: number, dept: number) => call('POST', `/months/${month}/depts/${dept}/refresh-tree`);
  const monthNodes = async (month: number, dept = tt) =>
    all<Json>(env.DB, `SELECT node_id, parent_id, name, manager_user_id, status FROM month_nodes WHERE month_id = ? AND dept_id = ? ORDER BY node_id`, month, dept);

  it('a node and route added after the month opened can then be uploaded', async () => {
    const month = await openMonth();
    const area2 = await mkNode(tt, 'TT area 2', ttRoot);
    const r4 = await mkLeaf(tt, area2, 'R4');
    const file = await mkFile(month, tt);
    const before = await batchOf(month, file, [grid(r4)]);
    expect(before.status).toBe(409);
    expect((await json(before)).detail).toBe('leaf_node_not_in_month');

    const res = await refresh(month, tt);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ added: 1, removed: 0 });
    expect((await monthNodes(month)).map((n) => n.node_id)).toEqual([ttRoot, ttArea, area2]);
    expect((await batchOf(month, file, [grid(r4)])).status).toBe(200);
    expect(await auditActions()).toContain('month.tree_refresh');
  });

  it('start requires the new node routes after a refresh', async () => {
    const month = await openMonth();
    const file = await mkFile(month, tt);
    const area2 = await mkNode(tt, 'TT area 2', ttRoot);
    const r4 = await mkLeaf(tt, area2, 'R4');
    await refresh(month, tt);
    expect((await batchOf(month, file, [grid(r1), grid(r2), grid(r3)])).status).toBe(200);
    const start = await call('POST', `/months/${month}/depts/${tt}/start`);
    expect(start.status).toBe(409);
    expect((await json(start)).leafIds).toEqual([r4]);
  });

  it('updates names, managers and parents of existing month nodes', async () => {
    const month = await openMonth();
    const other = await mkNode(tt, 'Other', ttRoot);
    await run(env.DB, `UPDATE nodes SET name = 'Renamed', manager_user_id = ?, parent_id = ? WHERE id = ?`, mgrId, other, ttArea);
    expect((await refresh(month, tt)).status).toBe(200);
    const area = (await monthNodes(month)).find((n) => n.node_id === ttArea)!;
    expect(area).toMatchObject({ name: 'Renamed', manager_user_id: mgrId, parent_id: other, status: 'waiting' });
  });

  it('adds a department created after the month and its root', async () => {
    const month = await openMonth();
    const nd = await mkDept('ND');
    const root = await mkNode(nd, 'ND head', null);
    expect((await refresh(month, nd)).status).toBe(200);
    expect(await one(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, month, nd)).toEqual({ state: 'loading' });
    expect((await monthNodes(month, nd)).map((n) => [n.node_id, n.parent_id])).toEqual([[root, null]]);
  });

  it('is refused unless the department is loading', async () => {
    const month = await openMonth();
    const file = await mkFile(month, tt);
    await batchOf(month, file, [grid(r1), grid(r2), grid(r3)]);
    expect((await call('POST', `/months/${month}/depts/${tt}/start`)).status).toBe(200);
    const res = await refresh(month, tt);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('department_not_loading');
    expect((await refresh(month, 999999)).status).toBe(404);
    expect((await refresh(999999, tt)).status).toBe(404);
  });

  it('removes a stale empty node but keeps one that has month leaves', async () => {
    const empty = await mkNode(tt, 'Empty', ttRoot);
    const used = await mkNode(tt, 'Used', ttRoot);
    const usedLeaf = await mkLeaf(tt, used, 'RU');
    const month = await openMonth();
    const file = await mkFile(month, tt);
    expect((await batchOf(month, file, [grid(usedLeaf)])).status).toBe(200);
    await run(env.DB, `DELETE FROM nodes WHERE id = ?`, empty);
    await run(env.DB, `DELETE FROM leaves WHERE id = ?`, usedLeaf);
    await run(env.DB, `DELETE FROM nodes WHERE id = ?`, used);
    const res = await refresh(month, tt);
    expect(res.status).toBe(200);
    expect((await json(res)).removed).toBe(1);
    const ids = (await monthNodes(month)).map((n) => n.node_id);
    expect(ids).not.toContain(empty);
    expect(ids).toContain(used);
  });

  it('keeps the ancestors of a kept stale node', async () => {
    const mid = await mkNode(tt, 'Mid', ttRoot);
    const deep = await mkNode(tt, 'Deep', mid);
    const deepLeaf = await mkLeaf(tt, deep, 'RD');
    const month = await openMonth();
    const file = await mkFile(month, tt);
    await batchOf(month, file, [grid(deepLeaf)]);
    await run(env.DB, `DELETE FROM leaves WHERE id = ?`, deepLeaf);
    await run(env.DB, `DELETE FROM nodes WHERE id IN (?, ?)`, deep, mid);
    expect((await refresh(month, tt)).status).toBe(200);
    const ids = (await monthNodes(month)).map((n) => n.node_id);
    expect(ids).toEqual(expect.arrayContaining([mid, deep]));
  });

  it('refuses when a removed root that still has month leaves would stay beside the new root', async () => {
    const month = await openMonth();
    const file = await mkFile(month, tt);
    await batchOf(month, file, [grid(r1), grid(r2), grid(r3)]);
    await run(env.DB, `DELETE FROM leaves WHERE dept_id = ?`, tt);
    await run(env.DB, `DELETE FROM nodes WHERE id = ?`, ttArea);
    await run(env.DB, `DELETE FROM nodes WHERE id = ?`, ttRoot);
    await mkNode(tt, 'New head', null);
    const res = await refresh(month, tt);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('stale_root_has_leaves');
    const roots = await all(env.DB, `SELECT node_id FROM month_nodes WHERE month_id = ? AND dept_id = ? AND parent_id IS NULL`, month, tt);
    expect(roots).toHaveLength(1);
  });

  it('reset re-copies the live tree', async () => {
    const month = await openMonth();
    const file = await mkFile(month, tt);
    await batchOf(month, file, [grid(r1), grid(r2), grid(r3)]);
    const area2 = await mkNode(tt, 'TT area 2', ttRoot);
    await run(env.DB, `UPDATE nodes SET name = 'Renamed' WHERE id = ?`, ttArea);
    expect((await call('POST', `/months/${month}/depts/${tt}/reset`)).status).toBe(200);
    const nodes = await monthNodes(month);
    expect(nodes.map((n) => n.node_id)).toEqual([ttRoot, ttArea, area2]);
    expect(nodes.find((n) => n.node_id === ttArea)!.name).toBe('Renamed');
  });

  it('stays within the statement budget on a large tree', async () => {
    const month = await openMonth();
    await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) SELECT ?, ?, 'sub' || i FROM n`, tt, ttRoot);
    const res = await refresh(month, tt);
    expect(res.status).toBe(200);
    expect((await json(res)).added).toBe(300);
  });
});
