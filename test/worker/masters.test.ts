import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';
import { logAudit } from '../../src/worker/services/audit';

type Json = Record<string, any>;

async function addUser(username: string, password: string, role: 'admin' | 'manager' = 'manager'): Promise<number> {
  const { hash, salt } = await hashPassword(password);
  const res = await run(
    env.DB,
    `INSERT INTO users(username, name, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role,
  );
  return res.lastRowId;
}

async function sidFor(username: string, password: string): Promise<string> {
  const res = await SELF.fetch('http://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

let sid: string;
let adminId: number;

function call(method: string, path: string, body?: unknown, cookie: string | null = sid): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `sid=${cookie}`;
  return SELF.fetch(`http://x/api/admin${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : body === undefined ? '{}' : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function auditRows(action?: string): Promise<{ action: string; user_id: number; detail: Json | null }[]> {
  const rows = await all<{ action: string; user_id: number; detail_json: string | null }>(
    env.DB,
    `SELECT action, user_id, detail_json FROM audit ${action ? 'WHERE action = ?' : ''} ORDER BY id`,
    ...(action ? [action] : []),
  );
  return rows.map((r) => ({ action: r.action, user_id: r.user_id, detail: r.detail_json ? JSON.parse(r.detail_json) : null }));
}

beforeEach(async () => {
  for (const t of ['audit', 'sessions', 'login_failures', 'packs', 'departments', 'users']) {
    await run(env.DB, `DELETE FROM ${t}`);
  }
  await run(env.DB, `UPDATE settings SET value = '5' WHERE key = 'cap_pct'`);
  adminId = await addUser('boss', 'boss-password', 'admin');
  sid = await sidFor('boss', 'boss-password');
});

describe('access control', () => {
  it('401 without a session, 403 for a manager, on every route', async () => {
    await addUser('mgr', 'mgr-password');
    const mgr = await sidFor('mgr', 'mgr-password');
    const routes: [string, string][] = [
      ['GET', '/users'], ['POST', '/users'], ['PATCH', '/users/1'], ['POST', '/users/1/password'],
      ['GET', '/departments'], ['POST', '/departments'], ['PATCH', '/departments/1'],
      ['GET', '/packs'], ['POST', '/packs'], ['PATCH', '/packs/X'],
      ['GET', '/settings'], ['PUT', '/settings'],
    ];
    for (const [m, p] of routes) {
      expect((await call(m, p, {}, null)).status, `${m} ${p} anon`).toBe(401);
      expect((await call(m, p, {}, mgr)).status, `${m} ${p} manager`).toBe(403);
    }
  });

  it('refuses a non-JSON content type with 415', async () => {
    const res = await SELF.fetch('http://x/api/admin/packs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie: `sid=${sid}` },
      body: JSON.stringify({ code: 'P1', grp: 'CSD' }),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
  });
});

describe('users', () => {
  it('create, list, patch round-trip with a plain-text password', async () => {
    const created = await call('POST', '/users', {
      username: 'sara', name: 'Sara A', email: 'sara@example.com', role: 'manager', lang: 'ar', password: 'sara-password',
    });
    expect(created.status).toBe(201);
    const { user } = await json(created);
    expect(user).toEqual({
      id: expect.any(Number), username: 'sara', name: 'Sara A', email: 'sara@example.com',
      role: 'manager', lang: 'ar', active: true,
    });
    expect(JSON.stringify(user)).not.toMatch(/pw_|hash|salt|password/i);

    const list = await json(await call('GET', '/users'));
    expect(list.users.map((u: Json) => u.username)).toEqual(['boss', 'sara']);
    expect(JSON.stringify(list)).not.toMatch(/pw_hash|pw_salt|pbkdf2/i);

    const patched = await call('PATCH', `/users/${user.id}`, { name: 'Sara B', email: null, role: 'admin', lang: 'en', active: false });
    expect(patched.status).toBe(200);
    expect((await json(patched)).user).toMatchObject({ name: 'Sara B', email: null, role: 'admin', lang: 'en', active: false });
    const row = await one<Json>(env.DB, `SELECT * FROM users WHERE id = ?`, user.id);
    expect(row).toMatchObject({ name: 'Sara B', email: null, role: 'admin', lang: 'en', active: 0 });
  });

  it('stores a verifiable hash and the new user can log in', async () => {
    await call('POST', '/users', { username: 'sara', name: 'Sara', role: 'manager', password: 'sara-password' });
    const row = (await one<{ pw_hash: string; pw_salt: string }>(env.DB, `SELECT pw_hash, pw_salt FROM users WHERE username = 'sara'`))!;
    expect(row.pw_hash).toMatch(/^pbkdf2-sha256\$10000\$/);
    expect(await verifyPassword('sara-password', row.pw_hash, row.pw_salt)).toBe(true);
    await sidFor('sara', 'sara-password');
  });

  it('normalizes the username (trim + lower-case) and defaults lang/active', async () => {
    const res = await call('POST', '/users', { username: '  Sara.K ', name: 'Sara', role: 'manager', password: 'sara-password' });
    expect(res.status).toBe(201);
    expect((await json(res)).user).toMatchObject({ username: 'sara.k', lang: 'en', active: true, email: null });
    await sidFor(' SARA.K ', 'sara-password');
  });

  it('rejects empty usernames and usernames containing whitespace', async () => {
    for (const username of ['', '   ', 'sa ra', 'sa\tra', 5, undefined]) {
      const res = await call('POST', '/users', { username, name: 'X', role: 'manager', password: 'long-enough' });
      expect(res.status, String(username)).toBe(400);
      expect((await json(res)).error).toBe('invalid_request');
    }
  });

  it('duplicate username, in any case or padding, is 409', async () => {
    const make = (username: string) => call('POST', '/users', { username, name: 'X', role: 'manager', password: 'long-enough' });
    expect((await make('sara')).status).toBe(201);
    for (const u of ['sara', 'SARA', ' Sara ']) {
      const res = await make(u);
      expect(res.status, u).toBe(409);
      expect(await json(res)).toMatchObject({ error: 'conflict', detail: expect.any(String) });
    }
    const dup = await call('PATCH', `/users/${adminId}`, { username: 'SARA' });
    expect(dup.status).toBe(409);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM users WHERE username = 'sara'`)).toEqual({ n: 1 });
    // The failed creates left no audit rows.
    expect((await auditRows('user.create')).length).toBe(1);
  });

  it('validates fields: password length, role, lang, email, active type', async () => {
    const base = { username: 'sara', name: 'Sara', role: 'manager', password: 'long-enough' };
    for (const extra of [
      { password: 'short' }, { password: 12345678 }, { password: undefined }, { role: 'owner' }, { role: undefined },
      { lang: 'fr' }, { email: 'nope' }, { active: 'yes' }, { name: '  ' },
    ]) {
      const res = await call('POST', '/users', { ...base, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await call('POST', '/users', 'not an object')).status).toBe(400);
    const raw = await SELF.fetch('http://x/api/admin/users', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `sid=${sid}` }, body: '{bad',
    });
    expect(raw.status).toBe(400);
    expect(await one(env.DB, `SELECT 1 AS x FROM users WHERE username = 'sara'`)).toBeNull();
  });

  it('patch: 404 for an unknown or malformed id, 400 for an empty or invalid patch', async () => {
    expect((await call('PATCH', '/users/99999', { name: 'x' })).status).toBe(404);
    expect((await call('PATCH', '/users/abc', { name: 'x' })).status).toBe(404);
    expect(await json(await call('PATCH', '/users/99999', { name: 'x' }))).toEqual({ error: 'not_found' });
    const id = await addUser('sara', 'long-enough');
    expect((await call('PATCH', `/users/${id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/users/${id}`, { role: 'owner' })).status).toBe(400);
    expect((await call('PATCH', `/users/${id}`, { active: 0 })).status).toBe(400);
  });

  it('disabling a user deletes their sessions and locks them out', async () => {
    const id = await addUser('sara', 'sara-password');
    const saraSid = await sidFor('sara', 'sara-password');
    expect((await SELF.fetch('http://x/api/me', { headers: { cookie: `sid=${saraSid}` } })).status).toBe(200);
    expect((await call('PATCH', `/users/${id}`, { active: false })).status).toBe(200);
    expect(await one(env.DB, `SELECT 1 AS x FROM sessions WHERE user_id = ?`, id)).toBeNull();
    expect((await SELF.fetch('http://x/api/me', { headers: { cookie: `sid=${saraSid}` } })).status).toBe(401);
    // Boss's own session is untouched.
    expect(await one(env.DB, `SELECT 1 AS x FROM sessions WHERE user_id = ?`, adminId)).not.toBeNull();
  });

  it('an admin cannot disable or demote themselves', async () => {
    for (const patch of [{ active: false }, { role: 'manager' }]) {
      const res = await call('PATCH', `/users/${adminId}`, patch);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_request');
    }
    expect(await one(env.DB, `SELECT role, active FROM users WHERE id = ?`, adminId)).toEqual({ role: 'admin', active: 1 });
    // Harmless self edits still work.
    expect((await call('PATCH', `/users/${adminId}`, { name: 'The Boss', role: 'admin', active: true })).status).toBe(200);
  });

  it('password reset: validates, changes the hash, signs the user out, never echoes secrets', async () => {
    const id = await addUser('sara', 'old-password');
    const saraSid = await sidFor('sara', 'old-password');
    expect((await call('POST', `/users/${id}/password`, { password: 'short' })).status).toBe(400);
    expect((await call('POST', '/users/99999/password', { password: 'new-password' })).status).toBe(404);

    const res = await call('POST', `/users/${id}/password`, { password: 'new-password' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await SELF.fetch('http://x/api/me', { headers: { cookie: `sid=${saraSid}` } })).status).toBe(401);
    const bad = await SELF.fetch('http://x/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sara', password: 'old-password' }),
    });
    expect(bad.status).toBe(401);
    await sidFor('sara', 'new-password');
  });

  it('a reset without a password makes a first password, shows it until the person changes it, and unlocks', async () => {
    const id = await addUser('omar', 'old-password');
    const res = await call('POST', `/users/${id}/password`, {});
    expect(res.status).toBe(200);
    const { password } = await json(res);
    expect(password).toMatch(/^[A-Z]{4}[2-9]{4}$/);
    const list = async () => (await json(await call('GET', '/accounts'))).accounts.find((a: { id: number }) => a.id === id);
    expect(await list()).toMatchObject({ firstPw: password, status: 'norole' });
    const sid = await sidFor('omar', password);
    const chg = await SELF.fetch('http://x/api/me/password', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `sid=${sid}` },
      body: JSON.stringify({ current: password, currentPassword: password, password: 'my-own-pass-1', newPassword: 'my-own-pass-1' }),
    });
    expect(chg.status, await chg.clone().text()).toBe(200);
    expect(await list()).toMatchObject({ firstPw: null });
    expect((await list()).lastLogin).toBeTruthy();
  });

  it('an admin changing their own password keeps their session', async () => {
    expect((await call('POST', `/users/${adminId}/password`, { password: 'brand-new-pw' })).status).toBe(200);
    expect((await call('GET', '/users')).status).toBe(200);
    await sidFor('boss', 'brand-new-pw');
  });

  it('writes audit rows without passwords or hashes', async () => {
    const res = await call('POST', '/users', { username: 'sara', name: 'Sara', role: 'manager', password: 'secret-pass-123' });
    const id = (await json(res)).user.id;
    await call('PATCH', `/users/${id}`, { name: 'Sara B', active: false });
    await call('POST', `/users/${id}/password`, { password: 'another-secret-456' });

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['user.create', 'user.update', 'user.password']);
    expect(rows.every((r) => r.user_id === adminId)).toBe(true);
    expect(rows[0]!.detail).toMatchObject({ id, username: 'sara', role: 'manager' });
    expect(rows[1]!.detail).toEqual({ id, changes: { name: { from: 'Sara', to: 'Sara B' }, active: { from: true, to: false } } });
    expect(rows[2]!.detail).toEqual({ id, username: 'sara' });
    const dump = JSON.stringify(await all(env.DB, `SELECT * FROM audit`));
    expect(dump).not.toMatch(/secret-pass|another-secret|pbkdf2|pw_hash|pw_salt/);
  });

  it('a no-op patch writes no audit row', async () => {
    const id = await addUser('sara', 'long-enough');
    expect((await call('PATCH', `/users/${id}`, { name: 'Name sara' })).status).toBe(200);
    expect(await auditRows('user.update')).toEqual([]);
  });
});

describe('departments', () => {
  it('create, list, patch round-trip with upper-cased trimmed code', async () => {
    const created = await call('POST', '/departments', { code: ' cd ', name: 'Consumer Division' });
    expect(created.status).toBe(201);
    const { department } = await json(created);
    expect(department).toEqual({ id: expect.any(Number), code: 'CD', name: 'Consumer Division' });

    await call('POST', '/departments', { code: 'ab', name: 'Another' });
    expect((await json(await call('GET', '/departments'))).departments.map((d: Json) => d.code)).toEqual(['AB', 'CD']);

    const patched = await call('PATCH', `/departments/${department.id}`, { name: 'Consumer', code: 'cons' });
    expect(patched.status).toBe(200);
    expect((await json(patched)).department).toEqual({ id: department.id, code: 'CONS', name: 'Consumer' });
  });

  it('duplicate code is 409 (case-insensitive), invalid input is 400, unknown id is 404', async () => {
    await call('POST', '/departments', { code: 'CD', name: 'One' });
    const dup = await call('POST', '/departments', { code: 'cd', name: 'Two' });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ error: 'conflict' });
    expect((await call('POST', '/departments', { code: '  ', name: 'x' })).status).toBe(400);
    expect((await call('POST', '/departments', { code: 'X', name: '' })).status).toBe(400);
    expect((await call('POST', '/departments', { code: 'X' })).status).toBe(400);
    expect((await call('PATCH', '/departments/9999', { name: 'x' })).status).toBe(404);
    const other = (await json(await call('POST', '/departments', { code: 'EF', name: 'Three' }))).department;
    expect((await call('PATCH', `/departments/${other.id}`, { code: 'cd' })).status).toBe(409);
    expect((await call('PATCH', `/departments/${other.id}`, {})).status).toBe(400);
  });

  it('writes audit rows (create carries the new id)', async () => {
    const { department } = await json(await call('POST', '/departments', { code: 'cd', name: 'One' }));
    await call('PATCH', `/departments/${department.id}`, { name: 'Two' });
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['dept.create', 'dept.update']);
    expect(rows[0]!.detail).toEqual({ id: department.id, code: 'CD', name: 'One' });
    expect(rows[1]!.detail).toEqual({ id: department.id, changes: { name: { from: 'One', to: 'Two' } } });
  });
});

describe('packs', () => {
  it('create, list, patch round-trip; code keeps its case; list in the file order (CSD, Water, LRB-Others)', async () => {
    const created = await call('POST', '/packs', { code: ' Pep330 ', grp: 'CSD', sort: 20 });
    expect(created.status).toBe(201);
    expect((await json(created)).pack).toEqual({ code: 'Pep330', grp: 'CSD', active: true, sort: 20 });
    await call('POST', '/packs', { code: 'Aqua', grp: 'Water', active: false, sort: 10 });
    await call('POST', '/packs', { code: 'pep330', grp: 'LRB-Others' }); // case differs: a different pack

    const list = (await json(await call('GET', '/packs'))).packs;
    expect(list).toEqual([
      { code: 'Pep330', grp: 'CSD', active: true, sort: 10 },
      { code: 'Aqua', grp: 'Water', active: false, sort: 20 },
      { code: 'pep330', grp: 'LRB-Others', active: true, sort: 30 },
    ]);

    const patched = await call('PATCH', '/packs/Pep330', { grp: 'Water', active: false, sort: 5 });
    expect(patched.status).toBe(200);
    expect((await json(patched)).pack).toEqual({ code: 'Pep330', grp: 'Water', active: false, sort: 5 });
    expect(await one(env.DB, `SELECT grp, active, sort FROM packs WHERE code = 'Pep330'`)).toEqual({ grp: 'Water', active: 0, sort: 5 });
  });

  it('works for codes that need URL encoding', async () => {
    expect((await call('POST', '/packs', { code: 'Can 330/ml', grp: 'CSD' })).status).toBe(201);
    expect((await call('PATCH', `/packs/${encodeURIComponent('Can 330/ml')}`, { sort: 3 })).status).toBe(200);
  });

  it('invalid grp is 400 on create and patch', async () => {
    for (const grp of ['Juice', 'csd', '', 5, undefined]) {
      expect((await call('POST', '/packs', { code: 'P1', grp })).status, String(grp)).toBe(400);
    }
    await call('POST', '/packs', { code: 'P1', grp: 'CSD' });
    expect((await call('PATCH', '/packs/P1', { grp: 'Juice' })).status).toBe(400);
    expect(await one(env.DB, `SELECT grp FROM packs WHERE code = 'P1'`)).toEqual({ grp: 'CSD' });
  });

  it('validates code, sort and active; duplicate code is 409; unknown code is 404', async () => {
    expect((await call('POST', '/packs', { code: '  ', grp: 'CSD' })).status).toBe(400);
    expect((await call('POST', '/packs', { code: 'P1', grp: 'CSD', sort: 1.5 })).status).toBe(400);
    expect((await call('POST', '/packs', { code: 'P1', grp: 'CSD', sort: '1' })).status).toBe(400);
    expect((await call('POST', '/packs', { code: 'P1', grp: 'CSD', active: 1 })).status).toBe(400);
    expect((await call('POST', '/packs', { code: 'P1', grp: 'CSD' })).status).toBe(201);
    const dup = await call('POST', '/packs', { code: 'P1', grp: 'Water' });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ error: 'conflict' });
    expect((await call('PATCH', '/packs/NOPE', { sort: 1 })).status).toBe(404);
    expect((await call('PATCH', '/packs/P1', {})).status).toBe(400);
    expect((await call('PATCH', '/packs/P1', { sort: 1.5 })).status).toBe(400);
  });

  it('PATCH cannot change the code', async () => {
    await call('POST', '/packs', { code: 'P1', grp: 'CSD' });
    const res = await call('PATCH', '/packs/P1', { code: 'P2', sort: 4 });
    expect(res.status).toBe(400);
    expect(await one(env.DB, `SELECT code, sort FROM packs`)).toEqual({ code: 'P1', sort: 10 });
    // Repeating the same code is harmless.
    expect((await call('PATCH', '/packs/P1', { code: 'P1', sort: 4 })).status).toBe(200);
  });

  it('writes audit rows', async () => {
    await call('POST', '/packs', { code: 'P1', grp: 'CSD', sort: 1 });
    await call('PATCH', '/packs/P1', { active: false });
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['pack.create', 'pack.update']);
    expect(rows[0]!.detail).toEqual({ code: 'P1', grp: 'CSD', active: true, sort: 1 });
    expect(rows[1]!.detail).toEqual({ code: 'P1', changes: { active: { from: true, to: false } } });
  });
});

describe('settings', () => {
  it('GET returns the default 5; PUT accepts decimals and persists', async () => {
    expect(await json(await call('GET', '/settings'))).toEqual({ capPct: 5 });
    const res = await call('PUT', '/settings', { capPct: 4.5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capPct: 4.5 });
    expect(await json(await call('GET', '/settings'))).toEqual({ capPct: 4.5 });
    expect((await call('PUT', '/settings', { capPct: 100 })).status).toBe(200);
    expect((await call('PUT', '/settings', { capPct: 0.01 })).status).toBe(200);
  });

  it('rejects 0, negatives, above 100, and non-numbers with 400 and keeps the old value', async () => {
    for (const capPct of [0, -1, 100.5, 150, '5', null, NaN, undefined]) {
      const res = await call('PUT', '/settings', { capPct });
      expect(res.status, String(capPct)).toBe(400);
      expect((await json(res)).error).toBe('invalid_request');
    }
    expect(await json(await call('GET', '/settings'))).toEqual({ capPct: 5 });
    expect(await auditRows()).toEqual([]);
  });

  it('writes an audit row with before and after', async () => {
    await call('PUT', '/settings', { capPct: 7 });
    expect(await auditRows('settings.update')).toEqual([
      { action: 'settings.update', user_id: adminId, detail: { changes: { capPct: { from: 5, to: 7 } } } },
    ]);
  });
});

describe('logAudit', () => {
  it('stores ids and JSON detail; user and ids may be null', async () => {
    await logAudit(env.DB, adminId, 'x.test', { monthId: 3, nodeId: 4 }, { a: [1, 2] });
    await logAudit(env.DB, null, 'x.system', {}, undefined);
    const rows = await all<Json>(env.DB, `SELECT user_id, action, month_id, node_id, detail_json, at FROM audit ORDER BY id`);
    expect(rows[0]).toMatchObject({ user_id: adminId, action: 'x.test', month_id: 3, node_id: 4, detail_json: '{"a":[1,2]}' });
    expect(Number.isNaN(Date.parse(rows[0]!.at))).toBe(false);
    expect(rows[1]).toMatchObject({ user_id: null, month_id: null, node_id: null, detail_json: null });
  });
});

describe('employee ID is the login', () => {
  it('setting an ID makes it the username; the password stays; the admin and taken IDs are left', async () => {
    const ali = await addUser('ali.hassan', 'ali-password');
    const sam = await addUser('sam', 'sam-password');
    const res = await call('PUT', `/users/${ali}/employee-id`, { employeeId: ' 41419 ' });
    expect(res.status).toBe(200);
    expect((await json(res)).logins.changed).toBe(1);
    expect(await one(env.DB, `SELECT username, employee_id FROM users WHERE id = ?`, ali)).toEqual({ username: '41419', employee_id: '41419' });
    await sidFor('41419', 'ali-password');
    // An ID another account already signs in with is skipped.
    const r2 = await json(await call('PUT', `/users/${sam}/employee-id`, { employeeId: '41419' }));
    expect(r2.logins.skipped).toEqual(['41419']);
    expect(await one(env.DB, `SELECT username FROM users WHERE id = ?`, sam)).toEqual({ username: 'sam' });
    await call('PUT', `/users/${adminId}/employee-id`, { employeeId: '1' });
    expect(await one(env.DB, `SELECT username FROM users WHERE id = ?`, adminId)).toEqual({ username: 'boss' });
  });
});
