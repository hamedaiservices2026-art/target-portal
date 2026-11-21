import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';
import { applyHierarchy, applyUsers, stagePassword } from '../../src/worker/services/imports';

type Json = Record<string, any>;

async function addUser(username: string, password = 'password-123', role: 'admin' | 'manager' = 'manager', active = 1): Promise<number> {
  const { hash, salt } = await hashPassword(password);
  return (await run(env.DB, `INSERT INTO users(username, name, pw_hash, pw_salt, role, active) VALUES (?, ?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role, active)).lastRowId;
}

async function login(username: string, password = 'password-123'): Promise<Response> {
  return SELF.fetch('http://x/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
}
async function sidFor(username: string, password = 'password-123'): Promise<string> {
  const res = await login(username, password);
  expect(res.status, `login ${username}`).toBe(200);
  return /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

let sid: string;
let adminId: number;

function call(method: string, path: string, body?: unknown, cookie: string | null = sid): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `sid=${cookie}`;
  return SELF.fetch(`http://x/api${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;
const post = async (path: string, body: unknown, status = 200): Promise<Json> => {
  const res = await call('POST', `/admin/import${path}`, body);
  const out = await json(res);
  expect(res.status, `${path} ${JSON.stringify(out).slice(0, 300)}`).toBe(status);
  return out;
};
const auditOf = async (action: string): Promise<Json[]> =>
  (await all<{ detail_json: string }>(env.DB, `SELECT detail_json FROM audit WHERE action = ? ORDER BY id`, action)).map((r) => JSON.parse(r.detail_json));

beforeEach(async () => {
  for (const t of ['audit', 'import_passwords', 'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months',
    'leaves', 'nodes', 'sessions', 'login_failures', 'packs', 'departments', 'users']) {
    await run(env.DB, `DELETE FROM ${t}`);
  }
  adminId = await addUser('boss', 'boss-password', 'admin');
  sid = await sidFor('boss', 'boss-password');
});

const ROUTES = ['/users/preview', '/users/password', '/users/apply', '/packs/preview', '/packs/apply', '/hierarchy/preview', '/hierarchy/apply'];

describe('access and request guards', () => {
  it('401 without a session, 403 for a manager, on every import route', async () => {
    await addUser('mgr');
    const mgr = await sidFor('mgr');
    for (const r of ROUTES) {
      expect((await call('POST', `/admin/import${r}`, {}, null)).status, `${r} anon`).toBe(401);
      expect((await call('POST', `/admin/import${r}`, {}, mgr)).status, `${r} manager`).toBe(403);
    }
  });

  it('refuses a non-JSON body (415), a missing or malformed row list (400) and more than 2000 rows (413)', async () => {
    const res = await SELF.fetch('http://x/api/admin/import/packs/apply', {
      method: 'POST', headers: { 'content-type': 'text/plain', cookie: `sid=${sid}` }, body: '{}',
    });
    expect(res.status).toBe(415);
    expect((await post('/packs/preview', {}, 400)).error).toBe('invalid_request');
    expect((await post('/packs/preview', { rows: [{ line: 2, code: 7 }] }, 400)).error).toBe('invalid_request');
    const many = Array.from({ length: 2001 }, (_, i) => ({ line: i + 2, code: `P${i}`, grp: 'CSD' }));
    expect((await post('/packs/apply', { rows: many }, 413)).error).toBe('too_many_rows');
    expect(await one(env.DB, `SELECT COUNT(*) n FROM packs`)).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------- packs

describe('packs import', () => {
  const rows = [
    { line: 2, code: 'CSD_PET', grp: 'CSD', sort: '1', active: 'yes' },
    { line: 3, code: 'AQ_500', grp: 'Water', sort: '', active: '' },
    { line: 4, code: 'LRB_X', grp: 'LRB-Others', sort: '7', active: 'no' },
  ];

  it('preview writes nothing; apply creates and updates in one go and audits the counts; re-apply is 0 changes', async () => {
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('CSD_PET', 'Water', 1, 1), ('OTHER', 'CSD', 1, 3)`);
    const pre = await post('/packs/preview', { rows });
    expect(pre).toMatchObject({ create: 2, update: 1, unchanged: 0, issues: [] });
    expect(await one(env.DB, `SELECT COUNT(*) n FROM packs`)).toEqual({ n: 2 });
    expect(await auditOf('import.packs')).toEqual([]);

    expect(await post('/packs/apply', { rows })).toMatchObject({ created: 2, updated: 1, unchanged: 0 });
    expect(await all(env.DB, `SELECT code, grp, active, sort FROM packs ORDER BY code`)).toEqual([
      { code: 'AQ_500', grp: 'Water', active: 1, sort: 4 },
      { code: 'CSD_PET', grp: 'CSD', active: 1, sort: 1 },
      { code: 'LRB_X', grp: 'LRB-Others', active: 0, sort: 7 },
      { code: 'OTHER', grp: 'CSD', active: 1, sort: 3 }, // not in the file: left alone
    ]);
    expect(await auditOf('import.packs')).toEqual([{ rows: 3, created: 2, updated: 1, unchanged: 0, codes: { created: ['AQ_500', 'LRB_X'], updated: ['CSD_PET'] } }]);

    expect(await post('/packs/apply', { rows })).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await auditOf('import.packs')).toHaveLength(1); // nothing to do, nothing written
  });

  it('apply re-validates: a file with any error writes nothing and returns the issues', async () => {
    const res = await post('/packs/apply', { rows: [...rows, { line: 5, code: 'BAD', grp: 'csd' }] }, 400);
    expect(res.error).toBe('invalid_request');
    expect(res.issues).toEqual([{ line: 5, level: 'error', code: 'invalid_value', column: 'Group', vars: { value: 'csd', allowed: 'CSD, Water, LRB-Others' } }]);
    expect(await one(env.DB, `SELECT COUNT(*) n FROM packs`)).toEqual({ n: 0 });
  });

  it('2000 rows are applied atomically within the statement budget', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ line: i + 2, code: `P${String(i).padStart(4, '0')}`, grp: 'CSD', sort: String(i) }));
    expect(await post('/packs/apply', { rows: many })).toMatchObject({ created: 2000 });
    expect(await one(env.DB, `SELECT COUNT(*) n, MAX(sort) m FROM packs`)).toEqual({ n: 2000, m: 1999 });
  });
});

// ---------------------------------------------------------------- users

describe('users import', () => {
  const ID = 'import-0001';
  const pw = (username: string, password: string, op: 'verify' | 'hash') => post('/users/password', { importId: ID, username, password, op });

  it('preview lists the password work; one password per request; apply creates the users atomically; passwords never in audit', async () => {
    await addUser('ali'); // existing, stays as it is
    const rows = [
      { line: 2, username: 'Sara', name: 'Sara Q', role: 'manager', password: 'sara-password', lang: 'ar', email: 'sara@x.com' },
      { line: 3, username: 'omar', name: 'Omar', role: 'admin', password: '', lang: '', email: '' },
      { line: 4, username: 'ali', name: 'Name ali', role: 'manager', password: '', lang: '', email: '' },
    ];
    const pre = await post('/users/preview', { importId: ID, rows });
    expect(pre).toMatchObject({ create: 2, update: 0, unchanged: 1, issues: [] });
    expect(pre.pending).toEqual([{ line: 2, username: 'sara', op: 'hash' }, { line: 3, username: 'omar', op: 'hash' }]);

    // Apply before the passwords are staged is refused.
    expect((await post('/users/apply', { importId: ID, rows }, 409)).detail).toBe('passwords_pending');

    expect(await pw('sara', 'sara-password', 'hash')).toEqual({ ok: true });
    const gen = await pw('omar', '', 'hash');
    expect(gen.generated).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(await one(env.DB, `SELECT COUNT(*) n FROM users`)).toEqual({ n: 2 }); // still nothing written to users
    expect((await post('/users/preview', { importId: ID, rows })).pending).toEqual([]);

    expect(await post('/users/apply', { importId: ID, rows })).toMatchObject({ created: 2, updated: 0, unchanged: 1, passwordsSet: ['sara', 'omar'] });
    expect(await all(env.DB, `SELECT username, name, email, role, lang, active FROM users WHERE username IN ('sara', 'omar') ORDER BY username`)).toEqual([
      { username: 'omar', name: 'Omar', email: null, role: 'admin', lang: 'en', active: 1 },
      { username: 'sara', name: 'Sara Q', email: 'sara@x.com', role: 'manager', lang: 'ar', active: 1 },
    ]);
    expect((await login('sara', 'sara-password')).status).toBe(200);
    expect((await login('omar', gen.generated)).status).toBe(200);
    const stored = await one<{ pw_hash: string }>(env.DB, `SELECT pw_hash FROM users WHERE username = 'sara'`);
    expect(stored!.pw_hash).toMatch(/^pbkdf2-sha256\$10000\$/); // the normal hashing path, iterations in the hash
    expect(await one(env.DB, `SELECT COUNT(*) n FROM import_passwords`)).toEqual({ n: 0 }); // staging cleared

    const audit = await all<{ detail_json: string }>(env.DB, `SELECT detail_json FROM audit`);
    const text = audit.map((a) => a.detail_json).join('\n');
    expect(text).not.toContain('sara-password');
    expect(text).not.toContain(gen.generated);
    expect(text).not.toContain('pbkdf2');
    expect(await auditOf('import.users')).toEqual([{ rows: 3, created: 2, updated: 0, unchanged: 1, passwordsSet: 2, usernames: { created: ['sara', 'omar'], updated: [] } }]);
  });

  it('existing users: blank password = unchanged; a different password resets it and signs them out; the same one is no change', async () => {
    await addUser('ali', 'old-password');
    const aliSid = await sidFor('ali', 'old-password');
    const row = (password: string, name = 'Name ali') => [{ line: 2, username: 'ALI', name, role: 'manager', password, lang: 'ar', email: '' }];

    // Same password: verify says same; the only change is the language.
    let pre = await post('/users/preview', { importId: ID, rows: row('old-password') });
    expect(pre.pending).toEqual([{ line: 2, username: 'ali', op: 'verify' }]);
    expect(await pw('ali', 'old-password', 'verify')).toEqual({ same: true });
    pre = await post('/users/preview', { importId: ID, rows: row('old-password') });
    expect(pre).toMatchObject({ update: 1, pending: [] });
    expect(pre.actions[0].changes).toEqual(['lang']);
    await post('/users/apply', { importId: ID, rows: row('old-password') });
    expect((await call('GET', '/me', undefined, aliSid)).status).toBe(200); // still signed in

    // A new password: verify says different, then hash; apply resets it and signs ali out.
    const ID2 = 'import-0002';
    expect(await post('/users/password', { importId: ID2, username: 'ali', password: 'new-password-1', op: 'verify' })).toEqual({ same: false });
    expect(await post('/users/password', { importId: ID2, username: 'ali', password: 'new-password-1', op: 'hash' })).toEqual({ ok: true });
    expect(await post('/users/apply', { importId: ID2, rows: row('new-password-1') })).toMatchObject({ updated: 1 });
    expect((await call('GET', '/me', undefined, aliSid)).status).toBe(401);
    expect((await login('ali', 'new-password-1')).status).toBe(200);

    // Re-applying the file (blank password) changes nothing at all.
    expect(await post('/users/apply', { importId: 'import-0003', rows: row('') })).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(await auditOf('import.users')).toHaveLength(2);
  });

  it('the password step validates its input and refuses a blank password for an existing user', async () => {
    await addUser('ali');
    expect((await post('/users/password', { importId: 'x', username: 'a', password: 'secret-123', op: 'hash' }, 400)).detail).toMatch(/importId/);
    expect((await post('/users/password', { importId: ID, username: 'new', password: 'short', op: 'hash' }, 400)).detail).toMatch(/at least 8/);
    expect((await post('/users/password', { importId: ID, username: 'ali', password: '', op: 'hash' }, 400)).detail).toMatch(/blank/);
    expect((await post('/users/password', { importId: ID, username: 'nobody', password: 'secret-123', op: 'verify' }, 400)).detail).toMatch(/does not exist/);
    expect((await post('/users/password', { importId: ID, username: 'ali', password: 'secret-123', op: 'other' }, 400)).detail).toMatch(/op/);
  });

  it('wrong passwords in the verify step count as failed logins: the 6th is refused (429)', async () => {
    await addUser('ali', 'right-password-1');
    for (let i = 0; i < 5; i++) expect(await pw('ali', `wrong-password-${i}`, 'verify')).toEqual({ same: false });
    const res = await post('/users/password', { importId: ID, username: 'ali', password: 'right-password-1', op: 'verify' }, 429);
    expect(res.error).toBe('too_many_attempts');
    // Insert-first like the login: the refused attempt is recorded too (5 wrong + the refused one).
    expect(await one(env.DB, `SELECT COUNT(*) n FROM login_failures WHERE username = 'ali'`)).toEqual({ n: 6 });
    expect((await login('ali', 'right-password-1')).status).toBe(429); // the same throttle as the login
    // A right answer is not a failure.
    await addUser('sara', 'sara-password');
    expect(await pw('sara', 'sara-password', 'verify')).toEqual({ same: true });
    expect(await one(env.DB, `SELECT COUNT(*) n FROM login_failures WHERE username = 'sara'`)).toEqual({ n: 0 });
  });

  it('a staged password older than an hour is ignored by preview and apply even before it is pruned', async () => {
    const rows = [{ line: 2, username: 'newbie', name: 'N', role: 'manager', password: 'newbie-pass', lang: '', email: '' }];
    await pw('newbie', 'newbie-pass', 'hash');
    await run(env.DB, `UPDATE import_passwords SET created_at = ?`, new Date(Date.now() - 61 * 60 * 1000).toISOString());
    expect((await post('/users/preview', { importId: ID, rows })).pending).toEqual([{ line: 2, username: 'newbie', op: 'hash' }]);
    expect((await post('/users/apply', { importId: ID, rows }, 409)).detail).toBe('passwords_pending');
    expect(await one(env.DB, `SELECT COUNT(*) n FROM users WHERE username = 'newbie'`)).toEqual({ n: 0 });
  });

  it('another admin cannot take over a staged slot (same import id and username)', async () => {
    await addUser('boss2', 'boss2-password', 'admin');
    const other = await sidFor('boss2', 'boss2-password');
    await pw('newbie', 'newbie-pass', 'hash');
    const before = await one(env.DB, `SELECT actor_id, pw_hash FROM import_passwords`);
    const res = await call('POST', '/admin/import/users/password', { importId: ID, username: 'newbie', password: 'other-pass-1', op: 'hash' }, other);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('import_slot_taken');
    expect(await one(env.DB, `SELECT actor_id, pw_hash FROM import_passwords`)).toEqual(before);
    expect(before!.actor_id).toBe(adminId);
  });

  it('apply reports whose password it set: a user created after the password step does not get the generated one', async () => {
    const rows = [{ line: 2, username: 'newbie', name: 'N', role: 'manager', password: '', lang: '', email: '' }];
    const gen = await pw('newbie', '', 'hash');
    expect(gen.generated).toBeTruthy();
    await addUser('newbie', 'own-password-1'); // created elsewhere meanwhile
    const out = await post('/users/apply', { importId: ID, rows });
    expect(out).toMatchObject({ created: 0, passwordsSet: [] });
    expect((await login('newbie', 'own-password-1')).status).toBe(200);
    expect((await login('newbie', gen.generated)).status).toBe(401);
  });

  it('server-side checks: duplicate usernames, self-demotion; nothing is written', async () => {
    const rows = [
      { line: 2, username: 'boss', name: 'Boss', role: 'manager', password: '', lang: '', email: '' },
      { line: 3, username: 'x1', name: 'X', role: 'manager', password: '', lang: '', email: '' },
      { line: 4, username: 'X1', name: 'X', role: 'manager', password: '', lang: '', email: '' },
    ];
    const res = await post('/users/apply', { importId: ID, rows }, 400);
    expect(res.issues.map((i: Json) => `${i.line}:${i.code}`)).toEqual(['2:self_demote', '4:duplicate']);
    expect(await one(env.DB, `SELECT role FROM users WHERE id = ?`, adminId)).toEqual({ role: 'admin' });
  });

  it('staged passwords belong to the admin who staged them and expire', async () => {
    await addUser('boss2', 'boss2-password', 'admin');
    const other = await sidFor('boss2', 'boss2-password');
    await pw('newbie', 'newbie-pass', 'hash');
    const rows = [{ line: 2, username: 'newbie', name: 'N', role: 'manager', password: 'newbie-pass', lang: '', email: '' }];
    const res = await call('POST', '/admin/import/users/apply', { importId: ID, rows }, other);
    expect(res.status).toBe(409);
    // An old staged row is removed by the next password step.
    await run(env.DB, `UPDATE import_passwords SET created_at = '2000-01-01T00:00:00.000Z'`);
    await pw('another', 'another-pass', 'hash');
    expect(await all(env.DB, `SELECT username FROM import_passwords`)).toEqual([{ username: 'another' }]);
  });
});

// ---------------------------------------------------------------- hierarchy

describe('hierarchy import', () => {
  let tt: number;
  let ali: number;
  let sara: number;
  beforeEach(async () => {
    tt = (await run(env.DB, `INSERT INTO departments(code, name) VALUES ('TT', 'Traditional Trade')`)).lastRowId;
    ali = await addUser('ali');
    sara = await addUser('sara');
  });
  const R = (line: number, node: string, parent: string, manager = 'ali', dept = 'TT') => ({ line, dept, node, parent, manager });
  const nodes = () => all<{ name: string; parent: string | null; manager: string | null }>(env.DB,
    `SELECT n.name, p.name AS parent, u.username AS manager FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
     LEFT JOIN users u ON u.id = n.manager_user_id ORDER BY n.name`);

  it('builds a whole tree in one apply (children listed before parents), audited; re-apply is 0 changes', async () => {
    const rows = [R(2, 'Sup 1', 'Area 1'), R(3, 'Sup 2', 'Area 1', 'sara'), R(4, 'Area 1', 'Head'), R(5, 'Head', '', 'boss')];
    expect(await post('/hierarchy/preview', { rows })).toMatchObject({ create: 4, update: 0, unchanged: 0, issues: [] });
    expect(await nodes()).toEqual([]);
    const out = await post('/hierarchy/apply', { rows });
    expect(out).toMatchObject({ created: 4, updated: 0, unchanged: 0, treeChange: null });
    expect(await nodes()).toEqual([
      { name: 'Area 1', parent: 'Head', manager: 'ali' }, { name: 'Head', parent: null, manager: 'boss' },
      { name: 'Sup 1', parent: 'Area 1', manager: 'ali' }, { name: 'Sup 2', parent: 'Area 1', manager: 'sara' },
    ]);
    expect(await auditOf('import.hierarchy')).toEqual([{ rows: 4, created: 4, updated: 0, unchanged: 0, depts: [tt] }]);
    expect(await post('/hierarchy/apply', { rows })).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
    expect(await auditOf('import.hierarchy')).toHaveLength(1);
  });

  it('refuses unknown managers, duplicates, cycles and a second root, writing nothing', async () => {
    const res = await post('/hierarchy/apply', { rows: [
      R(2, 'Head', ''), R(3, 'A', 'Head', 'ghost'), R(4, 'B', 'Head'), R(5, 'B', 'Head'), R(6, 'C', 'D'), R(7, 'D', 'C'), R(8, 'Head 2', ''),
    ] }, 400);
    expect(res.issues.filter((i: Json) => i.level === 'error').map((i: Json) => `${i.line}:${i.code}`))
      .toEqual(['3:unknown_manager', '5:duplicate', '6:cycle', '7:cycle', '8:two_roots']);
    expect(await nodes()).toEqual([]);
  });

  it('a disabled user or an unknown department is refused', async () => {
    await addUser('gone', 'password-123', 'manager', 0);
    const res = await post('/hierarchy/preview', { rows: [R(2, 'Head', '', 'gone'), R(3, 'X', '', 'ali', 'NOPE')] });
    expect(res.issues.map((i: Json) => `${i.line}:${i.code}`)).toEqual(['2:manager_disabled', '3:unknown_department']);
  });

  it('moves and manager changes reach open months like the tree editor (loading month takes moves)', async () => {
    await post('/hierarchy/apply', { rows: [R(2, 'Head', ''), R(3, 'Area 1', 'Head'), R(4, 'Area 2', 'Head'), R(5, 'Sup', 'Area 1')] });
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('P', 'CSD', 1, 0)`);
    const m = (await json(await call('POST', '/admin/months', { period: '2026-11' }))).month.id;
    const ids = Object.fromEntries((await all<{ id: number; name: string }>(env.DB, `SELECT id, name FROM nodes`)).map((n) => [n.name, n.id]));

    const out = await post('/hierarchy/apply', { rows: [R(2, 'Sup', 'Area 2', 'sara'), R(3, 'Area 1', 'Head', 'sara'), R(4, 'Head', '')] });
    expect(out).toMatchObject({ created: 0, updated: 2, unchanged: 1 });
    expect(out.treeChange).toEqual({ appliedMonths: [m], skippedMonths: [] });
    const mn = await all<{ name: string; parent_id: number | null; manager_user_id: number | null }>(env.DB,
      `SELECT name, parent_id, manager_user_id FROM month_nodes WHERE month_id = ? ORDER BY name`, m);
    expect(mn).toEqual([
      { name: 'Area 1', parent_id: ids['Head'], manager_user_id: sara },
      { name: 'Area 2', parent_id: ids['Head'], manager_user_id: ali },
      { name: 'Head', parent_id: null, manager_user_id: ali },
      { name: 'Sup', parent_id: ids['Area 2'], manager_user_id: sara },
    ]);
    expect((await auditOf('tree.apply_month')).length).toBe(2); // one for the manager changes, one for the move
  });

  it('an open-month node moved under a node created by the same import: live tree moves, the month skips it (R20)', async () => {
    await post('/hierarchy/apply', { rows: [R(2, 'Head', ''), R(3, 'Area 1', 'Head'), R(4, 'Sup', 'Area 1')] });
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('P', 'CSD', 1, 0)`);
    const m = (await json(await call('POST', '/admin/months', { period: '2026-11' }))).month.id;
    const out = await post('/hierarchy/apply', { rows: [R(2, 'Area 3', 'Head'), R(3, 'Sup', 'Area 3')] });
    expect(out).toMatchObject({ created: 1, updated: 1 });
    expect(out.treeChange).toEqual({ appliedMonths: [], skippedMonths: [m] });
    expect(await nodes()).toContainEqual({ name: 'Sup', parent: 'Area 3', manager: 'ali' });
    const mn = await one<{ parent: string }>(env.DB,
      `SELECT p.name AS parent FROM month_nodes s JOIN month_nodes p ON p.month_id = s.month_id AND p.node_id = s.parent_id
       WHERE s.month_id = ? AND s.name = 'Sup'`, m);
    expect(mn).toEqual({ parent: 'Area 1' });
  });

  it('at most 4 moves of nodes that are in open months per import', async () => {
    const base = [R(2, 'Head', ''), R(3, 'Area', 'Head'), ...Array.from({ length: 5 }, (_, i) => R(4 + i, `S${i}`, 'Head'))];
    await post('/hierarchy/apply', { rows: base });
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('P', 'CSD', 1, 0)`);
    expect((await call('POST', '/admin/months', { period: '2026-11' })).status).toBe(201);
    const move = (n: number) => Array.from({ length: n }, (_, i) => R(2 + i, `S${i}`, 'Area'));
    const res = await post('/hierarchy/apply', { rows: move(5) }, 400);
    expect(res.issues).toEqual([{ line: null, level: 'error', code: 'too_many_moves', vars: { n: 5, max: 4 } }]);
    expect((await post('/hierarchy/apply', { rows: move(4) })).updated).toBe(4);
  });

  it('a large multi-level tree (2000 rows) is created in one apply', async () => {
    const rows = [R(2, 'Head', '')];
    for (let a = 0; a < 20; a++) {
      rows.push(R(rows.length + 2, `A${a}`, 'Head'));
      for (let s = 0; s < 99 && rows.length < 2000; s++) rows.push(R(rows.length + 2, `A${a}-S${s}`, `A${a}`));
    }
    expect(rows.length).toBe(2000);
    expect(await post('/hierarchy/apply', { rows })).toMatchObject({ created: 2000 });
    expect(await one(env.DB, `SELECT COUNT(*) n FROM nodes WHERE dept_id = ?`, tt)).toEqual({ n: 2000 });
    expect(await one(env.DB, `SELECT COUNT(*) n FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE p.name = 'A7'`)).toEqual({ n: 99 });
  });
});

// ---------------------------------------------------------------- D1 budget

/** A D1 stand-in that counts every query run (each statement of a batch counts, as on the Free plan). */
function counting(db: D1Database): { db: D1Database; n: () => number } {
  let n = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
          return (...args: unknown[]) => { n++; return (target as any)[prop](...args); };
        }
        return (target as any)[prop];
      },
    });
    real.set(p, stmt);
    return p;
  };
  const proxy = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => { n += stmts.length; return db.batch(stmts.map((x) => real.get(x) ?? x)); },
  } as unknown as D1Database;
  return { db: proxy, n: () => n };
}

/** Runs `before` against the real database just before the write batch (a concurrent change). */
function racing(db: D1Database, before: () => Promise<unknown>): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          if (stmts.length > 1 || (stmts[0] as any)?.__write) await before();
          return target.batch(stmts);
        };
      }
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('apply is atomic: a concurrent change rolls the whole batch back (409)', () => {
  it('hierarchy: a node with one of the new names appears meanwhile -> nothing of the file is written', async () => {
    const tt = (await run(env.DB, `INSERT INTO departments(code, name) VALUES ('TT', 'TT')`)).lastRowId;
    await addUser('ali');
    const rows = [{ line: 2, dept: 'TT', node: 'Head', parent: '', manager: 'ali' }, { line: 3, dept: 'TT', node: 'Area', parent: 'Head', manager: 'ali' }];
    let reads = 0;
    const db = racing(env.DB, async () => {
      if (reads++ === 1) await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'Other root')`, tt);
    });
    await expect(applyHierarchy(db, adminId, { rows })).rejects.toMatchObject({ status: 409, body: { error: 'conflict', detail: 'import_changed' } });
    expect(await all(env.DB, `SELECT name FROM nodes`)).toEqual([{ name: 'Other root' }]);
    expect(await auditOf('import.hierarchy')).toEqual([]);
  });

  it('users: the staged hash vanishes meanwhile -> no user of the file is created', async () => {
    const ID = 'race-0001';
    const rows = ['a1', 'a2'].map((u, i) => ({ line: i + 2, username: u, name: u, role: 'manager', password: 'password-123', lang: '', email: '' }));
    for (const r of rows) await stagePassword(env.DB, adminId, { importId: ID, username: r.username, password: r.password, op: 'hash' });
    let reads = 0;
    const db = racing(env.DB, async () => {
      if (reads++ === 1) await run(env.DB, `DELETE FROM import_passwords WHERE username = 'a2'`);
    });
    await expect(applyUsers(db, adminId, { importId: ID, rows })).rejects.toMatchObject({ status: 409 });
    expect(await one(env.DB, `SELECT COUNT(*) n FROM users WHERE username IN ('a1', 'a2')`)).toEqual({ n: 0 });
  });
});

describe('D1 query budget (50 per request on the Free plan; the session lookup costs 1 more)', () => {
  it('maximum statements: 4 open-month moves, manager changes, 8 levels with 11 insert chunks (2000 rows)', async () => {
    await run(env.DB, `INSERT INTO departments(code, name) VALUES ('TT', 'TT')`);
    await addUser('ali');
    await addUser('sara');
    const R = (line: number, node: string, parent: string, manager = 'ali') => ({ line, dept: 'TT', node, parent, manager });
    await post('/hierarchy/apply', { rows: [R(2, 'Head', ''), R(3, 'Area', 'Head'), ...Array.from({ length: 6 }, (_, i) => R(4 + i, `S${i}`, 'Head'))] });
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('P', 'CSD', 1, 0)`);
    expect((await call('POST', '/admin/months', { period: '2026-11' })).status).toBe(201);
    const rows = [...Array.from({ length: 4 }, (_, i) => R(2 + i, `S${i}`, 'Area', 'sara')), R(6, 'S4', 'Head', 'sara'), R(7, 'S5', 'Head', 'sara')];
    // Level sizes 501, 501, 501, 487, 1, 1, 1, 1 -> 2+2+2+1+1+1+1+1 = 11 insert statements (500 rows each at most).
    const sizes = [501, 501, 501, 487, 1, 1, 1, 1];
    sizes.forEach((n, lvl) => {
      for (let i = 0; i < n; i++) rows.push(R(rows.length + 2, `L${lvl}-${i}`, lvl === 0 ? 'Area' : `L${lvl - 1}-0`));
    });
    expect(rows.length).toBe(2000);
    const c = counting(env.DB);
    const out = await applyHierarchy(c.db, adminId, { rows });
    expect(out).toMatchObject({ created: 1994, updated: 6 });
    expect(out.treeChange?.error).toBeUndefined();
    expect(c.n() + 1).toBe(44); // the figure in services/imports.ts and docs/decisions.md
  });

  it('worst-case hierarchy apply: 4 open-month moves, manager changes, 8 levels of new nodes, ~2000 rows', async () => {
    await run(env.DB, `INSERT INTO departments(code, name) VALUES ('TT', 'TT')`);
    await addUser('ali');
    await addUser('sara');
    const R = (line: number, node: string, parent: string, manager = 'ali') => ({ line, dept: 'TT', node, parent, manager });
    await post('/hierarchy/apply', { rows: [R(2, 'Head', ''), R(3, 'Area', 'Head'), ...Array.from({ length: 6 }, (_, i) => R(4 + i, `S${i}`, 'Head'))] });
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('P', 'CSD', 1, 0)`);
    expect((await call('POST', '/admin/months', { period: '2026-11' })).status).toBe(201);
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => R(2 + i, `S${i}`, 'Area', 'sara')), // 4 moves + 4 manager changes
      R(6, 'S5', 'Head', 'sara'), // manager change only
    ];
    for (let lvl = 0; rows.length < 2000; lvl = (lvl + 1) % 8) {
      rows.push(R(rows.length + 2, `N${rows.length}`, lvl === 0 ? 'Area' : `N${rows.length - 1}`));
    }
    const c = counting(env.DB);
    const out = await applyHierarchy(c.db, adminId, { rows });
    expect(out).toMatchObject({ created: 1995, updated: 5 });
    expect(out.treeChange?.error).toBeUndefined();
    expect(c.n() + 1).toBeLessThanOrEqual(50);
  });

  it('worst-case users apply (2000 rows) and one password step stay within budget', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ line: i + 2, username: `u${i}`, name: `U ${i}`, role: 'manager', password: '', lang: '', email: '' }));
    const stage = counting(env.DB);
    await stagePassword(stage.db, adminId, { importId: 'budget-01', username: 'u0', password: '', op: 'hash' });
    expect(stage.n() + 1).toBeLessThanOrEqual(5);
    // Stage the rest straight into the table (hashing 2000 passwords here would only slow the test).
    const { hash, salt } = await hashPassword('password-123');
    await run(env.DB, `INSERT INTO import_passwords(import_id, username, actor_id, pw_hash, pw_salt, created_at)
      SELECT 'budget-01', 'u' || value, ?, ?, ?, ? FROM json_each(?) WHERE value > 0`,
      adminId, hash, salt, new Date().toISOString(), JSON.stringify(rows.map((_, i) => i)));
    const c = counting(env.DB);
    expect(await applyUsers(c.db, adminId, { importId: 'budget-01', rows })).toMatchObject({ created: 2000 });
    expect(c.n() + 1).toBeLessThanOrEqual(50);
  });
});
