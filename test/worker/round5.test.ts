import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { one, run } from '../../src/worker/db';

type Json = Record<string, any>;

async function addUser(username: string, role: 'admin' | 'manager' = 'manager'): Promise<number> {
  const { hash, salt } = await hashPassword('password-123');
  return (await run(env.DB, `INSERT INTO users(username, name, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role)).lastRowId;
}

async function login(username: string): Promise<string> {
  const res = await SELF.fetch('http://x/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password-123' }),
  });
  expect(res.status).toBe(200);
  return /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

function api(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`http://x/api${path}`, {
    method, headers: { 'content-type': 'application/json', cookie: `sid=${cookie}` }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

describe('round 5: users, positions and Key Account links', () => {
  let admin: string;
  let adminId: number;
  let headId: number;
  let mt: number;
  let kaDept: number;
  let kaRoot: number;

  beforeEach(async () => {
    for (const t of ['notifications', 'head_approvals', 'cycles', 'data_months', 'data_routes', 'user_roles', 'dept_channels', 'audit', 'settings',
      'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months', 'leaves', 'nodes', 'departments', 'packs', 'sessions', 'login_failures', 'users']) {
      await run(env.DB, `DELETE FROM ${t}`);
    }
    adminId = await addUser('admin', 'admin');
    headId = await addUser('mt.head');
    mt = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('MT', 'Mohamed shehata', 'ops')`)).lastRowId;
    await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name, manager_user_id) VALUES (?, NULL, 'Mohamed shehata', ?)`, mt, headId);
    kaDept = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('MS', 'Mohammed Shehadeh', 'ka')`)).lastRowId;
    kaRoot = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'Mohammed Shehadeh')`, kaDept)).lastRowId;
    const kam = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Abdelhamid Selim')`, kaDept, kaRoot)).lastRowId;
    const kae = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Mohammed Aref Ibrahim')`, kaDept, kam)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'KA', '41461', ?, '41461')`, kaDept, kae);
    admin = await login('admin');
  });

  it('deletes a user: hidden from the list, signed out, places in the hierarchy open, username free again', async () => {
    const sid = await login('mt.head');
    expect((await api('DELETE', `/admin/users/${adminId}`, admin)).status).toBe(400); // not yourself
    expect((await api('DELETE', `/admin/users/${headId}`, admin)).status).toBe(200);
    const list = await json(await api('GET', '/admin/accounts', admin));
    expect(list.accounts.map((a: Json) => a.username)).not.toContain('mt.head');
    expect((await api('GET', '/me', sid)).status).toBe(401);
    expect(await one(env.DB, `SELECT manager_user_id AS u FROM nodes WHERE dept_id = ? AND parent_id IS NULL`, mt)).toEqual({ u: null });
    const again = await api('POST', '/admin/users', admin, { username: 'mt.head', name: 'New head', role: 'manager', password: 'password-456' });
    expect(again.status).toBe(201);
    expect((await api('DELETE', `/admin/users/${headId}`, admin)).status).toBe(404);
  });

  it('keeps the positions the admin adds and shows a position on the account', async () => {
    expect(await json(await api('GET', '/admin/positions', admin))).toEqual({ positions: [] });
    expect((await api('PUT', '/admin/positions', admin, { positions: ['Trade Marketing', 'trade marketing', 'Merchandiser'] })).status).toBe(200);
    expect(await json(await api('GET', '/admin/positions', admin))).toEqual({ positions: ['Trade Marketing', 'Merchandiser'] });
    expect((await api('POST', '/admin/users', admin, { username: 'tm', name: 'TM', role: 'manager', password: 'password-456', position: 'Trade Marketing' })).status).toBe(201);
    const a = (await json(await api('GET', '/admin/accounts', admin))).accounts.find((x: Json) => x.username === 'tm');
    expect(a).toMatchObject({ position: 'Trade Marketing', status: 'pending' });
  });

  it('links a Key Account department to its Operation department: the MDM uses the Operation Head', async () => {
    expect((await api('PUT', `/admin/ka-links/${kaDept}`, admin, { opsDeptId: kaDept })).status).toBe(400); // must be Operation
    expect((await api('PUT', `/admin/ka-links/${kaDept}`, admin, { opsDeptId: mt })).status).toBe(200);
    expect(await json(await api('GET', '/admin/ka-links', admin))).toEqual({ links: [{ kaDeptId: kaDept, opsDeptId: mt }] });
    expect(await one(env.DB, `SELECT manager_user_id AS u FROM nodes WHERE id = ?`, kaRoot)).toEqual({ u: headId });
  });

  it('creates accounts for the KAM and the KAE but not for the MDM', async () => {
    const made: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await json(await api('POST', '/admin/accounts/sync', admin));
      if (r.created) made.push(r.created.name);
      if (!r.created || r.remaining === 0) break;
    }
    expect(made).toContain('Abdelhamid Selim');
    expect(made).toContain('Mohammed Aref Ibrahim');
    expect(made).not.toContain('Mohammed Shehadeh');
    const list = await json(await api('GET', '/admin/accounts', admin));
    expect(list.missing).toBe(0);
    const kae = list.accounts.find((a: Json) => a.name === 'Mohammed Aref Ibrahim');
    expect(kae.roles).toEqual([{ kind: 'supervisor', dept: 'MS', ws: 'ka' }]);
  });

  it('a Key Account cycle has no Commercial Director step, starts from the Operation target, keeps the note and the uplift range', async () => {
    const P = '2026-12';
    expect((await api('PUT', `/admin/cycle/ka/${P}/settings`, admin, { cdStep: true, deadlines: { head: null, manager: null, supervisor: null } })).status).toBe(200);
    let c = await json(await api('GET', `/cycle/ka/${P}`, admin));
    expect(c.settings).toMatchObject({ cdStep: false, ntMode: 'ops' });
    expect((await api('PUT', `/admin/cycle/ka/${P}/settings`, admin, { note: 'September had a one-off order', uplift: { min: 1, max: 3 } })).status).toBe(200);
    expect((await api('PUT', `/admin/cycle/ka/${P}/settings`, admin, { uplift: { min: 4, max: 3 } })).status).toBe(400);
    c = await json(await api('GET', `/cycle/ka/${P}`, admin));
    expect(c.settings).toMatchObject({ note: 'September had a one-off order', uplift: { min: 1, max: 3 } });
    // The department target is set by the Key Account calculator (no CD step).
    expect((await api('PUT', `/admin/cycle/ka/${P}/dept-target`, admin, { dept: { [kaDept]: { CSD_CANS150: 10 } } })).status).toBe(200);
    expect((await api('PUT', `/admin/cycle/ka/${P}/calc`, admin, { calc: { [kaDept]: { 41461: { CSD_CANS150: 10 } } } })).status).toBe(200);
    // AOP option for Operation.
    expect((await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, { ntMode: 'aop' })).status).toBe(200);
    expect((await json(await api('GET', `/cycle/ops/${P}`, admin))).settings.ntMode).toBe('aop');
  });
});
