import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';
import { cdFinal, cdSubmitProblems, type CdWork } from '../../src/worker/services/cycle';

type Json = Record<string, any>;

async function addUser(username: string, role: 'admin' | 'manager' = 'manager'): Promise<number> {
  const { hash, salt } = await hashPassword('password-123');
  return (await run(env.DB, `INSERT INTO users(username, name, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role)).lastRowId;
}

async function login(username: string): Promise<string> {
  const res = await SELF.fetch('http://x/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password-123' }),
  });
  expect(res.status).toBe(200);
  return /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

function api(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`http://x/api${path}`, {
    method, headers: { 'content-type': 'application/json', cookie: `sid=${cookie}` }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

const P = '2026-10';

describe('target cycle (handover flow)', () => {
  let admin: string;
  let cd: string;
  let head: string;
  let other: string;
  let tt: number;
  let mt: number;
  let headId: number;

  beforeEach(async () => {
    for (const t of ['notifications', 'head_approvals', 'cycles', 'data_months', 'data_routes', 'user_roles', 'dept_channels', 'audit',
      'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months', 'leaves', 'nodes', 'departments', 'packs', 'sessions', 'login_failures', 'users']) {
      await run(env.DB, `DELETE FROM ${t}`);
    }
    await addUser('admin', 'admin');
    const cdId = await addUser('cd');
    headId = await addUser('head');
    await addUser('other');
    await run(env.DB, `INSERT INTO user_roles(user_id, role, workspace) VALUES (?, 'cd', 'ops')`, cdId);
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES ('CSD_CANS150', 'CSD', 1, 1), ('AquafinA_330', 'Water', 1, 2)`);
    tt = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('TT', 'TT', 'ops')`)).lastRowId;
    mt = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('MT', 'MT', 'ops')`)).lastRowId;
    const root = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name, manager_user_id) VALUES (?, NULL, 'TT Head', ?)`, tt, headId)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'TT DMM', 'R1', ?, 'R1'), (?, 'TT DMM', 'R2', ?, 'R2')`, tt, root, tt, root);
    const mroot = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'MT Head')`, mt)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'MT', 'M1', ?, 'M1')`, mt, mroot);
    admin = await login('admin');
    cd = await login('cd');
    head = await login('head');
    other = await login('other');
  });

  it('stores data, runs the CD step, calculates, sends and approves', async () => {
    // Step 5: sales by month.
    let r = await api('POST', '/admin/data/ops/routes', admin, {
      kind: 'sales', rows: [
        { month: '2026-09', routeCode: 'R1', values: { CSD_CANS150: 60, AquafinA_330: 10 } },
        { month: '2026-09', routeCode: 'R2', values: { CSD_CANS150: 40 } },
        { month: '2026-09', routeCode: 'M1', values: { CSD_CANS150: 100, AquafinA_330: 30 } },
      ],
    });
    expect(r.status).toBe(200);
    r = await api('GET', '/data/ops/routes?kind=sales&month=2026-09', cd);
    expect((await json(r)).length).toBe(3);
    expect((await api('GET', '/data/ops/routes?kind=sales&month=2026-09', other)).status).toBe(403);

    // Step 1 and send to the CD.
    expect((await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, { cdStep: true })).status).toBe(200);
    expect((await api('POST', `/admin/cycle/ops/${P}/cd/send`, admin, { nt: { CSD_CANS150: 1000, AquafinA_330: 101 } })).status).toBe(200);
    const notes = await json(await api('GET', '/my/notifications', cd));
    expect(notes.unread).toBe(1);

    // CD: approve, split, set column J, submit.
    let cyc = await json(await api('GET', `/cycle/ops/${P}`, cd));
    expect(cyc.cdStatus).toBe('with_cd');
    const work: CdWork = {
      nt: { CSD_CANS150: 1000, AquafinA_330: 101 }, ntOk: true, splitNt: { CSD_CANS150: 1000, AquafinA_330: 101 }, basis: {},
      dm: { [tt]: { 'TT DMM': { CSD_CANS150: 500, AquafinA_330: 25 } }, [mt]: { MT: { CSD_CANS150: 500, AquafinA_330: 76 } } },
      gm: {}, colJ: { [tt]: { CSD: 520, Water: 25 }, [mt]: { CSD: 480, Water: 76 } },
    };
    expect((await api('PUT', `/cycle/ops/${P}/cd`, admin, { cd: work, version: cyc.version })).status).toBe(403);
    r = await api('PUT', `/cycle/ops/${P}/cd`, cd, { cd: work, version: cyc.version });
    expect(r.status).toBe(200);
    r = await api('POST', `/cycle/ops/${P}/cd/submit`, cd);
    expect(r.status).toBe(200);
    const dept = (await json(r)).dept;
    expect(dept[tt]).toEqual({ CSD_CANS150: 520, AquafinA_330: 25 });
    expect(dept[mt]).toEqual({ CSD_CANS150: 480, AquafinA_330: 76 });

    // Admin: apply a calculation that is over the department target -> refused
    // (under is allowed: Admin's edits may leave cases unassigned); then a right one.
    r = await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 330, AquafinA_330: 25 }, R2: { CSD_CANS150: 200 } } } });
    expect(r.status).toBe(400);
    r = await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 312, AquafinA_330: 25 }, R2: { CSD_CANS150: 208 } } } });
    expect(r.status).toBe(200);

    // Send to the Head: opens the month and loads the routes.
    r = await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin);
    expect(r.status).toBe(200);
    const monthId = (await json(r)).monthId;
    const leaves = await all<{ route_code: string; values_json: string }>(env.DB, `SELECT route_code, values_json FROM month_leaves WHERE month_id = ? AND dept_id = ? ORDER BY route_code`, monthId, tt);
    expect(leaves.map((l) => [l.route_code, JSON.parse(l.values_json)])).toEqual([
      ['R1', { CSD_CANS150: 312, AquafinA_330: 25 }], ['R2', { CSD_CANS150: 208, AquafinA_330: 0 }],
    ]);
    const approvals = await json(await api('GET', '/my/approvals', head));
    expect(approvals.approvals[0]).toMatchObject({ status: 'pending', sentTotal: 545 });

    // Only the Head approves; approval starts the department.
    expect((await api('POST', `/cycle/ops/${P}/heads/${tt}/approve`, other)).status).toBe(403);
    // Sending opens the Head's distribution turn at once (review and distribute before approving).
    const st0 = await one<{ state: string }>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, monthId, tt);
    expect(st0!.state).toBe('running');
    expect((await api('POST', `/cycle/ops/${P}/heads/${tt}/approve`, head)).status).toBe(200);
    const st = await one<{ state: string }>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, monthId, tt);
    expect(['running', 'complete']).toContain(st!.state);
    cyc = await json(await api('GET', `/cycle/ops/${P}`, admin));
    expect(cyc.heads.find((x: Json) => x.deptId === tt).status).toBe('approved');

    // Restart sends the channel back to draft.
    expect((await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/restart`, admin)).status).toBe(200);
    const st2 = await one<{ state: string }>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, monthId, tt);
    expect(st2!.state).toBe('loading');
  });

  it('a Head can return the target with a comment', async () => {
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, { cdStep: false });
    // Operation always goes to the CD: the CD step stays on.
    expect((await json(await api('GET', `/cycle/ops/${P}`, admin))).settings.cdStep).toBe(true);
    await run(env.DB, `UPDATE cycles SET cd_status = 'submitted', dept_json = ? WHERE ws = 'ops' AND period = ?`, JSON.stringify({ [tt]: { CSD_CANS150: 10 } }), P);
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 10 } } } })).status).toBe(200);
    expect((await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin)).status).toBe(200);
    expect((await api('POST', `/cycle/ops/${P}/heads/${tt}/return`, head, {})).status).toBe(400);
    expect((await api('POST', `/cycle/ops/${P}/heads/${tt}/return`, head, { comment: 'too high' })).status).toBe(200);
    const h = await one<{ status: string; comment: string }>(env.DB, `SELECT status, comment FROM head_approvals WHERE dept_id = ?`, tt);
    expect(h).toEqual({ status: 'returned', comment: 'too high' });
    // Re-send after a return is allowed.
    expect((await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin)).status).toBe(200);
  });

  it('sending an Operation Head also sends the linked Key Account department', async () => {
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, {});
    await run(env.DB, `UPDATE cycles SET cd_status = 'submitted', dept_json = ? WHERE ws = 'ops' AND period = ?`, JSON.stringify({ [tt]: { CSD_CANS150: 10 } }), P);
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 10 } } } })).status).toBe(200);
    const ka = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('KA_TT', 'KA TT', 'ka')`)).lastRowId;
    const kroot = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'KA Head')`, ka)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'KA', 'K1', ?, 'K1')`, ka, kroot);
    expect((await api('PUT', `/admin/ka-links/${ka}`, admin, { opsDeptId: tt })).status).toBe(200);
    await api('PUT', `/admin/cycle/ka/${P}/settings`, admin, {});
    await run(env.DB, `UPDATE cycles SET dept_json = ? WHERE ws = 'ka' AND period = ?`, JSON.stringify({ [ka]: { CSD_CANS150: 7 } }), P);
    expect((await api('PUT', `/admin/cycle/ka/${P}/calc`, admin, { calc: { [ka]: { K1: { CSD_CANS150: 7 } } } })).status).toBe(200);
    const r = await json(await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin));
    expect(r.ka).toEqual([{ deptId: ka, name: 'KA TT', sent: true }]);
    const hs = await all<{ dept_id: number; status: string }>(env.DB, `SELECT dept_id, status FROM head_approvals ORDER BY dept_id`);
    expect(hs).toEqual([{ dept_id: tt, status: 'pending' }, { dept_id: ka, status: 'pending' }]);
    // The Operation Head is the Key Account Head: both targets wait for the same person.
    const ap = await json(await api('GET', '/my/approvals', head));
    expect(ap.approvals.length).toBe(2);
  });

  it('a Key Account department made after the month opened is sent; approving Operation also approves it and the KAM gets the turn', async () => {
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, {});
    await run(env.DB, `UPDATE cycles SET cd_status = 'submitted', dept_json = ? WHERE ws = 'ops' AND period = ?`, JSON.stringify({ [tt]: { CSD_CANS150: 10 }, [mt]: { CSD_CANS150: 5 } }), P);
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 10 } } } })).status).toBe(200);
    // The month opens with the first send (MT has no Head account: refused with the reason).
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [mt]: { M1: { CSD_CANS150: 5 } } } })).status).toBe(200);
    expect((await json(await api('POST', `/admin/cycle/ops/${P}/heads/${mt}/send`, admin))).detail).toMatch(/MT Head has no account/);
    expect(await one(env.DB, `SELECT COUNT(*) AS n FROM months`)).toEqual({ n: 1 });
    // A Key Account department uploaded after the month opened, ending at the KAM (routes under the KAM).
    await addUser('kam1');
    await run(env.DB, `UPDATE users SET name = 'Kam One' WHERE username = 'kam1'`);
    const ka = (await run(env.DB, `INSERT INTO departments(code, name, workspace) VALUES ('KA_TT', 'KA TT', 'ka')`)).lastRowId;
    const kroot = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, NULL, 'KA Head')`, ka)).lastRowId;
    const kam = (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name) VALUES (?, ?, 'Kam One')`, ka, kroot)).lastRowId;
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'KA', 'K1', ?, 'Kae One')`, ka, kam);
    await run(env.DB, `UPDATE departments SET ops_dept_id = ? WHERE id = ?`, tt, ka);
    await api('PUT', `/admin/cycle/ka/${P}/settings`, admin, {});
    await run(env.DB, `UPDATE cycles SET dept_json = ? WHERE ws = 'ka' AND period = ?`, JSON.stringify({ [ka]: { CSD_CANS150: 7 } }), P);
    expect((await api('PUT', `/admin/cycle/ka/${P}/calc`, admin, { calc: { [ka]: { K1: { CSD_CANS150: 7 } } } })).status).toBe(200);
    const r = await json(await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin));
    expect(r.ka).toEqual([{ deptId: ka, name: 'KA TT', sent: true }]);
    // The KA Head is the Operation Head; the KAM got the account of the same name.
    expect(await one(env.DB, `SELECT manager_user_id AS u FROM nodes WHERE id = ?`, kroot)).toEqual({ u: headId });
    const ap = await json(await api('POST', `/cycle/ops/${P}/heads/${tt}/approve`, head));
    expect(ap.ka).toEqual([{ deptId: ka, name: 'KA TT', approved: true }]);
    const kamNode = await one<{ status: string; u: number | null }>(env.DB, `SELECT status, manager_user_id AS u FROM month_nodes WHERE node_id = ?`, kam);
    expect(kamNode?.status).toBe('in_progress');
    expect(kamNode?.u).not.toBeNull();
  });

  it('every AOP option goes to the CD; data can be cleared before an upload', async () => {
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, { ntMode: 'aop', aopBy: 'dept' });
    expect((await json(await api('GET', `/cycle/ops/${P}`, admin))).settings.cdStep).toBe(true);
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, { aopBy: 'pack' });
    expect((await json(await api('GET', `/cycle/ops/${P}`, admin))).settings.cdStep).toBe(true);
    for (const m of ['2027-01', '2027-02']) {
      expect((await api('POST', '/admin/data/ops/months', admin, { kind: 'aop_dept', month: m, values: { MT: { CSD_CANS150: 5 } } })).status).toBe(200);
    }
    expect(await json(await api('POST', '/admin/data/ops/clear-all', admin, { table: 'months', kind: 'aop_dept' }))).toEqual({ removed: 2 });
    expect(await json(await api('GET', '/data/ops/months?kind=aop_dept', admin))).toEqual({});
    expect((await api('POST', '/admin/data/ops/clear-all', other, { table: 'months', kind: 'aop_dept' })).status).toBe(403);
  });

  it('a target uploaded by department skips the Commercial Director', async () => {
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, { ntMode: 'dept' });
    const cyc = await json(await api('GET', `/cycle/ops/${P}`, admin));
    expect(cyc.settings.cdStep).toBe(false);
    expect((await api('PUT', `/admin/cycle/ops/${P}/dept-target`, admin, { dept: { [tt]: { CSD_CANS150: 10 } } })).status).toBe(200);
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 10 } } } })).status).toBe(200);
    expect((await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin)).status).toBe(200);
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, { ntMode: 'pack' });
    expect((await json(await api('GET', `/cycle/ops/${P}`, admin))).settings.cdStep).toBe(true);
  });

  it('a pack turned on after the month was opened is added to the month when sending', async () => {
    await api('PUT', `/admin/cycle/ops/${P}/settings`, admin, {});
    await run(env.DB, `UPDATE cycles SET cd_status = 'submitted', dept_json = ? WHERE ws = 'ops' AND period = ?`, JSON.stringify({ [tt]: { CSD_CANS150: 10, LIT_CANS320: 4, NOPE: 1 } }), P);
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 10 } } } })).status).toBe(200);
    expect((await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin)).status).toBe(200);
    expect((await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/restart`, admin)).status).toBe(200);
    await run(env.DB, `INSERT INTO packs(code, grp, active) VALUES ('LIT_CANS320', 'LRB-Others', 1)`);
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { CSD_CANS150: 10, LIT_CANS320: 4 } } } })).status).toBe(200);
    const r = await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin);
    expect(r.status, await r.clone().text()).toBe(200);
    const m = await one<{ packs_json: string }>(env.DB, `SELECT packs_json FROM months WHERE period = ?`, P);
    expect(m!.packs_json).toContain('LIT_CANS320');
    // A pack that is not in the pack list at all is named in the error.
    expect((await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/restart`, admin)).status).toBe(200);
    expect((await api('PUT', `/admin/cycle/ops/${P}/calc`, admin, { calc: { [tt]: { R1: { NOPE: 1 } } } })).status).toBe(200);
    expect((await json(await api('POST', `/admin/cycle/ops/${P}/heads/${tt}/send`, admin))).detail).toMatch(/NOPE is not in the pack list/);
  });

  it('rules settings are admin only and validated', async () => {
    expect((await api('GET', '/admin/rules', other)).status).toBe(403);
    const r = await api('PUT', '/admin/rules', admin, { caps: { head: 3, manager: 4, supervisor: 5 }, rule2: true, rule3: false, exceptions: [{ name: 'R1', pct: 10 }] });
    expect(r.status).toBe(200);
    expect((await json(await api('GET', '/admin/rules', admin))).caps.head).toBe(3);
  });

  it('first login with a new account must change the password', async () => {
    await run(env.DB, `UPDATE users SET must_change_pw = 1 WHERE username = 'other'`);
    expect((await api('GET', '/my/tasks', other)).status).toBe(403);
    expect((await json(await api('GET', '/me', other))).user.mustChangePw).toBe(true);
    expect((await api('POST', '/me/password', other, { password: 'a-new-password' })).status).toBe(200);
    expect((await api('GET', '/my/tasks', other)).status).toBe(200);
  });
});

describe('CD submit check and final fit', () => {
  const cats = new Map([['A', 'CSD'], ['B', 'CSD'], ['W', 'Water']]);
  const base: CdWork = {
    nt: { A: 100, B: 50, W: 30 }, ntOk: true, splitNt: { A: 100, B: 50, W: 30 }, basis: {}, gm: {},
    dm: { '1': { _: { A: 60, B: 20, W: 10 } }, '2': { _: { A: 40, B: 30, W: 20 } } },
    colJ: { '1': { CSD: 90, Water: 12 }, '2': { CSD: 60, Water: 18 } },
  };
  it('passes when everything adds up, and lists the reasons otherwise', () => {
    expect(cdSubmitProblems(base, cats, ['1', '2'])).toEqual([]);
    const bad = { ...base, ntOk: false, nt: { ...base.nt, A: 101 }, colJ: { '1': { CSD: 90, Water: 12 }, '2': { CSD: 61, Water: 18 } } };
    const p = cdSubmitProblems(bad, cats, ['1', '2']);
    expect(p.join('|')).toMatch(/not approved/);
    expect(p.join('|')).toMatch(/stale/);
    expect(p.join('|')).toMatch(/1 packs in Target by department/);
  });
  it('rows = New Target per pack, columns = column J', () => {
    const f = cdFinal(base, cats, ['1', '2']);
    expect(f['1']!.A! + f['2']!.A!).toBe(100);
    expect(f['1']!.A! + f['1']!.B!).toBe(90);
    expect(f['1']!.W).toBe(12);
  });
});
