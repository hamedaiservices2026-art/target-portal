// Authentication primitives: password hashing, session tokens, middleware.
// Routes live in routes/auth.ts.
import { deleteCookie, getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Env } from './index';
import { one, run } from './db';

export type Role = 'admin' | 'manager';
export type Lang = 'en' | 'ar';
export type Workspace = 'ops' | 'ka';
/**
 * `cd`: the workspaces where the user is Commercial Director (user_roles).
 * `mustChangePw`: first login, the password must be changed before anything else.
 */
export type SessionUser = { id: number; role: Role; lang: Lang; name: string; cd: Workspace[]; mustChangePw: boolean };

/** Shared by every route module: `new Hono<AppEnv>()`. */
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Ruling R4 throttle: more than this many failed password checks per username in the window -> 429. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Ruling R4 (docs/decisions.md): 10,000, not the 100,000 Workers allows,
 * because the Free plan gives ~10 ms CPU per request. The count is stored
 * inside every hash, so raising it later does not invalidate old passwords.
 */
export const PBKDF2_ITERATIONS = 10_000;
const ALGO = 'pbkdf2-sha256';
const SALT_BYTES = 16;
const HASH_BITS = 256;
/** workerd refuses more than this; also bounds work for a tampered stored hash. */
const MAX_ITERATIONS = 100_000;

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(s.length));
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time equality for two byte arrays of the same length. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Constant-time string comparison (compares SHA-256 digests, so length does not leak). */
export async function safeEqualStrings(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return timingSafeEqual(new Uint8Array(da), new Uint8Array(db));
}

async function pbkdf2(pw: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** `hash` = `pbkdf2-sha256$<iterations>$<base64 digest>`, `salt` = base64. */
export async function hashPassword(pw: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = await pbkdf2(pw, salt, PBKDF2_ITERATIONS);
  return { hash: `${ALGO}$${PBKDF2_ITERATIONS}$${toBase64(digest)}`, salt: toBase64(salt) };
}

/** Reads the iteration count from the stored hash. Malformed input is just `false`. */
export async function verifyPassword(pw: string, hash: string, salt: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 3 || parts[0] !== ALGO) return false;
  if (!/^[1-9][0-9]*$/.test(parts[1]!)) return false;
  const iterations = Number(parts[1]);
  if (iterations > MAX_ITERATIONS) return false;
  const expected = fromBase64(parts[2]!);
  const saltBytes = fromBase64(salt);
  if (!expected || !saltBytes || expected.length === 0) return false;
  const actual = await pbkdf2(pw, saltBytes, iterations);
  return timingSafeEqual(actual, expected);
}

/** SHA-256 hex; the form in which session tokens are stored. */
export async function sha256Hex(s: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

/** 32 random bytes, base64url (43 chars). */
export function newSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Session lookup: ONE query (sessions joined to users). Expired sessions are
 * rejected and deleted lazily; disabled users are rejected.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return c.json({ error: 'unauthenticated' }, 401);
  const token = await sha256Hex(sid);
  const row = await one<{ id: number; role: Role; lang: Lang; name: string; active: number; expires_at: string; cd: string | null; must_change_pw: number }>(
    c.env.DB,
    `SELECT u.id, u.role, u.lang, u.name, u.active, s.expires_at, u.must_change_pw,
            (SELECT group_concat(r.workspace) FROM user_roles r WHERE r.user_id = u.id AND r.role = 'cd') AS cd
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    token,
  );
  if (!row) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ error: 'unauthenticated' }, 401);
  }
  if (row.expires_at <= new Date().toISOString()) {
    await run(c.env.DB, `DELETE FROM sessions WHERE token = ?`, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ error: 'unauthenticated' }, 401);
  }
  if (!row.active) return c.json({ error: 'unauthenticated' }, 401);
  const cd = (row.cd ?? '').split(',').filter((w): w is Workspace => w === 'ops' || w === 'ka');
  c.set('user', { id: row.id, role: row.role, lang: row.lang, name: row.name, cd, mustChangePw: row.must_change_pw === 1 });
  // First login: only reading the session, changing the password and signing out are allowed.
  if (row.must_change_pw === 1 && !/^\/api\/(me|auth\/logout)(\/|$)/.test(new URL(c.req.url).pathname)) {
    return c.json({ error: 'password_change_required' }, 403);
  }
  await next();
});

/** Use after requireUser. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
});
