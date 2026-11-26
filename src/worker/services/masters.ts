// Master data: users, departments, packs, settings. Validation, persistence
// and audit in one place; routes/admin.ts only maps HTTP onto these.
//
// Each write is ONE db.batch() (change + audit row, atomic) after at most one
// read, so a request stays well inside the per-request D1 query budget.
import { hashPassword, type Lang, type Role } from '../auth';
import { all, batch, one } from '../db';
import { auditStatement } from './audit';

/** Thrown for any client error; routes turn it into a JSON response. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 429,
    readonly body: {
      error: 'invalid_request' | 'forbidden' | 'not_found' | 'conflict' | 'stale' | 'too_many_rows' | 'rules_failed' | 'no_routes' | 'salesman_missing' | 'too_many_attempts';
      /** Name of the node a no_routes error is about. */
      node?: string;
      detail?: string;
      errors?: { line: number; detail: string }[];
      /** Leaves a 409 is about (month uploads). */
      leafIds?: number[];
      /** Per-pack rule results when a submit fails the cap rules (distribution). */
      byPack?: Record<string, unknown>;
      /** Import preview problems by sheet row (services/imports.ts). */
      issues?: unknown[];
    },
  ) {
    super(body.error + (body.detail ? `: ${body.detail}` : ''));
  }
}
export const bad = (detail: string) => new ApiError(400, { error: 'invalid_request', detail });
export const notFound = () => new ApiError(404, { error: 'not_found' });
export const forbidden = () => new ApiError(403, { error: 'forbidden' });

export type Obj = Record<string, unknown>;

export function asObject(body: unknown): Obj {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
  return body as Obj;
}

/** Route ids are positive integers; anything else cannot exist. */
export function parseId(raw: string): number {
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) throw notFound();
  return Number(raw);
}

/** Runs the batch; a UNIQUE violation (the whole batch rolls back) becomes 409. */
export async function writeBatch(
  db: D1Database,
  stmts: D1PreparedStatement[],
  conflict: string | ((sqliteMessage: string) => string),
): Promise<D1Result[]> {
  try {
    return await batch(db, stmts);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${(e.cause as Error | undefined)?.message ?? ''}` : '';
    if (/UNIQUE constraint failed/i.test(msg)) throw new ApiError(409, { error: 'conflict', detail: typeof conflict === 'string' ? conflict : conflict(msg) });
    throw e;
  }
}

// ---------- field parsers ----------

const MAX_TEXT = 200;
const MAX_USERNAME = 100; // login rejects longer
const MAX_PASSWORD = 1024; // login rejects longer
const MIN_PASSWORD = 8;

export function text(v: unknown, field: string, max = MAX_TEXT): string {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const s = v.trim();
  if (!s) throw bad(`${field} must not be empty`);
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`);
  return s;
}

/** Ruling R11: usernames are stored trimmed and lower-cased, no whitespace inside. */
export function normalizeUsername(v: unknown): string {
  const s = text(v, 'username', MAX_USERNAME).toLowerCase();
  if (/\s/.test(s)) throw bad('username must not contain whitespace');
  return s;
}

function email(v: unknown): string | null {
  if (v === null || v === '') return null;
  const s = text(v, 'email', 254);
  if (!/^[^\s@]+@[^\s@]+$/.test(s)) throw bad('email is not valid');
  return s;
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw bad(`${field} must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw bad(`${field} must be a boolean`);
  return v;
}

export function int(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 1_000_000_000) {
    throw bad(`${field} must be an integer`);
  }
  return v;
}

function password(v: unknown): string {
  if (typeof v !== 'string' || v.length < MIN_PASSWORD) throw bad(`password must be at least ${MIN_PASSWORD} characters`);
  if (v.length > MAX_PASSWORD) throw bad(`password must be at most ${MAX_PASSWORD} characters`);
  return v;
}

const ROLES = ['admin', 'manager'] as const;
const LANGS = ['en', 'ar'] as const;
export const PACK_GROUPS = ['CSD', 'Water', 'LRB-Others'] as const;
export type PackGroup = (typeof PACK_GROUPS)[number];

/** Copies only the keys that differ, as {from, to}, for the audit detail. */
function diff(before: Obj, after: Obj): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) if (before[k] !== after[k]) out[k] = { from: before[k], to: after[k] };
  return out;
}

// ---------- users ----------

export type UserDto = {
  id: number; username: string; name: string; email: string | null;
  role: Role; lang: Lang; active: boolean;
};
type UserRow = Omit<UserDto, 'active'> & { active: number };
const USER_COLS = 'id, username, name, email, role, lang, active';
const toUser = (r: UserRow): UserDto => ({ ...r, active: r.active === 1 });

export async function listUsers(db: D1Database): Promise<UserDto[]> {
  return (await all<UserRow>(db, `SELECT ${USER_COLS} FROM users WHERE deleted_at IS NULL ORDER BY username`)).map(toUser);
}

export async function createUser(db: D1Database, actorId: number, body: Obj): Promise<UserDto> {
  const v = {
    username: normalizeUsername(body.username),
    name: text(body.name, 'name'),
    email: body.email === undefined ? null : email(body.email),
    role: oneOf(body.role, 'role', ROLES),
    lang: body.lang === undefined ? ('en' as Lang) : oneOf(body.lang, 'lang', LANGS),
    active: body.active === undefined ? true : bool(body.active, 'active'),
    position: body.position === undefined || body.position === null || body.position === '' ? null : text(body.position, 'position').slice(0, 60),
  };
  const pw = password(body.password);
  const { hash, salt } = await hashPassword(pw); // the only PBKDF2 of this request
  const [ins] = await writeBatch(db, [
    db.prepare(
      `INSERT INTO users(username, name, email, pw_hash, pw_salt, role, lang, active, must_change_pw, first_pw, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING ${USER_COLS}`,
    ).bind(v.username, v.name, v.email, hash, salt, v.role, v.lang, v.active ? 1 : 0, pw, v.position),
    auditStatement(db, actorId, 'user.create', {}, v, { lastInsertIdAs: 'id' }),
  ], 'username already exists');
  return toUser(ins!.results[0] as UserRow);
}

export async function updateUser(db: D1Database, actorId: number, id: number, body: Obj): Promise<UserDto> {
  const patch: Partial<Omit<UserDto, 'id'>> = {};
  if (body.username !== undefined) patch.username = normalizeUsername(body.username);
  if (body.name !== undefined) patch.name = text(body.name, 'name');
  if (body.email !== undefined) patch.email = email(body.email);
  if (body.role !== undefined) patch.role = oneOf(body.role, 'role', ROLES);
  if (body.lang !== undefined) patch.lang = oneOf(body.lang, 'lang', LANGS);
  if (body.active !== undefined) patch.active = bool(body.active, 'active');
  if (Object.keys(patch).length === 0) throw bad('no updatable fields given');
  if (id === actorId && (patch.active === false || (patch.role !== undefined && patch.role !== 'admin'))) {
    throw bad('you cannot disable or demote yourself');
  }

  const row = await one<UserRow>(db, `SELECT ${USER_COLS} FROM users WHERE id = ?`, id);
  if (!row) throw notFound();
  const before = toUser(row);
  const changes = diff(before, patch);
  if (Object.keys(changes).length === 0) return before;

  const after: UserDto = { ...before, ...patch };
  const stmts = [
    db.prepare(
      `UPDATE users SET username = ?, name = ?, email = ?, role = ?, lang = ?, active = ? WHERE id = ?`,
    ).bind(after.username, after.name, after.email, after.role, after.lang, after.active ? 1 : 0, id),
  ];
  // A disabled user is already refused by requireUser; deleting the rows too
  // keeps the table clean and makes re-enabling start from a fresh login.
  if (patch.active === false) stmts.push(db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id));
  stmts.push(auditStatement(db, actorId, 'user.update', {}, { id, changes }));
  await writeBatch(db, stmts, 'username already exists');
  return after;
}

/** A first password like the v16 prototype: 4 letters and 4 digits, easy to read out. */
export function firstPassword(): string {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789';
  const a = new Uint32Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (x, i) => (i < 4 ? L[x % L.length] : D[x % D.length])).join('');
}

/**
 * The admin sets a password (body.password) or, without one, a new first
 * password is made. Someone else's password must be changed at the next
 * sign-in and is shown to the admin (first_pw) until then.
 */
export async function setUserPassword(db: D1Database, actorId: number, id: number, body: Obj): Promise<{ password?: string }> {
  const made = body.password === undefined || body.password === null || body.password === '';
  const pw = made ? firstPassword() : password(body.password);
  const row = await one<{ username: string }>(db, `SELECT username FROM users WHERE id = ?`, id);
  if (!row) throw notFound();
  const { hash, salt } = await hashPassword(pw); // the only PBKDF2 of this request
  const stmts = [
    // A reset by the admin of someone else's password must be changed at the next login.
    db.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ?, must_change_pw = ?, first_pw = ? WHERE id = ?`)
      .bind(hash, salt, id === actorId ? 0 : 1, id === actorId ? null : pw, id),
  ];
  // Resetting someone else's password signs them out everywhere; the admin
  // changing their own keeps the current session.
  if (id !== actorId) stmts.push(db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id));
  // A new password also unlocks the account.
  stmts.push(db.prepare(`DELETE FROM login_failures WHERE username = ?`).bind(row.username));
  stmts.push(auditStatement(db, actorId, 'user.password', {}, { id, username: row.username }));
  await writeBatch(db, stmts, 'conflict');
  // Only a password made here is sent back (the admin typed any other one).
  return made ? { password: pw } : {};
}

// ---------- departments ----------

export type DepartmentDto = { id: number; code: string; name: string; workspace?: 'ops' | 'ka'; sort?: number };

function deptCode(v: unknown): string {
  return text(v, 'code', 50).toUpperCase();
}

export async function listDepartments(db: D1Database): Promise<DepartmentDto[]> {
  return all<DepartmentDto>(db, `SELECT id, code, name, workspace, sort FROM departments ORDER BY workspace DESC, sort, code`);
}

export async function createDepartment(db: D1Database, actorId: number, body: Obj): Promise<DepartmentDto> {
  const v = { code: deptCode(body.code), name: text(body.name, 'name') };
  const [ins] = await writeBatch(db, [
    db.prepare(`INSERT INTO departments(code, name) VALUES (?, ?) RETURNING id, code, name`).bind(v.code, v.name),
    auditStatement(db, actorId, 'dept.create', {}, v, { lastInsertIdAs: 'id' }),
  ], 'department code already exists');
  return ins!.results[0] as DepartmentDto;
}

export async function updateDepartment(db: D1Database, actorId: number, id: number, body: Obj): Promise<DepartmentDto> {
  const patch: Partial<Omit<DepartmentDto, 'id'>> = {};
  if (body.code !== undefined) patch.code = deptCode(body.code);
  if (body.name !== undefined) patch.name = text(body.name, 'name');
  if (Object.keys(patch).length === 0) throw bad('no updatable fields given');

  const before = await one<DepartmentDto>(db, `SELECT id, code, name FROM departments WHERE id = ?`, id);
  if (!before) throw notFound();
  const changes = diff(before, patch);
  if (Object.keys(changes).length === 0) return before;
  const after = { ...before, ...patch };
  await writeBatch(db, [
    db.prepare(`UPDATE departments SET code = ?, name = ? WHERE id = ?`).bind(after.code, after.name, id),
    auditStatement(db, actorId, 'dept.update', {}, { id, changes }),
  ], 'department code already exists');
  return after;
}

// ---------- packs ----------

export type PackDto = { code: string; grp: PackGroup; active: boolean; sort: number };
type PackRow = Omit<PackDto, 'active'> & { active: number };
const toPack = (r: PackRow): PackDto => ({ ...r, active: r.active === 1 });

export async function listPacks(db: D1Database): Promise<PackDto[]> {
  return (await all<PackRow>(db, `SELECT code, grp, active, sort FROM packs ORDER BY sort, code`)).map(toPack);
}

export async function createPack(db: D1Database, actorId: number, body: Obj): Promise<PackDto> {
  const v: PackDto = {
    code: text(body.code, 'code', 50),
    grp: oneOf(body.grp, 'grp', PACK_GROUPS),
    active: body.active === undefined ? true : bool(body.active, 'active'),
    sort: body.sort === undefined ? 0 : int(body.sort, 'sort'),
  };
  await writeBatch(db, [
    db.prepare(`INSERT INTO packs(code, grp, active, sort) VALUES (?, ?, ?, ?)`)
      .bind(v.code, v.grp, v.active ? 1 : 0, v.sort),
    auditStatement(db, actorId, 'pack.create', {}, v),
  ], 'pack code already exists');
  return v;
}

export async function updatePack(db: D1Database, actorId: number, code: string, body: Obj): Promise<PackDto> {
  if (body.code !== undefined && body.code !== code) throw bad('code cannot be changed');
  const patch: Partial<Omit<PackDto, 'code'>> = {};
  if (body.grp !== undefined) patch.grp = oneOf(body.grp, 'grp', PACK_GROUPS);
  if (body.active !== undefined) patch.active = bool(body.active, 'active');
  if (body.sort !== undefined) patch.sort = int(body.sort, 'sort');
  if (Object.keys(patch).length === 0) throw bad('no updatable fields given');

  const row = await one<PackRow>(db, `SELECT code, grp, active, sort FROM packs WHERE code = ?`, code);
  if (!row) throw notFound();
  const before = toPack(row);
  const changes = diff(before, patch);
  if (Object.keys(changes).length === 0) return before;
  const after = { ...before, ...patch };
  await writeBatch(db, [
    db.prepare(`UPDATE packs SET grp = ?, active = ?, sort = ? WHERE code = ?`)
      .bind(after.grp, after.active ? 1 : 0, after.sort, code),
    auditStatement(db, actorId, 'pack.update', {}, { code, changes }),
  ], 'conflict');
  return after;
}

// ---------- settings ----------

const DEFAULT_CAP_PCT = 5;

/** Also used by later tasks (cap computation). Falls back to the default if the row is missing or garbled. */
/** The stored settings value as a cap %; anything unusable falls back to the default. */
export function capPctFrom(raw: string | null | undefined): number {
  const n = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_CAP_PCT;
}

export async function getCapPct(db: D1Database): Promise<number> {
  const row = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'cap_pct'`);
  return capPctFrom(row?.value);
}

export async function setCapPct(db: D1Database, actorId: number, body: Obj): Promise<number> {
  const v = body.capPct;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) {
    throw bad('capPct must be a number greater than 0 and at most 100');
  }
  const before = await getCapPct(db);
  if (before === v) return v;
  await writeBatch(db, [
    db.prepare(
      `INSERT INTO settings(key, value) VALUES ('cap_pct', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(v)),
    // The single cap sets every level's cap of the distribution rules.
    db.prepare(
      `UPDATE settings SET value = json_set(value, '$.caps.head', ?, '$.caps.manager', ?, '$.caps.supervisor', ?) WHERE key = 'rules_json'`,
    ).bind(v, v, v),
    auditStatement(db, actorId, 'settings.update', {}, { changes: { capPct: { from: before, to: v } } }),
  ], 'conflict');
  return v;
}

// ---------- packs the admin added (AOP option): rename or delete ----------

const ADDED_PACKS_SQL = `SELECT code FROM packs WHERE code IN (
  SELECT json_extract(detail_json, '$.code') FROM audit WHERE action = 'pack.create'
  UNION SELECT json_extract(detail_json, '$.to') FROM audit WHERE action = 'pack.rename') ORDER BY code`;

/** Packs added by the admin in the app (not the original pack master). */
export async function listAddedPacks(db: D1Database): Promise<string[]> {
  return (await all<{ code: string }>(db, ADDED_PACKS_SQL)).map((r) => r.code);
}

async function requireAdded(db: D1Database, code: string): Promise<void> {
  if (!(await listAddedPacks(db)).includes(code)) throw bad(`${code} is not a pack you added, so it cannot be renamed or deleted here`);
}

export async function renamePack(db: D1Database, actorId: number, code: string, body: Obj): Promise<PackDto> {
  await requireAdded(db, code);
  const to = text(body.code, 'code', 50);
  if (to === code) throw bad('the new name is the same');
  if (await one(db, `SELECT 1 AS x FROM packs WHERE lower(code) = lower(?) AND code <> ?`, to, code)) throw new ApiError(409, { error: 'conflict', detail: `${to} already exists` });
  await writeBatch(db, [
    db.prepare(`UPDATE packs SET code = ? WHERE code = ?`).bind(to, code),
    auditStatement(db, actorId, 'pack.rename', {}, { from: code, to }),
  ], 'pack code already exists');
  const row = await one<PackRow>(db, `SELECT code, grp, active, sort FROM packs WHERE code = ?`, to);
  return toPack(row!);
}

export async function deletePack(db: D1Database, actorId: number, code: string): Promise<void> {
  await requireAdded(db, code);
  await writeBatch(db, [
    db.prepare(`DELETE FROM packs WHERE code = ?`).bind(code),
    auditStatement(db, actorId, 'pack.delete', {}, { code }),
  ], 'conflict');
}
