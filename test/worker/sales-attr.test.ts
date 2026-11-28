import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/worker/db';
import { attrSales } from '../../src/worker/services/salesAttr';

describe('YAGO sales of the people assigned to a channel (approval template only)', () => {
  it('returns the assigned KA and unmapped Operation codes of that month, nothing else', async () => {
    await run(env.DB, `INSERT INTO settings(key, value) VALUES ('sales_attr', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify([{ code: 'K1', src: 'ka', deptId: 7, channel: 'MT' }, { code: 'X9', src: 'ops', deptId: 7, channel: 'MT Bulk' }]));
    await run(env.DB, `INSERT INTO data_routes(ws, kind, month, route_code, values_json) VALUES
      ('ka', 'sales', '2025-12', 'K1', '{"A":5}'), ('ka', 'sales', '2025-12', 'K2', '{"A":9}'),
      ('ops', 'sales', '2025-12', 'X9', '{"B":3}'), ('ka', 'sales', '2025-11', 'K1', '{"A":1}')`);
    expect(await attrSales(env.DB, '2025-12')).toEqual([
      { deptId: 7, channel: 'MT', v: { A: 5 } }, { deptId: 7, channel: 'MT Bulk', v: { B: 3 } },
    ]);
  });
});
