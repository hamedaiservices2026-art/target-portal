import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { one, run } from '../../src/worker/db';
import { mergePacks, mergePacksOnce } from '../../src/worker/services/packMerge';

describe('CSD_SSPET500 and the combined row are merged into CSD_SSPET400', () => {
  it('renames keys and strings, adds the cases, keeps one entry', () => {
    expect(mergePacks({ CSD_SSPET400: 5, CSD_SSPET500: 7, 'CSD_SSPET500/400': 1, X: 2 })).toEqual({ CSD_SSPET400: 13, X: 2 });
    expect(mergePacks({ a: { CSD_SSPET500: { cases: 3, nr: 1 } }, b: { CSD_SSPET400: { cases: 2, nr: null }, CSD_SSPET500: { cases: 3, nr: 1 } } }))
      .toEqual({ a: { CSD_SSPET400: { cases: 3, nr: 1 } }, b: { CSD_SSPET400: { cases: 5, nr: 1 } } });
    expect(mergePacks({ layout: [{ p: 'CSD_SSPET500/400' }, { p: 'CSD_SSPET400' }, { t: 'Total SSNR', of: ['CSD_SSPET500', 'CSD_SSPET400', 'CSD_NRB'] }] }))
      .toEqual({ layout: [{ p: 'CSD_SSPET400' }, { t: 'Total SSNR', of: ['CSD_SSPET400', 'CSD_NRB'] }] });
  });

  it('merges the stored month files and cycles once', async () => {
    await run(env.DB, `INSERT INTO data_months(ws, kind, month, values_json, uploaded_at) VALUES ('ops', 'new_target', '2040-01', ?, 'x')`,
      JSON.stringify({ mode: 'pack', byPack: { CSD_SSPET500: 10, CSD_SSPET400: 1 } }));
    await run(env.DB, `INSERT INTO cycles(ws, period, settings_json, cd_status, cd_json, version, updated_at) VALUES ('ops', '2040-01', '{}', 'submitted', ?, 1, 'x')`,
      JSON.stringify({ nt: { CSD_SSPET500: 4 } }));
    await mergePacksOnce(env.DB);
    const d = await one<{ v: string }>(env.DB, `SELECT values_json AS v FROM data_months WHERE month = '2040-01'`);
    expect(JSON.parse(d!.v).byPack).toEqual({ CSD_SSPET400: 11 });
    const c = await one<{ v: string }>(env.DB, `SELECT cd_json AS v FROM cycles WHERE period = '2040-01'`);
    expect(JSON.parse(c!.v).nt).toEqual({ CSD_SSPET400: 4 });
  });
});
