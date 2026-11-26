// Admin › Users, as in the v16 prototype: one account per person of the sales
// hierarchy (Channel Head, Sales Manager, Sales Supervisor) plus the
// Commercial Director, each with a first password the admin hands out; the
// person must choose their own password at the first sign-in.
import { hashPassword, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, type Role } from '../auth';
import { all, batch, one } from '../db';
import { auditStatement } from './audit';
import { listPeople, type Position } from './hierarchySync';
import { bad, firstPassword, notFound, type Obj } from './masters';

export type AccountRole = { kind: 'admin' | Position; dept?: string | null; ws?: 'ops' | 'ka' };
export type AccountStatus = 'disabled' | 'locked' | 'norole' | 'pending' | 'active';
export type AccountDto = {
  id: number; username: string; name: string; role: Role; active: boolean;
  roles: AccountRole[]; status: AccountStatus;
  /** The first password while the person has not chosen their own. */
  firstPw: string | null;
  lastLogin: string | null;
  /** A position the admin gave the account (Other user, or a position they added). */
  position: string | null;
  /** The employee ID (from the sales file's HOD / Manager / Supervisor / KAM / KAE ID columns). */
  employeeId: string | null;
  email: string | null;
};

type Row = { id: number; username: string; name: string; role: Role; active: number; must_change_pw: number; first_pw: string | null; last_login: string | null; position: string | null; employee_id: string | null; email: string | null };

export async function listAccounts(db: D1Database): Promise<{ accounts: AccountDto[]; missing: number }> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  const [users, people, fails, wsRows] = await Promise.all([
    all<Row>(db, `SELECT id, username, name, role, active, must_change_pw, first_pw, last_login, position, employee_id, email FROM users WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`),
    listPeople(db),
    all<{ username: string; n: number }>(db, `SELECT username, COUNT(*) AS n FROM login_failures WHERE at > ? GROUP BY username`, since),
    all<{ code: string; workspace: 'ops' | 'ka' }>(db, `SELECT code, workspace FROM departments`),
  ]);
  const wsOf = new Map(wsRows.map((d) => [d.code, d.workspace]));
  const failed = new Map(fails.map((f) => [f.username, f.n]));
  const roles = new Map<number, AccountRole[]>();
  for (const p of people) {
    if (p.userId === null) continue;
    const list = roles.get(p.userId) ?? [];
    if (p.position === 'cd') for (const w of p.workspaces ?? []) list.push({ kind: 'cd', ws: w as 'ops' | 'ka' });
    else list.push({ kind: p.position, dept: p.dept, ws: p.dept ? wsOf.get(p.dept) : undefined });
    roles.set(p.userId, list);
  }
  const accounts = users.map((u): AccountDto => {
    const r = [...(u.role === 'admin' ? [{ kind: 'admin' as const }] : []), ...(roles.get(u.id) ?? [])];
    const status: AccountStatus = u.active !== 1 ? 'disabled'
      : (failed.get(u.username) ?? 0) >= LOGIN_MAX_FAILURES ? 'locked'
      : r.length === 0 && !u.position ? 'norole'
      : u.must_change_pw === 1 ? 'pending' : 'active';
    return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active === 1, roles: r, status, firstPw: u.must_change_pw === 1 ? u.first_pw : null, lastLogin: u.last_login, position: u.position, employeeId: u.employee_id, email: u.email };
  });
  // The top of a Key Account department (MDM) has no account of its own: it is the Operation Head of Department.
  const isKaHead = (p: { position: string; dept: string | null }) => p.position === 'head' && !!p.dept && wsOf.get(p.dept) === 'ka';
  const missing = new Set(people.filter((p) => p.nodeId !== null && p.userId === null && !isKaHead(p)).map((p) => p.name.trim().toLowerCase())).size
    + (people.some((p) => p.position === 'cd') ? 0 : 1);
  return { accounts, missing };
}

export async function unlockUser(db: D1Database, actorId: number, id: number): Promise<{ ok: true }> {
  const u = await one<{ username: string }>(db, `SELECT username FROM users WHERE id = ?`, id);
  if (!u) throw notFound();
  await batch(db, [
    db.prepare(`DELETE FROM login_failures WHERE username = ?`).bind(u.username),
    auditStatement(db, actorId, 'user.unlock', {}, { id, username: u.username }),
  ]);
  return { ok: true };
}

/** "Amir Elnagar" → "amir.elnagar" (as v16), made unique. */
export function usernameFor(name: string, taken: Set<string>): string {
  const base = name.normalize('NFKD').replace(/[^\w\s.-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '') || 'user';
  let u = base;
  for (let i = 2; taken.has(u); i++) u = `${base}${i}`;
  return u;
}

export type SyncStep = { created: { name: string; username: string; password: string } | null; linked: number; remaining: number };

/**
 * One step of "create the missing accounts": links every hierarchy person to
 * an active account with the same name, then creates at most one new account
 * (one password hash per request) and links all of that person's positions.
 * The Commercial Director account is made first when nobody has the CD role.
 * Call again while `remaining` > 0.
 */
export async function syncNextAccount(db: D1Database, actorId: number): Promise<SyncStep> {
  const users = await all<{ id: number; username: string; name: string; role: Role; active: number }>(db, `SELECT id, username, name, role, active FROM users`);
  const byName = new Map(users.filter((u) => u.active === 1).map((u) => [u.name.trim().toLowerCase(), u.id]));
  const nodes = await all<{ id: number; name: string; depth: number }>(db,
    `WITH RECURSIVE t(id, name, depth) AS (
       SELECT id, name, 0 FROM nodes WHERE parent_id IS NULL
         AND dept_id NOT IN (SELECT id FROM departments WHERE workspace = 'ka')
       UNION ALL SELECT n.id, n.name, t.depth + 1 FROM nodes n JOIN t ON n.parent_id = t.id)
     SELECT t.id, t.name, t.depth FROM t JOIN nodes n ON n.id = t.id WHERE n.manager_user_id IS NULL
     UNION ALL
     SELECT k.id, k.name, 1 FROM nodes k JOIN departments d ON d.id = k.dept_id
     WHERE d.workspace = 'ka' AND k.parent_id IS NOT NULL AND k.manager_user_id IS NULL
     ORDER BY 3, 2`);
  const link = nodes.filter((n) => byName.has(n.name.trim().toLowerCase()));
  if (link.length) {
    await batch(db, [
      ...link.map((n) => db.prepare(`UPDATE nodes SET manager_user_id = ? WHERE id = ?`).bind(byName.get(n.name.trim().toLowerCase())!, n.id)),
      // Months already running: the person gets their turn there too.
      ...link.map((n) => db.prepare(`UPDATE month_nodes SET manager_user_id = ? WHERE node_id = ? AND manager_user_id IS NULL`).bind(byName.get(n.name.trim().toLowerCase())!, n.id)),
      auditStatement(db, actorId, 'accounts.link', {}, { nodes: link.length }),
    ]);
  }
  const left = nodes.filter((n) => !byName.has(n.name.trim().toLowerCase()));
  const names = [...new Set(left.map((n) => n.name.trim()))];
  const hasCd = !!(await one(db, `SELECT 1 FROM user_roles WHERE role = 'cd'`));
  const taken = new Set(users.map((u) => u.username));
  const pw = firstPassword();

  if (!hasCd) {
    const username = usernameFor('commercial.director', taken);
    const { hash, salt } = await hashPassword(pw);
    await batch(db, [
      db.prepare(`INSERT INTO users(username, name, pw_hash, pw_salt, role, lang, must_change_pw, first_pw) VALUES (?, 'Commercial Director', ?, ?, 'manager', 'en', 1, ?)`).bind(username, hash, salt, pw),
      db.prepare(`INSERT INTO user_roles(user_id, role, workspace) SELECT id, 'cd', 'ops' FROM users WHERE username = ?`).bind(username),
      db.prepare(`INSERT INTO user_roles(user_id, role, workspace) SELECT id, 'cd', 'ka' FROM users WHERE username = ?`).bind(username),
      auditStatement(db, actorId, 'user.create', {}, { username, name: 'Commercial Director', cd: ['ops', 'ka'] }),
    ]);
    return { created: { name: 'Commercial Director', username, password: pw }, linked: link.length, remaining: names.length };
  }
  const name = names[0];
  if (name === undefined) return { created: null, linked: link.length, remaining: 0 };
  const username = usernameFor(name, taken);
  const { hash, salt } = await hashPassword(pw); // the only PBKDF2 of this request
  const ids = left.filter((n) => n.name.trim() === name).map((n) => n.id);
  await batch(db, [
    db.prepare(`INSERT INTO users(username, name, pw_hash, pw_salt, role, lang, must_change_pw, first_pw) VALUES (?, ?, ?, ?, 'manager', 'en', 1, ?)`).bind(username, name, hash, salt, pw),
    ...ids.map((id) => db.prepare(`UPDATE nodes SET manager_user_id = (SELECT id FROM users WHERE username = ?) WHERE id = ?`).bind(username, id)),
    ...ids.map((id) => db.prepare(`UPDATE month_nodes SET manager_user_id = (SELECT id FROM users WHERE username = ?) WHERE node_id = ? AND manager_user_id IS NULL`).bind(username, id)),
    auditStatement(db, actorId, 'user.create', {}, { username, name, nodes: ids.length }),
  ]);
  return { created: { name, username, password: pw }, linked: link.length, remaining: names.length - 1 };
}

// ---------- delete, positions, Key Account links ----------

/**
 * Deletes an account from the list. The row is kept for the history (audit,
 * uploads) but hidden, signed out, disabled and renamed so the username is
 * free again; the hierarchy places it held become open.
 */
export async function deleteUser(db: D1Database, actorId: number, id: number): Promise<{ ok: true }> {
  if (id === actorId) throw bad('you cannot delete yourself');
  const u = await one<{ username: string; name: string }>(db, `SELECT username, name FROM users WHERE id = ? AND deleted_at IS NULL`, id);
  if (!u) throw notFound();
  await batch(db, [
    db.prepare(`UPDATE users SET deleted_at = ?, active = 0, first_pw = NULL, username = ? WHERE id = ?`).bind(new Date().toISOString(), `deleted.${id}.${u.username}`, id),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
    db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).bind(id),
    db.prepare(`UPDATE nodes SET manager_user_id = NULL WHERE manager_user_id = ?`).bind(id),
    db.prepare(`UPDATE month_nodes SET manager_user_id = NULL WHERE manager_user_id = ?`).bind(id),
    auditStatement(db, actorId, 'user.delete', {}, { id, username: u.username, name: u.name }),
  ]);
  return { ok: true };
}

const POSITIONS_KEY = 'positions_json';

/** Positions the admin added (besides Supervisor, Manager, Head of Department, KAM, KAE, CD, Admin). */
export async function getPositions(db: D1Database): Promise<string[]> {
  const r = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, POSITIONS_KEY);
  try {
    const v = r ? JSON.parse(r.value) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function setPositions(db: D1Database, actorId: number, body: Obj): Promise<{ positions: string[] }> {
  if (!Array.isArray(body.positions) || body.positions.length > 50) throw bad('positions must be a list of at most 50');
  const seen = new Set<string>();
  const positions: string[] = [];
  for (const p of body.positions) {
    if (typeof p !== 'string' || !p.trim() || p.trim().length > 60) throw bad('each position must be a text of 1 to 60 characters');
    const k = p.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    positions.push(p.trim());
  }
  await batch(db, [
    db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(POSITIONS_KEY, JSON.stringify(positions)),
    auditStatement(db, actorId, 'positions.set', {}, { positions }),
  ]);
  return { positions };
}

export type KaLink = { kaDeptId: number; opsDeptId: number | null };

export async function listKaLinks(db: D1Database): Promise<KaLink[]> {
  return all<KaLink>(db, `SELECT id AS kaDeptId, ops_dept_id AS opsDeptId FROM departments WHERE workspace = 'ka' ORDER BY sort, code`);
}

/**
 * Links a Key Account department to the Operation department its target is
 * built on. The Key Account Head (MDM) is the Operation Head: the top node of
 * the Key Account department gets the Operation Head's account.
 */
export async function setKaLink(db: D1Database, actorId: number, kaDeptId: number, body: Obj): Promise<KaLink> {
  const ka = await one<{ id: number }>(db, `SELECT id FROM departments WHERE id = ? AND workspace = 'ka'`, kaDeptId);
  if (!ka) throw notFound();
  const raw = body.opsDeptId;
  let opsDeptId: number | null = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) throw bad('opsDeptId must be a department id');
    const ops = await one<{ id: number }>(db, `SELECT id FROM departments WHERE id = ? AND workspace = 'ops'`, raw);
    if (!ops) throw bad('opsDeptId must be an Operation department');
    opsDeptId = raw;
  }
  const head = opsDeptId === null ? null
    : (await one<{ u: number | null }>(db, `SELECT manager_user_id AS u FROM nodes WHERE dept_id = ? AND parent_id IS NULL`, opsDeptId))?.u ?? null;
  await batch(db, [
    db.prepare(`UPDATE departments SET ops_dept_id = ? WHERE id = ?`).bind(opsDeptId, kaDeptId),
    ...(head !== null ? [
      db.prepare(`UPDATE nodes SET manager_user_id = ? WHERE dept_id = ? AND parent_id IS NULL`).bind(head, kaDeptId),
      db.prepare(`UPDATE month_nodes SET manager_user_id = ? WHERE dept_id = ? AND node_id = (SELECT id FROM nodes WHERE dept_id = ? AND parent_id IS NULL)`).bind(head, kaDeptId, kaDeptId),
    ] : []),
    auditStatement(db, actorId, 'dept.ka_link', {}, { kaDeptId, opsDeptId, headUserId: head }),
  ]);
  return { kaDeptId, opsDeptId };
}

/**
 * Employee IDs from the sales file: each person's name with their ID (HOD,
 * Manager, Supervisor, KAM), matched to accounts by name; and Key Account
 * routes (KAE IDs), given to the KAE who manages that route's node.
 */
export async function setEmployeeIds(db: D1Database, actorId: number, body: Obj): Promise<{ matched: number; notFound: string[] }> {
  const people = Array.isArray(body.people) ? body.people : [];
  const kae = Array.isArray(body.kae) ? body.kae : [];
  if (people.length > 5000 || kae.length > 5000) throw bad('at most 5000 names');
  const byName = new Map<string, string>();
  for (const p of people) {
    const o = p as { name?: unknown; id?: unknown };
    if (typeof o.name !== 'string' || typeof o.id !== 'string') continue;
    const name = o.name.trim().toLowerCase().replace(/\s+/g, ' ');
    const id = o.id.trim();
    if (name && id && id.length <= 40) byName.set(name, id);
  }
  const users = await all<{ id: number; name: string; employee_id: string | null }>(db, `SELECT id, name, employee_id FROM users WHERE deleted_at IS NULL`);
  const set = new Map<number, string>();
  const seen = new Set<string>();
  for (const u of users) {
    const k = u.name.trim().toLowerCase().replace(/\s+/g, ' ');
    const id = byName.get(k);
    if (id) { set.set(u.id, id); seen.add(k); }
  }
  // KAE IDs: the account managing the Key Account node the route is under.
  const routes = kae.filter((x): x is string => typeof x === 'string' && !!x.trim() && x.length <= 40).map((x) => x.trim());
  if (routes.length) {
    const rows = await all<{ route_code: string; u: number | null }>(db,
      `SELECT l.route_code, n.manager_user_id AS u FROM leaves l JOIN nodes n ON n.id = l.node_id JOIN departments d ON d.id = l.dept_id
       WHERE d.workspace = 'ka' AND l.route_code IN (SELECT value FROM json_each(?))`, JSON.stringify(routes));
    for (const r of rows) if (r.u !== null && !set.has(r.u)) set.set(r.u, r.route_code);
  }
  const stmts = [...set.entries()].map(([id, emp]) => db.prepare(`UPDATE users SET employee_id = ? WHERE id = ?`).bind(emp, id));
  stmts.push(auditStatement(db, actorId, 'users.employee_ids', {}, { matched: set.size }));
  await batch(db, stmts);
  return { matched: set.size, notFound: [...byName.keys()].filter((k) => !seen.has(k)).slice(0, 50) };
}

/** The admin types a person's employee ID (empty clears it). */
export async function setEmployeeId(db: D1Database, actorId: number, id: number, body: Obj): Promise<{ employeeId: string | null }> {
  const v = body.employeeId;
  if (v !== null && v !== undefined && (typeof v !== 'string' || v.trim().length > 40)) throw bad('the ID must be a text of at most 40 characters');
  const emp = typeof v === 'string' && v.trim() ? v.trim() : null;
  const u = await one<{ id: number }>(db, `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, id);
  if (!u) throw notFound();
  await batch(db, [
    db.prepare(`UPDATE users SET employee_id = ? WHERE id = ?`).bind(emp, id),
    auditStatement(db, actorId, 'user.employee_id', {}, { id, employeeId: emp }),
  ]);
  return { employeeId: emp };
}

const IDS_AS_LOGIN = 'usernames_from_ids_v1';

/**
 * The employee ID is the login: every account with an ID (not the admin) signs
 * in with it. Passwords stay. An ID another account already uses as its login is skipped.
 */
export async function usernamesFromIds(db: D1Database, actorId: number | null): Promise<{ changed: number; skipped: string[] }> {
  const users = await all<{ id: number; username: string; role: Role; employee_id: string | null }>(db,
    `SELECT id, username, role, employee_id FROM users WHERE deleted_at IS NULL`);
  const taken = new Map((await all<{ id: number; username: string }>(db, `SELECT id, username FROM users`)).map((u) => [u.username, u.id]));
  const stmts: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  for (const u of users) {
    if (u.role === 'admin' || !u.employee_id) continue;
    const want = u.employee_id.trim().toLowerCase().replace(/\s+/g, '');
    if (!want || want === u.username) continue;
    const owner = taken.get(want);
    if (owner !== undefined && owner !== u.id) { skipped.push(u.employee_id); continue; }
    taken.delete(u.username);
    taken.set(want, u.id);
    stmts.push(db.prepare(`UPDATE users SET username = ? WHERE id = ?`).bind(want, u.id));
    if (actorId !== null) stmts.push(auditStatement(db, actorId, 'user.username', {}, { id: u.id, from: u.username, to: want }));
  }
  stmts.push(db.prepare(`INSERT INTO settings(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(IDS_AS_LOGIN));
  await batch(db, stmts);
  return { changed: actorId === null ? stmts.length - 1 : (stmts.length - 1) / 2, skipped };
}

/** Once after this change: the accounts that already have an ID sign in with it. */
export async function usernamesFromIdsOnce(db: D1Database, actorId: number): Promise<void> {
  if (await one(db, `SELECT 1 AS x FROM settings WHERE key = ?`, IDS_AS_LOGIN)) return;
  await usernamesFromIds(db, actorId);
}
