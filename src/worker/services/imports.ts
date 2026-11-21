// Bulk import from Excel (Task E): users, packs, hierarchy. The browser reads
// the .xlsx and sends text rows; the plan (create / update / unchanged and every
// problem) is computed by src/shared/imports.ts from the rows and the database,
// on preview and AGAIN on apply. Preview writes nothing.
//
// Mode is add and update only: nothing is deleted or disabled; records not in
// the file are left alone. Re-applying the same file is "0 changes" and writes
// nothing (not even an audit row).
//
// D1 budget per request (Free: 50 queries per invocation, ruling R10; each
// statement of a batch counted): session 1 + reads 1-4 + ONE atomic write batch
// of set-based statements (json_each, at most IMPORT_CHUNK rows each) + audit.
// Worst cases (measured with a query-counting test, test/worker/imports.test.ts):
// packs 1+1+10+1 = 13; users 1+2+(5 chunks+2+1+1) = 13; password step 1+4+2 = 7;
// hierarchy 1+4+(11 insert chunks+1 update+1 audit) + open-month propagation
// 2 (managers, set-based) + 6 per moved node (at most HIERARCHY_MAX_OPEN_MOVES = 4)
// = 44.
//
// Users: PBKDF2 (~5.3 ms CPU measured for 10,000 iterations) allows ONE hash or
// check per request on the Free plan's ~10 ms. The browser calls the password
// step once per user that needs one; each result is staged in import_passwords
// (hashes only), and apply copies the staged hashes in its single batch.
import {
  coerceImportRows, hasErrors, IMPORT_MAX_ROWS, PASSWORD_MAX, PASSWORD_MIN, planHierarchy, planPacks, planUsers,
  type ImportIssue, type ImportKind, type ImportRowOf, type StagedPassword,
} from '../../shared/imports';
import { hashPassword, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, verifyPassword } from '../auth';
import { batch, insertJsonStatement, MAX_INSERT_ROWS } from '../db';
import { auditStatement } from './audit';
import { type TreeChange, type TreeChangeResult } from './flow';
import { notify } from './hierarchy';
import { ApiError, bad, normalizeUsername, type Obj, type PackGroup } from './masters';

/** Rows per set-based statement (one bound JSON parameter; far below D1's 2 MB value limit). */
const IMPORT_CHUNK = 500;
/** Staged password rows older than this are pruned. */
const STAGE_TTL_MS = 60 * 60 * 1000;

const chunks = <T>(list: T[], size = IMPORT_CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

function rowsOf<K extends ImportKind>(kind: K, body: Obj): ImportRowOf<K>[] {
  if (Array.isArray(body.rows) && body.rows.length > IMPORT_MAX_ROWS) {
    throw new ApiError(413, { error: 'too_many_rows', detail: `at most ${IMPORT_MAX_ROWS} rows per import` });
  }
  const c = coerceImportRows(kind, body.rows);
  if (!c.ok) throw bad(c.detail);
  return c.rows;
}

function refuseErrors(issues: ImportIssue[]): void {
  if (!hasErrors(issues)) return;
  const n = new Set(issues.filter((i) => i.level === 'error').map((i) => i.line)).size;
  throw new ApiError(400, { error: 'invalid_request', detail: `${n} row(s) have errors; nothing was saved`, issues });
}

/** The single write batch. A concurrent change (unique name, vanished parent or staged hash) rolls it all back as 409. */
async function writeAll(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await batch(db, stmts);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${(e.cause as Error | undefined)?.message ?? ''}` : '';
    if (/UNIQUE constraint|FOREIGN KEY constraint|NOT NULL constraint/i.test(msg)) {
      throw new ApiError(409, { error: 'conflict', detail: 'import_changed' });
    }
    throw e;
  }
}

export type ApplyResult = { created: number; updated: number; unchanged: number; issues: ImportIssue[] };

// ---------------------------------------------------------------- packs

async function packsPlan(db: D1Database, body: Obj) {
  const rows = rowsOf('packs', body);
  const [res] = await batch(db, [db.prepare(`SELECT code, grp, active, sort FROM packs`)]);
  const packs = (res!.results as { code: string; grp: PackGroup; active: number; sort: number }[])
    .map((p) => ({ ...p, active: p.active === 1 }));
  return { rows, plan: planPacks(rows, { packs }) };
}

export async function previewPacks(db: D1Database, body: Obj) {
  return (await packsPlan(db, body)).plan;
}

export async function applyPacks(db: D1Database, actorId: number, body: Obj): Promise<ApplyResult> {
  const { rows, plan } = await packsPlan(db, body);
  refuseErrors(plan.issues);
  const result = { created: plan.create, updated: plan.update, unchanged: plan.unchanged, issues: plan.issues };
  const todo = plan.actions.filter((a) => a.kind !== 'unchanged');
  if (todo.length === 0) return result;
  const stmts = chunks(todo, MAX_INSERT_ROWS).map((part) => insertJsonStatement(db, 'packs', ['code', 'grp', 'active', 'sort'],
    part.map((a) => ({ code: a.code, grp: a.grp, active: a.active ? 1 : 0, sort: a.sort })),
    { onConflict: 'ON CONFLICT(code) DO UPDATE SET grp = excluded.grp, active = excluded.active, sort = excluded.sort' }));
  stmts.push(auditStatement(db, actorId, 'import.packs', {}, {
    rows: rows.length, created: plan.create, updated: plan.update, unchanged: plan.unchanged,
    codes: { created: todo.filter((a) => a.kind === 'create').map((a) => a.code), updated: todo.filter((a) => a.kind === 'update').map((a) => a.code) },
  }));
  await writeAll(db, stmts);
  return result;
}

// ---------------------------------------------------------------- users

function importId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw bad('importId must be 8-64 letters, digits, - or _');
  return v;
}

/** Staged rows older than this instant are ignored everywhere (even before they are pruned). */
const stageCutoff = (now = Date.now()): string => new Date(now - STAGE_TTL_MS).toISOString();

async function usersPlan(db: D1Database, actorId: number, body: Obj) {
  const id = importId(body.importId);
  const rows = rowsOf('users', body);
  const cutoff = stageCutoff();
  const [u, s] = await batch(db, [
    db.prepare(`SELECT id, username, name, email, role, lang, active FROM users`),
    db.prepare(
      `SELECT username, pw_hash IS NOT NULL AS has_hash FROM import_passwords
       WHERE import_id = ? AND actor_id = ? AND created_at >= ?`,
    ).bind(id, actorId, cutoff),
  ]);
  const users = (u!.results as { id: number; username: string; name: string; email: string | null; role: 'admin' | 'manager'; lang: 'en' | 'ar'; active: number }[])
    .map((r) => ({ ...r, active: r.active === 1 }));
  const staged = new Map((s!.results as { username: string; has_hash: number }[])
    .map((r) => [r.username, (r.has_hash ? 'hash' : 'same') as StagedPassword]));
  return { id, rows, cutoff, plan: planUsers(rows, { users, actorId, staged }) };
}

export async function previewUsers(db: D1Database, actorId: number, body: Obj) {
  return (await usersPlan(db, actorId, body)).plan;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 12 characters from a 55-letter alphabet without look-alikes (~69 bits), unbiased (rejection sampling). */
export function generatePassword(length = 12): string {
  let out = '';
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/**
 * One password per request: 'verify' checks the file's password against the
 * current one (same -> staged as "no change"); 'hash' hashes it, or generates
 * one for a new user whose cell is blank. The generated password is returned
 * here, once, and never stored or logged.
 *
 * 'verify' answers whether a password is right, so it goes through the login
 * throttle (ruling R4): the attempt is recorded in login_failures before the
 * check (insert-first, atomic, like the login), removed again when the answer
 * is "same", and more than LOGIN_MAX_FAILURES in the window is 429. A normal
 * re-import checks each user once, so it never comes near the limit.
 *
 * A staged slot (import id + username) belongs to the admin who staged it:
 * another admin's write to the same slot is refused (409 import_slot_taken).
 */
export async function stagePassword(
  db: D1Database, actorId: number, body: Obj,
): Promise<{ same: boolean } | { ok: true; generated?: string }> {
  const id = importId(body.importId);
  const username = normalizeUsername(body.username);
  if (body.op !== 'verify' && body.op !== 'hash') throw bad('op must be verify or hash');
  const raw = typeof body.password === 'string' ? body.password : '';
  const given = raw.trim() ? raw : '';
  if (given && given.length < PASSWORD_MIN) throw bad(`password must be at least ${PASSWORD_MIN} characters`);
  if (given.length > PASSWORD_MAX) throw bad(`password must be at most ${PASSWORD_MAX} characters`);

  const now = new Date();
  const nowIso = now.toISOString();
  const [, cur] = await batch(db, [
    db.prepare(`DELETE FROM import_passwords WHERE created_at < ?`).bind(stageCutoff(now.getTime())),
    db.prepare(`SELECT pw_hash, pw_salt FROM users WHERE username = ?`).bind(username),
  ]);
  const user = cur!.results[0] as { pw_hash: string; pw_salt: string } | undefined;
  const stage = async (hash: string | null, salt: string | null) => {
    const res = await db.prepare(
      `INSERT INTO import_passwords(import_id, username, actor_id, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(import_id, username) DO UPDATE SET pw_hash = excluded.pw_hash, pw_salt = excluded.pw_salt,
         created_at = excluded.created_at
       WHERE import_passwords.actor_id = excluded.actor_id`,
    ).bind(id, username, actorId, hash, salt, nowIso).run();
    if ((res.meta.changes ?? 0) !== 1) throw new ApiError(409, { error: 'conflict', detail: 'import_slot_taken' });
  };

  if (body.op === 'verify') {
    if (!user) throw bad('username does not exist; new users need op hash');
    if (!given) throw bad('a blank password keeps the current one; nothing to check');
    const [attempt, counted] = await batch(db, [
      db.prepare(`INSERT INTO login_failures(username, at) VALUES (?, ?) RETURNING rowid AS id`).bind(username, nowIso),
      db.prepare(`SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?`)
        .bind(username, new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString()),
    ]);
    if (((counted!.results[0] as { n: number }).n) > LOGIN_MAX_FAILURES) {
      throw new ApiError(429, { error: 'too_many_attempts' });
    }
    const same = await verifyPassword(given, user.pw_hash, user.pw_salt); // the only PBKDF2 of this request
    if (same) {
      await batch(db, [db.prepare(`DELETE FROM login_failures WHERE rowid = ?`).bind((attempt!.results[0] as { id: number }).id)]);
      await stage(null, null);
    }
    return { same };
  }
  if (user && !given) throw bad('a blank password keeps the current one; nothing to hash');
  const password = given || generatePassword();
  const { hash, salt } = await hashPassword(password); // the only PBKDF2 of this request
  await stage(hash, salt);
  return given ? { ok: true } : { ok: true, generated: password };
}

export async function applyUsers(
  db: D1Database, actorId: number, body: Obj,
): Promise<ApplyResult & { passwordsSet: string[] }> {
  const { id, rows, cutoff, plan } = await usersPlan(db, actorId, body);
  refuseErrors(plan.issues);
  if (plan.pending.length) {
    throw new ApiError(409, { error: 'conflict', detail: 'passwords_pending' });
  }
  const creates = plan.actions.filter((a) => a.kind === 'create');
  const updates = plan.actions.filter((a) => a.kind === 'update');
  const resetRows = updates.filter((a) => a.setPassword);
  const resets = resetRows.map((a) => a.id!);
  // Exactly the users whose password this apply sets (the browser shows generated passwords only for them).
  const passwordsSet = [...creates, ...resetRows].sort((a, b) => a.line - b.line).map((a) => a.username);
  const result = { created: plan.create, updated: plan.update, unchanged: plan.unchanged, issues: plan.issues, passwordsSet };
  const stmts: D1PreparedStatement[] = [];
  // A missing staged hash leaves pw_hash NULL: the NOT NULL constraint fails the whole batch (409).
  for (const part of chunks(creates)) {
    stmts.push(db.prepare(
      `INSERT INTO users(username, name, email, pw_hash, pw_salt, role, lang, active)
       SELECT j.u, j.n, j.e, s.pw_hash, s.pw_salt, j.r, j.l, 1
       FROM (SELECT json_extract(value, '$.u') AS u, json_extract(value, '$.n') AS n, json_extract(value, '$.e') AS e,
                    json_extract(value, '$.r') AS r, json_extract(value, '$.l') AS l FROM json_each(?)) j
       LEFT JOIN import_passwords s ON s.import_id = ? AND s.actor_id = ? AND s.username = j.u AND s.created_at >= ?
       WHERE true`,
    ).bind(JSON.stringify(part.map((a) => ({ u: a.username, n: a.name, e: a.email, r: a.role, l: a.lang }))), id, actorId, cutoff));
  }
  for (const part of chunks(updates)) {
    stmts.push(db.prepare(
      `WITH j AS MATERIALIZED (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.n') AS n, json_extract(value, '$.e') AS e,
                                      json_extract(value, '$.r') AS r, json_extract(value, '$.l') AS l FROM json_each(?))
       UPDATE users SET name = j.n, email = j.e, role = j.r, lang = j.l FROM j WHERE users.id = j.id`,
    ).bind(JSON.stringify(part.map((a) => ({ id: a.id, n: a.name, e: a.email, r: a.role, l: a.lang })))));
  }
  if (resets.length) {
    const ids = JSON.stringify(resets);
    stmts.push(db.prepare(
      `UPDATE users SET pw_hash = s.pw_hash, pw_salt = s.pw_salt FROM import_passwords s
       WHERE s.import_id = ? AND s.actor_id = ? AND s.created_at >= ? AND s.pw_hash IS NOT NULL AND s.username = users.username
         AND users.id IN (SELECT value FROM json_each(?))`,
    ).bind(id, actorId, cutoff, ids));
    // Like a single reset: the user is signed out everywhere; the admin's own sessions stay.
    stmts.push(db.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT value FROM json_each(?)) AND user_id <> ?`).bind(ids, actorId));
  }
  stmts.push(db.prepare(`DELETE FROM import_passwords WHERE import_id = ? AND actor_id = ?`).bind(id, actorId));
  if (creates.length === 0 && updates.length === 0) {
    await writeAll(db, stmts); // only clears what was staged for this import
    return result;
  }
  stmts.push(auditStatement(db, actorId, 'import.users', {}, {
    rows: rows.length, created: plan.create, updated: plan.update, unchanged: plan.unchanged,
    passwordsSet: creates.length + resets.length,
    usernames: { created: creates.map((a) => a.username), updated: updates.map((a) => a.username) },
  }));
  await writeAll(db, stmts);
  return result;
}

// ---------------------------------------------------------------- hierarchy

async function hierarchyPlan(db: D1Database, body: Obj) {
  const rows = rowsOf('hierarchy', body);
  const [d, n, u, o] = await batch(db, [
    db.prepare(`SELECT id, code, name FROM departments`),
    db.prepare(`SELECT id, dept_id, parent_id, name, manager_user_id FROM nodes`),
    db.prepare(`SELECT id, username, active FROM users`),
    db.prepare(
      `SELECT DISTINCT mn.node_id FROM month_depts md CROSS JOIN month_nodes mn
       WHERE md.state IN ('running', 'loading') AND mn.month_id = md.month_id AND mn.dept_id = md.dept_id`,
    ),
  ]);
  const plan = planHierarchy(rows, {
    departments: d!.results as { id: number; code: string; name: string }[],
    nodes: n!.results as { id: number; dept_id: number; parent_id: number | null; name: string; manager_user_id: number | null }[],
    users: (u!.results as { id: number; username: string; active: number }[]).map((r) => ({ ...r, active: r.active === 1 })),
    openMonthNodeIds: new Set((o!.results as { node_id: number }[]).map((r) => r.node_id)),
  });
  return { rows, plan, nodes: n!.results as { id: number; parent_id: number | null }[] };
}

export async function previewHierarchy(db: D1Database, body: Obj) {
  return (await hierarchyPlan(db, body)).plan;
}

/**
 * New nodes are inserted level by level (a parent always has a lower level, so
 * the name lookup of each statement finds it); then existing nodes are updated.
 * Parents are found by (department, name); a parent that vanished meanwhile
 * gives parent id -1, a foreign-key failure that rolls the batch back.
 * Afterwards the open months are told, exactly like the tree editor
 * (hierarchy.notify): manager changes in one set-based change, each move of a
 * node that is in an open month on its own (the safe rule decides per month).
 */
export async function applyHierarchy(
  db: D1Database, actorId: number, body: Obj,
): Promise<ApplyResult & { treeChange: TreeChangeResult | null }> {
  const { rows, plan, nodes } = await hierarchyPlan(db, body);
  refuseErrors(plan.issues);
  const result = { created: plan.create, updated: plan.update, unchanged: plan.unchanged, issues: plan.issues, treeChange: null };
  const creates = plan.actions.filter((a) => a.kind === 'create');
  const updates = plan.actions.filter((a) => a.kind === 'update');
  if (creates.length === 0 && updates.length === 0) return result;

  const parentSql = (dept: string) => `COALESCE((SELECT x.id FROM nodes x WHERE x.dept_id = ${dept} AND x.name = j.p), -1)`;
  const stmts: D1PreparedStatement[] = [];
  for (let level = 0; level < plan.levels; level++) {
    for (const part of chunks(creates.filter((a) => a.level === level))) {
      stmts.push(db.prepare(
        `INSERT INTO nodes(dept_id, parent_id, name, manager_user_id)
         SELECT j.d, CASE WHEN j.p IS NULL THEN NULL ELSE ${parentSql('j.d')} END, j.n, j.m
         FROM (SELECT json_extract(value, '$.d') AS d, json_extract(value, '$.p') AS p, json_extract(value, '$.n') AS n,
                      json_extract(value, '$.m') AS m FROM json_each(?)) j
         WHERE true`,
      ).bind(JSON.stringify(part.map((a) => ({ d: a.deptId, p: a.parent, n: a.name, m: a.managerId })))));
    }
  }
  const updateAt = stmts.length;
  for (const part of chunks(updates)) {
    stmts.push(db.prepare(
      `WITH j AS MATERIALIZED (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.p') AS p,
                                      json_extract(value, '$.mv') AS mv, json_extract(value, '$.m') AS m FROM json_each(?))
       UPDATE nodes SET parent_id = CASE WHEN j.mv = 1 THEN ${parentSql('nodes.dept_id')} ELSE nodes.parent_id END,
                        manager_user_id = j.m
       FROM j WHERE nodes.id = j.id
       RETURNING nodes.id AS id, nodes.parent_id AS parent_id`,
    ).bind(JSON.stringify(part.map((a) => ({ id: a.id, p: a.parent, mv: a.moved ? 1 : 0, m: a.managerId })))));
  }
  const depts = [...new Set([...creates, ...updates].map((a) => a.deptId))].sort((a, b) => a - b);
  stmts.push(auditStatement(db, actorId, 'import.hierarchy', {}, {
    rows: rows.length, created: plan.create, updated: plan.update, unchanged: plan.unchanged, depts,
  }));
  const res = await writeAll(db, stmts);

  // Open months, as the tree editor does it (spec section 5): managers at once, moves by the safe rule.
  const newParent = new Map<number, number | null>();
  for (const r of res.slice(updateAt, stmts.length - 1)) {
    for (const row of r.results as { id: number; parent_id: number | null }[]) newParent.set(row.id, row.parent_id);
  }
  const before = new Map(nodes.map((x) => [x.id, x.parent_id]));
  const events: TreeChange[] = [];
  const managers = updates.filter((a) => a.managerChanged).map((a) => ({ nodeId: a.id!, userId: a.managerId }));
  if (managers.length) events.push({ kind: 'managers', changes: managers });
  for (const a of updates) {
    if (!a.moved || !a.openMonth) continue; // a node in no open month: nothing to carry
    const from = before.get(a.id!);
    const to = newParent.get(a.id!);
    if (from === null || from === undefined || to === null || to === undefined) continue;
    events.push({ kind: 'move_node', id: a.id!, fromParent: from, toParent: to });
  }
  return { ...result, treeChange: await notify(db, actorId, events) };
}
