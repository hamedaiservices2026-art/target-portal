import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  hashPassword,
  newSessionToken,
  requireUser,
  safeEqualStrings,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sha256Hex,
  verifyPassword,
  type AppEnv,
  type SessionUser,
} from '../auth';
import { batch, one, run } from '../db';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_USERNAME = 100;
const MAX_PASSWORD = 1024;

// Verified against when the user is unknown, so a miss costs the same CPU as a hit.
const DUMMY_HASH = 'pbkdf2-sha256$10000$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA==';

const cookieOpts = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: SESSION_TTL_SECONDS,
} as const;

type UserRow = SessionUser & { pw_hash: string; pw_salt: string; active: number };

const auth = new Hono<AppEnv>();

auth.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const username = body?.username;
  const password = body?.password;
  if (
    typeof username !== 'string' || typeof password !== 'string' ||
    username.length === 0 || username.length > MAX_USERNAME || password.length > MAX_PASSWORD
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const db = c.env.DB;
  const key = username.trim().toLowerCase();
  const now = new Date();
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - WINDOW_MS).toISOString();

  // Throttle first, before any password work.
  const fails = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?`,
    key, windowStart,
  );
  if ((fails?.n ?? 0) >= MAX_FAILURES) return c.json({ error: 'too_many_attempts' }, 429);

  const user = await one<UserRow>(
    db,
    `SELECT id, role, lang, name, pw_hash, pw_salt, active FROM users WHERE username = ?`,
    username,
  );

  let sessionUser: SessionUser | null = null;
  if (user) {
    const ok = await verifyPassword(password, user.pw_hash, user.pw_salt);
    if (ok && user.active) {
      sessionUser = { id: user.id, role: user.role, lang: user.lang, name: user.name };
    }
  } else {
    await verifyPassword(password, DUMMY_HASH, DUMMY_SALT);
    sessionUser = await tryBootstrap(c.env, username, password);
  }

  if (!sessionUser) {
    // Record the failure and prune rows outside the window in one round trip.
    await batch(db, [
      db.prepare(`INSERT INTO login_failures(username, at) VALUES (?, ?)`).bind(key, nowIso),
      db.prepare(`DELETE FROM login_failures WHERE at <= ?`).bind(windowStart),
    ]);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const sid = newSessionToken();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await batch(db, [
    db.prepare(`DELETE FROM login_failures WHERE username = ?`).bind(key),
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(nowIso),
    db.prepare(`INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)`)
      .bind(await sha256Hex(sid), sessionUser.id, expires),
  ]);
  setCookie(c, SESSION_COOKIE, sid, cookieOpts);
  return c.json({ user: sessionUser });
});

/**
 * First-run admin: only when BOOTSTRAP_ADMIN_PASSWORD is set, the login is
 * `admin` with exactly that password, and the users table is empty. The
 * emptiness check is part of the INSERT, so two racing logins create one row.
 */
async function tryBootstrap(
  env: AppEnv['Bindings'],
  username: string,
  password: string,
): Promise<SessionUser | null> {
  const secret = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!secret || username !== 'admin' || !(await safeEqualStrings(password, secret))) return null;
  const { hash, salt } = await hashPassword(password);
  const res = await run(
    env.DB,
    `INSERT INTO users(username, name, pw_hash, pw_salt, role)
     SELECT 'admin', 'Administrator', ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`,
    hash, salt,
  );
  if (res.changes !== 1) return null;
  return { id: res.lastRowId, role: 'admin', lang: 'en', name: 'Administrator' };
}

auth.post('/api/auth/logout', async (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) await run(c.env.DB, `DELETE FROM sessions WHERE token = ?`, await sha256Hex(sid));
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  return c.json({ ok: true });
});

auth.get('/api/me', requireUser, (c) => c.json({ user: c.var.user }));

auth.patch('/api/me', requireUser, async (c) => {
  const body = await c.req.json().catch(() => null);
  const lang = body?.lang;
  if (lang !== 'en' && lang !== 'ar') return c.json({ error: 'invalid_lang' }, 400);
  await run(c.env.DB, `UPDATE users SET lang = ? WHERE id = ?`, lang, c.var.user.id);
  return c.json({ user: { ...c.var.user, lang } });
});

export default auth;
