// Admin-only master data API. Logic and validation live in services/masters.ts.
import { syncPackSort, syncPackSortOnce } from '../services/packOrder';
import { mergePacksOnce } from '../services/packMerge';
import { Hono } from 'hono';
import { requireAdmin, requireUser, type AppEnv } from '../auth';
import { h, p } from './handler';
import { backupIndex, backupPage, listAudit } from '../services/export';
import importRoutes from './imports';
import { deleteUser, getPositions, listAccounts, listKaLinks, setEmployeeId, setEmployeeIds, setKaLink, setPositions, syncNextAccount, unlockUser, usernamesFromIds, usernamesFromIdsOnce } from '../services/accounts';
import { applyHierarchySync, deleteHead, deleteHierarchy, listPeople, previewHierarchySync, removeKaFromOps } from '../services/hierarchySync';
import monthRoutes from './months';
import {
  bulkMapLeaves, createLeaf, createNode, deleteLeaf, deleteNode, listLeaves, listNodes, optionalDept,
  updateLeaf, updateNode,
} from '../services/hierarchy';
import {
  createDepartment, createPack, createUser, getCapPct, listDepartments,
  deletePack, listAddedPacks, listPacks, listUsers, renamePack, parseId, setCapPct, setUserPassword, updateDepartment, updatePack, updateUser,
} from '../services/masters';

const admin = new Hono<AppEnv>();
admin.use('/api/admin/*', requireUser, requireAdmin);

admin.get('/api/admin/users', h(async (c, db) => c.json({ users: await listUsers(db) })));
admin.post('/api/admin/users', h(async (c, db, me, body) =>
  c.json({ user: await createUser(db, me, await body()) }, 201)));
admin.patch('/api/admin/users/:id', h(async (c, db, me, body) =>
  c.json({ user: await updateUser(db, me, parseId(p(c, 'id')), await body()) })));
admin.post('/api/admin/users/:id/password', h(async (c, db, me, body) => {
  const r = await setUserPassword(db, me, parseId(p(c, 'id')), await body());
  return c.json({ ok: true, ...r });
}));
admin.get('/api/admin/accounts', h(async (c, db, me) => { await usernamesFromIdsOnce(db, me); return c.json(await listAccounts(db)); }));
admin.post('/api/admin/users/:id/unlock', h(async (c, db, me) => c.json(await unlockUser(db, me, parseId(p(c, 'id'))))));
admin.post('/api/admin/accounts/sync', h(async (c, db, me) => c.json(await syncNextAccount(db, me))));
admin.delete('/api/admin/users/:id', h(async (c, db, me) => c.json(await deleteUser(db, me, parseId(p(c, 'id'))))));
admin.get('/api/admin/positions', h(async (c, db) => c.json({ positions: await getPositions(db) })));
admin.put('/api/admin/positions', h(async (c, db, me, body) => c.json(await setPositions(db, me, await body()))));
// The employee ID is the login: setting IDs also sets the usernames.
admin.post('/api/admin/employee-ids', h(async (c, db, me, body) => { const r = await setEmployeeIds(db, me, await body()); const u = await usernamesFromIds(db, me); return c.json({ ...r, logins: u }); }));
admin.put('/api/admin/users/:id/employee-id', h(async (c, db, me, body) => { const r = await setEmployeeId(db, me, parseId(p(c, 'id')), await body()); const u = await usernamesFromIds(db, me); return c.json({ ...r, logins: u }); }));
admin.get('/api/admin/ka-links', h(async (c, db) => c.json({ links: await listKaLinks(db) })));
admin.put('/api/admin/ka-links/:id', h(async (c, db, me, body) => c.json(await setKaLink(db, me, parseId(p(c, 'id')), await body()))));

admin.get('/api/admin/departments', h(async (c, db) => c.json({ departments: await listDepartments(db) })));
admin.post('/api/admin/departments', h(async (c, db, me, body) =>
  c.json({ department: await createDepartment(db, me, await body()) }, 201)));
admin.patch('/api/admin/departments/:id', h(async (c, db, me, body) =>
  c.json({ department: await updateDepartment(db, me, parseId(p(c, 'id')), await body()) })));

admin.get('/api/admin/packs', h(async (c, db) => { await mergePacksOnce(db); await syncPackSortOnce(db); return c.json({ packs: await listPacks(db) }); }));
admin.post('/api/admin/packs', h(async (c, db, me, body) =>
  { const pack = await createPack(db, me, await body()); await syncPackSort(db); return c.json({ pack }, 201); }));
admin.get('/api/admin/packs-added', h(async (c, db) => c.json({ packs: await listAddedPacks(db) })));
admin.post('/api/admin/packs/:code/rename', h(async (c, db, me, body) => { const pack = await renamePack(db, me, p(c, 'code'), await body()); await syncPackSort(db); return c.json({ pack }); }));
admin.delete('/api/admin/packs/:code', h(async (c, db, me) => { await deletePack(db, me, p(c, 'code')); return c.json({ ok: true }); }));
admin.patch('/api/admin/packs/:code', h(async (c, db, me, body) =>
  c.json({ pack: await updatePack(db, me, p(c, 'code'), await body()) })));

admin.get('/api/admin/settings', h(async (c, db) => c.json({ capPct: await getCapPct(db) })));
admin.put('/api/admin/settings', h(async (c, db, me, body) =>
  c.json({ capPct: await setCapPct(db, me, await body()) })));

admin.get('/api/admin/people', h(async (c, db) => c.json({ people: await listPeople(db) })));
admin.post('/api/admin/hierarchy/sync/preview', h(async (c, db, _me, body) => c.json(await previewHierarchySync(db, await body()))));
admin.post('/api/admin/hierarchy/remove-ka-from-ops', h(async (c, db, me, body) => c.json(await removeKaFromOps(db, me, await body()))));
admin.post('/api/admin/hierarchy/delete-all', h(async (c, db, me, body) => c.json(await deleteHierarchy(db, me, await body()))));
admin.delete('/api/admin/departments/:id', h(async (c, db, me) => { await deleteHead(db, me, parseId(p(c, 'id'))); return c.json({ ok: true }); }));
admin.post('/api/admin/hierarchy/sync/apply', h(async (c, db, me, body) => c.json(await applyHierarchySync(db, me, await body()))));
admin.get('/api/admin/nodes', h(async (c, db) =>
  c.json({ nodes: await listNodes(db, optionalDept(c.req.query('dept'))) })));
admin.post('/api/admin/nodes', h(async (c, db, me, body) =>
  c.json({ node: await createNode(db, me, await body()) }, 201)));
admin.patch('/api/admin/nodes/:id', h(async (c, db, me, body) =>
  c.json(await updateNode(db, me, parseId(p(c, 'id')), await body()))));
admin.delete('/api/admin/nodes/:id', h(async (c, db, me) => {
  await deleteNode(db, me, parseId(p(c, 'id')));
  return c.json({ ok: true });
}));

admin.get('/api/admin/leaves', h(async (c, db) =>
  c.json({ leaves: await listLeaves(db, optionalDept(c.req.query('dept'))) })));
admin.post('/api/admin/leaves', h(async (c, db, me, body) =>
  c.json({ leaf: await createLeaf(db, me, await body()) }, 201)));
// Registered before /:id routes; "bulk-map" is not a numeric id anyway.
admin.post('/api/admin/leaves/bulk-map', h(async (c, db, me, body) =>
  c.json(await bulkMapLeaves(db, me, await body()))));
admin.patch('/api/admin/leaves/:id', h(async (c, db, me, body) =>
  c.json(await updateLeaf(db, me, parseId(p(c, 'id')), await body()))));
admin.delete('/api/admin/leaves/:id', h(async (c, db, me) => {
  await deleteLeaf(db, me, parseId(p(c, 'id')));
  return c.json({ ok: true });
}));

admin.get('/api/admin/audit', h(async (c, db) =>
  c.json(await listAudit(db, { month: c.req.query('month'), limit: c.req.query('limit'), before: c.req.query('before') }))));
// Paged: no `table` -> the table list; `table` (+ after, limit) -> one bounded page.
admin.get('/api/admin/backup', h(async (c, db, me) => {
  const table = c.req.query('table');
  if (table === undefined || table === '') return c.json(await backupIndex(db, me));
  return c.json(await backupPage(db, { table, after: c.req.query('after'), limit: c.req.query('limit') }));
}));

// Month and import routes sit behind the guard registered above (registered after it).
admin.route('/', monthRoutes);
admin.route('/', importRoutes);

export default admin;
