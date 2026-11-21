import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashPassword,
  PBKDF2_ITERATIONS,
  requireAdmin,
  requireUser,
  sha256Hex,
  verifyPassword,
  type AppEnv,
} from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';

const BOOTSTRAP = 'bootstrap-secret';

async function addUser(
  username: string,
  password: string,
  opts: { role?: 'admin' | 'manager'; active?: number; lang?: 'en' | 'ar' } = {},
): Promise<number> {
  const { hash, salt } = await hashPassword(password);
  const res = await run(
    env.DB,
    `INSERT INTO users(username, name, pw_hash, pw_salt, role, lang, active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, opts.role ?? 'manager', opts.lang ?? 'en', opts.active ?? 1,
  );
  return res.lastRowId;
}

function login(username: unknown, password: unknown): Promise<Response> {
  return SELF.fetch('http://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

function sidFrom(res: Response): string {
  const m = /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no sid cookie');
  return m[1]!;
}

async function loginSid(username: string, password: string): Promise<string> {
  const res = await login(username, password);
  expect(res.status).toBe(200);
  return sidFrom(res);
}

function withSid(sid: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), cookie: `sid=${sid}` } };
}

beforeEach(async () => {
  for (const t of ['sessions', 'login_failures', 'users']) await run(env.DB, `DELETE FROM ${t}`);
});

describe('password hashing', () => {
  it('stores algorithm and iterations inside the hash and verifies', async () => {
    const { hash, salt } = await hashPassword('s3cret-pw');
    expect(PBKDF2_ITERATIONS).toBe(10_000);
    expect(hash).toMatch(/^pbkdf2-sha256\$10000\$[A-Za-z0-9+/]+=*$/);
    expect(atob(salt)).toHaveLength(16);
    expect(await verifyPassword('s3cret-pw', hash, salt)).toBe(true);
    expect(await verifyPassword('wrong', hash, salt)).toBe(false);
  });

  it('uses a fresh random salt per hash', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('reads the iteration count from the stored string', async () => {
    const { hash, salt } = await hashPassword('pw');
    const parts = hash.split('$');
    // Same digest claiming a different iteration count must not verify.
    expect(await verifyPassword('pw', `${parts[0]}$9999$${parts[2]}`, salt)).toBe(false);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('pw', 'garbage', 'AAAA')).toBe(false);
    expect(await verifyPassword('pw', 'pbkdf2-sha256$abc$AAAA', 'AAAA')).toBe(false);
    expect(await verifyPassword('pw', 'pbkdf2-sha1$10000$AAAA', 'AAAA')).toBe(false);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in, sets the sid cookie and returns the user', async () => {
    await addUser('sara', 'pw-sara', { lang: 'ar' });
    const res = await login('sara', 'pw-sara');
    expect(res.status).toBe(200);
    const body = await res.json<{ user: Record<string, unknown> }>();
    expect(body.user).toMatchObject({ role: 'manager', lang: 'ar', name: 'Name sara' });
    expect(JSON.stringify(body)).not.toContain('pw_hash');

    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Max-Age=43200/i);
  });

  it('finds the user by the trimmed, lower-cased username', async () => {
    await addUser('sara', 'pw-sara');
    const res = await login(' SARA ', 'pw-sara');
    expect(res.status).toBe(200);
    expect((await res.json<{ user: { name: string } }>()).user.name).toBe('Name sara');
  });

  it('refuses non-JSON content types with 415 before doing any work', async () => {
    for (const [type, body] of [
      ['text/plain', JSON.stringify({ username: 'sara', password: 'x' })],
      ['application/x-www-form-urlencoded', 'username=sara&password=x'],
    ] as const) {
      const res = await SELF.fetch('http://x/api/auth/login', { method: 'POST', headers: { 'content-type': type }, body });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
    }
    expect((await SELF.fetch('http://x/api/auth/login', { method: 'POST', body: '{}' })).status).toBe(415);
    expect(await one(env.DB, `SELECT 1 AS x FROM login_failures`)).toBeNull();
  });

  it('accepts a JSON content type with parameters', async () => {
    await addUser('sara', 'pw-sara');
    const res = await SELF.fetch('http://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      body: JSON.stringify({ username: 'sara', password: 'pw-sara' }),
    });
    expect(res.status).toBe(200);
  });

  it('stores only the SHA-256 hex of the token, 12 h expiry', async () => {
    await addUser('sara', 'pw-sara');
    const sid = await loginSid('sara', 'pw-sara');
    const rows = await all<{ token: string; expires_at: string }>(env.DB, `SELECT token, expires_at FROM sessions`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(await sha256Hex(sid));
    expect(rows[0]!.token).not.toBe(sid);
    const ttl = Date.parse(rows[0]!.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(12 * 3600_000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(12 * 3600_000);
  });

  it('wrong password and unknown user get the identical 401', async () => {
    await addUser('sara', 'pw-sara');
    const wrong = await login('sara', 'nope');
    const unknown = await login('ghost', 'nope');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'invalid_credentials' });
    expect(await unknown.json()).toEqual({ error: 'invalid_credentials' });
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('disabled user gets the same 401 even with the right password', async () => {
    await addUser('off', 'pw-off', { active: 0 });
    const res = await login('off', 'pw-off');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('rejects non-string or missing fields with 400', async () => {
    expect((await login(undefined, 'x')).status).toBe(400);
    expect((await login('x', 123)).status).toBe(400);
    const bad = await SELF.fetch('http://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
  });
});

describe('login throttling', () => {
  it('returns 429 after 5 failures without checking the password', async () => {
    await addUser('sara', 'pw-sara');
    for (let i = 0; i < 5; i++) expect((await login('sara', 'bad')).status).toBe(401);
    const blocked = await login('sara', 'bad');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'too_many_attempts' });
    // The correct password is not even checked while blocked.
    const right = await login('sara', 'pw-sara');
    expect(right.status).toBe(429);
    expect(right.headers.get('set-cookie')).toBeNull();
  });

  it('throttles unknown usernames the same way', async () => {
    for (let i = 0; i < 5; i++) expect((await login('ghost', 'bad')).status).toBe(401);
    expect((await login('ghost', 'bad')).status).toBe(429);
  });

  it('is keyed by username, case-insensitively', async () => {
    await addUser('sara', 'pw-sara');
    for (let i = 0; i < 5; i++) await login('SARA', 'bad');
    expect((await login('sara', 'pw-sara')).status).toBe(429);
    await addUser('omar', 'pw-omar');
    expect((await login('omar', 'pw-omar')).status).toBe(200);
  });

  it('lets the user in again once failures are older than 15 minutes', async () => {
    await addUser('sara', 'pw-sara');
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    for (let i = 0; i < 5; i++) {
      await run(env.DB, `INSERT INTO login_failures(username, at) VALUES ('sara', ?)`, old);
    }
    expect((await login('sara', 'pw-sara')).status).toBe(200);
  });

  it('still blocks when the failures are inside the window', async () => {
    await addUser('sara', 'pw-sara');
    const recent = new Date(Date.now() - 14 * 60_000).toISOString();
    for (let i = 0; i < 5; i++) {
      await run(env.DB, `INSERT INTO login_failures(username, at) VALUES ('sara', ?)`, recent);
    }
    expect((await login('sara', 'pw-sara')).status).toBe(429);
  });

  it('clears the username failures on success and prunes stale rows on failure', async () => {
    await addUser('sara', 'pw-sara');
    for (let i = 0; i < 3; i++) await login('sara', 'bad');
    expect((await login('sara', 'pw-sara')).status).toBe(200);
    expect(await one(env.DB, `SELECT 1 AS x FROM login_failures WHERE username = 'sara'`)).toBeNull();

    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await run(env.DB, `INSERT INTO login_failures(username, at) VALUES ('other', ?)`, old);
    await login('sara', 'bad');
    expect(await one(env.DB, `SELECT 1 AS x FROM login_failures WHERE username = 'other'`)).toBeNull();
  });
});

describe('login throttling under concurrency', () => {
  it('lets at most 5 of 10 parallel wrong guesses through to the password check', async () => {
    await addUser('sara', 'pw-sara');
    const results = await Promise.all(Array.from({ length: 10 }, () => login('sara', 'bad')));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it('applies to unknown usernames in parallel too', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => login('ghost', 'bad')));
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(5);
  });
});

describe('sessions', () => {
  it('GET /api/me returns the user for a valid session', async () => {
    await addUser('sara', 'pw-sara', { role: 'admin' });
    const sid = await loginSid('sara', 'pw-sara');
    const res = await SELF.fetch('http://x/api/me', withSid(sid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: expect.any(Number), role: 'admin', lang: 'en', name: 'Name sara', cd: [], mustChangePw: false },
    });
  });

  it('401 without a cookie or with an unknown token', async () => {
    expect((await SELF.fetch('http://x/api/me')).status).toBe(401);
    const res = await SELF.fetch('http://x/api/me', withSid('x'.repeat(43)));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('rejects an expired session with 401 and deletes it lazily', async () => {
    const uid = await addUser('sara', 'pw-sara');
    const sid = 'expired-token-value';
    await run(
      env.DB,
      `INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)`,
      await sha256Hex(sid), uid, new Date(Date.now() - 1000).toISOString(),
    );
    const res = await SELF.fetch('http://x/api/me', withSid(sid));
    expect(res.status).toBe(401);
    expect(await one(env.DB, `SELECT 1 AS x FROM sessions`)).toBeNull();
  });

  it('a live session stops working once the user is disabled', async () => {
    const uid = await addUser('sara', 'pw-sara');
    const sid = await loginSid('sara', 'pw-sara');
    await run(env.DB, `UPDATE users SET active = 0 WHERE id = ?`, uid);
    expect((await SELF.fetch('http://x/api/me', withSid(sid))).status).toBe(401);
  });

  it('logout deletes the session and clears the cookie', async () => {
    await addUser('sara', 'pw-sara');
    const sid = await loginSid('sara', 'pw-sara');
    const res = await SELF.fetch('http://x/api/auth/logout', withSid(sid, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/sid=;/);
    expect(await one(env.DB, `SELECT 1 AS x FROM sessions`)).toBeNull();
    expect((await SELF.fetch('http://x/api/me', withSid(sid))).status).toBe(401);
  });

  it('logout without a session is still 200', async () => {
    const res = await SELF.fetch('http://x/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/me', () => {
  it('updates lang to ar and en', async () => {
    await addUser('sara', 'pw-sara');
    const sid = await loginSid('sara', 'pw-sara');
    const patch = (body: unknown) =>
      SELF.fetch('http://x/api/me', withSid(sid, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    const res = await patch({ lang: 'ar' });
    expect(res.status).toBe(200);
    expect((await res.json<{ user: { lang: string } }>()).user.lang).toBe('ar');
    expect((await one<{ lang: string }>(env.DB, `SELECT lang FROM users`))!.lang).toBe('ar');
    expect((await patch({ lang: 'en' })).status).toBe(200);
  });

  it('rejects any other lang with 400', async () => {
    await addUser('sara', 'pw-sara');
    const sid = await loginSid('sara', 'pw-sara');
    for (const body of [{ lang: 'fr' }, { lang: '' }, { lang: 1 }, {}]) {
      const res = await SELF.fetch('http://x/api/me', withSid(sid, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      expect(res.status).toBe(400);
    }
    expect((await one<{ lang: string }>(env.DB, `SELECT lang FROM users`))!.lang).toBe('en');
  });

  it('requires a session', async () => {
    const res = await SELF.fetch('http://x/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'ar' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('requireAdmin', () => {
  const app = new Hono<AppEnv>();
  app.get('/admin-only', requireUser, requireAdmin, (c) => c.json({ ok: true, who: c.var.user.name }));
  app.get('/any-user', requireUser, (c) => c.json({ ok: true }));
  const call = (path: string, sid?: string) =>
    app.request(path, sid ? { headers: { cookie: `sid=${sid}` } } : {}, env);

  it('403 forbidden for a manager', async () => {
    await addUser('mgr', 'pw-mgr', { role: 'manager' });
    const sid = await loginSid('mgr', 'pw-mgr');
    const res = await call('/admin-only', sid);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect((await call('/any-user', sid)).status).toBe(200);
  });

  it('lets an admin through', async () => {
    await addUser('adm', 'pw-adm', { role: 'admin' });
    const sid = await loginSid('adm', 'pw-adm');
    const res = await call('/admin-only', sid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, who: 'Name adm' });
  });

  it('401 when not logged in', async () => {
    expect((await call('/admin-only')).status).toBe(401);
  });
});

describe('bootstrap admin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('performs exactly one PBKDF2 derivation (CPU budget)', async () => {
    const spy = vi.spyOn(crypto.subtle, 'deriveBits');
    const res = await login('admin', BOOTSTRAP);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('an unknown user still costs exactly one PBKDF2 derivation', async () => {
    const spy = vi.spyOn(crypto.subtle, 'deriveBits');
    expect((await login('ghost', 'bad')).status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('creates the admin on first login with the secret, only once', async () => {
    const first = await login('admin', BOOTSTRAP);
    expect(first.status).toBe(200);
    const body = await first.json<{ user: { role: string; name: string } }>();
    expect(body.user).toMatchObject({ role: 'admin', name: 'Administrator' });
    expect(sidFrom(first)).toBeTruthy();

    const row = await one<{ role: string; pw_hash: string }>(env.DB, `SELECT role, pw_hash FROM users WHERE username = 'admin'`);
    expect(row?.role).toBe('admin');
    expect(row?.pw_hash).not.toContain(BOOTSTRAP);

    // The created account now logs in through the normal path.
    expect((await login('admin', BOOTSTRAP)).status).toBe(200);
    expect((await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM users`))!.n).toBe(1);
  });

  it('does not run when the users table is not empty', async () => {
    await addUser('someone', 'pw');
    const res = await login('admin', BOOTSTRAP);
    expect(res.status).toBe(401);
    expect(await one(env.DB, `SELECT 1 AS x FROM users WHERE username = 'admin'`)).toBeNull();
  });

  it('does not run again after the admin was removed while other users exist', async () => {
    await login('admin', BOOTSTRAP);
    await addUser('other', 'pw');
    await run(env.DB, `DELETE FROM users WHERE username = 'admin'`);
    expect((await login('admin', BOOTSTRAP)).status).toBe(401);
  });

  it('needs the exact password and the username admin', async () => {
    expect((await login('admin', 'wrong')).status).toBe(401);
    expect((await login('admin', BOOTSTRAP + ' ')).status).toBe(401);
    expect((await login('root', BOOTSTRAP)).status).toBe(401);
    expect((await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM users`))!.n).toBe(0);
  });

  it('is off when the secret is not set', async () => {
    const res = await (await import('../../src/worker/index')).app.request(
      '/api/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'anything' }) },
      { ...env, BOOTSTRAP_ADMIN_PASSWORD: undefined },
    );
    expect(res.status).toBe(401);
    expect((await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM users`))!.n).toBe(0);
  });
});
