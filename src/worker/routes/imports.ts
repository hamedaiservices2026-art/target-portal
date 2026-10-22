// Admin bulk import (Task E). Mounted from routes/admin.ts behind its
// requireUser + requireAdmin guard; the JSON content-type guard is global (index.ts).
import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { h } from './handler';
import {
  applyHierarchy, applyPacks, applyUsers, previewHierarchy, previewPacks, previewUsers, stagePassword,
} from '../services/imports';

const imports = new Hono<AppEnv>();

imports.post('/api/admin/import/users/preview', h(async (c, db, me, body) => c.json(await previewUsers(db, me, await body()))));
imports.post('/api/admin/import/users/password', h(async (c, db, me, body) => c.json(await stagePassword(db, me, await body()))));
imports.post('/api/admin/import/users/apply', h(async (c, db, me, body) => c.json(await applyUsers(db, me, await body()))));
imports.post('/api/admin/import/packs/preview', h(async (c, db, _me, body) => c.json(await previewPacks(db, await body()))));
imports.post('/api/admin/import/packs/apply', h(async (c, db, me, body) => c.json(await applyPacks(db, me, await body()))));
imports.post('/api/admin/import/hierarchy/preview', h(async (c, db, _me, body) => c.json(await previewHierarchy(db, await body()))));
imports.post('/api/admin/import/hierarchy/apply', h(async (c, db, me, body) => c.json(await applyHierarchy(db, me, await body()))));

export default imports;
