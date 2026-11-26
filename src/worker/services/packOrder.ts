// The pack master's order (packs.sort) follows the uploaded target file: its
// packs in the file's order, packs it doesn't list with their group (or under
// the Total picked in Admin › Packs). Without a file: the department file's
// default order. Every list of packs reads this order.
import { all, one } from '../db';
import { approvalLines, mapLayout, type FileRow } from '../../shared/calc/packOrder';
import { getPackPlace } from './packPlace';

const DONE = 'pack_sort_v1';

/** The latest uploaded layout: New Target, uploaded target or AOP by pack and department (Ops first). */
async function latestLayout(db: D1Database): Promise<FileRow[]> {
  const rows = await all<{ layout: string }>(db,
    `SELECT json_extract(values_json, '$.layout') AS layout FROM data_months
     WHERE kind IN ('new_target', 'target_upload', 'aop_dept') AND json_type(values_json, '$.layout') = 'array'
       AND json_array_length(values_json, '$.layout') > 0
     ORDER BY CASE ws WHEN 'ops' THEN 0 ELSE 1 END, month DESC,
       CASE kind WHEN 'new_target' THEN 0 WHEN 'target_upload' THEN 1 ELSE 2 END
     LIMIT 1`);
  try {
    const v = rows[0] ? JSON.parse(rows[0].layout) : [];
    return Array.isArray(v) ? (v as FileRow[]).filter((r) => r && (typeof (r as { p?: unknown }).p === 'string' || (typeof (r as { t?: unknown }).t === 'string' && Array.isArray((r as { of?: unknown }).of)))) : [];
  } catch {
    return [];
  }
}

/** Sets packs.sort (and the pack order of every month) from the file's order. */
export async function syncPackSort(db: D1Database): Promise<void> {
  const packs = await all<{ code: string; grp: string; sort: number }>(db, `SELECT code, grp, sort FROM packs ORDER BY sort, code`);
  if (!packs.length) return;
  const codes = packs.map((p) => p.code);
  const grp = new Map(packs.map((p) => [p.code, p.grp]));
  const layout = mapLayout(await latestLayout(db), codes);
  const set = new Set(codes);
  const order = approvalLines(layout, codes, (p) => grp.get(p) ?? 'LRB-Others', await getPackPlace(db))
    .flatMap((l) => (l.pack && set.has(l.pack) ? [l.pack] : []));
  const sortOf = new Map([...new Set(order)].map((p, i) => [p, (i + 1) * 10]));
  const stmts: D1PreparedStatement[] = packs
    .filter((p) => sortOf.has(p.code) && sortOf.get(p.code) !== p.sort)
    .map((p) => db.prepare(`UPDATE packs SET sort = ? WHERE code = ?`).bind(sortOf.get(p.code)!, p.code));
  const months = await all<{ id: number; packs_json: string }>(db, `SELECT id, packs_json FROM months`);
  for (const m of months) {
    try {
      const list = JSON.parse(m.packs_json) as { code: string; sort: number }[];
      if (!Array.isArray(list)) continue;
      let changed = false;
      for (const p of list) {
        const s = sortOf.get(p.code);
        if (s !== undefined && s !== p.sort) { p.sort = s; changed = true; }
      }
      if (changed) stmts.push(db.prepare(`UPDATE months SET packs_json = ? WHERE id = ?`).bind(JSON.stringify(list), m.id));
    } catch { /* leave a month we can't read */ }
  }
  stmts.push(db.prepare(`INSERT INTO settings(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(DONE));
  await db.batch(stmts);
}

/** Once after this change: order the packs from the files already uploaded. */
export async function syncPackSortOnce(db: D1Database): Promise<void> {
  if (await one(db, `SELECT 1 AS x FROM settings WHERE key = ?`, DONE)) return;
  await syncPackSort(db);
}
