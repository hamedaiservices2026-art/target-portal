import type { Env } from './index';
import { all, insertJson } from './db';
import { departmentComplete, deadlineReminder, turnOpened, type Lang } from './emailTemplates';

export type MailMsg = { to: string; subject: string; text: string; html: string };
export type MailResult = 'sent' | 'logged' | 'failed';

const MAX_PER_RUN = 30;

type Delivery = { to: string; subject: string; result: MailResult; logged: string };

async function logAll(env: Env, ds: Delivery[]): Promise<void> {
  if (!ds.length) return;
  try {
    const at = new Date().toISOString();
    await insertJson(env.DB, 'email_log', ['at', 'to_addr', 'subject', 'result'],
      ds.map((d) => ({ at, to_addr: d.to, subject: d.subject, result: d.logged })));
  } catch { /* logging must never break a request */ }
}

/** One delivery attempt; never throws and never touches the database. */
async function deliver(env: Env, msg: MailMsg): Promise<Delivery> {
  const base = { to: msg.to, subject: msg.subject };
  if (!(env.BREVO_API_KEY && env.MAIL_FROM)) return { ...base, result: 'logged', logged: 'logged' };
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: 'Target Portal' },
        to: [{ email: msg.to }],
        replyTo: { email: env.MAIL_FROM },
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.status >= 200 && res.status < 300
      ? { ...base, result: 'sent', logged: 'sent' }
      : { ...base, result: 'failed', logged: `failed:${res.status}` };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ...base, result: 'failed', logged: timeout ? 'failed:timeout' : 'failed:error' };
  }
}

/** Sends through Brevo when configured, else only logs. Always writes email_log; never throws. */
export async function sendMail(env: Env, msg: MailMsg): Promise<MailResult> {
  const d = await deliver(env, msg);
  await logAll(env, [d]);
  return d.result;
}

/** Awaits sendMail; never throws. */
export async function queueMail(env: Env, msg: MailMsg): Promise<void> {
  try { await sendMail(env, msg); } catch { /* never fail the caller */ }
}

/** Sends all messages concurrently, then writes one multi-row email_log INSERT. Never throws. */
export async function sendMailBatch(env: Env, msgs: MailMsg[]): Promise<void> {
  try {
    const settled = await Promise.allSettled(msgs.map((m) => deliver(env, m)));
    await logAll(env, settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
  } catch { /* never fail the caller */ }
}

/**
 * Notifications are fire-and-forget after the commit: with a deferrer
 * (waitUntil) the response does not wait for email; without one (tests,
 * cron) the work is awaited.
 */
async function dispatch(env: Env, work: Promise<unknown>): Promise<void> {
  const safe = work.catch(() => {});
  if (env.defer) env.defer(safe);
  else await safe;
}

function link(env: Env, monthId: number, nodeId: number): string | null {
  const base = env.APP_URL?.replace(/\/+$/, '');
  return base ? `${base}/m/${monthId}/n/${nodeId}` : null;
}

type NodeRow = { name: string; email: string; lang: Lang; period: string; deadline: string | null; node_id: number; month_id: number; node_name: string };

const NODE_SELECT = `SELECT u.name, u.email, u.lang, m.period, m.deadline, mn.node_id, mn.month_id, mn.name AS node_name
  FROM month_nodes mn JOIN months m ON m.id = mn.month_id JOIN users u ON u.id = mn.manager_user_id
  WHERE u.active = 1 AND u.email IS NOT NULL AND u.email <> ''`;

function nodeMail(env: Env, r: NodeRow, tpl: typeof turnOpened) {
  return { to: r.email, ...tpl({
    name: r.name, period: r.period, nodeName: r.node_name, deadline: r.deadline, lang: r.lang, link: link(env, r.month_id, r.node_id),
  }) };
}

/** After the turns of `nodeIds` opened (D1 batch already committed). Never throws. */
export function notifyTurnOpened(env: Env, monthId: number, nodeIds: number[]): Promise<void> {
  return dispatch(env, turnOpenedWork(env, monthId, nodeIds));
}

async function turnOpenedWork(env: Env, monthId: number, nodeIds: number[]): Promise<void> {
  try {
    // In-app notification (the reliable signal; email may be filtered).
    await env.DB.prepare(
      `INSERT INTO notifications(user_id, at, kind, text, link)
       SELECT mn.manager_user_id, ?, 'turn_opened',
              json_object('en', 'Your turn to split the ' || m.period || ' target of ' || mn.name || ' is open.',
                          'ar', 'حان دورك لتوزيع هدف ' || m.period || ' لـ ' || mn.name || '.'),
              '/m/' || mn.month_id || '/n/' || mn.node_id
       FROM month_nodes mn JOIN months m ON m.id = mn.month_id
       WHERE mn.month_id = ? AND mn.node_id IN (SELECT value FROM json_each(?)) AND mn.manager_user_id IS NOT NULL`,
    ).bind(new Date().toISOString(), monthId, JSON.stringify(nodeIds)).run();
  } catch { /* notifications must not fail the request */ }
  try {
    const ids = nodeIds.slice(0, MAX_PER_RUN);
    if (!ids.length) return;
    const rows = await all<NodeRow>(env.DB,
      `${NODE_SELECT} AND mn.month_id = ? AND mn.node_id IN (${ids.map(() => '?').join(',')})`, monthId, ...ids);
    await sendMailBatch(env, rows.map((r) => nodeMail(env, r, turnOpened)));
  } catch { /* email must not fail the request */ }
}

/** After a department became complete: all active admins with an email. Never throws. */
export function notifyDeptComplete(env: Env, monthId: number, deptId: number): Promise<void> {
  return dispatch(env, deptCompleteWork(env, monthId, deptId));
}

async function deptCompleteWork(env: Env, monthId: number, deptId: number): Promise<void> {
  try {
    // "Final": the Head and the admins are notified in the app.
    await env.DB.prepare(
      `INSERT INTO notifications(user_id, at, kind, text, link)
       SELECT u.id, ?, 'final',
              json_object('en', 'The ' || m.period || ' target of ' || d.name || ' is final.',
                          'ar', 'أصبح هدف ' || m.period || ' لـ ' || d.name || ' نهائياً.'), NULL
       FROM users u, months m, departments d
       WHERE m.id = ? AND d.id = ? AND u.active = 1
         AND (u.role = 'admin' OR u.id = (SELECT manager_user_id FROM nodes WHERE dept_id = d.id AND parent_id IS NULL))`,
    ).bind(new Date().toISOString(), monthId, deptId).run();
  } catch { /* notifications must not fail the request */ }
  try {
    const rows = await all<{ email: string; lang: Lang; period: string; dept_name: string }>(env.DB,
      `SELECT u.email, u.lang, m.period, d.name AS dept_name FROM users u, months m, departments d
       WHERE m.id = ? AND d.id = ? AND u.role = 'admin' AND u.active = 1 AND u.email IS NOT NULL AND u.email <> ''
       LIMIT ${MAX_PER_RUN}`, monthId, deptId);
    const base = env.APP_URL?.replace(/\/+$/, '');
    await sendMailBatch(env, rows.map((r) => ({ to: r.email, ...departmentComplete({
      period: r.period, deptName: r.dept_name, lang: r.lang, link: base ? `${base}/m/${monthId}` : null,
    }) })));
  } catch { /* email must not fail the request */ }
}

/** Cron: remind managers of in_progress nodes whose month deadline is tomorrow in Asia/Riyadh (UTC+3, no DST). */
export async function sendDeadlineReminders(db: D1Database, env: Env, now: Date): Promise<number> {
  try {
    const tomorrow = new Date(now.getTime() + (3 + 24) * 3600_000).toISOString().slice(0, 10);
    const rows = await all<NodeRow>(db,
      `${NODE_SELECT} AND mn.status = 'in_progress' AND m.deadline = ? LIMIT ${MAX_PER_RUN}`, tomorrow);
    await sendMailBatch(env, rows.map((r) => nodeMail(env, r, deadlineReminder)));
    return rows.length;
  } catch {
    return 0;
  }
}
