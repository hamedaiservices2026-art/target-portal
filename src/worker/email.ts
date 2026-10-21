import type { Env } from './index';
import { all, run } from './db';
import { departmentComplete, deadlineReminder, turnOpened, type Lang } from './emailTemplates';

export type MailMsg = { to: string; subject: string; text: string; html: string };
export type MailResult = 'sent' | 'logged' | 'failed';

const MAX_PER_RUN = 30;

async function log(env: Env, to: string, subject: string, result: string): Promise<void> {
  try {
    await run(env.DB, `INSERT INTO email_log(at, to_addr, subject, result) VALUES (?, ?, ?, ?)`,
      new Date().toISOString(), to, subject, result);
  } catch { /* logging must never break a request */ }
}

/** Sends through Brevo when configured, else only logs. Always writes email_log; never throws. */
export async function sendMail(env: Env, msg: MailMsg): Promise<MailResult> {
  let result: MailResult = 'logged';
  if (env.BREVO_API_KEY && env.MAIL_FROM) {
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
      result = res.status >= 200 && res.status < 300 ? 'sent' : 'failed';
    } catch {
      result = 'failed';
    }
  }
  await log(env, msg.to, msg.subject, result);
  return result;
}

/** Awaits sendMail; never throws. */
export async function queueMail(env: Env, msg: MailMsg): Promise<void> {
  try { await sendMail(env, msg); } catch { /* never fail the caller */ }
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
export async function notifyTurnOpened(env: Env, monthId: number, nodeIds: number[]): Promise<void> {
  try {
    const ids = nodeIds.slice(0, MAX_PER_RUN);
    if (!ids.length) return;
    const rows = await all<NodeRow>(env.DB,
      `${NODE_SELECT} AND mn.month_id = ? AND mn.node_id IN (${ids.map(() => '?').join(',')})`, monthId, ...ids);
    for (const r of rows) await queueMail(env, nodeMail(env, r, turnOpened));
  } catch { /* email must not fail the request */ }
}

/** After a department became complete: all active admins with an email. Never throws. */
export async function notifyDeptComplete(env: Env, monthId: number, deptId: number): Promise<void> {
  try {
    const rows = await all<{ email: string; lang: Lang; period: string; dept_name: string }>(env.DB,
      `SELECT u.email, u.lang, m.period, d.name AS dept_name FROM users u, months m, departments d
       WHERE m.id = ? AND d.id = ? AND u.role = 'admin' AND u.active = 1 AND u.email IS NOT NULL AND u.email <> ''
       LIMIT ${MAX_PER_RUN}`, monthId, deptId);
    const base = env.APP_URL?.replace(/\/+$/, '');
    for (const r of rows) {
      await queueMail(env, { to: r.email, ...departmentComplete({
        period: r.period, deptName: r.dept_name, lang: r.lang, link: base ? `${base}/m/${monthId}` : null,
      }) });
    }
  } catch { /* email must not fail the request */ }
}

/** Cron: remind managers of in_progress nodes whose month deadline is tomorrow in Asia/Riyadh (UTC+3, no DST). */
export async function sendDeadlineReminders(db: D1Database, env: Env, now: Date): Promise<number> {
  try {
    const tomorrow = new Date(now.getTime() + (3 + 24) * 3600_000).toISOString().slice(0, 10);
    const rows = await all<NodeRow>(db,
      `${NODE_SELECT} AND mn.status = 'in_progress' AND m.deadline = ? LIMIT ${MAX_PER_RUN}`, tomorrow);
    for (const r of rows) await queueMail(env, nodeMail(env, r, deadlineReminder));
    return rows.length;
  } catch {
    return 0;
  }
}
