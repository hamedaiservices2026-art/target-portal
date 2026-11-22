import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  hashPassword,
  newSessionToken,
  PBKDF2_ITERATIONS,
  requireUser,
  safeEqualStrings,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sha256Hex,
  verifyPassword,
  LOGIN_MAX_FAILURES as MAX_FAILURES,
  LOGIN_WINDOW_MS as WINDOW_MS,
  type AppEnv,
  type SessionUser,
  type Workspace,
} from '../auth';
import { batch, one, run } from '../db';
import { auditStatement } from '../services/audit';

const MAX_USERNAME = 100;
const MAX_PASSWORD = 1024;

// Verified against when the user is unknown, so a miss costs the same CPU as a hit.
const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA==';

const cookieOpts = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: SESSION_TTL_SECONDS,
} as const;

type UserRow = Omit<SessionUser, 'cd' | 'mustChangePw'> & { pw_hash: string; pw_salt: string; active: number; cd: string | null; must_change_pw: number };

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

  // Throttle first, before any password work. The attempt is recorded BEFORE
  // it is checked, in one batch (one D1 transaction), so parallel requests
  // see each other's rows and cannot all slip under the limit. The count
  // includes this attempt: attempts 1..5 are checked, the 6th is blocked.
  // Success deletes the username's rows below. Out-of-window rows are pruned.
  const [, , counted] = await batch(db, [
    db.prepare(`INSERT INTO login_failures(username, at) VALUES (?, ?)`).bind(key, nowIso),
    db.prepare(`DELETE FROM login_failures WHERE at <= ?`).bind(windowStart),
    db.prepare(`SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?`)
      .bind(key, windowStart),
  ]);
  const attempts = (counted?.results[0] as { n: number } | undefined)?.n ?? 0;
  if (attempts > MAX_FAILURES) return c.json({ error: 'too_many_attempts' }, 429);

  const user = await one<UserRow>(
    db,
    `SELECT id, role, lang, name, pw_hash, pw_salt, active, must_change_pw,
            (SELECT group_concat(r.workspace) FROM user_roles r WHERE r.user_id = users.id AND r.role = 'cd') AS cd
       FROM users WHERE username = ?`,
    key, // Ruling R11: usernames are stored trimmed and lower-cased
  );

  let sessionUser: SessionUser | null = null;
  if (user) {
    const ok = await verifyPassword(password, user.pw_hash, user.pw_salt);
    if (ok && user.active) {
      const cd = (user.cd ?? '').split(',').filter((w): w is Workspace => w === 'ops' || w === 'ka');
      sessionUser = { id: user.id, role: user.role, lang: user.lang, name: user.name, cd, mustChangePw: user.must_change_pw === 1 };
    }
  } else if (await isBootstrapLogin(c.env, username, password)) {
    // createBootstrapAdmin runs one PBKDF2 (hashPassword), the same cost as a
    // verify; a dummy verify on top would double the CPU of this request.
    sessionUser = await createBootstrapAdmin(c.env.DB, password);
  } else {
    await verifyPassword(password, DUMMY_HASH, DUMMY_SALT);
  }

  // The failed attempt is already recorded (see the throttle above).
  if (!sessionUser) return c.json({ error: 'invalid_credentials' }, 401);

  const sid = newSessionToken();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await batch(db, [
    db.prepare(`DELETE FROM login_failures WHERE username = ?`).bind(key),
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(nowIso),
    db.prepare(`UPDATE users SET last_login = ? WHERE id = ?`).bind(nowIso, sessionUser.id),
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
async function isBootstrapLogin(
  env: AppEnv['Bindings'],
  username: string,
  password: string,
): Promise<boolean> {
  const secret = env.BOOTSTRAP_ADMIN_PASSWORD;
  return !!secret && username === 'admin' && (await safeEqualStrings(password, secret));
}

async function createBootstrapAdmin(db: D1Database, password: string): Promise<SessionUser | null> {
  const { hash, salt } = await hashPassword(password);
  const res = await run(
    db,
    `INSERT INTO users(username, name, pw_hash, pw_salt, role)
     SELECT 'admin', 'Administrator', ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`,
    hash, salt,
  );
  if (res.changes !== 1) return null;
  return { id: res.lastRowId, role: 'admin', lang: 'en', name: 'Administrator', cd: [], mustChangePw: false };
}

auth.post('/api/auth/logout', async (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) await run(c.env.DB, `DELETE FROM sessions WHERE token = ?`, await sha256Hex(sid));
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  return c.json({ ok: true });
});

auth.get('/api/me', requireUser, (c) => c.json({ user: c.var.user }));

/**
 * First login: set a new password (handover section 2). Only while the
 * account must change it: the session was just opened with the old one, so it
 * is not asked again (one PBKDF2 per request, docs/decisions.md).
 */
auth.post('/api/me/password', requireUser, async (c) => {
  if (!c.var.user.mustChangePw) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => null);
  const pw = body?.password;
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > MAX_PASSWORD) return c.json({ error: 'invalid_request', detail: 'password must be 8 to 1024 characters' }, 400);
  const { hash, salt } = await hashPassword(pw);
  await batch(c.env.DB, [
    c.env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ?, must_change_pw = 0, first_pw = NULL WHERE id = ?`).bind(hash, salt, c.var.user.id),
    auditStatement(c.env.DB, c.var.user.id, 'user.password_first_change', {}, { id: c.var.user.id }),
  ]);
  return c.json({ user: { ...c.var.user, mustChangePw: false } });
});

auth.patch('/api/me', requireUser, async (c) => {
  const body = await c.req.json().catch(() => null);
  const lang = body?.lang;
  if (lang !== 'en' && lang !== 'ar') return c.json({ error: 'invalid_lang' }, 400);
  await run(c.env.DB, `UPDATE users SET lang = ? WHERE id = ?`, lang, c.var.user.id);
  return c.json({ user: { ...c.var.user, lang } });
});

export default auth;
