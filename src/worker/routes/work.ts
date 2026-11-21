// Manager API: workspace, draft, submit, branch and "my tasks". Any signed-in
// user (requireUser, NOT the admin guard); who may see or change a node is
// decided per node in services/distribution.ts.
import { Hono } from 'hono';
import { requireUser, type AppEnv } from '../auth';
import { getBranch, getWorkspace, myTasks, saveDraft, submitNode } from '../services/distribution';
import { bad, int, parseId } from '../services/masters';
import { h, p, type Ctx } from './handler';

const work = new Hono<AppEnv>();
work.use('/api/months/*', requireUser);
work.use('/api/my/*', requireUser);

const ids = (c: Ctx) => [parseId(p(c, 'mid')), parseId(p(c, 'nid'))] as const;

work.get('/api/my/tasks', h(async (c, db, me) => c.json(await myTasks(db, me))));

work.get('/api/months/:mid/nodes/:nid', h(async (c, db) =>
  c.json(await getWorkspace(db, c.var.user, ...ids(c)))));
work.get('/api/months/:mid/nodes/:nid/branch', h(async (c, db) =>
  c.json(await getBranch(db, c.var.user, ...ids(c)))));
work.put('/api/months/:mid/nodes/:nid/draft', h(async (c, db, me, body) =>
  c.json(await saveDraft(db, me, ...ids(c), await body()))));
work.post('/api/months/:mid/nodes/:nid/submit', h(async (c, db, me, body) => {
  const [mid, nid] = ids(c);
  const expectedVersion = int((await body()).version, 'version');
  if (expectedVersion < 0) throw bad('version must be an integer of at least 0');
  return c.json(await submitNode(db, c.env, mid, nid, me, 'draft', { expectedVersion, asManager: true }));
}));

export default work;
