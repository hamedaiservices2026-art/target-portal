import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, batch, insertJson, MAX_STATEMENTS_PER_BATCH, one, run } from '../../src/worker/db';

const TABLES = [
  'users', 'sessions', 'departments', 'packs', 'settings', 'nodes', 'leaves', 'months',
  'month_files', 'month_depts', 'month_nodes', 'month_leaves', 'audit', 'email_log',
];

async function seedMonth() {
  await run(env.DB, `INSERT INTO users(username, name, pw_hash, pw_salt, role) VALUES ('up','Up','h','s','admin')`);
  await run(env.DB, `INSERT INTO departments(code, name) VALUES ('D1', 'Dept 1')`);
  await run(env.DB, `INSERT INTO months(period, packs_json, created_at) VALUES ('2026-11', '[]', '2026-10-19T00:00:00Z')`);
  const dept = await one<{ id: number }>(env.DB, `SELECT id FROM departments WHERE code = 'D1'`);
  const month = await one<{ id: number }>(env.DB, `SELECT id FROM months WHERE period = '2026-11'`);
  const user = await one<{ id: number }>(env.DB, `SELECT id FROM users WHERE username = 'up'`);
  return { deptId: dept!.id, monthId: month!.id, userId: user!.id };
}

beforeEach(async () => {
  // Tests share one database per file: wipe everything except the seeded settings.
  for (const t of ['month_leaves', 'month_nodes', 'month_depts', 'month_files', 'audit', 'email_log',
    'sessions', 'leaves', 'nodes', 'months', 'users', 'departments', 'packs']) {
    await run(env.DB, `DELETE FROM ${t}`);
  }
});

describe('migration 0001_init', () => {
  it('creates every table', async () => {
    const rows = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table'`);
    const names = rows.map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it("seeds settings.cap_pct = '5'", async () => {
    const row = await one<{ value: string }>(env.DB, `SELECT value FROM settings WHERE key = 'cap_pct'`);
    expect(row?.value).toBe('5');
  });

  it('enforces CHECK constraints', async () => {
    await expect(run(env.DB,
      `INSERT INTO users(username, name, email, pw_hash, pw_salt, role) VALUES ('a','A','a@x','h','s','boss')`,
    )).rejects.toThrow();
    await expect(run(env.DB,
      `INSERT INTO users(username, name, email, pw_hash, pw_salt, role, lang) VALUES ('a','A','a@x','h','s','admin','fr')`,
    )).rejects.toThrow();
    await expect(run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('P1', 'Juice', 1, 1)`)).rejects.toThrow();
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('P1', 'CSD', 1, 1)`);
    const { deptId, monthId } = await seedMonth();
    await expect(run(env.DB,
      `INSERT INTO month_depts(month_id, dept_id, state) VALUES (?, ?, 'weird')`, monthId, deptId,
    )).rejects.toThrow();
  });

  it('applies defaults (lang en, active 1)', async () => {
    await run(env.DB, `INSERT INTO users(username, name, email, pw_hash, pw_salt, role) VALUES ('m','M','m@x','h','s','manager')`);
    const u = await one<{ lang: string; active: number }>(env.DB, `SELECT lang, active FROM users WHERE username = 'm'`);
    expect(u).toEqual({ lang: 'en', active: 1 });
  });

  it('keeps leaf identity unique on delivery_system + route_code', async () => {
    const { deptId } = await seedMonth();
    await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'root')`, deptId);
    const node = await one<{ id: number }>(env.DB, `SELECT id FROM nodes WHERE name = 'root'`);
    const ins = `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'DS1', 'R1', ?, 'x')`;
    await run(env.DB, ins, deptId, node!.id);
    await expect(run(env.DB, ins, deptId, node!.id)).rejects.toThrow();
  });
});

describe('db helpers', () => {
  it('one returns null when there is no row, all returns []', async () => {
    expect(await one(env.DB, `SELECT * FROM users`)).toBeNull();
    expect(await all(env.DB, `SELECT * FROM users`)).toEqual([]);
  });

  it('run reports changes', async () => {
    const res = await run(env.DB, `INSERT INTO departments(code, name) VALUES ('X', 'x')`);
    expect(res.changes).toBe(1);
  });

  it('batch chunks into groups of at most MAX_STATEMENTS_PER_BATCH', async () => {
    expect(MAX_STATEMENTS_PER_BATCH).toBe(50);
    const sizes: number[] = [];
    const spy = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: (stmts: D1PreparedStatement[]) => { sizes.push(stmts.length); return env.DB.batch(stmts); },
    } as unknown as D1Database;
    const stmts = Array.from({ length: 120 }, (_, i) =>
      env.DB.prepare(`INSERT INTO departments(code, name) VALUES (?, ?)`).bind(`C${i}`, `n${i}`));
    await batch(spy, stmts);
    expect(sizes).toEqual([50, 50, 20]);
    const n = await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM departments`);
    expect(n!.n).toBe(120);
  });

  it('batch with no statements is a no-op', async () => {
    await batch(env.DB, []);
  });
});

describe('insertJson (json_each bulk insert)', () => {
  it('inserts 200 month_leaves rows in one statement and reads them back', async () => {
    const { deptId, monthId, userId } = await seedMonth();
    await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'root')`, deptId);
    const node = await one<{ id: number }>(env.DB, `SELECT id FROM nodes WHERE name = 'root'`);
    await run(env.DB, `INSERT INTO month_files(month_id, dept_id, name, uploaded_by, uploaded_at) VALUES (?, ?, 'f.xlsx', ?, '2026-10-19T00:00:00Z')`, monthId, deptId, userId);
    const file = await one<{ id: number }>(env.DB, `SELECT id FROM month_files`);

    const rows = Array.from({ length: 200 }, (_, i) => ({
      month_id: monthId,
      leaf_id: i + 1,
      node_id: node!.id,
      dept_id: deptId,
      file_id: file!.id,
      delivery_system: 'DS',
      route_code: `R${i}`,
      salesman_id: `S${i}`,
      values_json: JSON.stringify([i, i + 1, i + 2]),
    }));
    const prepared: string[] = [];
    const spy = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => { prepared.push(sql); return target.prepare(sql); };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await insertJson(spy, 'month_leaves', Object.keys(rows[0]!), rows);
    expect(prepared).toHaveLength(1);

    const back = await all<{ leaf_id: number; route_code: string; values_json: string }>(
      env.DB, `SELECT leaf_id, route_code, values_json FROM month_leaves WHERE month_id = ? ORDER BY leaf_id`, monthId);
    expect(back).toHaveLength(200);
    expect(back[199]).toEqual({ leaf_id: 200, route_code: 'R199', values_json: '[199,200,201]' });
    expect(JSON.parse(back[7]!.values_json)).toEqual([7, 8, 9]);
  });

  it('supports an onConflict clause (upsert)', async () => {
    await insertJson(env.DB, 'departments', ['code', 'name'], [{ code: 'A', name: 'one' }]);
    await insertJson(env.DB, 'departments', ['code', 'name'], [{ code: 'A', name: 'two' }],
      { onConflict: 'ON CONFLICT(code) DO UPDATE SET name = excluded.name' });
    const row = await one<{ name: string }>(env.DB, `SELECT name FROM departments WHERE code = 'A'`);
    expect(row?.name).toBe('two');
  });

  it('stores null values as NULL', async () => {
    await insertJson(env.DB, 'nodes', ['dept_id', 'parent_id', 'name'], []);
    await run(env.DB, `INSERT INTO departments(code, name) VALUES ('D', 'd')`);
    const d = await one<{ id: number }>(env.DB, `SELECT id FROM departments`);
    await insertJson(env.DB, 'nodes', ['dept_id', 'parent_id', 'name'], [{ dept_id: d!.id, parent_id: null, name: 'r' }]);
    const n = await one<{ parent_id: number | null }>(env.DB, `SELECT parent_id FROM nodes WHERE name = 'r'`);
    expect(n?.parent_id).toBeNull();
  });

  it('rejects unsafe identifiers', async () => {
    await expect(insertJson(env.DB, 'users; DROP TABLE users', ['a'], [{ a: 1 }])).rejects.toThrow(/identifier/);
    await expect(insertJson(env.DB, 'users', ['a b'], [{ 'a b': 1 }])).rejects.toThrow(/identifier/);
  });
});
