// Merged packs in the data already stored: CSD_SSPET500 and the combined
// "CSD_SSPET500/400" are CSD_SSPET400 (see PACK_ALIASES). The flat route
// tables are merged by migration 0012; here, once, every stored JSON that
// names a merged pack (cycles, uploaded month files, month pack lists, the
// managers' grids) gets the pack renamed and its cases added up.
import { all, one } from '../db';

const DONE = 'merge_sspet400_v1';
const TO = 'CSD_SSPET400';
const ALIAS = new Map<string, string>([['CSD_SSPET500', TO], ['CSD_SSPET500/400', TO], ['CSD_SSPET400/500', TO]]);
const LIKE = `%SSPET500%`;

function add(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const o: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) o[k] = k in o ? add(o[k], v) : v;
    return o;
  }
  return a ?? b;
}

/** The value with merged packs renamed (keys, strings) and their numbers added up. */
export function mergePacks(v: unknown): unknown {
  if (typeof v === 'string') return ALIAS.get(v) ?? v;
  if (Array.isArray(v)) {
    const seen = new Set<string>();
    return v.map(mergePacks).filter((x) => {
      const id = typeof x === 'string' ? (x === TO ? `s:${x}` : null)
        : x && typeof x === 'object' && !Array.isArray(x) ? (((x as { code?: unknown }).code ?? (x as { p?: unknown }).p) === TO ? 'o' : null) : null;
      if (id === null) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const nk = ALIAS.get(k) ?? k;
      const nx = mergePacks(x);
      o[nk] = nk in o ? add(o[nk], nx) : nx;
    }
    return o;
  }
  return v;
}

const fix = (s: string | null): string | null => {
  if (!s || !s.includes('SSPET500')) return null;
  try { const out = JSON.stringify(mergePacks(JSON.parse(s))); return out === s ? null : out; } catch { return null; }
};

export async function mergePacksOnce(db: D1Database): Promise<void> {
  if (await one(db, `SELECT 1 AS x FROM settings WHERE key = ?`, DONE)) return;
  const stmts: D1PreparedStatement[] = [];
  for (const r of await all<{ ws: string; period: string; cd_json: string | null; dept_json: string | null; calc_json: string | null }>(db,
    `SELECT ws, period, cd_json, dept_json, calc_json FROM cycles WHERE cd_json LIKE ? OR dept_json LIKE ? OR calc_json LIKE ?`, LIKE, LIKE, LIKE)) {
    const [a, b, c] = [fix(r.cd_json), fix(r.dept_json), fix(r.calc_json)];
    if (a || b || c) stmts.push(db.prepare(`UPDATE cycles SET cd_json = COALESCE(?, cd_json), dept_json = COALESCE(?, dept_json), calc_json = COALESCE(?, calc_json) WHERE ws = ? AND period = ?`).bind(a, b, c, r.ws, r.period));
  }
  for (const r of await all<{ ws: string; kind: string; month: string; values_json: string }>(db,
    `SELECT ws, kind, month, values_json FROM data_months WHERE values_json LIKE ?`, LIKE)) {
    const a = fix(r.values_json);
    if (a) stmts.push(db.prepare(`UPDATE data_months SET values_json = ? WHERE ws = ? AND kind = ? AND month = ?`).bind(a, r.ws, r.kind, r.month));
  }
  for (const r of await all<{ id: number; packs_json: string }>(db, `SELECT id, packs_json FROM months WHERE packs_json LIKE ?`, LIKE)) {
    const a = fix(r.packs_json);
    if (a) stmts.push(db.prepare(`UPDATE months SET packs_json = ? WHERE id = ?`).bind(a, r.id));
  }
  for (const r of await all<{ month_id: number; node_id: number; baseline_json: string | null; draft_json: string | null }>(db,
    `SELECT month_id, node_id, baseline_json, draft_json FROM month_nodes WHERE baseline_json LIKE ? OR draft_json LIKE ?`, LIKE, LIKE)) {
    const [a, b] = [fix(r.baseline_json), fix(r.draft_json)];
    if (a || b) stmts.push(db.prepare(`UPDATE month_nodes SET baseline_json = COALESCE(?, baseline_json), draft_json = COALESCE(?, draft_json) WHERE month_id = ? AND node_id = ?`).bind(a, b, r.month_id, r.node_id));
  }
  for (const r of await all<{ month_id: number; leaf_id: number; values_json: string }>(db, `SELECT month_id, leaf_id, values_json FROM month_leaves WHERE values_json LIKE ?`, LIKE)) {
    const a = fix(r.values_json);
    if (a) stmts.push(db.prepare(`UPDATE month_leaves SET values_json = ? WHERE month_id = ? AND leaf_id = ?`).bind(a, r.month_id, r.leaf_id));
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  await db.prepare(`INSERT INTO settings(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(DONE).run();
}
