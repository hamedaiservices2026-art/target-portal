// In-app notifications at every hand-off (handover section 3): sent, approved,
// returned, submitted, final, salesman ID changed. Statements are returned so
// a caller can put them in the same atomic batch as the change.
import { all, run } from '../db';

export type NotifyKind =
  | 'cd_sent' | 'cd_recalled' | 'cd_returned' | 'cd_submitted'
  | 'head_sent' | 'head_approved' | 'head_returned' | 'channel_restarted'
  | 'turn_opened' | 'submitted' | 'final' | 'salesman_changed';

/** Notification text is stored in English and in Arabic: `{en, ar}` as JSON. */
export type NotifyText = { en: string; ar: string };

/** One row per user id in `userIdsSql` (a SELECT returning user ids). */
export function notifySql(
  db: D1Database, userIdsSql: string, args: (string | number | null)[], kind: NotifyKind, text: NotifyText, link: string | null,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notifications(user_id, at, kind, text, link)
     SELECT id, ?, ?, ?, ? FROM users WHERE active = 1 AND id IN (${userIdsSql})`,
  ).bind(new Date().toISOString(), kind, JSON.stringify(text), link, ...args);
}

export const ADMINS = `SELECT id FROM users WHERE role = 'admin'`;
export const CDS = (ws: string) => ({ sql: `SELECT user_id FROM user_roles WHERE role = 'cd' AND workspace = ?`, args: [ws] });

export type NotificationDto = { id: number; at: string; kind: string; text: NotifyText; link: string | null; read: boolean };

export async function listNotifications(db: D1Database, userId: number): Promise<{ items: NotificationDto[]; unread: number }> {
  const rows = await all<{ id: number; at: string; kind: string; text: string; link: string | null; read_at: string | null }>(
    db, `SELECT id, at, kind, text, link, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`, userId);
  const items = rows.map((r) => {
    let text: NotifyText;
    try {
      text = JSON.parse(r.text) as NotifyText;
    } catch {
      text = { en: r.text, ar: r.text };
    }
    return { id: r.id, at: r.at, kind: r.kind, text, link: r.link, read: r.read_at !== null };
  });
  return { items, unread: items.filter((i) => !i.read).length };
}

export async function markRead(db: D1Database, userId: number): Promise<void> {
  await run(db, `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`, new Date().toISOString(), userId);
}
