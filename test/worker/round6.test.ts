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
