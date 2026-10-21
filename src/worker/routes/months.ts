// Month cycle API. Mounted by routes/admin.ts AFTER its requireUser +
// requireAdmin guard, so every route here is admin-only.
import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import {
  addFile, createMonth, listMonths, monthContext, requiredDept, resetDept, startDept, updateMonth, uploadBatch,
} from '../services/months';
import { parseId } from '../services/masters';
import { h, p } from './handler';

const months = new Hono<AppEnv>();

months.get('/api/admin/months', h(async (c, db) => c.json({ months: await listMonths(db) })));
months.post('/api/admin/months', h(async (c, db, me, body) =>
  c.json({ month: await createMonth(db, me, await body()) }, 201)));
months.patch('/api/admin/months/:id', h(async (c, db, me, body) =>
  c.json({ month: await updateMonth(db, me, parseId(p(c, 'id')), await body()) })));
months.get('/api/admin/months/:id/context', h(async (c, db) =>
  c.json(await monthContext(db, parseId(p(c, 'id')), requiredDept(c.req.query('dept'))))));

months.post('/api/admin/months/:id/files', h(async (c, db, me, body) =>
  c.json(await addFile(db, me, parseId(p(c, 'id')), await body()), 201)));
months.post('/api/admin/months/:id/files/:fileId/batch', h(async (c, db, me, body) =>
  c.json(await uploadBatch(db, me, parseId(p(c, 'id')), parseId(p(c, 'fileId')), await body()))));

months.post('/api/admin/months/:id/depts/:deptId/reset', h(async (c, db, me) => {
  await resetDept(db, me, parseId(p(c, 'id')), parseId(p(c, 'deptId')));
  return c.json({ state: 'loading' });
}));
months.post('/api/admin/months/:id/depts/:deptId/start', h(async (c, db, me) =>
  c.json(await startDept(db, c.env, me, parseId(p(c, 'id')), parseId(p(c, 'deptId'))))));

export default months;
