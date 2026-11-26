// Target cycle API (handover design): data store, Commercial Director step,
// calculation, Head approval, rules settings, notifications, benchmarks.
// Logic and validation live in services/cycle*.ts.
import { Hono } from 'hono';
import { requireUser, type AppEnv } from '../auth';
import { h, p, type Ctx } from './handler';
import { benchmarks, salesMonths, setSalesman } from '../services/benchmarks';
import {
  applyCalc, approveHeadAll, getCalc, getCycle, getProgress, headSummary, listCycles, myApprovals, recallFromCd, restartHead, returnFromCd, revertCycle, returnHead,
  saveCd, saveSettings, sendToCd, sendToHeadAll, setDeptTarget, submitCd,
} from '../services/cycle';
import {
  clearAllData, clearRouteMonths, dataStatus, listCdRoles, logUpload, packSubs, readMonthData, readOrg, readRouteRows, saveMonthData, setCdRoles, setPackSubs,
  setChannels, setDeptWorkspace, uploadRouteRows, workspace,
  setupHistory, undoSetupChange,
} from '../services/cycleData';
import { forbidden, parseId } from '../services/masters';
import { listNotifications, markRead } from '../services/notify';
import { getRules, setRules } from '../services/rulesSettings';
import { getBrand, setBrand } from '../services/brand';
import { getPackPlace, setPackPlace } from '../services/packPlace';
import { syncPackSort, syncPackSortOnce } from '../services/packOrder';
import { mailStatus, setMailOn, setUserEmails } from '../services/mailSettings';

const cycle = new Hono<AppEnv>();

const ws = (c: Ctx) => workspace(c.req.param('ws'));
const per = (c: Ctx) => p(c, 'period');
/** A JSON string built by SQLite, sent as is. */
const raw = (c: Ctx, json: string) => c.body(json, 200, { 'Content-Type': 'application/json; charset=UTF-8' });

/** Admin, or the Commercial Director of this workspace. */
function adminOrCd(c: Ctx): void {
  const u = c.var.user;
  if (u.role !== 'admin' && !u.cd.includes(ws(c))) throw forbidden();
}

// ---------- admin only ----------
// Mounted after routes/admin.ts, whose `/api/admin/*` guard (requireUser +
// requireAdmin) already runs before these handlers.

cycle.get('/api/admin/rules', h(async (c, db) => c.json(await getRules(db))));
cycle.put('/api/admin/rules', h(async (c, db, me, body) => c.json(await setRules(db, me, await body()))));
cycle.get('/api/admin/mail', h(async (c, db) => c.json(await mailStatus(db, c.env))));
cycle.put('/api/admin/mail', h(async (c, db, me, body) => c.json(await setMailOn(db, me, await body()))));
cycle.post('/api/admin/user-emails', h(async (c, db, me, body) => c.json(await setUserEmails(db, me, await body()))));
cycle.put('/api/admin/pack-place', h(async (c, db, me, body) => { const r = await setPackPlace(db, me, await body()); await syncPackSort(db); return c.json(r); }));
cycle.put('/api/admin/approval-brand', h(async (c, db, me, body) => c.json(await setBrand(db, me, await body()))));

cycle.put('/api/admin/departments/:id/workspace', h(async (c, db, me, body) => {
  await setDeptWorkspace(db, me, parseId(p(c, 'id')), await body());
  return c.json({ ok: true });
}));
cycle.put('/api/admin/departments/:id/channels', h(async (c, db, me, body) =>
  c.json(await setChannels(db, me, parseId(p(c, 'id')), await body()))));
cycle.get('/api/admin/departments/setup-history', h(async (c, db) => c.json(await setupHistory(db))));
cycle.post('/api/admin/departments/setup-history/:id/undo', h(async (c, db, me) => {
  await undoSetupChange(db, me, parseId(p(c, 'id')));
  return c.json({ ok: true });
}));
cycle.put('/api/admin/packs-sub', h(async (c, db, me, body) => c.json(await setPackSubs(db, me, await body()))));
cycle.get('/api/admin/cd-roles', h(async (c, db) => c.json({ roles: await listCdRoles(db) })));
cycle.put('/api/admin/users/:id/cd', h(async (c, db, me, body) => c.json(await setCdRoles(db, me, parseId(p(c, 'id')), await body()))));

cycle.post('/api/admin/data/:ws/clear-all', h(async (c, db, me, body) => c.json(await clearAllData(db, me, ws(c), await body()))));
cycle.post('/api/admin/data/:ws/routes/clear', h(async (c, db, me, body) => c.json(await clearRouteMonths(db, me, ws(c), await body()))));
cycle.post('/api/admin/data/:ws/routes', h(async (c, db, me, body) => c.json(await uploadRouteRows(db, me, ws(c), await body()))));
cycle.post('/api/admin/data/:ws/log', h(async (c, db, me, body) => {
  await logUpload(db, me, ws(c), await body());
  return c.json({ ok: true });
}));
cycle.post('/api/admin/data/:ws/months', h(async (c, db, me, body) => {
  const b = await body();
  const r = await saveMonthData(db, me, ws(c), b);
  // A target file with its own order: the packs follow it everywhere.
  if (['new_target', 'target_upload', 'aop_dept'].includes(String(b.kind))) await syncPackSort(db);
  return c.json(r);
}));

cycle.put('/api/admin/cycle/:ws/:period/settings', h(async (c, db, me, body) => c.json({ settings: await saveSettings(db, me, ws(c), per(c), await body()) })));
cycle.post('/api/admin/cycle/:ws/:period/cd/send', h(async (c, db, me, body) => {
  await sendToCd(db, me, ws(c), per(c), await body());
  return c.json({ ok: true });
}));
cycle.post('/api/admin/cycle/:ws/:period/cd/recall', h(async (c, db, me) => {
  await recallFromCd(db, me, ws(c), per(c));
  return c.json({ ok: true });
}));
cycle.put('/api/admin/cycle/:ws/:period/dept-target', h(async (c, db, me, body) => {
  await setDeptTarget(db, me, ws(c), per(c), await body());
  return c.json({ ok: true });
}));
cycle.put('/api/admin/cycle/:ws/:period/calc', h(async (c, db, me, body) => c.json(await applyCalc(db, me, ws(c), per(c), await body()))));
cycle.post('/api/admin/cycle/:ws/:period/heads/:deptId/send', h(async (c, db, me) =>
  c.json(await sendToHeadAll(db, me, ws(c), per(c), parseId(p(c, 'deptId')), c.env))));
cycle.post('/api/admin/cycle/:ws/:period/revert', h(async (c, db, me) => {
  await revertCycle(db, me, ws(c), per(c));
  return c.json({ ok: true });
}));
cycle.post('/api/admin/cycle/:ws/:period/heads/:deptId/restart', h(async (c, db, me) => {
  await restartHead(db, me, ws(c), per(c), parseId(p(c, 'deptId')));
  return c.json({ ok: true });
}));

// ---------- signed-in users ----------
// `/api/my/*` and `/api/months/*` are already guarded by routes/work.ts (mounted before).
cycle.use('/api/cycle/*', requireUser);
cycle.use('/api/data/*', requireUser);

// Data reads: Admin and the CD (others see sales through their own scope: benchmarks).
cycle.get('/api/data/:ws/status', h(async (c, db) => { adminOrCd(c); return c.json({ status: await dataStatus(db, ws(c)) }); }));
cycle.get('/api/data/:ws/routes', h(async (c, db) => { adminOrCd(c); return raw(c, await readRouteRows(db, ws(c), c.req.query('kind'), c.req.query('month'))); }));
cycle.get('/api/data/:ws/months', h(async (c, db) => { adminOrCd(c); return raw(c, await readMonthData(db, ws(c), c.req.query('kind'))); }));
cycle.get('/api/data/:ws/org', h(async (c, db) => { adminOrCd(c); await syncPackSortOnce(db); return c.json(await readOrg(db, ws(c))); }));
cycle.get('/api/data/:ws/pack-place', h(async (c, db) => { adminOrCd(c); return c.json({ place: await getPackPlace(db) }); }));
cycle.get('/api/data/:ws/approval-brand', h(async (c, db) => { adminOrCd(c); return c.json(await getBrand(db)); }));
cycle.get('/api/data/packs-sub', h(async (c, db) => c.json(await packSubs(db))));
cycle.get('/api/data/:ws/sales-months', h(async (c, db) => c.json({ months: await salesMonths(db, ws(c)) })));

cycle.get('/api/cycle/:ws', h(async (c, db) => { adminOrCd(c); return c.json({ cycles: await listCycles(db, ws(c)) }); }));
cycle.get('/api/cycle/:ws/:period', h(async (c, db) => c.json(await getCycle(db, c.var.user, ws(c), per(c)))));
cycle.get('/api/cycle/:ws/:period/progress', h(async (c, db) => c.json(await getProgress(db, c.var.user, ws(c), per(c)))));
cycle.get('/api/cycle/:ws/:period/heads/:deptId/summary', h(async (c, db) =>
  c.json(await headSummary(db, c.var.user, ws(c), per(c), parseId(p(c, 'deptId'))))));
cycle.get('/api/cycle/:ws/:period/calc', h(async (c, db) => raw(c, await getCalc(db, c.var.user, ws(c), per(c)))));
cycle.put('/api/cycle/:ws/:period/cd', h(async (c, db, _me, body) => c.json(await saveCd(db, c.var.user, ws(c), per(c), await body()))));
cycle.post('/api/cycle/:ws/:period/cd/submit', h(async (c, db) => c.json(await submitCd(db, c.var.user, ws(c), per(c)))));
cycle.post('/api/cycle/:ws/:period/cd/return', h(async (c, db, _me, body) => {
  await returnFromCd(db, c.var.user, ws(c), per(c), await body());
  return c.json({ ok: true });
}));
cycle.post('/api/cycle/:ws/:period/heads/:deptId/approve', h(async (c, db) =>
  c.json({ ok: true, ...(await approveHeadAll(db, c.env, c.var.user, ws(c), per(c), parseId(p(c, 'deptId')))) })));
cycle.post('/api/cycle/:ws/:period/heads/:deptId/return', h(async (c, db, _me, body) => {
  await returnHead(db, c.var.user, ws(c), per(c), parseId(p(c, 'deptId')), await body());
  return c.json({ ok: true });
}));

cycle.get('/api/my/approvals', h(async (c, db, me) => c.json({ approvals: await myApprovals(db, me) })));
cycle.get('/api/my/notifications', h(async (c, db, me) => c.json(await listNotifications(db, me))));
cycle.post('/api/my/notifications/read', h(async (c, db, me) => {
  await markRead(db, me);
  return c.json({ ok: true });
}));

cycle.get('/api/months/:mid/nodes/:nid/benchmarks', h(async (c, db) =>
  raw(c, await benchmarks(db, c.var.user, parseId(p(c, 'mid')), parseId(p(c, 'nid')), c.req.query('months')))));
cycle.put('/api/months/:mid/leaves/:leafId/salesman', h(async (c, db, _me, body) =>
  c.json(await setSalesman(db, c.var.user, parseId(p(c, 'mid')), parseId(p(c, 'leafId')), await body()))));

export default cycle;
