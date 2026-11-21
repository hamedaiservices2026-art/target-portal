// Audit trail. Every admin change writes one row to `audit`.
//
// `auditStatement` returns the prepared INSERT so a caller can put the change
// and its audit row in ONE db.batch() (one transaction: both or neither).
// `logAudit` runs it on its own for callers with nothing to batch it with.
//
// Never pass passwords, hashes or tokens in `detail`.

export type AuditIds = { monthId?: number; nodeId?: number };

export function auditStatement(
  db: D1Database,
  userId: number | null,
  action: string,
  ids: AuditIds,
  detail: unknown,
  opts: { lastInsertIdAs?: string } = {},
): D1PreparedStatement {
  const json = detail === undefined ? null : JSON.stringify(detail);
  // For creates inside a batch the new row id is unknown up front: when
  // `lastInsertIdAs` is given, the id of the row inserted by the previous
  // statement is merged into the detail object (batches run in order, in one
  // transaction, so last_insert_rowid() is that row's id).
  const detailSql = opts.lastInsertIdAs && json !== null
    ? `json_set(?, '$.${opts.lastInsertIdAs.replace(/[^A-Za-z0-9_]/g, '')}', last_insert_rowid())`
    : '?';
  return db
    .prepare(
      `INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ${detailSql})`,
    )
    .bind(new Date().toISOString(), userId, action, ids.monthId ?? null, ids.nodeId ?? null, json);
}

export async function logAudit(
  db: D1Database,
  userId: number | null,
  action: string,
  ids: AuditIds,
  detail: unknown,
): Promise<void> {
  await auditStatement(db, userId, action, ids, detail).run();
}
