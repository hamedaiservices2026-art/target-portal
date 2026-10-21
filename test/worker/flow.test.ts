import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { all, one, run } from '../../src/worker/db';
import { saveDraft, submitNode } from '../../src/worker/services/distribution';
import { applyTreeChangeToOpenMonths, reopenNode, restoreOrReopen } from '../../src/worker/services/flow';

type Json = Record<string, any>;
type Grid = Record<string, number>;

// ---------- fixture helpers ----------

const PET = 'CSD_PET1000';
const CAN = 'CSD_CAN330';
const PACKS: [string, string][] = [[PET, 'CSD'], [CAN, 'CSD']];

async function addUser(username: string, role: 'admin' | 'manager' = 'manager'): Promise<number> {
  const { hash, salt } = await hashPassword('password-123');
  return (await run(env.DB, `INSERT INTO users(username, name, email, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?, ?)`,
    username, `Name ${username}`, `${username}@example.com`, hash, salt, role)).lastRowId;
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

async function upload(admin: string, m: number, dept: number, grids: { leafId: number; values: Grid }[]): Promise<void> {
  const f = await api('POST', `/admin/months/${m}/files`, admin, { deptId: dept, name: 'forecast' });
  expect(f.status).toBe(201);
  const fileId = (await json(f)).fileId;
  const res = await api('POST', `/admin/months/${m}/files/${fileId}/batch`, admin,
    { grids: grids.map((g, i) => ({ ...g, salesmanId: `S${i}`, deliverySystem: 'DS', routeCode: 'x' })) });
  expect(res.status).toBe(200);
}

/** Σ over every leaf of the department, per pack, straight from the database. */
async function grandTotals(m: number, dept: number): Promise<Grid> {
  const rows = await all<{ values_json: string }>(env.DB, `SELECT values_json FROM month_leaves WHERE month_id = ? AND dept_id = ?`, m, dept);
  const out: Grid = {};
  for (const r of rows) for (const [k, v] of Object.entries(JSON.parse(r.values_json) as Grid)) out[k] = (out[k] ?? 0) + v;
  return out;
}
async function leafGrid(m: number, leaf: number): Promise<Grid> {
  return JSON.parse((await one<{ values_json: string }>(env.DB, `SELECT values_json FROM month_leaves WHERE month_id = ? AND leaf_id = ?`, m, leaf))!.values_json);
}
async function leafNode(m: number, leaf: number): Promise<number> {
  return (await one<{ node_id: number }>(env.DB, `SELECT node_id FROM month_leaves WHERE month_id = ? AND leaf_id = ?`, m, leaf))!.node_id;
}
async function nodeRow(m: number, node: number): Promise<Json> {
  return (await one<Json>(env.DB, `SELECT * FROM month_nodes WHERE month_id = ? AND node_id = ?`, m, node))!;
}
async function deptState(m: number, dept: number): Promise<string> {
  return (await one<{ state: string }>(env.DB, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, m, dept))!.state;
}
const statusOf = async (m: number, node: number): Promise<[string, string | null]> => {
  const r = await nodeRow(m, node);
  return [r.status, r.held_status];
};

const getWs = (cookie: string, m: number, node: number) => api('GET', `/months/${m}/nodes/${node}`, cookie);
const putDraft = (cookie: string, m: number, node: number, values: Json, version: number) =>
  api('PUT', `/months/${m}/nodes/${node}/draft`, cookie, { values, version });
const submit = (cookie: string, m: number, node: number, version: number) =>
  api('POST', `/months/${m}/nodes/${node}/submit`, cookie, { version });
const reopen = (m: number, node: number) => api('POST', `/admin/months/${m}/nodes/${node}/reopen`, admin);
const push = (m: number, node: number) => api('POST', `/admin/months/${m}/nodes/${node}/push`, admin);

const valuesOf = (ws: Json): Record<string, Grid> => Object.fromEntries(ws.children.map((c: Json) => [c.key, { ...c.values }]));

// ---------- fixture ----------
// TT: Head -> Area -> Sup A [r1 700, r2 300], Sup B [r3 600, r4 400], Sup C [r5 500, r6 500] (PET).

let admin: string;
let headS: string; let areaS: string; let supAS: string; let supBS: string; let supCS: string;
let headU: number; let areaU: number; let supAU: number; let supBU: number; let supCU: number;
let tt: number; let month: number;
let head: number; let area: number; let supA: number; let supB: number; let supC: number;
let r1: number; let r2: number; let r3: number; let r4: number; let r5: number; let r6: number;
let start: Grid;

const V = (pet: number, can: number): Grid => ({ [PET]: pet, [CAN]: can });

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
  supCU = await addUser('supc');
  [admin, headS, areaS, supAS, supBS, supCS] = (await Promise.all(['boss', 'head', 'area', 'supa', 'supb', 'supc'].map(login))) as
    [string, string, string, string, string, string];
  for (const [i, [code, grp]] of PACKS.entries()) {
    await run(env.DB, `INSERT INTO packs(code, grp, active, sort) VALUES (?, ?, 1, ?)`, code, grp, i);
  }
  tt = await mkDept('TT');
  head = await mkNode(tt, 'Head', null, headU);
  area = await mkNode(tt, 'Area', head, areaU);
  supA = await mkNode(tt, 'Sup A', area, supAU);
  supB = await mkNode(tt, 'Sup B', area, supBU);
  supC = await mkNode(tt, 'Sup C', area, supCU);
  r1 = await mkLeaf(tt, supA, 'R1');
  r2 = await mkLeaf(tt, supA, 'R2');
  r3 = await mkLeaf(tt, supB, 'R3');
  r4 = await mkLeaf(tt, supB, 'R4');
  r5 = await mkLeaf(tt, supC, 'R5');
  r6 = await mkLeaf(tt, supC, 'R6');
  const res = await api('POST', '/admin/months', admin, { period: '2026-10', deadline: '2026-10-25' });
  expect(res.status).toBe(201);
  month = (await json(res)).month.id;
  await upload(admin, month, tt, [
    { leafId: r1, values: V(700, 120) }, { leafId: r2, values: V(300, 80) },
    { leafId: r3, values: V(600, 200) }, { leafId: r4, values: V(400, 100) },
    { leafId: r5, values: V(500, 50) }, { leafId: r6, values: V(500, 50) },
  ]);
  expect((await api('POST', `/admin/months/${month}/depts/${tt}/start`, admin)).status).toBe(200);
  start = await grandTotals(month, tt);
  expect(start).toEqual(V(3000, 600));
});

async function headSubmits(): Promise<void> {
  const ws = await json(await getWs(headS, month, head));
  expect((await submit(headS, month, head, ws.version)).status).toBe(200);
  expect(await grandTotals(month, tt)).toEqual(start);
}

/** Area moves 50 PET from Sup A to Sup B (A 950, B 1050, C 1000) and submits. */
async function areaMoves50(): Promise<void> {
  await headSubmits();
  const ws = await json(await getWs(areaS, month, area));
  const v = valuesOf(ws);
  v[`n:${supA}`]![PET] = 950;
  v[`n:${supB}`]![PET] = 1050;
  const d = await putDraft(areaS, month, area, v, ws.version);
  expect(d.status).toBe(200);
  expect((await submit(areaS, month, area, (await json(d)).version)).status).toBe(200);
  expect(await grandTotals(month, tt)).toEqual(start);
}

/**
 * After the area's move: Sup A saves a draft (r1 675 / r2 275), Sup B submits
 * (r3 640 / r4 410), Sup C has not started.
 */
async function supsWork(): Promise<void> {
  await areaMoves50();
  const a = await json(await getWs(supAS, month, supA));
  const av = valuesOf(a);
  av[`l:${r1}`]![PET] = 675;
  av[`l:${r2}`]![PET] = 275;
  expect((await putDraft(supAS, month, supA, av, a.version)).status).toBe(200);
  const b = await json(await getWs(supBS, month, supB));
  const bv = valuesOf(b);
  bv[`l:${r3}`]![PET] = 640;
  bv[`l:${r4}`]![PET] = 410;
  const d = await json(await putDraft(supBS, month, supB, bv, b.version));
  expect((await submit(supBS, month, supB, d.version)).status).toBe(200);
  expect(await grandTotals(month, tt)).toEqual(start);
}

// ---------- reopen ----------

describe('reopen', () => {
  it('sends the node back to in_progress (baseline kept, draft = submitted values) and holds every descendant', async () => {
    await supsWork();
    const before = await nodeRow(month, area);
    const sups = await Promise.all([supA, supB, supC].map((n) => nodeRow(month, n)));
    const res = await reopen(month, area);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: 'in_progress', version: before.version + 1 });

    const after = await nodeRow(month, area);
    expect(after.status).toBe('in_progress');
    expect(after.version).toBe(before.version + 1);
    expect(after.baseline_json).toBe(before.baseline_json); // spec §6: never reset by reopen
    expect(JSON.parse(after.draft_json)).toEqual(JSON.parse(before.draft_json));
    expect(JSON.parse(after.draft_json)[`n:${supB}`][PET]).toBe(1050);
    expect(await statusOf(month, supA)).toEqual(['waiting', 'in_progress']);
    expect(await statusOf(month, supB)).toEqual(['waiting', 'submitted']);
    expect(await statusOf(month, supC)).toEqual(['waiting', 'in_progress']);
    for (const [i, n] of [supA, supB, supC].entries()) expect((await nodeRow(month, n)).version).toBe(sups[i]!.version + 1);

    // The area manager can edit again; a held supervisor cannot.
    const ws = await json(await getWs(areaS, month, area));
    expect(ws.editable).toBe(true);
    expect(ws.children.map((c: Json) => c.starts[PET])).toEqual([1000, 1000, 1000]);
    expect(ws.children.map((c: Json) => c.values[PET])).toEqual([950, 1050, 1000]);
    const a = await json(await getWs(supAS, month, supA));
    expect(a.editable).toBe(false);
    expect((await putDraft(supAS, month, supA, valuesOf(a), a.version)).status).toBe(409);

    const audit = await all<Json>(env.DB, `SELECT node_id, user_id FROM audit WHERE action = 'node.reopen'`);
    expect(audit).toEqual([{ node_id: area, user_id: expect.any(Number) }]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('unchanged resubmit: Sup A and B return to their held statuses with their work intact', async () => {
    await supsWork();
    const aDraft = (await nodeRow(month, supA)).draft_json;
    expect((await reopen(month, area)).status).toBe(200);
    const ws = await json(await getWs(areaS, month, area));
    expect((await submit(areaS, month, area, ws.version)).status).toBe(200);

    expect(await statusOf(month, supA)).toEqual(['in_progress', null]);
    expect(await statusOf(month, supB)).toEqual(['submitted', null]);
    expect(await statusOf(month, supC)).toEqual(['in_progress', null]);
    expect((await nodeRow(month, supA)).draft_json).toBe(aDraft);
    expect((await leafGrid(month, r3))[PET]).toBe(640);
    expect((await leafGrid(month, r4))[PET]).toBe(410);
    const a = await json(await getWs(supAS, month, supA));
    expect(a.editable).toBe(true);
    expect(a.children.map((c: Json) => c.values[PET])).toEqual([675, 275]);
    expect(a.children.map((c: Json) => c.starts[PET])).toEqual([665, 285]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('changed resubmit: the changed sups lose their work and reopen with the rescaled starts; Sup A keeps its draft', async () => {
    await supsWork();
    const aDraft = (await nodeRow(month, supA)).draft_json;
    expect((await reopen(month, area)).status).toBe(200);
    const ws = await json(await getWs(areaS, month, area));
    const v = valuesOf(ws);
    v[`n:${supB}`]![PET] = 1030; // B 1050 -> 1030, C 1000 -> 1020; A unchanged at 950
    v[`n:${supC}`]![PET] = 1020;
    const d = await json(await putDraft(areaS, month, area, v, ws.version));
    const mark = (await one<{ id: number }>(env.DB, `SELECT MAX(id) AS id FROM audit`))!.id;
    expect((await submit(areaS, month, area, d.version)).status).toBe(200);

    // Sup A unchanged: restored with its draft.
    expect(await statusOf(month, supA)).toEqual(['in_progress', null]);
    expect((await nodeRow(month, supA)).draft_json).toBe(aDraft);
    // Sup B changed: its submitted work (640/410) is rescaled to 1030 and its turn reopens from there.
    const b = await nodeRow(month, supB);
    expect([b.status, b.held_status, b.draft_json, b.submitted_at]).toEqual(['in_progress', null, null, null]);
    expect((await leafGrid(month, r3))[PET]).toBe(628);
    expect((await leafGrid(month, r4))[PET]).toBe(402);
    expect(JSON.parse(b.baseline_json)).toEqual({ [`l:${r3}`]: V(628, 200), [`l:${r4}`]: V(402, 100) });
    const bws = await json(await getWs(supBS, month, supB));
    expect(bws.editable).toBe(true);
    expect(bws.totals[PET]).toBe(1030);
    expect(bws.children.map((c: Json) => c.starts[PET])).toEqual([628, 402]);
    // Sup C changed: 500/500 -> 510/510.
    expect(await statusOf(month, supC)).toEqual(['in_progress', null]);
    expect(JSON.parse((await nodeRow(month, supC)).baseline_json)).toEqual({ [`l:${r5}`]: V(510, 50), [`l:${r6}`]: V(510, 50) });
    // Only the changed sups get a fresh turn (and its 'node.open').
    const opens = await all<Json>(env.DB, `SELECT node_id FROM audit WHERE action = 'node.open' AND id > ? ORDER BY node_id`, mark);
    expect(opens.map((o) => o.node_id)).toEqual([supB, supC]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('the reopened node keeps its original baseline, so the cap cannot be stepped around', async () => {
    await supsWork();
    expect((await reopen(month, area)).status).toBe(200);
    const ws = await json(await getWs(areaS, month, area));
    const v = valuesOf(ws);
    // 150 is the area's cap (3000 x 5%); from the original 1000/1000/1000 baseline A -> 850 moves 150: ok.
    // A further 1 would be 151 moved: rejected, even though it is only 101 from the last submission.
    v[`n:${supA}`]![PET] = 849;
    v[`n:${supB}`]![PET] = 1151;
    const d = await json(await putDraft(areaS, month, area, v, ws.version));
    const res = await submit(areaS, month, area, d.version);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('rules_failed');
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('reopening the head holds the whole department; an unchanged resubmit restores every level', async () => {
    await supsWork();
    const sub = await all<Json>(env.DB, `SELECT node_id, status, draft_json, baseline_json FROM month_nodes WHERE month_id = ? ORDER BY node_id`, month);
    expect((await reopen(month, head)).status).toBe(200);
    expect(await statusOf(month, area)).toEqual(['waiting', 'submitted']);
    expect(await statusOf(month, supB)).toEqual(['waiting', 'submitted']);
    const ws = await json(await getWs(headS, month, head));
    expect((await submit(headS, month, head, ws.version)).status).toBe(200);
    expect(await all<Json>(env.DB, `SELECT node_id, status, draft_json, baseline_json FROM month_nodes WHERE month_id = ? ORDER BY node_id`, month)).toEqual(sub);
    expect(await one<Json>(env.DB, `SELECT COUNT(*) n FROM month_nodes WHERE held_status IS NOT NULL`)).toEqual({ n: 0 });
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('restoreOrReopen(changed) clears a held subtree and opens the child with fresh starts', async () => {
    await supsWork();
    expect((await reopen(month, head)).status).toBe(200);
    await restoreOrReopen(env.DB, env, month, area, true);
    const a = await nodeRow(month, area);
    expect([a.status, a.held_status, a.draft_json]).toEqual(['in_progress', null, null]);
    expect(JSON.parse(a.baseline_json)).toEqual({ [`n:${supA}`]: V(950, 200), [`n:${supB}`]: V(1050, 300), [`n:${supC}`]: V(1000, 100) });
    for (const n of [supA, supB, supC]) {
      const r = await nodeRow(month, n);
      expect([r.status, r.held_status, r.baseline_json, r.draft_json]).toEqual(['waiting', null, null, null]);
    }
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('only a submitted node can be reopened; not while a reopen below it is pending; unknown node 404', async () => {
    await supsWork();
    expect((await reopen(month, supA)).status).toBe(409); // in progress
    expect((await reopen(month, 99999)).status).toBe(404);
    expect((await api('POST', `/admin/months/${month}/nodes/${supB}/reopen`, supBS)).status).toBe(403);
    expect((await reopen(month, area)).status).toBe(200);
    // The area's reopen is pending (its sups are held): the head cannot be reopened until it resolves.
    const res = await reopen(month, head);
    expect(res.status).toBe(409);
    expect((await json(res)).detail).toBe('reopen_pending_below');
    // A reopen with nothing held below it is fine: Sup B (no child nodes) under a submitted area.
    const ws = await json(await getWs(areaS, month, area));
    expect((await submit(areaS, month, area, ws.version)).status).toBe(200);
    expect((await reopen(month, supB)).status).toBe(200);
    expect((await reopen(month, area)).status).toBe(200);
    expect(await statusOf(month, supB)).toEqual(['waiting', 'in_progress']);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('reopening in a complete department sets it running again; the resubmit completes it', async () => {
    await areaMoves50();
    for (const [s, n] of [[supAS, supA], [supBS, supB], [supCS, supC]] as const) {
      const ws = await json(await getWs(s, month, n));
      expect((await submit(s, month, n, ws.version)).status).toBe(200);
    }
    expect(await deptState(month, tt)).toBe('complete');
    expect((await reopen(month, supA)).status).toBe(200);
    expect(await deptState(month, tt)).toBe('running');
    const ws = await json(await getWs(supAS, month, supA));
    expect(ws.editable).toBe(true);
    const res = await submit(supAS, month, supA, ws.version);
    expect(await json(res)).toMatchObject({ deptComplete: true });
    expect(await deptState(month, tt)).toBe('complete');
    expect(await grandTotals(month, tt)).toEqual(start);
  });
});

// ---------- push forward ----------

describe('push forward', () => {
  it('an invalid draft is not submitted: the baseline is, used = baseline', async () => {
    const ws = await json(await getWs(headS, month, head));
    const v = valuesOf(ws);
    v[`n:${area}`]![PET] = 2999; // short by one
    expect((await putDraft(headS, month, head, v, ws.version)).status).toBe(200);
    const res = await push(month, head);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ used: 'baseline', status: 'submitted' });
    expect((await nodeRow(month, head)).status).toBe('submitted');
    expect(JSON.parse((await nodeRow(month, head)).draft_json)).toEqual({ [`n:${area}`]: start });
    expect((await nodeRow(month, area)).status).toBe('in_progress');
    const audit = await all<Json>(env.DB, `SELECT node_id, detail_json FROM audit WHERE action = 'node.push'`);
    expect(audit).toEqual([{ node_id: head, detail_json: JSON.stringify({ used: 'baseline' }) }]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a valid draft is submitted as it is, used = draft', async () => {
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    const v = valuesOf(ws);
    v[`n:${supA}`]![PET] = 950;
    v[`n:${supB}`]![PET] = 1050;
    expect((await putDraft(areaS, month, area, v, ws.version)).status).toBe(200);
    const res = await push(month, area);
    expect(await json(res)).toMatchObject({ used: 'draft' });
    expect((await leafGrid(month, r1))[PET]).toBe(665);
    expect((await leafGrid(month, r3))[PET]).toBe(630);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('no draft: the baseline; only in_progress nodes; a node with no manager progresses only by push', async () => {
    await run(env.DB, `UPDATE month_nodes SET manager_user_id = NULL WHERE month_id = ? AND node_id = ?`, month, head);
    expect((await push(month, area)).status).toBe(409); // waiting
    const res = await push(month, head);
    expect(await json(res)).toMatchObject({ used: 'baseline' });
    expect((await push(month, head)).status).toBe(409); // submitted
    expect((await api('POST', `/admin/months/${month}/nodes/${area}/push`, areaS)).status).toBe(403);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('push works on a reopened node and restores its held children', async () => {
    await supsWork();
    expect((await reopen(month, area)).status).toBe(200);
    expect(await json(await push(month, area))).toMatchObject({ used: 'draft' }); // draft = the submitted values
    expect(await statusOf(month, supB)).toEqual(['submitted', null]);
    expect(await statusOf(month, supA)).toEqual(['in_progress', null]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });
});

// ---------- board ----------

describe('board', () => {
  it('lists every node of the department with manager, status, times and an absolute link', async () => {
    await headSubmits();
    const res = await api('GET', `/admin/months/${month}/board?dept=${tt}`, admin);
    expect(res.status).toBe(200);
    const board = await json(res) as unknown as Json[];
    expect(board.map((b) => b.nodeId)).toEqual([head, area, supA, supB, supC]);
    expect(board[0]).toEqual({
      nodeId: head, name: 'Head', parentId: null, manager: 'Name head', managerEmail: 'head@example.com', status: 'submitted',
      openedAt: expect.any(String), submittedAt: expect.any(String), link: `http://x/m/${month}/n/${head}`,
    });
    expect(board[1]).toMatchObject({ nodeId: area, parentId: head, status: 'in_progress', submittedAt: null });
    expect(board[2]).toMatchObject({ nodeId: supA, status: 'waiting', openedAt: null, link: `http://x/m/${month}/n/${supA}` });
    expect((await api('GET', `/admin/months/${month}/board?dept=${tt}`, headS)).status).toBe(403);
    expect((await api('GET', `/admin/months/${month}/board`, admin)).status).toBe(400);
    expect((await api('GET', `/admin/months/99999/board?dept=${tt}`, admin)).status).toBe(404);
  });
});

// ---------- mid-month tree changes ----------

describe('mid-month tree changes', () => {
  const moveLeaf = (leaf: number, nodeId: number) => api('PATCH', `/admin/leaves/${leaf}`, admin, { nodeId });

  it('a leaf moved between two waiting sups under a waiting area is applied to the running month', async () => {
    const before = await Promise.all([area, supA, supB].map((n) => nodeRow(month, n)));
    const res = await moveLeaf(r2, supB);
    expect(res.status).toBe(200);
    expect((await json(res)).treeChange).toEqual({ appliedMonths: [month], skippedMonths: [] });
    expect(await leafNode(month, r2)).toBe(supB);
    // Every node on the paths is version-bumped, so an in-flight open of the area fails its guard.
    for (const [i, n] of [area, supA, supB].entries()) expect((await nodeRow(month, n)).version).toBe(before[i]!.version + 1);
    const audit = await all<Json>(env.DB, `SELECT detail_json FROM audit WHERE action = 'tree.apply_month'`);
    expect(audit.map((a) => JSON.parse(a.detail_json))).toEqual([{ appliedMonths: [month], skippedMonths: [] }]);
    // The area opens with the new split.
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    expect(ws.children.map((c: Json) => c.starts[PET])).toEqual([700, 1300, 1000]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('the same move while the area is in progress is skipped (next month); a loading month always takes it', async () => {
    await headSubmits();
    const res2 = await api('POST', '/admin/months', admin, { period: '2026-11' });
    const m2 = (await json(res2)).month.id;
    await upload(admin, m2, tt, [{ leafId: r1, values: V(1, 1) }, { leafId: r2, values: V(1, 1) }]);
    const res = await moveLeaf(r2, supB);
    expect(res.status).toBe(200);
    expect((await json(res)).treeChange).toEqual({ appliedMonths: [m2], skippedMonths: [month] });
    expect(await leafNode(month, r2)).toBe(supA);
    expect(await leafNode(m2, r2)).toBe(supB);
    const live = await one<{ node_id: number }>(env.DB, `SELECT node_id FROM leaves WHERE id = ?`, r2);
    expect(live!.node_id).toBe(supB); // the live change stands
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a held (reopen) node does not count as waiting', async () => {
    await supsWork();
    expect((await reopen(month, area)).status).toBe(200); // sups waiting, but held
    const res = await moveLeaf(r2, supC);
    expect((await json(res)).treeChange).toEqual({ appliedMonths: [], skippedMonths: [month] });
    expect(await leafNode(month, r2)).toBe(supA);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a node move follows the same rule; a complete month is skipped', async () => {
    // Area 2 under Head, waiting. Sup C moves from Area to Area 2: LCA Head is in progress -> skipped.
    const area2 = await mkNode(tt, 'Area 2', head);
    const res2 = await api('POST', '/admin/months', admin, { period: '2026-11' });
    const m2 = (await json(res2)).month.id;
    let res = await api('PATCH', `/admin/nodes/${supC}`, admin, { parentId: area2 });
    expect(res.status).toBe(200);
    // Month 1 has no Area 2 (created after it opened): skipped. Month 2 (loading) takes it.
    expect((await json(res)).treeChange).toEqual({ appliedMonths: [m2], skippedMonths: [month] });
    expect((await nodeRow(m2, supC)).parent_id).toBe(area2);
    expect((await nodeRow(month, supC)).parent_id).toBe(area);
    // Sup B -> Sup A (both waiting, LCA Area waiting) in month 1: applied.
    res = await api('PATCH', `/admin/nodes/${supB}`, admin, { parentId: supA });
    expect((await json(res)).treeChange).toEqual({ appliedMonths: [month, m2], skippedMonths: [] });
    expect((await nodeRow(month, supB)).parent_id).toBe(supA);
    await run(env.DB, `UPDATE month_depts SET state = 'complete' WHERE month_id = ?`, m2);
    res = await api('PATCH', `/admin/nodes/${supB}`, admin, { parentId: area });
    expect((await json(res)).treeChange).toEqual({ appliedMonths: [month], skippedMonths: [m2] });
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a manager change is applied immediately to running and loading months', async () => {
    await areaMoves50();
    const newU = await addUser('newsup');
    const newS = await login('newsup');
    const res2 = await api('POST', '/admin/months', admin, { period: '2026-11' });
    const m2 = (await json(res2)).month.id;
    const res = await api('PATCH', `/admin/nodes/${supA}`, admin, { managerUserId: newU });
    expect(res.status).toBe(200);
    expect((await json(res)).treeChange).toEqual({ appliedMonths: [month, m2], skippedMonths: [] });
    expect((await nodeRow(month, supA)).manager_user_id).toBe(newU);
    expect((await nodeRow(m2, supA)).manager_user_id).toBe(newU);
    // The new manager can work the turn; the old one has lost his edit rights.
    const ws = await json(await getWs(newS, month, supA));
    expect(ws.editable).toBe(true);
    expect((await getWs(supAS, month, supA)).status).toBe(403);
    expect((await submit(supAS, month, supA, ws.version)).status).toBe(403);
    expect((await submit(newS, month, supA, ws.version)).status).toBe(200);
    const audit = await all<Json>(env.DB, `SELECT node_id, detail_json FROM audit WHERE action = 'tree.apply_month'`);
    expect(audit).toEqual([{ node_id: supA, detail_json: JSON.stringify({ appliedMonths: [month, m2], skippedMonths: [] }) }]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('bulk-map: moved leaves are applied set-based by (from, to) pair', async () => {
    const res = await api('POST', '/admin/leaves/bulk-map', admin, {
      deptId: tt,
      rows: [
        { deliverySystem: 'DS', routeCode: 'R1', nodeName: 'Sup B' }, // A -> B: applied
        { deliverySystem: 'DS', routeCode: 'R2', nodeName: 'Sup B' }, // A -> B: applied
        { deliverySystem: 'DS', routeCode: 'R5', nodeName: 'Sup A' }, // C -> A: applied
        { deliverySystem: 'DS', routeCode: 'R3', nodeName: 'Sup B' }, // unchanged
      ],
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ created: 0, moved: 3, unchanged: 1, treeChange: { appliedMonths: [month], skippedMonths: [] } });
    expect(await leafNode(month, r1)).toBe(supB);
    expect(await leafNode(month, r2)).toBe(supB);
    expect(await leafNode(month, r5)).toBe(supA);
    expect(await grandTotals(month, tt)).toEqual(start);

    await headSubmits(); // area in progress now
    const res2 = await api('POST', '/admin/leaves/bulk-map', admin, {
      deptId: tt, rows: [{ deliverySystem: 'DS', routeCode: 'R1', nodeName: 'Sup A' }],
    });
    expect((await json(res2)).treeChange).toEqual({ appliedMonths: [], skippedMonths: [month] });
    expect(await leafNode(month, r1)).toBe(supB);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('bulk move with month history: only open months are read and sent; complete months are reported skipped', async () => {
    const boss = (await one<{ id: number }>(env.DB, `SELECT id FROM users WHERE username = 'boss'`))!.id;
    // 60 more live routes under Sup A, loaded into the running month with zero cases.
    await run(env.DB, `INSERT INTO leaves(dept_id, delivery_system, route_code, node_id, label)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) SELECT ?, 'DS', 'X' || i, ?, 'x' FROM n`, tt, supA);
    const file = (await one<{ id: number }>(env.DB, `SELECT id FROM month_files WHERE month_id = ?`, month))!.id;
    await run(env.DB, `INSERT INTO month_leaves(month_id, leaf_id, node_id, dept_id, file_id, delivery_system, route_code, values_json)
      SELECT ?, id, node_id, dept_id, ?, delivery_system, route_code, ? FROM leaves WHERE route_code LIKE 'X%'`,
      month, file, JSON.stringify(V(0, 0)));
    // Four past complete months and one loading month, each holding every route.
    const copyMonth = async (period: string, state: string): Promise<number> => {
      const m = (await json(await api('POST', '/admin/months', admin, { period }))).month.id;
      const f = (await run(env.DB, `INSERT INTO month_files(month_id, dept_id, name, uploaded_by, uploaded_at) VALUES (?, ?, 'f', ?, 'now')`, m, tt, boss)).lastRowId;
      await run(env.DB, `INSERT INTO month_leaves(month_id, leaf_id, node_id, dept_id, file_id, delivery_system, route_code, salesman_id, values_json)
        SELECT ?, leaf_id, node_id, dept_id, ?, delivery_system, route_code, salesman_id, values_json FROM month_leaves WHERE month_id = ?`, m, f, month);
      await run(env.DB, `UPDATE month_depts SET state = ? WHERE month_id = ?`, state, m);
      return m;
    };
    const past = [];
    for (const p of ['2026-06', '2026-07', '2026-08', '2026-09']) past.push(await copyMonth(p, 'complete'));
    const next = await copyMonth('2026-11', 'loading');
    const nextTotals = await grandTotals(next, tt);

    const binds: { sql: string; args: unknown[] }[] = [];
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const st = target.prepare(sql);
            return new Proxy(st, {
              get(t, k) {
                if (k === 'bind') return (...args: unknown[]) => { binds.push({ sql, args }); return t.bind(...(args as any[])); };
                const v = (t as any)[k];
                return typeof v === 'function' ? v.bind(t) : v;
              },
            });
          };
        }
        const v = (target as any)[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const { bulkMapLeaves } = await import('../../src/worker/services/hierarchy');
    const rows = [{ deliverySystem: 'DS', routeCode: 'R1', nodeName: 'Sup B' }, { deliverySystem: 'DS', routeCode: 'R2', nodeName: 'Sup B' }];
    for (let i = 1; i <= 60; i++) rows.push({ deliverySystem: 'DS', routeCode: `X${i}`, nodeName: 'Sup B' });
    const out = await bulkMapLeaves(db, boss, { deptId: tt, rows });
    expect(out.moved).toBe(62);
    expect(out.treeChange).toEqual({ appliedMonths: [month, next], skippedMonths: past });

    const moved = await all<{ month_id: number; n: number }>(env.DB,
      `SELECT month_id, COUNT(*) AS n FROM month_leaves WHERE node_id = ? GROUP BY month_id ORDER BY month_id`, supB);
    // Complete months keep their history (only R3, R4 under Sup B); open months take all 62 moves.
    expect(moved).toEqual([...past.map((m) => ({ month_id: m, n: 2 })), { month_id: month, n: 64 }, { month_id: next, n: 64 }]
      .sort((a, b) => a.month_id - b.month_id));

    // The move payload (bound into the three write statements) holds open-month groups only.
    const writes = binds.filter((b) => b.sql.includes('gok AS MATERIALIZED'));
    expect(writes).toHaveLength(3);
    for (const w of writes) {
      const groups = JSON.parse(w.args[0] as string) as { m: number; ids: number[] }[];
      expect(groups.map((g) => g.m).sort()).toEqual([month, next]);
      expect(groups.reduce((n, g) => n + g.ids.length, 0)).toBe(124);
    }
    expect(await grandTotals(month, tt)).toEqual(start);
    expect(await grandTotals(next, tt)).toEqual(nextTotals);
  });

  it('a move-propagation failure does not stop the manager change in the same edit', async () => {
    await areaMoves50();
    const newU = await addUser('newsup');
    const boss = (await one<{ id: number }>(env.DB, `SELECT id FROM users WHERE username = 'boss'`))!.id;
    let batches = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        // Batch 1: the live change. Batch 2: the move's reads (fails). Batch 3+: the manager change.
        if (key === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches === 2) throw new Error('D1 is down');
            return target.batch(stmts);
          };
        }
        const v = (target as any)[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const { updateNode } = await import('../../src/worker/services/hierarchy');
    const out = await updateNode(db, boss, supC, { parentId: supA, managerUserId: newU });
    expect(out.treeChange).toEqual({ appliedMonths: [month], skippedMonths: [], error: 'move_node: D1 is down' });
    expect((await nodeRow(month, supC)).manager_user_id).toBe(newU);
    expect((await nodeRow(month, supC)).parent_id).toBe(area);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a propagation failure leaves the live change in place and reports treeChange.error', async () => {
    let batches = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        // The live change (first batch) commits; propagation (later batches) fails.
        if (key === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches > 1) throw new Error('D1 is down');
            return target.batch(stmts);
          };
        }
        const v = (target as any)[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const { updateLeaf } = await import('../../src/worker/services/hierarchy');
    const boss = (await one<{ id: number }>(env.DB, `SELECT id FROM users WHERE username = 'boss'`))!.id;
    const out = await updateLeaf(db, boss, r2, { nodeId: supB });
    expect(out.treeChange).toEqual({ appliedMonths: [], skippedMonths: [], error: 'move_leaf: D1 is down' });
    expect((await one<{ node_id: number }>(env.DB, `SELECT node_id FROM leaves WHERE id = ?`, r2))!.node_id).toBe(supB);
  });
});

// ---------- races ----------

describe('races', () => {
  /** A DB that runs `racer` just before its `n`-th db.batch (the write, after the read batch). */
  function racingDb(racer: () => Promise<unknown>, n = 2): D1Database {
    let batches = 0;
    return new Proxy(env.DB, {
      get(target, key) {
        if (key === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches === n) await racer();
            return target.batch(stmts);
          };
        }
        const v = (target as any)[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }
  const bossId = async () => (await one<{ id: number }>(env.DB, `SELECT id FROM users WHERE username = 'boss'`))!.id;

  it('a reopen bumps every descendant: a sup draft in flight during the area reopen is 409 stale', async () => {
    await supsWork();
    const a = await json(await getWs(supAS, month, supA));
    const draftBefore = (await nodeRow(month, supA)).draft_json;
    const boss = await bossId();
    const db = racingDb(() => reopenNode(env.DB, env, boss, month, area));
    const err = await saveDraft(db, supAU, month, supA, { values: valuesOf(a), version: a.version }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(await statusOf(month, supA)).toEqual(['waiting', 'in_progress']);
    expect((await nodeRow(month, supA)).draft_json).toBe(draftBefore);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a sup submit racing the area reopen writes nothing: held statuses and leaves stay intact', async () => {
    await supsWork();
    const c = await json(await getWs(supCS, month, supC));
    const boss = await bossId();
    const db = racingDb(() => reopenNode(env.DB, env, boss, month, area));
    const err = await submitNode(db, env, month, supC, supCU, 'draft', { expectedVersion: c.version, asManager: true }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(await statusOf(month, supC)).toEqual(['waiting', 'in_progress']);
    expect(await statusOf(month, supB)).toEqual(['waiting', 'submitted']);
    expect(await all(env.DB, `SELECT id FROM audit WHERE action = 'node.submit' AND node_id = ?`, supC)).toEqual([]);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a submit whose child changed after the read writes nothing (child writes are conditioned on the child as read)', async () => {
    await headSubmits();
    const ws = await json(await getWs(areaS, month, area));
    const v = valuesOf(ws);
    v[`n:${supA}`]![PET] = 950;
    v[`n:${supB}`]![PET] = 1050;
    const ver = (await json(await putDraft(areaS, month, area, v, ws.version))).version;
    const db = racingDb(() => run(env.DB, `UPDATE month_nodes SET version = version + 1 WHERE month_id = ? AND node_id = ?`, month, supB));
    const err = await submitNode(db, env, month, area, areaU, 'draft', { expectedVersion: ver, asManager: true }).catch((e) => e);
    expect(err.status).toBe(409);
    expect((await nodeRow(month, area)).status).toBe('in_progress');
    expect((await nodeRow(month, area)).version).toBe(ver);
    expect((await nodeRow(month, supA)).status).toBe('waiting');
    expect((await leafGrid(month, r1))[PET]).toBe(700);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a reopen racing a reopen below it writes nothing (the pending reopen keeps its held statuses)', async () => {
    await supsWork();
    const boss = await bossId();
    // Head reopen reads, then the area is reopened, then the head's write runs.
    const db = racingDb(() => reopenNode(env.DB, env, boss, month, area), 2);
    const err = await reopenNode(db, env, boss, month, head).catch((e) => e);
    expect(err.status).toBe(409);
    expect(await statusOf(month, head)).toEqual(['submitted', null]);
    expect(await statusOf(month, area)).toEqual(['in_progress', null]);
    expect(await statusOf(month, supB)).toEqual(['waiting', 'submitted']);
    expect(await statusOf(month, supA)).toEqual(['waiting', 'in_progress']);
    expect(await grandTotals(month, tt)).toEqual(start);
  });

  it('a move whose path opens after the read is skipped, not applied', async () => {
    await run(env.DB, `UPDATE leaves SET node_id = ? WHERE id = ?`, supB, r2); // the live change
    const db = racingDb(async () => {
      const ws = await json(await getWs(headS, month, head));
      expect((await submit(headS, month, head, ws.version)).status).toBe(200); // the area opens
    });
    const out = await applyTreeChangeToOpenMonths(db, { kind: 'move_leaf', id: r2, fromParent: supA, toParent: supB });
    expect(out).toEqual({ appliedMonths: [], skippedMonths: [month] });
    expect(await leafNode(month, r2)).toBe(supA);
    expect(await grandTotals(month, tt)).toEqual(start);
  });
});
