// Admin › Cycle setup › Emails: turn the target emails on or off, see whether
// the mail service is set up, and load each person's email address.
import { all, batch, one } from '../db';
import { auditStatement } from './audit';
import { bad, type Obj } from './masters';

export type MailStatus = { on: boolean; configured: boolean; appUrl: boolean; withEmail: number; accounts: number };

export async function mailStatus(db: D1Database, env: { BREVO_API_KEY?: string; MAIL_FROM?: string; APP_URL?: string }): Promise<MailStatus> {
  const [r, n] = await Promise.all([
    one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'mail_on'`),
    one<{ a: number; e: number }>(db, `SELECT COUNT(*) AS a, SUM(CASE WHEN email IS NOT NULL AND email <> '' THEN 1 ELSE 0 END) AS e FROM users WHERE deleted_at IS NULL AND active = 1`),
  ]);
  return { on: r?.value !== '0', configured: !!(env.BREVO_API_KEY && env.MAIL_FROM), appUrl: !!env.APP_URL, withEmail: n?.e ?? 0, accounts: n?.a ?? 0 };
}

export async function setMailOn(db: D1Database, actorId: number, body: Obj): Promise<{ on: boolean }> {
  if (typeof body.on !== 'boolean') throw bad('on must be true or false');
  await batch(db, [
    db.prepare(`INSERT INTO settings(key, value) VALUES ('mail_on', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(body.on ? '1' : '0'),
    auditStatement(db, actorId, 'mail.on', {}, { on: body.on }),
  ]);
  return { on: body.on };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** body.rows: [{id?, name?, email}] matched to accounts by employee ID, else by name. */
export async function setUserEmails(db: D1Database, actorId: number, body: Obj): Promise<{ matched: number; notFound: string[]; invalid: string[] }> {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > 5000) throw bad('at most 5000 rows');
  const users = await all<{ id: number; name: string; employee_id: string | null }>(db, `SELECT id, name, employee_id FROM users WHERE deleted_at IS NULL`);
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
  const byEmp = new Map(users.filter((u) => u.employee_id).map((u) => [u.employee_id!.trim(), u.id]));
  const byName = new Map(users.map((u) => [norm(u.name), u.id]));
  const set = new Map<number, string>();
  const notFound: string[] = [];
  const invalid: string[] = [];
  for (const raw of rows) {
    const o = raw as { id?: unknown; name?: unknown; email?: unknown };
    const email = typeof o.email === 'string' ? o.email.trim() : '';
    const who = (typeof o.id === 'string' && o.id.trim()) || (typeof o.name === 'string' && o.name.trim()) || '';
    if (!email) continue;
    if (!EMAIL_RE.test(email) || email.length > 254) { invalid.push(who || email); continue; }
    const id = (typeof o.id === 'string' && byEmp.get(o.id.trim())) || (typeof o.name === 'string' && byName.get(norm(o.name))) || null;
    if (id === null) { notFound.push(who || email); continue; }
    set.set(id, email);
  }
  const stmts = [...set.entries()].map(([id, e]) => db.prepare(`UPDATE users SET email = ? WHERE id = ?`).bind(e, id));
  stmts.push(auditStatement(db, actorId, 'users.emails', {}, { matched: set.size }));
  await batch(db, stmts);
  return { matched: set.size, notFound: notFound.slice(0, 50), invalid: invalid.slice(0, 50) };
}
