// Thin typed helpers over D1. All SQL stays in the callers; these only bind,
// run and chunk.

/**
 * D1 Free allows 50 queries per Worker invocation, and every statement inside
 * db.batch() counts (docs/decisions.md). One db.batch() call therefore never
 * carries more than this many statements.
 */
export const MAX_STATEMENTS_PER_BATCH = 50;

/** D1 allows at most 100 bound parameters per statement (docs/decisions.md). */
export const MAX_BOUND_PARAMS = 100;

export type Bindable = string | number | boolean | null | ArrayBuffer;

function bind(db: D1Database, sql: string, args: Bindable[]): D1PreparedStatement {
  const stmt = db.prepare(sql);
  return args.length ? stmt.bind(...args) : stmt;
}

/** First row, or null when the query returns none. */
export async function one<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...args: Bindable[]
): Promise<T | null> {
  return bind(db, sql, args).first<T>();
}

/** All rows. */
export async function all<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...args: Bindable[]
): Promise<T[]> {
  const res = await bind(db, sql, args).all<T>();
  return res.results;
}

/** Execute a write. */
export async function run(
  db: D1Database,
  sql: string,
  ...args: Bindable[]
): Promise<{ changes: number; lastRowId: number }> {
  const res = await bind(db, sql, args).run();
  return { changes: res.meta.changes ?? 0, lastRowId: res.meta.last_row_id ?? 0 };
}

/**
 * Run prepared statements, at most MAX_STATEMENTS_PER_BATCH per db.batch().
 * Each chunk is atomic; the whole list is NOT (a later chunk can fail after an
 * earlier one committed). Callers needing all-or-nothing must stay within one
 * chunk, or use insertJson (a single statement).
 */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  const out: D1Result[] = [];
  for (let i = 0; i < stmts.length; i += MAX_STATEMENTS_PER_BATCH) {
    out.push(...(await db.batch(stmts.slice(i, i + MAX_STATEMENTS_PER_BATCH))));
  }
  return out;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`insertJson: unsafe identifier "${name}"`);
  return name;
}

/**
 * Bulk insert as ONE statement with ONE bound parameter:
 *   INSERT INTO t (a, b) SELECT json_extract(value,'$.a'), json_extract(value,'$.b')
 *   FROM json_each(?) WHERE true [onConflict]
 * Keeps a 200-row batch to a single query (50-queries cap) and one bound
 * parameter (100-params cap). Keep batches to <= 200 rows.
 *
 * Column values may be string, number, boolean (stored 1/0) or null. A JSON
 * string stays a string, so pass `values_json`-style columns already
 * stringified. `table` and `columns` are interpolated into SQL, so they are
 * validated as plain identifiers. `onConflict` is trusted SQL appended after
 * the SELECT, e.g. "ON CONFLICT(code) DO UPDATE SET name = excluded.name".
 */
export async function insertJson(
  db: D1Database,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  opts: { onConflict?: string } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const t = ident(table);
  const cols = columns.map(ident);
  const select = cols.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  // "WHERE true" avoids SQLite's INSERT..SELECT / ON CONFLICT parse ambiguity.
  const sql =
    `INSERT INTO ${t} (${cols.join(', ')}) SELECT ${select} FROM json_each(?) WHERE true` +
    (opts.onConflict ? ` ${opts.onConflict}` : '');
  const projected = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  await db.prepare(sql).bind(JSON.stringify(projected)).run();
}
