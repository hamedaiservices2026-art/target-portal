// Where a pack shows in the target tables and the approval template when the
// uploaded file does not list it: under the Total row the admin picks
// (Admin › Packs). Kept in the settings table as {pack code: Total row name}.
import { batch, one } from '../db';
import { auditStatement } from './audit';
import { bad, type Obj } from './masters';

const KEY = 'pack_place_json';

export async function getPackPlace(db: D1Database): Promise<Record<string, string>> {
  const r = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, KEY);
  try {
    const v = r ? JSON.parse(r.value) : {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

/** body: {code, under}; an empty `under` goes back to the automatic place. */
export async function setPackPlace(db: D1Database, actorId: number, body: Obj): Promise<{ place: Record<string, string> }> {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code || code.length > 100) throw bad('code is required');
  const under = typeof body.under === 'string' ? body.under.trim() : '';
  if (under.length > 100) throw bad('the Total name must be at most 100 characters');
  const place = await getPackPlace(db);
  if (under) place[code] = under;
  else delete place[code];
  await batch(db, [
    db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(KEY, JSON.stringify(place)),
    auditStatement(db, actorId, 'pack.place', {}, { code, under: under || null }),
  ]);
  return { place };
}
