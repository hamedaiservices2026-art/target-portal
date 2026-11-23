import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';

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


describe('revert the target month to the beginning', () => {
  it('clears the cycle and the new target upload, keeps the sales and the AOP', async () => {
    for (const t of ['notifications', 'head_approvals', 'cycles', 'data_months', 'data_routes', 'user_roles', 'dept_channels', 'audit', 'settings',
      'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months', 'leaves', 'nodes', 'departments', 'packs', 'sessions', 'login_failures', 'users']) {
      await run(env.DB, `DELETE FROM ${t}`);
    }
    await addUser('admin', 'admin');
    const admin = await login('admin');
    const P = '2040-09';
    expect((await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, {})).status).toBe(200);
    expect((await api('POST', '/admin/data/ops/months', admin, { kind: 'new_target', month: P, values: { mode: 'pack', byPack: { CSD_CANS150: 5 } } })).status).toBe(200);
    expect((await api('POST', '/admin/data/ops/months', admin, { kind: 'aop', month: P, values: { CSD_CANS150: { cases: 9, nr: null } } })).status).toBe(200);
    expect((await api('POST', `/admin/cycle/ops/${P}/revert`, admin)).status).toBe(200);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM cycles WHERE period = ?`, P)).toEqual({ n: 0 });
    expect(await one(env.DB, `SELECT group_concat(kind) AS k FROM data_months WHERE month = ?`, P)).toEqual({ k: 'aop' });
    // It can be opened again.
    expect((await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, {})).status).toBe(200);
  });
});

describe('Hierarchy: Operation and Key Account kept apart', () => {
  it('a Key Account file makes Key Account departments even when an MDM has an Operation Head of the same name; the clean-up takes KA people out of Operation', async () => {
    for (const t of ['notifications', 'head_approvals', 'cycles', 'data_months', 'data_routes', 'user_roles', 'dept_channels', 'audit', 'settings',
      'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months', 'leaves', 'nodes', 'departments', 'packs', 'sessions', 'login_failures', 'users']) {
      await run(env.DB, `DELETE FROM ${t}`);
    }
    await addUser('admin', 'admin');
    const admin = await login('admin');
    const mt = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('MS', 'Mohammed Shehadeh', 'ops')`)).lastRowId;
    const root = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'Mohammed Shehadeh')`, mt)).lastRowId;
    const mgr = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Walid Abdou')`, mt, root)).lastRowId;
    const sup = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Sup One')`, mt, mgr)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'MT', '314001', ?, '314001')`, mt, sup);
    // The old mistake: KA people under the Operation Head.
    const kam = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Kam One')`, mt, root)).lastRowId;
    const kae = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Kae One')`, mt, kam)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'Mohammed Shehadeh', '41461', ?, '41461')`, mt, kae);
    const rows = [{ head: 'Mohammed Shehadeh', manager: 'Kam One', supervisor: 'Kae One', route: '41461', ds: '' }];

    const pre = await json(await api('POST', '/admin/hierarchy/remove-ka-from-ops', admin, { rows, apply: false }));
    expect(pre.nodes.map((n: Json) => n.name).sort()).toEqual(['Kae One', 'Kam One']);
    expect(pre.leaves.map((l: Json) => l.route)).toEqual(['41461']);
    expect((await api('POST', '/admin/hierarchy/remove-ka-from-ops', admin, { rows, apply: true })).status).toBe(200);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM nodes WHERE dept_id = ?`, mt)).toEqual({ n: 3 });
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM leaves WHERE dept_id = ?`, mt)).toEqual({ n: 1 });

    // The Key Account upload does not match the Operation department of the same name.
    const plan = await json(await api('POST', '/admin/hierarchy/sync/preview', admin, { rows, depts: { 'Mohammed Shehadeh': 'new' }, workspace: 'ka' }));
    expect(plan.problems).toEqual([]);
    expect((await api('POST', '/admin/hierarchy/sync/apply', admin, { rows, depts: { 'Mohammed Shehadeh': 'new' }, workspace: 'ka' })).status).toBe(200);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM departments WHERE workspace = 'ka'`)).toEqual({ n: 1 });
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM nodes WHERE dept_id = ?`, mt)).toEqual({ n: 3 });
    // Without picking, the Operation department is not offered for a Key Account file.
    const p2 = await json(await api('POST', '/admin/hierarchy/sync/preview', admin, { rows, workspace: 'ka' }));
    expect(p2.heads[0].deptId).not.toBe(mt);

    // The clean-up can also use the Key Account hierarchy already uploaded (no file).
    const kam2 = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Kam One')`, mt, root)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'MT', '41461', ?, '41461')`, mt, kam2);
    const pre2 = await json(await api('POST', '/admin/hierarchy/remove-ka-from-ops', admin, { fromKa: true, apply: false }));
    expect(pre2.nodes.map((n: Json) => n.name)).toEqual(['Kam One']);
    expect((await api('POST', '/admin/hierarchy/remove-ka-from-ops', admin, { fromKa: true, apply: true })).status).toBe(200);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM nodes WHERE dept_id = ?`, mt)).toEqual({ n: 3 });
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM leaves WHERE dept_id = ?`, mt)).toEqual({ n: 1 });
  });
});

describe('packs the admin added', () => {
  it('can be renamed and deleted; the original packs cannot', async () => {
    for (const t of ['audit', 'packs', 'sessions', 'login_failures', 'user_roles', 'users']) await run(env.DB, `DELETE FROM ${t}`);
    await addUser('admin', 'admin');
    const admin = await login('admin');
    await run(env.DB, `INSERT INTO packs(code, grp) VALUES ('CSD_CANS150', 'CSD')`);
    expect((await api('POST', '/admin/packs', admin, { code: 'CSD_SSPET50', grp: 'CSD' })).status).toBe(201);
    expect(await json(await api('GET', '/admin/packs-added', admin))).toEqual({ packs: ['CSD_SSPET50'] });
    expect((await api('POST', '/admin/packs/CSD_SSPET50/rename', admin, { code: 'CSD_SSPET500' })).status).toBe(200);
    expect(await json(await api('GET', '/admin/packs-added', admin))).toEqual({ packs: ['CSD_SSPET500'] });
    expect((await api('POST', '/admin/packs/CSD_CANS150/rename', admin, { code: 'X' })).status).toBe(400);
    expect((await api('DELETE', '/admin/packs/CSD_CANS150', admin)).status).toBe(400);
    expect((await api('DELETE', '/admin/packs/CSD_SSPET500', admin)).status).toBe(200);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM packs`)).toEqual({ n: 1 });
  });
});

describe('Heads setup history', () => {
  it('lists channel and workspace changes with the value before, skips saves without a change, and undoes', async () => {
    for (const t of ['audit', 'dept_channels', 'leaves', 'nodes', 'departments', 'sessions', 'login_failures', 'user_roles', 'users']) await run(env.DB, `DELETE FROM ${t}`);
    await addUser('admin', 'admin');
    const admin = await login('admin');
    const d = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('MT', 'MT', 'ops')`)).lastRowId;
    const put = (path: string, body: unknown) => api('PUT', `/admin/departments/${d}/${path}`, admin, body);
    expect((await put('channels', { channels: [{ channel: 'MT', grp: 'MT' }, { channel: 'MT SSV', grp: 'MT' }] })).status).toBe(200);
    expect((await put('channels', { channels: [{ channel: 'MT', grp: 'MT' }, { channel: 'MT SSV', grp: 'MT' }] })).status).toBe(200); // no change
    expect((await put('channels', { channels: [] })).status).toBe(200);
    expect((await put('workspace', { workspace: 'ops', sort: 0 })).status).toBe(200); // no change
    expect((await put('workspace', { workspace: 'ka', sort: 0 })).status).toBe(200);
    const h = await json(await api('GET', '/admin/departments/setup-history', admin));
    expect(h.changes.map((c: Json) => [c.kind, c.before, c.after])).toEqual([
      ['workspace', 'Operations · order 0', 'Key Accounts · order 0'],
      ['channels', 'MT, MT SSV', '(none)'],
      ['channels', '(none)', 'MT, MT SSV'],
    ]);
    expect((await api('POST', `/admin/departments/setup-history/${h.changes[1].id}/undo`, admin)).status).toBe(200);
    expect((await api('POST', `/admin/departments/setup-history/${h.changes[0].id}/undo`, admin)).status).toBe(200);
    expect(await all(env.DB, `SELECT channel FROM dept_channels WHERE dept_id = ? ORDER BY sort`, d)).toEqual([{ channel: 'MT' }, { channel: 'MT SSV' }]);
    expect(await one(env.DB, `SELECT workspace FROM departments WHERE id = ?`, d)).toEqual({ workspace: 'ops' });
  });
});

describe('Hierarchy replace and delete', () => {
  it('replace takes out old names, keeps the Head and its accounts, deletes Heads not in the file; a Head and all can be deleted', async () => {
    for (const t of ['notifications', 'head_approvals', 'cycles', 'audit', 'dept_channels', 'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months',
      'leaves', 'nodes', 'departments', 'sessions', 'login_failures', 'user_roles', 'users']) await run(env.DB, `DELETE FROM ${t}`);
    const adminId = await addUser('admin', 'admin');
    const admin = await login('admin');
    const mt = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('MT', 'MT', 'ops')`)).lastRowId;
    await run(env.DB, `INSERT INTO dept_channels(dept_id, channel, grp, sort) VALUES (?, 'MT', '', 0)`, mt);
    const root = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name, manager_user_id) VALUES (?, NULL, 'MT', ?)`, mt, adminId)).lastRowId;
    const old = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Old Manager')`, mt, root)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'MT', 'R9', ?, 'R9')`, mt, old);
    const dup = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('MT2', 'MT-LF', 'ops')`)).lastRowId;
    await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'MT-LF')`, dup);

    const rows = [{ head: 'MT', manager: 'New Manager', supervisor: 'Sup', route: 'R1', ds: 'MT' }];
    const pre = await json(await api('POST', '/admin/hierarchy/sync/preview', admin, { rows, workspace: 'ops', replace: true }));
    expect(pre.problems).toEqual([]);
    expect(pre.removed).toEqual([{ deptId: dup, name: 'MT-LF' }]);
    expect(pre.replacing).toEqual({ nodes: 3, routes: 1 });
    const r = await api('POST', '/admin/hierarchy/sync/apply', admin, { rows, workspace: 'ops', replace: true });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await all(env.DB, `SELECT n.name, n.manager_user_id AS u FROM nodes n ORDER BY n.id`)).toEqual([
      { name: 'MT', u: adminId }, { name: 'New Manager', u: null }, { name: 'Sup', u: null },
    ]);
    expect(await all(env.DB, `SELECT route_code FROM leaves`)).toEqual([{ route_code: 'R1' }]);
    expect(await all(env.DB, `SELECT id FROM departments`)).toEqual([{ id: mt }]);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM dept_channels WHERE dept_id = ?`, mt)).toEqual({ n: 1 });

    // Delete one Head, then delete all.
    const ka = (await run(env.DB, `INSERT INTO departments(code, name, workspace, ops_dept_id) VALUES ('K', 'K', 'ka', ?)`, mt)).lastRowId;
    expect((await api('DELETE', `/admin/departments/${mt}`, admin)).status).toBe(200);
    expect(await one(env.DB, `SELECT ops_dept_id AS o FROM departments WHERE id = ?`, ka)).toEqual({ o: null });
    expect(await json(await api('POST', '/admin/hierarchy/delete-all', admin, { workspace: 'ka' }))).toEqual({ heads: 1 });
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM departments`)).toEqual({ n: 0 });
  });
});
