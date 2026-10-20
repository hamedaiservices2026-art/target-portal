// Admin-only master data API. Logic and validation live in services/masters.ts.
import { Hono, type Context } from 'hono';
import { requireAdmin, requireUser, type AppEnv } from '../auth';
import {
  ApiError, asObject, createDepartment, createPack, createUser, getCapPct, listDepartments,
  listPacks, listUsers, parseId, setCapPct, setUserPassword, updateDepartment, updatePack, updateUser,
} from '../services/masters';

const admin = new Hono<AppEnv>();
admin.use('/api/admin/*', requireUser, requireAdmin);

type Ctx = Context<AppEnv>;
const p = (c: Ctx, name: string): string => c.req.param(name) ?? '';

/** Wraps a handler: ApiError becomes its JSON response, anything else propagates. */
const h = (fn: (c: Ctx, db: D1Database, actor: number, body: () => Promise<Record<string, unknown>>) => Promise<Response>) =>
  async (c: Ctx): Promise<Response> => {
    try {
      const body = async () => asObject(await c.req.json().catch(() => null));
      return await fn(c, c.env.DB, c.var.user.id, body);
    } catch (e) {
      if (e instanceof ApiError) return c.json(e.body, e.status);
      throw e;
    }
  };

admin.get('/api/admin/users', h(async (c, db) => c.json({ users: await listUsers(db) })));
admin.post('/api/admin/users', h(async (c, db, me, body) =>
  c.json({ user: await createUser(db, me, await body()) }, 201)));
admin.patch('/api/admin/users/:id', h(async (c, db, me, body) =>
  c.json({ user: await updateUser(db, me, parseId(p(c, 'id')), await body()) })));
admin.post('/api/admin/users/:id/password', h(async (c, db, me, body) => {
  await setUserPassword(db, me, parseId(p(c, 'id')), await body());
  return c.json({ ok: true });
}));

admin.get('/api/admin/departments', h(async (c, db) => c.json({ departments: await listDepartments(db) })));
admin.post('/api/admin/departments', h(async (c, db, me, body) =>
  c.json({ department: await createDepartment(db, me, await body()) }, 201)));
admin.patch('/api/admin/departments/:id', h(async (c, db, me, body) =>
  c.json({ department: await updateDepartment(db, me, parseId(p(c, 'id')), await body()) })));

admin.get('/api/admin/packs', h(async (c, db) => c.json({ packs: await listPacks(db) })));
admin.post('/api/admin/packs', h(async (c, db, me, body) =>
  c.json({ pack: await createPack(db, me, await body()) }, 201)));
admin.patch('/api/admin/packs/:code', h(async (c, db, me, body) =>
  c.json({ pack: await updatePack(db, me, p(c, 'code'), await body()) })));

admin.get('/api/admin/settings', h(async (c, db) => c.json({ capPct: await getCapPct(db) })));
admin.put('/api/admin/settings', h(async (c, db, me, body) =>
  c.json({ capPct: await setCapPct(db, me, await body()) })));

export default admin;
