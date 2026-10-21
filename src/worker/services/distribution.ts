// Distribution flow. Task 11 replaces the body of openTurn with the real
// implementation (baseline, status, notification); the callers are wired already.
import type { Env } from '../index';

/** Stub until Task 11: only marks the month node in progress. */
export async function openTurn(db: D1Database, _env: Env, monthId: number, nodeId: number): Promise<void> {
  await db
    .prepare(`UPDATE month_nodes SET status = 'in_progress' WHERE month_id = ? AND node_id = ?`)
    .bind(monthId, nodeId)
    .run();
}
