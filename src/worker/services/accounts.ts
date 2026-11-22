// Admin › Users, as in the v16 prototype: one account per person of the sales
// hierarchy (Channel Head, Sales Manager, Sales Supervisor) plus the
// Commercial Director, each with a first password the admin hands out; the
// person must choose their own password at the first sign-in.
import { hashPassword, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, type Role } from '../auth';
import { all, batch, one } from '../db';
import { auditStatement } from './audit';
import { listPeople, type Position } from './hierarchySync';
import { firstPassword, notFound } from './masters';

export type AccountRole = { kind: 'admin' | Position; dept?: string | null; ws?: 'ops' | 'ka' };
export type AccountStatus = 'disabled' | 'locked' | 'norole' | 'pending' | 'active';
export type AccountDto = {
  id: number; username: string; name: string; role: Role; active: boolean;
  roles: AccountRole[]; status: AccountStatus;
  /** The first password while the person has not chosen their own. */
  firstPw: string | null;
  lastLogin: string | null;
};

type Row = { id: number; username: string; name: string; role: Role; active: number; must_change_pw: number; first_pw: string | null; last_login: string | null };

export async function listAccounts(db: D1Database): Promise<{ accounts: AccountDto[]; missing: number }> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  const [users, people, fails, wsRows] = await Promise.all([
    all<Row>(db, `SELECT id, username, name, role, active, must_change_pw, first_pw, last_login FROM users ORDER BY name COLLATE NOCASE`),
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
      : r.length === 0 ? 'norole'
      : u.must_change_pw === 1 ? 'pending' : 'active';
    return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active === 1, roles: r, status, firstPw: u.must_change_pw === 1 ? u.first_pw : null, lastLogin: u.last_login };
  });
  const missing = new Set(people.filter((p) => p.nodeId !== null && p.userId === null).map((p) => p.name.trim().toLowerCase())).size
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
       UNION ALL SELECT n.id, n.name, t.depth + 1 FROM nodes n JOIN t ON n.parent_id = t.id)
     SELECT t.id, t.name, t.depth FROM t JOIN nodes n ON n.id = t.id WHERE n.manager_user_id IS NULL ORDER BY t.depth, t.name`);
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
