import { createExecutionContext, env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { capFor } from '../../src/shared/rules';
import { hashPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';
import app from '../../src/worker/index';
import { childTotals, openTurn, saveDraft, submitNode } from '../../src/worker/services/distribution';

type Json = Record<string, any>;
type Grid = Record<string, number>;

// ---------- fixture helpers ----------

const PET = 'CSD_PET1000';
const CAN = 'CSD_CAN330';
const WATER = 'WATER_600';
const JUICE = 'LRB_JUICE';
const PACKS: [string, string][] = [[PET, 'CSD'], [CAN, 'CSD'], [WATER, 'Water'], [JUICE, 'LRB-Others']];

async function addUser(username: string, role: 'admin' | 'manager' = 'manager'): Promise<number> {
  const { hash, salt } = await hashPassword('password-123');
  return (await run(env.DB, `INSERT INTO users(username, name, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?)`,
    username, `Name ${username}`, hash, salt, role)).lastRowId;
}

async function login(username: string): Promise<string> {
  const res = await SELF.fetch('http://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password-123' }),
  });
  expect(res.status).toBe(200);
  return /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

function api(method: string, path: string, cookie: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `sid=${cookie}`;
  return SELF.fetch(`http://x/api${path}`, {
    method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

async function mkDept(code: string): Promise<number> {
  return (await run(env.DB, `INSERT INTO departments(code, name) VALUES (?, ?)`, code, code)).lastRowId;
}
async function mkNode(dept: number, name: string, parent: number | null, mgr: number | null = null): Promise<number> {
  return (await run(env.DB, `INSERT INTO nodes(dept_id, parent_id, name, manager_user_id) VALUES (?, ?, ?, ?)`, dept, parent, name, mgr)).lastRowId;
}
async function mkLeaf(dept: number, node: number, route: string): Promise<number> {
  return (await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label) VALUES (?, 'DS', ?, ?, ?)`, dept, route, node, route)).lastRowId;
}

/** Uploads one file for the department (≤ 200 grids per batch) and starts it. */
async function loadAndStart(admin: string, month: number, dept: number, grids: { leafId: number; salesmanId: string; values: Grid }[]): Promise<void> {
  const f = await api('POST', `/admin/months/${month}/files`, admin, { deptId: dept, name: 'forecast' });
  expect(f.status).toBe(201);
  const fileId = (await json(f)).fileId;
  for (let i = 0; i < grids.length; i += 200) {
    const res = await api('POST', `/admin/months/${month}/files/${fileId}/batch`, admin,
      { grids: grids.slice(i, i + 200).map((g) => ({ ...g, deliverySystem: 'DS', routeCode: 'x' })) });
    expect(res.status).toBe(200);
  }
  const s = await api('POST', `/admin/months/${month}/depts/${dept}/start`, admin);
  expect(s.status).toBe(200);
}

/** Σ over every leaf of the department, per pack, straight from the database. */
async function grandTotals(month: number, dept: number): Promise<Grid> {
  const rows = await all<{ values_json: string }>(env.DB, `SELECT values_json FROM month_leaves WHERE month_id = ? AND dept_id = ?`, month, dept);
  const out: Grid = {};
  for (const r of rows) for (const [k, v] of Object.entries(JSON.parse(r.values_json) as Grid)) out[k] = (out[k] ?? 0) + v;
  return out;
}
async function leafGrid(month: number, leaf: number): Promise<Grid> {
  return JSON.parse((await one<{ values_json: string }>(env.DB, `SELECT values_json FROM month_leaves WHERE month_id = ? AND leaf_id = ?`, month, leaf))!.values_json);
}
async function nodeRow(month: number, node: number): Promise<Json> {
  return (await one<Json>(env.DB, `SELECT * FROM month_nodes WHERE month_id = ? AND node_id = ?`, month, node))!;
}
async function deptState(month: number, dept: number): Promise<string> {
  return (await one<{ state: string }>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, month, dept))!.state;
}

const getWs = (cookie: string, month: number, node: number) => api('GET', `/months/${month}/nodes/${node}`, cookie);
const putDraft = (cookie: string, month: number, node: number, values: Json, version: number) =>
  api('PUT', `/months/${month}/nodes/${node}/draft`, cookie, { values, version });
const submit = (cookie: string, month: number, node: number, version: number) =>
  api('POST', `/months/${month}/nodes/${node}/submit`, cookie, { version });

/** The workspace's current values as a draft body. */
const valuesOf = (ws: Json): Record<string, Grid> => Object.fromEntries(ws.children.map((c: Json) => [c.key, { ...c.values }]));

// ---------- the owner's fixture ----------
// TT: Head -> Area -> Sup A [r1 700, r2 300], Sup B [r3 600, r4 400] for CSD_PET1000; plus 3 more packs.

let admin: string;
let headS: string; let areaS: string; let supAS: string; let supBS: string;
let headU: number; let areaU: number; let supAU: number; let supBU: number;
let tt: number; let month: number;
let head: number; let area: number; let supA: number; let supB: number;
let r1: number; let r2: number; let r3: number; let r4: number;
let start: Grid;

const VALUES: Record<string, Grid> = {
  r1: { [PET]: 700, [CAN]: 120, [WATER]: 40, [JUICE]: 0 },
  r2: { [PET]: 300, [CAN]: 80, [WATER]: 60, [JUICE]: 0 },
  r3: { [PET]: 600, [CAN]: 200, [WATER]: 10, [JUICE]: 5 },
  r4: { [PET]: 400, [CAN]: 100, [WATER]: 90, [JUICE]: 7 },
};

beforeEach(async () => {
  for (const t of ['audit', 'month_leaves', 'month_files', 'month_nodes', 'month_depts', 'months', 'leaves', 'nodes',
    'sessions', 'login_failures', 'packs', 'departments', 'users']) {
    await run(env.DB, `DELETE FROM ${t}`);
  }
  await run(env.DB, `UPDATE settings SET value = '5' WHERE key = 'cap_pct'`);
  await addUser('boss', 'admin');
  headU = await addUser('head');
  areaU = await addUser('area');
  supAU = await addUser('supa');
  supBU = await addUser('supb');
  [admin, headS, areaS, supAS, supBS] = (await Promise.all(['boss', 'head', 'area', 'supa', 'supb'].map(login))) as [string, string, string, string, string];
  for (const [i, [code, grp]] of PACKS.entries()) {
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES (?, ?, 1, ?)`, code, grp, i);
  }
  tt = await mkDept('TT');
  head = await mkNode(tt, 'Head', null, headU);
  area = await mkNode(tt, 'Area', head, areaU);
  supA = await mkNode(tt, 'Sup A', area, supAU);
  supB = await mkNode(tt, 'Sup B', area, supBU);
  r1 = await mkLeaf(tt, supA, 'R1');
  r2 = await mkLeaf(tt, supA, 'R2');
  r3 = await mkLeaf(tt, supB, 'R3');
  r4 = await mkLeaf(tt, supB, 'R4');
  const res = await api('POST', '/admin/months', admin, { period: '2026-10', deadline: '2026-10-25' });
  expect(res.status).toBe(201);
  month = (await json(res)).month.id;
  await loadAndStart(admin, month, tt, [
    { leafId: r1, salesmanId: 'S1', values: VALUES.r1! },
    { leafId: r2, salesmanId: 'S2', values: VALUES.r2! },
    { leafId: r3, salesmanId: 'S3', values: VALUES.r3! },
    { leafId: r4, salesmanId: 'S4', values: VALUES.r4! },
  ]);
  start = await grandTotals(month, tt);
  expect(start).toEqual({ [PET]: 2000, [CAN]: 500, [WATER]: 200, [JUICE]: 12 });
});

/** Head submits his single child unchanged; the area's turn opens. */
async function headSubmits(): Promise<void> {
  const ws = await json(await getWs(headS, month, head));
  const res = await submit(headS, month, head, ws.version);
  expect(res.status).toBe(200);
  expect(await grandTotals(month, tt)).toEqual(start);
}

/** Area moves 50 PET from Sup A to Sup B and submits. */
async function areaMoves50(): Promise<void> {
  await headSubmits();
  const ws = await json(await getWs(areaS, month, area));
  const v = valuesOf(ws);
  v[`n:${supA}`]![PET] = 950;
  v[`n:${supB}`]![PET] = 1050;
  const d = await putDraft(areaS, month, area, v, ws.version);
  expect(d.status).toBe(200);
  const res = await submit(areaS, month, area, (await json(d)).version);
  expect(res.status).toBe(200);
  expect(await grandTotals(month, tt)).toEqual(start);
}

describe('opening turns', () => {
  it('dept start opens the root with baseline = child totals, draft null, version+1, audit node.open', async () => {
    const root = await nodeRow(month, head);
    expect(root.status).toBe('in_progress');
    expect(JSON.parse(root.baseline_json)).toEqual({ [`n:${area}`]: start });
    expect(root.draft_json).toBeNull();
    expect(root.opened_at).toEqual(expect.any(String));
    expect(root.version).toBe(1);
    expect((await nodeRow(month, area)).status).toBe('waiting');
    const opens = await all<Json>(env.DB, `SELECT month_id, node_id FROM audit WHERE action = 'node.open'`);
    expect(opens).toEqual([{ month_id: month, node_id: head }]);
  });

  it('childTotals: a child node is the sum of its leaves, a child leaf is its own grid', async () => {
    expect(await childTotals(env.DB, month, area)).toEqual({
      [`n:${supA}`]: { [PET]: 1000, [CAN]: 200, [WATER]: 100, [JUICE]: 0 },
      [`n:${supB}`]: { [PET]: 1000, [CAN]: 300, [WATER]: 100, [JUICE]: 12 },
    });
    expect(await childTotals(env.DB, month, supA)).toEqual({ [`l:${r1}`]: VALUES.r1, [`l:${r2}`]: VALUES.r2 });
  });

  it('openTurn is idempotent on an in-progress node with no draft', async () => {
    const before = await nodeRow(month, head);
    await openTurn(env.DB, env, month, head);
    expect(await nodeRow(month, head)).toEqual(before);
    expect((await all(env.DB, `SELECT id FROM audit WHERE action = 'node.open'`)).length).toBe(1);
  });

  it('Ruling R16: start re-run opens the root when the department is running but the root is still waiting', async () => {
    await run(env.DB, `UPDATE month_nodes SET status = 'waiting', baseline_json = NULL, opened_at = NULL WHERE month_id = ? AND node_id = ?`, month, head);
    const res = await api('POST', `/admin/months/${month}/depts/${tt}/start`, admin);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ state: 'running' });
    const root = await nodeRow(month, head);
    expect(root.status).toBe('in_progress');
    expect(JSON.parse(root.baseline_json)).toEqual({ [`n:${area}`]: start });
    // Once the root is open, start is refused again.
    const again = await api('POST', `/admin/months/${month}/depts/${tt}/start`, admin);
    expect(again.status).toBe(409);
    expect((await json(again)).detail).toBe('department_not_loading');
  });
});

describe('workspace', () => {
  it('shows the head his single child with labels, packs, cap and an editable turn', async () => {
    const res = await getWs(headS, month, head);
    expect(res.status).toBe(200);
    const ws = await json(res);
    expect(ws).toEqual({
      month: { id: month, period: '2026-10', deadline: '2026-10-25' },
      node: { id: head, name: 'Head', status: 'in_progress', deptCode: 'TT', deptId: expect.any(Number), level: 'head' },
      capPct: 5,
      rules: { rule2: true, rule3: true, personCapPct: [null] },
      packs: [
        { code: PET, grp: 'CSD', sort: 0 }, { code: CAN, grp: 'CSD', sort: 1 },
        { code: WATER, grp: 'Water', sort: 2 }, { code: JUICE, grp: 'LRB-Others', sort: 3 },
      ],
      totals: start,
      children: [{ key: `n:${area}`, label: 'Area', sub: 'Name area', starts: start, values: start }],
      version: 1,
      editable: true,
    });
  });

  it('a waiting node is viewable read-only; leaf children are labelled by route code and salesman ID', async () => {
    const ws = await json(await getWs(supAS, month, supA));
    expect(ws.node.status).toBe('waiting');
    expect(ws.editable).toBe(false);
    expect(ws.children).toEqual([
      { key: `l:${r1}`, label: 'R1', sub: 'S1', starts: VALUES.r1, values: VALUES.r1 },
      { key: `l:${r2}`, label: 'R2', sub: 'S2', starts: VALUES.r2, values: VALUES.r2 },
    ]);
  });

  it('Supervisor A cannot GET Sup B\'s workspace (403); the area manager can, read-only; admin can view', async () => {
    await areaMoves50();
    expect((await getWs(supAS, month, supB)).status).toBe(403);
    expect((await api('GET', `/months/${month}/nodes/${supB}/branch`, supAS)).status).toBe(403);

    const res = await getWs(areaS, month, supB);
    expect(res.status).toBe(200);
    const ws = await json(res);
    expect(ws.node.status).toBe('in_progress');
    expect(ws.editable).toBe(false);
    // Read-only also means the area manager cannot write into Sup B's turn.
    expect((await putDraft(areaS, month, supB, valuesOf(ws), ws.version)).status).toBe(403);
    expect((await submit(areaS, month, supB, ws.version)).status).toBe(403);
    expect((await nodeRow(month, supB)).version).toBe(ws.version);

    expect((await getWs(headS, month, supB)).status).toBe(200);
    const asAdmin = await json(await getWs(admin, month, supB));
    expect(asAdmin.editable).toBe(false);
    expect((await submit(admin, month, supB, ws.version)).status).toBe(403);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('401 anonymous, 404 for an unknown month or node', async () => {
    expect((await getWs('nope', month, head)).status).toBe(401);
    expect((await api('GET', `/months/${month}/nodes/${head}`, null)).status).toBe(401);
    expect((await getWs(admin, 999, head)).status).toBe(404);
    expect((await getWs(admin, month, 99999)).status).toBe(404);
    expect((await getWs(admin, month, 0)).status).toBe(404);
  });
});

describe('submit (top-down)', () => {
  it('owner\'s example: area moves 50 from A to B; leaves 665/285/630/420; A starts from 665/285 with cap 47', async () => {
    await areaMoves50();
    expect((await leafGrid(month, r1))[PET]).toBe(665);
    expect((await leafGrid(month, r2))[PET]).toBe(285);
    expect((await leafGrid(month, r3))[PET]).toBe(630);
    expect((await leafGrid(month, r4))[PET]).toBe(420);
    // Packs the area did not change are untouched.
    for (const [leaf, key] of [[r1, 'r1'], [r2, 'r2'], [r3, 'r3'], [r4, 'r4']] as const) {
      const g = await leafGrid(month, leaf);
      expect({ ...g, [PET]: 0 }).toEqual({ ...VALUES[key], [PET]: 0 });
    }

    const ws = await json(await getWs(supAS, month, supA));
    expect(ws.totals[PET]).toBe(950);
    expect(ws.children.map((c: Json) => c.starts[PET])).toEqual([665, 285]);
    expect(ws.children.map((c: Json) => c.values[PET])).toEqual([665, 285]);
    expect(capFor(ws.totals[PET], ws.capPct)).toBe(47);
    expect(ws.editable).toBe(true);

    expect((await nodeRow(month, supA)).status).toBe('in_progress');
    expect((await nodeRow(month, supB)).status).toBe('in_progress');
    const areaRow = await nodeRow(month, area);
    expect(areaRow.status).toBe('submitted');
    expect(areaRow.submitted_at).toEqual(expect.any(String));
    expect(JSON.parse((await nodeRow(month, supB)).baseline_json)).toEqual({
      [`l:${r3}`]: { ...VALUES.r3, [PET]: 630 }, [`l:${r4}`]: { ...VALUES.r4, [PET]: 420 },
    });
    // The area's own view now shows what it submitted.
    const areaWs = await json(await getWs(areaS, month, area));
    expect(areaWs.editable).toBe(false);
    expect(areaWs.children.map((c: Json) => c.values[PET])).toEqual([950, 1050]);
    expect(areaWs.children.map((c: Json) => c.starts[PET])).toEqual([1000, 1000]);

    const submits = await all<Json>(env.DB, `SELECT node_id, detail_json FROM audit WHERE action = 'node.submit' ORDER BY id`);
    expect(submits.map((s) => s.node_id)).toEqual([head, area]);
    expect(JSON.parse(submits[1]!.detail_json)).toEqual({ changedChildren: [`n:${supA}`, `n:${supB}`] });
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('rescales every changed pack of a child node, and a leaf child gets its grid directly', async () => {
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    const v = valuesOf(ws);
    // CAN: T = 500, cap 25. Move 10 from B to A.
    v[`n:${supA}`]![CAN] = 210;
    v[`n:${supB}`]![CAN] = 290;
    expect((await submit(areaS, month, area, (await json(await putDraft(areaS, month, area, v, ws.version))).version)).status).toBe(200);
    expect(await leafGrid(month, r1)).toEqual({ ...VALUES.r1, [CAN]: 126 });
    expect(await leafGrid(month, r2)).toEqual({ ...VALUES.r2, [CAN]: 84 });
    expect(await leafGrid(month, r3)).toEqual({ ...VALUES.r3, [CAN]: 193 });
    expect(await leafGrid(month, r4)).toEqual({ ...VALUES.r4, [CAN]: 97 });
    expect(await grandTotals(month, tt)).toEqual(start);

    // Sup A (leaf children): PET T = 1000, cap 50: r1 700 -> 740, r2 300 -> 260.
    const a = await json(await getWs(supAS, month, supA));
    const av = valuesOf(a);
    av[`l:${r1}`]![PET] = 740;
    av[`l:${r2}`]![PET] = 260;
    const d = await putDraft(supAS, month, supA, av, a.version);
    expect(d.status).toBe(200);
    expect((await submit(supAS, month, supA, (await json(d)).version)).status).toBe(200);
    expect(await leafGrid(month, r1)).toEqual({ ...VALUES.r1, [CAN]: 126, [PET]: 740 });
    expect(await leafGrid(month, r2)).toEqual({ ...VALUES.r2, [CAN]: 84, [PET]: 260 });
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('submitting without a draft submits the starting numbers unchanged', async () => {
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    expect((await submit(areaS, month, area, ws.version)).status).toBe(200);
    for (const [leaf, key] of [[r1, 'r1'], [r2, 'r2'], [r3, 'r3'], [r4, 'r4']] as const) {
      expect(await leafGrid(month, leaf)).toEqual(VALUES[key]);
    }
    const detail = await one<Json>(env.DB, `SELECT detail_json FROM audit WHERE action = 'node.submit' AND node_id = ?`, area);
    expect(JSON.parse(detail!.detail_json)).toEqual({ changedChildren: [] });
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('the four-rep 100-moved case is rejected with 400 moved_too_much and writes nothing', async () => {
    const mt = await mkDept('MT');
    const mtHeadU = await addUser('mthead');
    const mtHeadS = await login('mthead');
    const mtHead = await mkNode(mt, 'MT head', null, mtHeadU);
    const q = [await mkLeaf(mt, mtHead, 'Q1'), await mkLeaf(mt, mtHead, 'Q2'), await mkLeaf(mt, mtHead, 'Q3'), await mkLeaf(mt, mtHead, 'Q4')];
    const m2 = (await json(await api('POST', '/admin/months', admin, { period: '2026-11' }))).month.id;
    await loadAndStart(admin, m2, mt, q.map((id, i) => ({
      leafId: id, salesmanId: `Q${i}`, values: { [PET]: 250, [CAN]: 10, [WATER]: 10, [JUICE]: 10 },
    })));
    const before = await grandTotals(m2, mt);
    const ws = await json(await getWs(mtHeadS, m2, mtHead));
    expect(ws.totals[PET]).toBe(1000);
    const v = valuesOf(ws);
    // 50 off each of two reps onto the other two: 100 moved, cap 50.
    v[`l:${q[0]}`]![PET] = 200;
    v[`l:${q[1]}`]![PET] = 200;
    v[`l:${q[2]}`]![PET] = 300;
    v[`l:${q[3]}`]![PET] = 300;
    const d = await putDraft(mtHeadS, m2, mtHead, v, ws.version);
    expect(d.status).toBe(200); // drafts are not rule-checked
    const version = (await json(d)).version;
    const res = await submit(mtHeadS, m2, mtHead, version);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.byPack[PET]).toMatchObject({ ok: false, status: 'moved_too_much', moved: 100, cap: 50, total: 1000 });
    expect(body.byPack[CAN]).toMatchObject({ ok: true, status: 'ok' });
    const row = await nodeRow(m2, mtHead);
    expect(row.status).toBe('in_progress');
    expect(row.version).toBe(version);
    for (const id of q) expect((await leafGrid(m2, id))[PET]).toBe(250);
    expect(await grandTotals(m2, mt)).toEqual(before);
    expect(await all(env.DB, `SELECT id FROM audit WHERE action = 'node.submit'`)).toEqual([]);

    // Moving 50 in total passes; the root has no child nodes, so the department completes.
    v[`l:${q[0]}`]![PET] = 225;
    v[`l:${q[1]}`]![PET] = 225;
    v[`l:${q[2]}`]![PET] = 275;
    v[`l:${q[3]}`]![PET] = 275;
    const d2 = await putDraft(mtHeadS, m2, mtHead, v, version);
    expect((await submit(mtHeadS, m2, mtHead, (await json(d2)).version)).status).toBe(200);
    expect((await leafGrid(m2, q[0]!))[PET]).toBe(225);
    expect((await leafGrid(m2, q[3]!))[PET]).toBe(275);
    expect(await grandTotals(m2, mt)).toEqual(before);
    expect(await deptState(m2, mt)).toBe('complete');
  });

  it('a total that would change, or a pack with T = 0, is rejected', async () => {
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    const v = valuesOf(ws);
    v[`n:${supA}`]![PET] = 990; // short by 10
    let ver = (await json(await putDraft(areaS, month, area, v, ws.version))).version;
    let res = await submit(areaS, month, area, ver);
    expect(res.status).toBe(400);
    expect((await json(res)).byPack[PET].status).toBe('short');

    const v2 = valuesOf(ws);
    v2[`n:${supA}`]![JUICE] = 1; // T = 12 -> cap 0
    v2[`n:${supB}`]![JUICE] = 11;
    ver = (await json(await putDraft(areaS, month, area, v2, ver))).version;
    res = await submit(areaS, month, area, ver);
    expect(res.status).toBe(400);
    expect((await json(res)).byPack[JUICE]).toMatchObject({ status: 'moved_too_much', cap: 0 });
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('submit while an ancestor is not yet submitted is 409', async () => {
    // Area is still waiting: the head has not submitted.
    let res = await submit(areaS, month, area, 0);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('not_in_progress');
    // Even if the area were somehow open, its parent must have submitted first.
    await run(env.DB, `UPDATE month_nodes SET status = 'in_progress' WHERE month_id = ? AND node_id = ?`, month, area);
    res = await submit(areaS, month, area, (await nodeRow(month, area)).version);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('parent_not_submitted');
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a stale version is 409 stale; a submitted node cannot submit again', async () => {
    const ws = await json(await getWs(headS, month, head));
    let res = await submit(headS, month, head, ws.version - 1);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'stale' });
    expect((await submit(headS, month, head, ws.version)).status).toBe(200);
    res = await submit(headS, month, head, ws.version + 1);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('not_in_progress');
    expect((await submit(headS, month, head, Number.NaN as unknown as number)).status).toBe(400);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('only the node\'s own manager may submit', async () => {
    const ws = await json(await getWs(headS, month, head));
    expect((await submit(areaS, month, head, ws.version)).status).toBe(403);
    expect((await submit(admin, month, head, ws.version)).status).toBe(403);
    expect((await nodeRow(month, head)).status).toBe('in_progress');
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('cases cannot be moved into a child node that has no routes', async () => {
    const mt = await mkDept('MT');
    const u = await addUser('mthead');
    const s = await login('mthead');
    const root = await mkNode(mt, 'MT head', null, u);
    const empty = await mkNode(mt, 'MT empty', root);
    const q1 = await mkLeaf(mt, root, 'Q1');
    const m2 = (await json(await api('POST', '/admin/months', admin, { period: '2026-11' }))).month.id;
    await loadAndStart(admin, m2, mt, [{ leafId: q1, salesmanId: 'Q', values: { [PET]: 1000, [CAN]: 0, [WATER]: 0, [JUICE]: 0 } }]);
    const ws = await json(await getWs(s, m2, root));
    expect(ws.children.map((c: Json) => c.key)).toEqual([`n:${empty}`, `l:${q1}`]);
    expect(ws.children[0].sub).toBe('');
    const v = valuesOf(ws);
    v[`n:${empty}`]![PET] = 10;
    v[`l:${q1}`]![PET] = 990;
    const d = await putDraft(s, m2, root, v, ws.version);
    const res = await submit(s, m2, root, (await json(d)).version);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toMatchObject({ error: 'no_routes', node: 'MT empty' });
    expect(body.detail).toContain('MT empty');
    expect((await leafGrid(m2, q1))[PET]).toBe(1000);
    expect((await nodeRow(m2, root)).status).toBe('in_progress');
  });

  it('pack codes that cannot go in a JSON path (" and \\) are read and written correctly', async () => {
    const odd = 'WE"IRD';
    const slash = 'BACK\\SLASH';
    const arabic = 'مياه 600 [x].y';
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES (?, 'Water', 1, 10), (?, 'Water', 1, 11), (?, 'Water', 1, 12)`, odd, slash, arabic);
    const mt = await mkDept('MT');
    const u = await addUser('mthead');
    const s = await login('mthead');
    const root = await mkNode(mt, 'MT head', null, u);
    const x = await mkNode(mt, 'X', root);
    const y = await mkNode(mt, 'Y', root);
    const x1 = await mkLeaf(mt, x, 'X1');
    const x2 = await mkLeaf(mt, x, 'X2');
    const y1 = await mkLeaf(mt, y, 'Y1');
    const m2 = (await json(await api('POST', '/admin/months', admin, { period: '2026-11' }))).month.id;
    const base = { [PET]: 100, [CAN]: 0, [WATER]: 0, [JUICE]: 0 };
    await loadAndStart(admin, m2, mt, [
      { leafId: x1, salesmanId: 'a', values: { ...base, [odd]: 700, [slash]: 10, [arabic]: 300 } },
      { leafId: x2, salesmanId: 'b', values: { ...base, [odd]: 300, [slash]: 30, [arabic]: 100 } },
      { leafId: y1, salesmanId: 'c', values: { ...base, [odd]: 1000, [slash]: 0, [arabic]: 400 } },
    ]);
    const before = await grandTotals(m2, mt);
    const ws = await json(await getWs(s, m2, root));
    expect(ws.children[0].starts).toEqual({ ...base, [PET]: 200, [odd]: 1000, [slash]: 40, [arabic]: 400 });
    const v = valuesOf(ws);
    v[`n:${x}`]![odd] = 950; // T = 2000, cap 100
    v[`n:${y}`]![odd] = 1050;
    v[`n:${x}`]![arabic] = 420; // T = 800, cap 40
    v[`n:${y}`]![arabic] = 380;
    const d = await putDraft(s, m2, root, v, ws.version);
    expect((await submit(s, m2, root, (await json(d)).version)).status).toBe(200);
    expect(await leafGrid(m2, x1)).toEqual({ ...base, [odd]: 665, [slash]: 10, [arabic]: 315 });
    expect(await leafGrid(m2, x2)).toEqual({ ...base, [odd]: 285, [slash]: 30, [arabic]: 105 });
    expect(await leafGrid(m2, y1)).toEqual({ ...base, [odd]: 1050, [slash]: 0, [arabic]: 380 });
    expect(await grandTotals(m2, mt)).toEqual(before);
    const xw = await json(await getWs(admin, m2, x));
    expect(xw.totals).toEqual({ ...base, [PET]: 200, [odd]: 950, [slash]: 40, [arabic]: 420 });
  });

  it('rewritten values_json keeps every snapshot pack, in snapshot order', async () => {
    await areaMoves50();
    const raw = (await one<{ values_json: string }>(env.DB, `SELECT values_json FROM month_leaves WHERE month_id = ? AND leaf_id = ?`, month, r1))!.values_json;
    expect(raw).toBe(JSON.stringify({ [PET]: 665, [CAN]: 120, [WATER]: 40, [JUICE]: 0 }));
  });

  it('the last submit sets the department complete', async () => {
    await areaMoves50();
    expect(await deptState(month, tt)).toBe('running');
    const a = await json(await getWs(supAS, month, supA));
    expect((await submit(supAS, month, supA, a.version)).status).toBe(200);
    expect(await deptState(month, tt)).toBe('running');
    expect(await grandTotals(month, tt)).toEqual(start);
    const b = await json(await getWs(supBS, month, supB));
    const res = await submit(supBS, month, supB, b.version);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'submitted', deptComplete: true });
    expect(await deptState(month, tt)).toBe('complete');
    expect(await grandTotals(month, tt)).toEqual(start);
    expect((await one<Json>(env.DB, `SELECT COUNT(*) n FROM month_nodes WHERE month_id = ? AND status <> 'submitted'`, month))!.n).toBe(0);
  });
});

describe('races', () => {
  /**
   * A DB where someone else bumps the node's version between the read batch
   * (the first db.batch) and the write batch (the second).
   */
  function racingDb(nodeId: number): D1Database {
    let batches = 0;
    return new Proxy(env.DB, {
      get(target, key) {
        if (key === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches === 2) {
              await run(target, `UPDATE month_nodes SET version = version + 1 WHERE month_id = ? AND node_id = ?`, month, nodeId);
            }
            return target.batch(stmts);
          };
        }
        const v = (target as any)[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  it('a submit that loses a race writes nothing (every statement is version-guarded) and is 409 stale', async () => {
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    const v = valuesOf(ws);
    v[`n:${supA}`]![PET] = 950;
    v[`n:${supB}`]![PET] = 1050;
    const ver = (await json(await putDraft(areaS, month, area, v, ws.version))).version;
    const auditBefore = (await all(env.DB, `SELECT id FROM audit`)).length;
    const err = await submitNode(racingDb(area), env, month, area, areaU, 'draft', { expectedVersion: ver, asManager: true }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ error: 'stale' });
    expect(await grandTotals(month, tt)).toEqual(start);
    expect((await leafGrid(month, r1))[PET]).toBe(700);
    expect((await nodeRow(month, area)).status).toBe('in_progress');
    expect((await nodeRow(month, area)).version).toBe(ver + 1); // only the racer's bump
    expect((await nodeRow(month, supA)).status).toBe('waiting');
    expect((await all(env.DB, `SELECT id FROM audit`)).length).toBe(auditBefore);
  });

  it('a draft that loses a race is 409 stale and leaves the stored draft alone', async () => {
    const ws = await json(await getWs(headS, month, head));
    const err = await saveDraft(racingDb(head), headU, month, head, { values: valuesOf(ws), version: ws.version }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ error: 'stale' });
    expect((await nodeRow(month, head)).draft_json).toBeNull();
    expect((await nodeRow(month, head)).version).toBe(ws.version + 1); // only the racer's bump
    expect(await all(env.DB, `SELECT id FROM audit WHERE action = 'node.draft'`)).toEqual([]);
  });
});

describe('drafts', () => {
  it('saves a draft (not rule-checked), bumps the version and shows it as values', async () => {
    const ws = await json(await getWs(headS, month, head));
    const v = valuesOf(ws);
    const res = await putDraft(headS, month, head, v, ws.version);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ version: ws.version + 1 });

    await headSubmits();
    const aw = await json(await getWs(areaS, month, area));
    const av = valuesOf(aw);
    av[`n:${supA}`]![PET] = 500; // far over the cap: still a valid draft
    av[`n:${supB}`]![PET] = 1300;
    const d = await putDraft(areaS, month, area, av, aw.version);
    expect(d.status).toBe(200);
    const again = await json(await getWs(areaS, month, area));
    expect(again.version).toBe(aw.version + 1);
    expect(again.children.map((c: Json) => c.values[PET])).toEqual([500, 1300]);
    expect(again.children.map((c: Json) => c.starts[PET])).toEqual([1000, 1000]);
    const audit = await all<Json>(env.DB, `SELECT node_id, detail_json FROM audit WHERE action = 'node.draft' ORDER BY id`);
    expect(audit.map((a) => a.node_id)).toEqual([head, area]);
    expect(JSON.parse(audit[1]!.detail_json)).toEqual({ version: aw.version + 1 });
    // Drafts never touch leaves or the baseline.
    expect(await grandTotals(month, tt)).toEqual(start);
    expect(JSON.parse((await nodeRow(month, area)).baseline_json)[`n:${supA}`][PET]).toBe(1000);
  });

  it('Review Focus 3: two PUT draft calls with the same version: the second gets 409', async () => {
    const ws = await json(await getWs(headS, month, head));
    const first = valuesOf(ws);
    const second = valuesOf(ws);
    second[`n:${area}`]![PET] = 1999;
    const [a, b] = [await putDraft(headS, month, head, first, ws.version), await putDraft(headS, month, head, second, ws.version)];
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(await json(b)).toEqual({ error: 'stale' });
    expect(JSON.parse((await nodeRow(month, head)).draft_json)).toEqual(first);
    expect((await nodeRow(month, head)).version).toBe(ws.version + 1);
  });

  it('validates keys and packs: exactly the node\'s children, exactly the snapshot packs, whole cases >= 0', async () => {
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    const ok = valuesOf(ws);
    const A = `n:${supA}`;
    const B = `n:${supB}`;
    const bads: [string, unknown][] = [
      ['missing child', { [A]: ok[A] }],
      ['extra child', { ...ok, [`l:${r1}`]: ok[A] }],
      ['bad key', { ...ok, foo: ok[A] }],
      ['missing pack', { ...ok, [A]: { [PET]: 1000, [CAN]: 200, [WATER]: 100 } }],
      ['extra pack', { ...ok, [A]: { ...ok[A], OTHER: 1 } }],
      ['negative', { ...ok, [A]: { ...ok[A], [PET]: -1 } }],
      ['fraction', { ...ok, [A]: { ...ok[A], [PET]: 1.5 } }],
      ['string', { ...ok, [B]: { ...ok[B], [PET]: '1000' } }],
      ['not an object', [1, 2]],
    ];
    for (const [name, values] of bads) {
      expect((await putDraft(areaS, month, area, values as Json, ws.version)).status, name).toBe(400);
    }
    expect((await api('PUT', `/months/${month}/nodes/${area}/draft`, areaS, { values: ok })).status).toBe(400);
    expect((await nodeRow(month, area)).draft_json).toBeNull();
    expect((await nodeRow(month, area)).version).toBe(ws.version);
  });

  it('a draft on a node that is not in progress is 409; another manager is 403', async () => {
    const ws = await json(await getWs(supAS, month, supA));
    let res = await putDraft(supAS, month, supA, valuesOf(ws), ws.version);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('not_in_progress');
    const hw = await json(await getWs(headS, month, head));
    res = await putDraft(areaS, month, head, valuesOf(hw), hw.version);
    expect(res.status).toBe(403);
  });
});

describe('my tasks and branch', () => {
  it('lists the user\'s nodes across months, newest month first', async () => {
    const nov = (await json(await api('POST', '/admin/months', admin, { period: '2026-11', deadline: '2026-11-20' }))).month.id;
    await headSubmits();
    const res = await api('GET', '/my/tasks', areaS);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([
      { monthId: nov, period: '2026-11', nodeId: area, nodeName: 'Area', deptCode: 'TT', status: 'waiting', deadline: '2026-11-20' },
      { monthId: month, period: '2026-10', nodeId: area, nodeName: 'Area', deptCode: 'TT', status: 'in_progress', deadline: '2026-10-25' },
    ]);
    expect(await json(await api('GET', '/my/tasks', admin))).toEqual([]);
    expect((await api('GET', '/my/tasks', null)).status).toBe(401);
  });

  it('the branch is the node\'s subtree with totals from leaves', async () => {
    await areaMoves50();
    const res = await api('GET', `/months/${month}/nodes/${area}/branch`, areaS);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([
      { nodeId: area, parentId: head, name: 'Area', manager: 'Name area', status: 'submitted', totals: start },
      { nodeId: supA, parentId: area, name: 'Sup A', manager: 'Name supa', status: 'in_progress', totals: { [PET]: 950, [CAN]: 200, [WATER]: 100, [JUICE]: 0 } },
      { nodeId: supB, parentId: area, name: 'Sup B', manager: 'Name supb', status: 'in_progress', totals: { [PET]: 1050, [CAN]: 300, [WATER]: 100, [JUICE]: 12 } },
    ]);
    const mine = await json(await api('GET', `/months/${month}/nodes/${supA}/branch`, supAS));
    expect(mine.map((n: Json) => n.nodeId)).toEqual([supA]);
    expect((await api('GET', `/months/${month}/nodes/${area}/branch`, supAS)).status).toBe(403);
    expect((await api('GET', `/months/${month}/nodes/${head}/branch`, admin)).status).toBe(200);
  });
});

// ---------- D1 statement budget on a large department ----------

/** Calls the Worker in-process with a DB that counts every statement it prepares. */
async function counted(method: string, path: string, cookie: string, body?: unknown): Promise<{ res: Response; statements: number }> {
  let statements = 0;
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => { statements++; return target.prepare(sql); };
      const v = (target as any)[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const req = new Request(`http://x/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `sid=${cookie}` },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const res = await app.fetch(req, { ...env, DB: db }, createExecutionContext());
  return { res, statements };
}

describe('statement budget', () => {
  it('1,200 leaves x 42 packs under 3 levels: every request stays within 40 statements and totals never change', async () => {
    await run(env.DB, `DELETE FROM packs`);
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 42) SELECT 'PACK_' || printf('%02d', i), 'CSD', 1, i FROM n`);
    const big = await mkDept('BIG');
    const bh = await addUser('bighead');
    const ba = await addUser('bigarea');
    const bs = await addUser('bigsup');
    const [bhS, baS, bsS] = (await Promise.all(['bighead', 'bigarea', 'bigsup'].map(login))) as [string, string, string];
    const root = await mkNode(big, 'Big head', null, bh);
    const areas = [await mkNode(big, 'Big area 1', root, ba), await mkNode(big, 'Big area 2', root), await mkNode(big, 'Big area 3', root)];
    const sups: number[] = [];
    for (const [i, a] of areas.entries()) for (let j = 0; j < 3; j++) sups.push(await mkNode(big, `Big sup ${i}.${j}`, a, i === 0 && j === 0 ? bs : null));
    const LEAVES = 1200;
    for (const [s, sup] of sups.entries()) {
      const n = Math.floor(LEAVES / sups.length) + (s < LEAVES % sups.length ? 1 : 0);
      await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT ?, 'DS', 'B' || ? || '_' || i, ?, 'r' FROM n`,
        n, big, s, sup);
    }
    const leafIds = (await all<{ id: number }>(env.DB, `SELECT id FROM leaves WHERE dept_id = ? ORDER BY id`, big)).map((r) => r.id);
    expect(leafIds).toHaveLength(LEAVES);
    const m2 = (await json(await api('POST', '/admin/months', admin, { period: '2026-12' }))).month.id;
    const ctx = await json(await api('GET', `/admin/months/${m2}/context?dept=${big}`, admin));
    const codes: string[] = ctx.packs.map((p: Json) => p.code);
    expect(codes).toHaveLength(42);
    await loadAndStart(admin, m2, big, leafIds.map((id, i) => ({
      leafId: id, salesmanId: `S${i}`, values: Object.fromEntries(codes.map((c, j) => [c, 50 + ((i * 7 + j * 13) % 300)])),
    })));
    const before = await grandTotals(m2, big);
    const budget = 40;

    // Head: every pack moves the full cap off area 1 onto areas 2 and 3, so every leaf is rewritten.
    let r = await counted('GET', `/months/${m2}/nodes/${root}`, bhS);
    expect(r.res.status).toBe(200);
    expect(r.statements).toBeLessThanOrEqual(budget);
    let ws = await json(r.res);
    let v = valuesOf(ws);
    for (const c of codes) {
      const cap = capFor(ws.totals[c], 5);
      v[`n:${areas[0]}`]![c]! -= cap;
      v[`n:${areas[1]}`]![c]! += Math.floor(cap / 2);
      v[`n:${areas[2]}`]![c]! += cap - Math.floor(cap / 2);
    }
    r = await counted('PUT', `/months/${m2}/nodes/${root}/draft`, bhS, { values: v, version: ws.version });
    expect(r.res.status).toBe(200);
    expect(r.statements).toBeLessThanOrEqual(budget);
    const snapshotBefore = new Map((await all<{ leaf_id: number; values_json: string }>(env.DB, `SELECT leaf_id, values_json FROM month_leaves WHERE month_id = ?`, m2)).map((x) => [x.leaf_id, x.values_json]));
    r = await counted('POST', `/months/${m2}/nodes/${root}/submit`, bhS, { version: (await json(r.res)).version });
    expect(r.res.status).toBe(200);
    expect(r.statements).toBeLessThanOrEqual(budget);
    expect(await grandTotals(m2, big)).toEqual(before);
    const after = await all<{ leaf_id: number; values_json: string }>(env.DB, `SELECT leaf_id, values_json FROM month_leaves WHERE month_id = ?`, m2);
    expect(after.filter((x) => snapshotBefore.get(x.leaf_id) !== x.values_json).length).toBe(LEAVES);
    // Each area's new total is exactly what the head submitted.
    const aws = await json(await getWs(baS, m2, areas[0]!));
    expect(aws.totals).toEqual(v[`n:${areas[0]}`]);

    // Area 1: move the cap from sup 0 to sup 1 on every pack.
    r = await counted('GET', `/months/${m2}/nodes/${areas[0]}`, baS);
    expect(r.statements).toBeLessThanOrEqual(budget);
    ws = await json(r.res);
    v = valuesOf(ws);
    for (const c of codes) {
      const cap = capFor(ws.totals[c], 5);
      v[`n:${sups[0]}`]![c]! -= cap;
      v[`n:${sups[1]}`]![c]! += cap;
    }
    r = await counted('PUT', `/months/${m2}/nodes/${areas[0]}/draft`, baS, { values: v, version: ws.version });
    r = await counted('POST', `/months/${m2}/nodes/${areas[0]}/submit`, baS, { version: (await json(r.res)).version });
    expect(r.res.status).toBe(200);
    expect(r.statements).toBeLessThanOrEqual(budget);
    expect(await grandTotals(m2, big)).toEqual(before);

    // Sup 0 (leaf children): submit unchanged.
    r = await counted('GET', `/months/${m2}/nodes/${sups[0]}`, bsS);
    ws = await json(r.res);
    expect(ws.totals).toEqual(v[`n:${sups[0]}`]);
    r = await counted('POST', `/months/${m2}/nodes/${sups[0]}/submit`, bsS, { version: ws.version });
    expect(r.res.status).toBe(200);
    expect(r.statements).toBeLessThanOrEqual(budget);
    expect(await grandTotals(m2, big)).toEqual(before);

    r = await counted('GET', '/my/tasks', bsS);
    expect(r.statements).toBeLessThanOrEqual(budget);
    r = await counted('GET', `/months/${m2}/nodes/${root}/branch`, bhS);
    expect(r.res.status).toBe(200);
    expect(r.statements).toBeLessThanOrEqual(budget);
    expect(await json(r.res)).toHaveLength(1 + areas.length + sups.length);
  }, 60_000);
});
