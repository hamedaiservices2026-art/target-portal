import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { all, run } from '../../src/worker/db';
import { notifyDeptComplete, notifyTurnOpened, queueMail, sendDeadlineReminders, sendMail } from '../../src/worker/email';
import { departmentComplete, turnOpened } from '../../src/worker/emailTemplates';
import type { Env } from '../../src/worker/index';

const msg = { to: 'a@example.com', subject: 'S', text: 't', html: '<p>t</p>' };
const cfg = (extra: Partial<Env> = {}): Env => ({ ...env, BREVO_API_KEY: 'k', MAIL_FROM: 'from@gmail.com', APP_URL: 'https://app.test', ...extra });
const logRows = () => all<{ to_addr: string; subject: string; result: string }>(env.DB, `SELECT to_addr, subject, result FROM email_log ORDER BY id`);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  for (const t of ['email_log', 'month_nodes', 'month_depts', 'months', 'nodes', 'departments', 'users']) await run(env.DB, `DELETE FROM ${t}`);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }));
});
afterEach(() => vi.restoreAllMocks());

async function seed(deadline: string, statuses: string[]) {
  await run(env.DB, `INSERT INTO departments(id, code, name) VALUES (1, 'D', 'Dept')`);
  await run(env.DB, `INSERT INTO months(id, period, deadline, packs_json, created_at) VALUES (1, '2026-11', ?, '[]', 'x')`, deadline);
  await run(env.DB, `INSERT INTO users(id, username, name, email, pw_hash, pw_salt, role, lang) VALUES (1, 'adm', 'Admin', 'adm@e.com', 'h', 's', 'admin', 'en')`);
  await run(env.DB, `INSERT INTO users(id, username, name, email, pw_hash, pw_salt, role, lang) VALUES (2, 'noem', 'NoEmail', NULL, 'h', 's', 'manager', 'en')`);
  for (const [i, st] of statuses.entries()) {
    const id = i + 10;
    await run(env.DB, `INSERT INTO users(id, username, name, email, pw_hash, pw_salt, role, lang) VALUES (?, ?, ?, ?, 'h', 's', 'manager', 'ar')`, id, `m${id}`, `Mgr${id}`, `m${id}@e.com`);
    await run(env.DB, `INSERT INTO month_nodes(month_id, node_id, dept_id, name, manager_user_id, status) VALUES (1, ?, 1, ?, ?, ?)`, id, `Node${id}`, id, st);
  }
}

describe('sendMail', () => {
  it('without a key only logs', async () => {
    expect(await sendMail({ ...env } as Env, msg)).toBe('logged');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await logRows()).toEqual([{ to_addr: 'a@example.com', subject: 'S', result: 'logged' }]);
  });

  it('posts to Brevo and reports sent', async () => {
    expect(await sendMail(cfg(), msg)).toBe('sent');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('k');
    expect(JSON.parse(init.body as string)).toMatchObject({
      sender: { email: 'from@gmail.com', name: 'Target Portal' }, to: [{ email: 'a@example.com' }], replyTo: { email: 'from@gmail.com' },
      subject: 'S', htmlContent: '<p>t</p>', textContent: 't',
    });
    expect((await logRows())[0]!.result).toBe('sent');
  });

  it('a 500 is failed and does not throw', async () => {
    fetchSpy.mockResolvedValue(new Response('no', { status: 500 }));
    expect(await sendMail(cfg(), msg)).toBe('failed');
    expect((await logRows())[0]!.result).toBe('failed:500');
  });

  it('a network error is failed; queueMail never throws', async () => {
    fetchSpy.mockRejectedValue(new Error('down'));
    await expect(queueMail(cfg(), msg)).resolves.toBeUndefined();
    expect((await logRows())[0]!.result).toBe('failed:error');
  });

  it('a timeout is logged as failed:timeout, without secrets', async () => {
    fetchSpy.mockRejectedValue(new DOMException('t', 'TimeoutError'));
    await sendMail(cfg(), msg);
    expect((await logRows())[0]!.result).toBe('failed:timeout');
  });
});

describe('templates', () => {
  it('puts the recipient language first and escapes values', () => {
    const m = turnOpened({ name: '<b>x</b>', period: '2026-11', nodeName: 'N&M', deadline: '2026-11-20', link: 'https://a/m/1/n/2', lang: 'ar' });
    expect(m.html.indexOf('dir="rtl"')).toBeLessThan(m.html.indexOf('lang="en"'));
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(m.html).toContain('N&amp;M');
    expect(m.text).toContain('https://a/m/1/n/2');
    const en = turnOpened({ name: 'x', period: 'p', nodeName: 'n', deadline: null, link: null, lang: 'en' });
    expect(en.html.indexOf('lang="en"')).toBeLessThan(en.html.indexOf('dir="rtl"'));
    expect(en.text).not.toContain('http');
    expect(departmentComplete({ period: 'p', deptName: 'd', link: null }).subject).toContain('d');
  });
});

describe('hooks', () => {
  it('turn opened emails the manager with a link; skips managers without email', async () => {
    await seed('2026-11-20', ['in_progress']);
    await run(env.DB, `INSERT INTO month_nodes(month_id, node_id, dept_id, name, manager_user_id, status) VALUES (1, 99, 1, 'NoMail', 2, 'in_progress')`);
    await notifyTurnOpened(cfg(), 1, [10, 99]);
    const rows = await logRows();
    expect(rows.map((r) => r.to_addr)).toEqual(['m10@e.com']);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.textContent).toContain('https://app.test/m/1/n/10');
  });

  it('department complete goes to active admins with an email', async () => {
    await seed('2026-11-20', []);
    await notifyDeptComplete(cfg(), 1, 1);
    expect((await logRows()).map((r) => r.to_addr)).toEqual(['adm@e.com']);
  });

  it('a failing database never throws', async () => {
    await expect(notifyTurnOpened({ ...env, DB: undefined as never } as Env, 1, [1])).resolves.toBeUndefined();
  });
});

describe('fan-out', () => {
  async function seedMany(n: number) {
    await seed('2026-11-20', []);
    for (let i = 0; i < n; i++) {
      const id = 100 + i;
      await run(env.DB, `INSERT INTO users(id, username, name, email, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, 'h', 's', 'manager')`, id, `u${id}`, `U${id}`, `u${id}@e.com`);
      await run(env.DB, `INSERT INTO month_nodes(month_id, node_id, dept_id, name, manager_user_id, status) VALUES (1, ?, 1, ?, ?, 'in_progress')`, id, `N${id}`, id);
    }
    return Array.from({ length: n }, (_, i) => 100 + i);
  }

  it('sends concurrently and writes one email_log INSERT', async () => {
    const ids = await seedMany(5);
    let inFlight = 0; let peak = 0;
    fetchSpy.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return new Response('{}', { status: 201 });
    });
    const inserts: string[] = [];
    const db = new Proxy(env.DB, { get: (t, k) => k === 'prepare'
      ? (sql: string) => { if (/INSERT INTO email_log/.test(sql)) inserts.push(sql); return t.prepare(sql); }
      : (t as any)[k].bind?.(t) ?? (t as any)[k] });
    await notifyTurnOpened(cfg({ DB: db as D1Database }), 1, ids);
    expect(peak).toBe(5);
    expect(inserts).toHaveLength(1);
    expect(await logRows()).toHaveLength(5);
  });

  it('with defer the call returns before a slow fetch resolves', async () => {
    const ids = await seedMany(2);
    const releases: (() => void)[] = [];
    fetchSpy.mockImplementation(() => new Promise((r) => { releases.push(() => r(new Response('{}', { status: 201 }))); }));
    const pending: Promise<unknown>[] = [];
    await notifyTurnOpened(cfg({ defer: (p) => { pending.push(p); } }), 1, ids);
    expect(await logRows()).toHaveLength(0);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    releases.forEach((r) => r());
    await Promise.all(pending);
    await vi.waitFor(async () => expect(await logRows()).toHaveLength(2));
  });
});

describe('sendDeadlineReminders', () => {
  // 2026-11-19T22:00Z = 2026-11-20 01:00 Riyadh, so tomorrow is 2026-11-21.
  const now = new Date('2026-11-19T22:00:00Z');

  it('emails only in_progress managers, only when the deadline is tomorrow in Riyadh', async () => {
    await seed('2026-11-21', ['in_progress', 'submitted', 'waiting']);
    expect(await sendDeadlineReminders(env.DB, cfg(), now)).toBe(1);
    expect((await logRows()).map((r) => r.to_addr)).toEqual(['m10@e.com']);
  });

  it('sends nothing on other days', async () => {
    await seed('2026-11-21', ['in_progress']);
    expect(await sendDeadlineReminders(env.DB, cfg(), new Date('2026-11-19T20:00:00Z'))).toBe(0);
    expect(await sendDeadlineReminders(env.DB, cfg(), new Date('2026-11-21T05:00:00Z'))).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
