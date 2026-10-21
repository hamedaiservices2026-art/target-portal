import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { all, run } from '../../src/worker/db';

type Json = Record<string, any>;

async function addUser(username: string, role: 'admin' | 'manager' = 'manager'): Promise<number> {
  const { hash, salt } = await hashPassword('password-123');
  return (await run(env.DB, `INSERT INTO users(username, name, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role)).lastRowId;
}
async function sidFor(username: string): Promise<string> {
  const res = await SELF.fetch('http://x/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password-123' }),
  });
  expect(res.status).toBe(200);
  return /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}
let sid: string;
let tt: number;
let mt: number;
let month: number;
let ttFile: number;
let mtFile: number;

function call(method: string, path: string, body?: unknown, cookie: string | null = sid): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `sid=${cookie}`;
  return SELF.fetch(`http://x/api/admin${path}`, { method, headers, body: method === 'GET' ? undefined : body === undefined ? '{}' : JSON.stringify(body) });
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;
const get = (path: string) => call('GET', path);

const mkDept = async (code: string) => (await run(env.DB, `INSERT INTO departments(code, name) VALUES (?, ?)`, code, code)).lastRowId;
const mkNode = async (dept: number, name: string) => (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, ?)`, dept, name)).lastRowId;
const mkLeaf = async (dept: number, node: number, route: string, ds = 'DS') =>
  (await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, ?, ?, ?, ?)`, dept, ds, route, node, route)).lastRowId;
const grid = (leafId: number, route: string, values: Json, ds = 'DS', salesmanId: string | null = `S${route}`): Json =>
  ({ leafId, deliverySystem: ds, routeCode: route, salesmanId, values });

beforeEach(async () => {
  for (const t of ['audit', 'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months', 'leaves', 'nodes',
    'sessions', 'login_failures', 'packs', 'departments', 'users']) await run(env.DB, `DELETE FROM ${t}`);
  await addUser('boss', 'admin');
  await addUser('mgr');
  sid = await sidFor('boss');
  tt = await mkDept('TT');
  mt = await mkDept('MT');
  const ttNode = await mkNode(tt, 'TT head');
  const mtNode = await mkNode(mt, 'MT head');
  const l1 = await mkLeaf(tt, ttNode, 'R2');
  const l2 = await mkLeaf(tt, ttNode, 'R1');
  const l3 = await mkLeaf(mt, mtNode, 'M1', 'MTDS');
  for (const [i, code] of ['B', 'A', 'C'].entries()) {
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES (?, 'CSD', 1, ?)`, code, i);
  }
  month = (await json(await call('POST', '/months', { period: '2026-10' }))).month.id;
  ttFile = (await json(await call('POST', `/months/${month}/files`, { deptId: tt, name: 'tt' }))).fileId;
  mtFile = (await json(await call('POST', `/months/${month}/files`, { deptId: mt, name: 'mt' }))).fileId;
  expect((await call('POST', `/months/${month}/files/${ttFile}/batch`, { grids: [
    grid(l1, 'R2', { B: 10, A: 20, C: 30 }), grid(l2, 'R1', { B: 1, A: 0, C: 3 }, 'DS', null)] })).status).toBe(200);
  expect((await call('POST', `/months/${month}/files/${mtFile}/batch`, { grids: [grid(l3, 'M1', { B: 5, A: 6, C: 7 }, 'MTDS')] })).status).toBe(200);
});

describe('export', () => {
  it('has the exact spec headers and a full leaves x packs grid with zeros', async () => {
    const res = await get(`/months/${month}/export?dept=all`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.columns).toEqual(['Period (YYYY-MM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases']);
    expect(body.rows).toHaveLength(3 * 3);
    expect(body.rows).toContainEqual(['2026-10', 'DS', 'R1', '', 'A', 0]);
  });

  it('orders by file, route code, then snapshot pack order; keeps types', async () => {
    const { rows } = await json(await get(`/months/${month}/export?dept=all`));
    expect(rows.map((r: any[]) => `${r[2]}:${r[4]}`)).toEqual([
      'R1:B', 'R1:A', 'R1:C', 'R2:B', 'R2:A', 'R2:C', 'M1:B', 'M1:A', 'M1:C']);
    expect(rows[3]).toEqual(['2026-10', 'DS', 'R2', 'SR2', 'B', 10]);
    expect(typeof rows[0][0]).toBe('string');
    expect(Number.isInteger(rows[0][5])).toBe(true);
  });

  it('sums per pack equal the uploaded totals; dept filter and departments with state', async () => {
    const all_ = await json(await get(`/months/${month}/export?dept=all`));
    const sum = (rows: any[][], pack: string) => rows.filter((r) => r[4] === pack).reduce((s, r) => s + r[5], 0);
    expect([sum(all_.rows, 'A'), sum(all_.rows, 'B'), sum(all_.rows, 'C')]).toEqual([26, 16, 40]);
    expect(all_.departments).toEqual([{ id: tt, code: 'TT', state: 'loading' }, { id: mt, code: 'MT', state: 'loading' }]);
    const one_ = await json(await get(`/months/${month}/export?dept=${mt}`));
    expect(one_.rows).toHaveLength(3);
    expect(one_.departments).toEqual([{ id: mt, code: 'MT', state: 'loading' }]);
  });

  it('audits month.export with dept and row count; validates input', async () => {
    await get(`/months/${month}/export?dept=${tt}`);
    const a = await all<Json>(env.DB, `SELECT action, month_id, detail_json FROM audit WHERE action = 'month.export'`);
    expect(a).toHaveLength(1);
    expect(a[0]!.month_id).toBe(month);
    expect(JSON.parse(a[0]!.detail_json)).toEqual({ dept: tt, rows: 6 });
    expect((await get(`/months/${month}/export`)).status).toBe(400);
    expect((await get(`/months/${month}/export?dept=abc`)).status).toBe(400);
    expect((await get(`/months/${month}/export?dept=99999`)).status).toBe(404);
    expect((await get(`/months/999/export?dept=all`)).status).toBe(404);
    expect((await call('GET', `/months/${month}/export?dept=all`, undefined, await sidFor('mgr'))).status).toBe(403);
    expect((await call('GET', `/months/${month}/export?dept=all`, undefined, null)).status).toBe(401);
  });
});

describe('audit history', () => {
  it('newest first with user names, parsed detail, and paging by id', async () => {
    const first = await json(await get('/audit?limit=2'));
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0].id).toBeGreaterThan(first.rows[1].id);
    expect(first.rows[0]).toMatchObject({ userName: 'Name boss' });
    expect(first.nextBefore).toBe(first.rows[1].id);
    const next = await json(await get(`/audit?limit=2&before=${first.nextBefore}`));
    expect(next.rows.every((r: Json) => r.id < first.nextBefore)).toBe(true);
    const everything = await json(await get('/audit?limit=200'));
    expect(everything.nextBefore).toBeNull();
    expect(typeof everything.rows.find((r: Json) => r.action === 'month.create').detail).toBe('object');
  });

  it('filters by month, defaults and caps limit, rejects junk', async () => {
    const mine = await json(await get(`/audit?month=${month}`));
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every((r: Json) => r.monthId === month)).toBe(true);
    expect((await json(await get('/audit?month=999'))).rows).toEqual([]);
    expect((await get('/audit?limit=0')).status).toBe(400);
    expect((await get('/audit?before=x')).status).toBe(400);
    expect((await call('GET', '/audit', undefined, await sidFor('mgr'))).status).toBe(403);
  });
});

describe('backup', () => {
  it('has every table except sessions/login_failures, no password fields, and a dated attachment header', async () => {
    const res = await get('/backup');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="target-portal-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await res.text();
    expect(text).not.toMatch(/pw_hash|pw_salt/);
    const body = JSON.parse(text) as Json;
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    const tables = (await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`))
      .map((t) => t.name).filter((n) => !['sessions', 'login_failures'].includes(n));
    for (const t of tables) expect(body, t).toHaveProperty(t);
    expect(body).not.toHaveProperty('sessions');
    expect(body).not.toHaveProperty('login_failures');
    expect(body.users.map((u: Json) => u.username).sort()).toEqual(['boss', 'mgr']);
    expect(body.month_leaves).toHaveLength(3);
  });

  it('audits backup.download; admin only', async () => {
    await get('/backup');
    expect((await all(env.DB, `SELECT id FROM audit WHERE action = 'backup.download'`))).toHaveLength(1);
    expect((await call('GET', '/backup', undefined, await sidFor('mgr'))).status).toBe(403);
    expect((await call('GET', '/backup', undefined, null)).status).toBe(401);
  });
});
