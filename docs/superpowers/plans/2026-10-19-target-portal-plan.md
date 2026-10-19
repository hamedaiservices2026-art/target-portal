# Target Management Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bilingual (EN/AR) web portal where Pepsi sales managers rebalance monthly case targets top-down through an admin-defined hierarchy under a 5% cap, with totals that never drift, exported back in the import format.

**Architecture:** One Cloudflare Worker serves a Preact single-page app (static assets) and a JSON API (Hono) over Cloudflare D1. All business rules (caps, rounding, scaling, forecast checks) live in pure TypeScript modules under `src/shared/`, used by both browser and Worker and covered by unit tests. Excel is read and written in the browser; the Worker only receives checked, normalized data.

**Tech Stack:** TypeScript, Cloudflare Workers + Static Assets, D1 (SQLite), Hono, Preact + preact-iso, Vite, Vitest (+ `@cloudflare/vitest-pool-workers` for Worker/D1 tests), Playwright (pre-installed Chromium), `read-excel-file` / `write-excel-file`, Brevo HTTP email API. Use latest stable versions at build time and pin them in `package.json`.

**Spec:** `docs/design.md` (also in the claude.ai project as `claude/2026-10-19-target-portal-design.md`). Approved UI mockup: `claude/mockups/distribution-screen-v4.html` (copy at `docs/mockups/distribution-screen-v4.html`).

## Global Constraints

- Hosting: Cloudflare **free plan** only; no paid add-ons, no custom domain ($0).
- Cap: `C = floor(capPct × T / 100)`, default `capPct = 5`, admin-editable.
- Pass rules per pack: Σvᵢ = T; |vᵢ − sᵢ| ≤ C; Σ max(0, vᵢ − sᵢ) ≤ C.
- Whole cases only; every rounding uses largest-remainder (ties: larger value first, then key ascending) so totals never change.
- Pack groups are exactly `CSD`, `Water`, `LRB-Others`; no sub-groups.
- Forecast/export columns, in order: `Period (YYYY-MM)`, `Delivery System`, `Route Code`, `Salesman ID`, `Sales Target Category`, `Cases`.
- Leaf identity: `Delivery System + Route Code`. Salesman ID is per month.
- Login: username + password only. Roles: `admin`, `manager`.
- UI: English and Arabic; Arabic is full RTL; Western digits; pack codes never translated.
- Flow is top-down; no reject button; admin can reopen / push forward.
- The owner never touches code, servers or the database for a normal month.
- Per-request CPU on free Workers is small: no Excel parsing on the server; batch writes (≤ 200 leaves per request).

## Review Focus

1. **Excel cell types:** Route Code / Salesman ID come as numbers or text with spaces or leading zeros; Period comes as text `2026-10` or as an Excel date. Expect them normalized to trimmed strings and `YYYY-MM`. Test in Task 5.
2. **Typed numbers:** `1,200`, ` 35 `, Arabic-Indic digits `٣٥٠`, `12.5`, `-3`, empty. Expect: the first three are accepted; decimals and negatives are rejected with a visible error; empty is not saved as 0 silently. Test in Task 3.
3. **Two writers on one node:** a manager in two tabs, or the admin pushing forward while the manager saves. Expect the stale write to be rejected with "changed elsewhere, reload". Test in Task 11.
4. **Session expiry mid-edit:** expect the manager's unsaved numbers to survive re-login. Test in Task 16.
5. **Packs edited after a month opened:** expect the open month to keep the pack list it started with. Test in Task 10.

---

## File Structure

```
target-portal/
  wrangler.jsonc                 Worker, assets, D1 binding, cron
  migrations/0001_init.sql       D1 schema
  src/shared/                    pure, shared by browser + Worker
    types.ts                     Grid, PackGroup, ChildKey, Issue, …
    rounding.ts                  largestRemainder
    rules.ts                     capFor, checkPack, checkAll, parseCaseInput
    scaling.ts                   rescale
    forecast.ts                  normalizeForecastRows, checkForecast, compareToTotals
    tree.ts                      subtree/ancestor helpers over node lists
  src/worker/
    index.ts                     Hono app, static assets, scheduled()
    db.ts                        typed D1 helpers (one, all, run, batch)
    auth.ts                      hashing, sessions, middleware
    routes/{auth,admin,months,work}.ts
    services/{masters,hierarchy,months,distribution,flow,export,audit}.ts
    email.ts, emailTemplates.ts
  src/web/
    main.tsx, app.tsx, api.ts
    i18n/{index.ts,en.ts,ar.ts}
    pages/{Login,Home,Distribute,Branch}.tsx
    pages/admin/{Users,Departments,Packs,Settings,Hierarchy,Months,MonthDetail,History}.tsx
    components/{DistributionTable,Filters,GroupTabs,StatusBadge,Layout}.tsx
    excel.ts                     browser xlsx read/write wrappers
  test/shared/*.test.ts          pure unit tests (Vitest, node)
  test/worker/*.test.ts          API/D1 tests (vitest-pool-workers)
  test/e2e/*.spec.ts             Playwright against `wrangler dev`
  scripts/seed-dev.ts            local demo data (4 TT DMM routes like the mockup)
  docs/design.md, docs/mockups/, docs/OWNER-GUIDE.md
```

Shared names used across tasks (defined in `src/shared/types.ts`, Task 1):

```ts
export type PackCode = string;
export type PackGroup = 'CSD' | 'Water' | 'LRB-Others';
export type Grid = Record<PackCode, number>;           // whole cases per pack
export type ChildKey = `n:${number}` | `l:${number}`;   // child node or leaf
export type NodeStatus = 'waiting' | 'in_progress' | 'submitted';
export interface Issue { level: 'error' | 'warning'; code: IssueCode; line?: number; detail: string }
export type IssueCode = 'unknown_pack' | 'period_mismatch' | 'bad_cases' | 'duplicate'
  | 'unmapped_leaf' | 'leaf_in_other_file' | 'blank_salesman' | 'split_salesman'
  | 'all_zero_leaf' | 'missing_pack';
```

---

### Task 0: Verify platform assumptions

**Files:** Create `docs/decisions.md`

- [ ] **Step 1:** Look up the current Cloudflare **free** limits for Workers (CPU ms/request, requests/day, cron triggers) and D1 (rows written/day, rows read/day, DB size, max bound params). Record each with source URL and date.
- [ ] **Step 2:** Check them against the load: ~30k leaf-pack values/month stored as ≤ 3,000 packed rows, ≤ 200 rows/request. Record pass/fail. If anything fails, stop and report to the owner before Task 1.
- [ ] **Step 3:** Confirm that the Brevo free plan (or the best $0 alternative) can send via HTTPS API with a single verified sender address and **no custom domain**. Record the daily limit and the setup steps the owner must do.
- [ ] **Step 4:** Commit: `git add docs/decisions.md && git commit -m "docs: verify free-plan limits and email provider"`

### Task 1: Scaffold project

**Files:** Create `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts` (two projects: `shared` = node, `worker` = workers pool), `wrangler.jsonc`, `src/worker/index.ts`, `src/web/main.tsx`, `src/shared/types.ts`, `test/worker/health.test.ts`, `.gitignore`. Copy the spec and mockup into `docs/`.

**Interfaces:**
- Produces: `GET /api/health → {ok: true}`; scripts `npm run dev` (vite build --watch + wrangler dev), `npm test`, `npm run e2e`, `npm run deploy`; D1 binding name `DB`; assets dir `dist/`.

- [ ] **Step 1:** Write `test/worker/health.test.ts`: `SELF.fetch('http://x/api/health')` returns 200 with `{ ok: true }`.
- [ ] **Step 2:** Run `npm test -- health` → FAIL (no app).
- [ ] **Step 3:** Implement a Hono app in `src/worker/index.ts` with `/api/health`, all other non-`/api` paths served from assets (SPA fallback to `index.html`). Add `src/shared/types.ts` exactly as in File Structure.
- [ ] **Step 4:** Run `npm test` → PASS. Run `npm run build` → `dist/index.html` exists.
- [ ] **Step 5:** Commit `chore: scaffold worker, web app and tests`.

### Task 2: Largest-remainder rounding

**Files:** Create `src/shared/rounding.ts`; Test `test/shared/rounding.test.ts`

**Interfaces:**
- Produces: `largestRemainder(items: {key: string; value: number}[], target: number): Record<string, number>`. Returns non-negative integers summing exactly to `target` (an integer ≥ 0). `value`s are real shares (any scale; they are normalized to `target`). Ties go to the larger `value`, then `key` ascending. If all values are 0, split `target` evenly (remainder to keys ascending).

- [ ] **Step 1: Write failing tests**

```ts
expect(largestRemainder([{key:'a',value:665.5},{key:'b',value:284.5}], 950)).toEqual({a:666,b:284}); // tie → larger value
expect(largestRemainder([{key:'a',value:1},{key:'b',value:1},{key:'c',value:1}], 10)).toEqual({a:4,b:3,c:3});
expect(largestRemainder([{key:'x',value:0},{key:'y',value:0}], 5)).toEqual({x:3,y:2});
expect(largestRemainder([{key:'a',value:83.03},{key:'b',value:728.96}], 812)).toEqual({a:83,b:729});
// property: random inputs always sum to target and each result is within 1 of its exact share
```

- [ ] **Step 2:** Run `npm test -- rounding` → FAIL.
- [ ] **Step 3:** Implement: scale shares to `target`, floor, hand out the remainder by fractional part desc, then value desc, then key asc.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(shared): largest-remainder rounding`.

### Task 3: Redistribution rules

**Files:** Create `src/shared/rules.ts`; Test `test/shared/rules.test.ts`

**Interfaces:**
- Produces:
  - `capFor(total: number, capPct: number): number`, i.e. `floor(capPct*total/100)`, computed as `Math.floor((capPct*100*total + 1e-6)/10000)` to avoid float errors.
  - `type PackStatus = 'ok' | 'over' | 'short' | 'moved_too_much'`
  - `interface PackCheck { ok: boolean; status: PackStatus; total: number; sum: number; diff: number; moved: number; cap: number }`
  - `checkPack(total: number, starts: number[], values: number[], capPct: number): PackCheck`. Status order: `over`/`short` when sum ≠ total (diff = sum − total); else `moved_too_much` when moved > cap or any |vᵢ−sᵢ| > cap; else `ok`.
  - `checkAll(totals: Grid, starts: Grid[], values: Grid[], packs: PackCode[], capPct: number): { ok: boolean; byPack: Record<PackCode, PackCheck> }`
  - `parseCaseInput(raw: string): number | null`. Accepts digits with `,` thousands separators and surrounding spaces, and Arabic-Indic digits (٠-٩, ۰-۹). Returns `null` for empty input, decimals, negatives and other text.

- [ ] **Step 1: Write failing tests** (owner's examples verbatim)

```ts
expect(capFor(1000,5)).toBe(50); expect(capFor(950,5)).toBe(47); expect(capFor(19,5)).toBe(0); expect(capFor(20,5)).toBe(1);
expect(checkPack(1000,[700,300],[650,350],5).status).toBe('ok');
expect(checkPack(1000,[700,300],[750,250],5).status).toBe('ok');
expect(checkPack(1000,[700,300],[649,351],5).status).toBe('moved_too_much');
expect(checkPack(1000,[250,250,250,250],[200,200,300,300],5)).toMatchObject({status:'moved_too_much', moved:100, cap:50});
expect(checkPack(27500,[5015,8234,6278,7973],[4815,8234,6278,7973],5)).toMatchObject({status:'short', diff:-200});
expect(checkPack(0,[0,0],[0,0],5).ok).toBe(true);
expect(checkPack(0,[0,0],[1,0],5).status).toBe('over');
expect(parseCaseInput(' 1,200 ')).toBe(1200); expect(parseCaseInput('٣٥٠')).toBe(350);
expect(parseCaseInput('12.5')).toBeNull(); expect(parseCaseInput('-3')).toBeNull(); expect(parseCaseInput('')).toBeNull();
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(shared): cap rules and case input parsing`.

### Task 4: Scaling

**Files:** Create `src/shared/scaling.ts`; Test `test/shared/scaling.test.ts`

**Interfaces:**
- Consumes: `largestRemainder` (Task 2).
- Produces: `rescale(leaves: {key: string; value: number}[], newTotal: number): Record<string, number>`. Proportional to the current values; if they sum to 0, splits evenly. The result sums exactly to `newTotal`.

- [ ] **Step 1: Failing tests:** `rescale([{key:'r1',value:700},{key:'r2',value:300}],950)` → `{r1:665,r2:285}`; `rescale([{key:'r3',value:600},{key:'r4',value:400}],1050)` → `{r3:630,r4:420}`; `rescale([{key:'a',value:0},{key:'b',value:0},{key:'c',value:0}],10)` → `{a:4,b:3,c:3}`; `rescale([…],0)` → all 0.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (delegates to `largestRemainder`). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(shared): proportional rescale`.

### Task 5: Forecast file checks

**Files:** Create `src/shared/forecast.ts`; Test `test/shared/forecast.test.ts`; Fixture `test/fixtures/forecast-small.ts` (synthetic rows; also one row set copying the TT DMM quirks: route 314037 with one stray salesman row, route with blank salesman, decimal cases).

**Interfaces:**
- Consumes: `largestRemainder`, types.
- Produces:
  - `interface RawRow { line: number; period: string; deliverySystem: string; routeCode: string; salesmanId: string; pack: string; cases: number | null }`
  - `normalizeForecastRows(rows: unknown[][]): RawRow[]`. Finds the header row by the six column names (case/space-insensitive); stops at the first row whose first five cells are blank; trims and stringifies codes (`314019` → `'314019'`); turns an Excel date or a `2026-10` string into `'2026-10'`; turns cases into a number (decimals kept) or `null`.
  - `interface LeafGrid { leafId: number; deliverySystem: string; routeCode: string; salesmanId: string; values: Grid }`
  - `interface ForecastCheck { errors: Issue[]; warnings: Issue[]; grids: LeafGrid[]; packTotals: Grid }`
  - `checkForecast(rows: RawRow[], ctx: { period: string; packs: PackCode[]; leaves: Map<string /* "ds|route" */, number /* leafId */>; takenLeafIds: Set<number> }): ForecastCheck`. Applies every error/warning in spec §10. Builds a **full grid** (missing packs = 0). Per pack, rounds so leaves sum to `Math.round(Σ decimals)` via `largestRemainder`. For a split salesman it stores the ID with the most rows and warns.
  - `compareToTotals(packTotals: Grid, expected: Grid): { pack: PackCode; forecast: number; expected: number; diff: number }[]` (only non-zero diffs; `expected` rounded first).

- [ ] **Step 1: Failing tests:** one per error code and per warning code in spec §10. Also:
  - normalization of numeric codes and Excel-date periods;
  - per-pack rounding where decimals `[83.03, 728.96]` → `[83, 729]` and the total is preserved;
  - full grid has every pack for every leaf;
  - `compareToTotals` reports a 1-case difference.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(shared): forecast normalization and checks`.

### Task 6: Database schema and helpers

**Files:** Create `migrations/0001_init.sql`, `src/worker/db.ts`, `src/shared/tree.ts`; Test `test/worker/schema.test.ts`, `test/shared/tree.test.ts`

**Interfaces:**
- Produces tables (all `id INTEGER PRIMARY KEY`, timestamps ISO text):
  - `users(username UNIQUE, name, email, pw_hash, pw_salt, role CHECK IN('admin','manager'), lang CHECK IN('en','ar') DEFAULT 'en', active INT DEFAULT 1)`
  - `sessions(token TEXT PRIMARY KEY, user_id, expires_at)`
  - `departments(code UNIQUE, name)`
  - `packs(code TEXT PRIMARY KEY, grp CHECK IN('CSD','Water','LRB-Others'), active INT, sort INT)`
  - `settings(key TEXT PRIMARY KEY, value TEXT)`, seeded `cap_pct='5'`
  - `nodes(dept_id, parent_id NULL, name, manager_user_id NULL, UNIQUE(dept_id,name))` — live tree
  - `leaves(dept_id, delivery_system, route_code, node_id, label, UNIQUE(delivery_system, route_code))`
  - `months(period UNIQUE, deadline NULL, packs_json, created_at)` — `packs_json` = pack snapshot `[{code,grp,sort}]`
  - `month_files(month_id, dept_id, name, sheet1_json NULL, uploaded_by, uploaded_at)`
  - `month_depts(month_id, dept_id, state CHECK IN('loading','running','complete'), PRIMARY KEY(month_id,dept_id))`
  - `month_nodes(month_id, node_id, dept_id, parent_id NULL, name, manager_user_id, status, held_status NULL, baseline_json NULL, draft_json NULL, version INT DEFAULT 0, opened_at, submitted_at, PRIMARY KEY(month_id,node_id))`
  - `month_leaves(month_id, leaf_id, node_id, dept_id, file_id, delivery_system, route_code, salesman_id, values_json, PRIMARY KEY(month_id,leaf_id))` — packed grid
  - `audit(at, user_id, action, month_id NULL, node_id NULL, detail_json)`
  - `email_log(at, to_addr, subject, result)`
- `db.ts`: `one<T>(db, sql, ...args)`, `all<T>(…)`, `run(…)`, `batch(db, stmts)` (chunks to D1's bound-parameter limit recorded in Task 0).
- `tree.ts`: `descendants(nodes: {id:number; parent_id:number|null}[], id: number): number[]`, `ancestors(...)`, `lowestCommonAncestor(nodes, a, b): number | null`, `isInBranch(nodes, rootId, id): boolean`.

- [ ] **Step 1:** Failing tests:
  - Migration applies cleanly; `settings.cap_pct = '5'`.
  - `tree.ts` on a 3-level fixture: descendants, ancestors, LCA of cousins = grandparent, LCA across departments = null.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: D1 schema and tree helpers`.

### Task 7: Authentication

**Files:** Create `src/worker/auth.ts`, `src/worker/routes/auth.ts`; Test `test/worker/auth.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(pw: string): Promise<{hash: string; salt: string}>` — PBKDF2-SHA256 via WebCrypto (iterations = the max Workers allows, recorded in Task 0).
  - `verifyPassword(pw, hash, salt): Promise<boolean>`
  - Middleware `requireUser` (sets `c.var.user: {id, role, lang, name}`), `requireAdmin`.
  - Routes:
    - `POST /api/auth/login {username,password}` → sets `sid` cookie (HttpOnly, Secure, SameSite=Lax, 12 h) and returns `{user}`.
    - `POST /api/auth/logout`
    - `GET /api/me`
    - `PATCH /api/me {lang}`
  - Bootstrap: if `users` is empty and env secret `BOOTSTRAP_ADMIN_PASSWORD` is set, login as `admin` with that password creates the admin.

- [ ] **Step 1:** Failing tests:
  - Wrong password → 401 with the same message as an unknown user.
  - Disabled user → 401.
  - Expired session → 401.
  - Manager calling an admin route → 403.
  - Bootstrap works only once.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: username/password auth with sessions`.

### Task 8: Master data API

**Files:** Create `src/worker/services/masters.ts`, `src/worker/services/audit.ts`, `src/worker/routes/admin.ts`; Test `test/worker/masters.test.ts`

**Interfaces:**
- Produces:
  - `logAudit(db, userId, action: string, ids: {monthId?: number; nodeId?: number}, detail: unknown): Promise<void>`
  - Routes (all `requireAdmin`):
    - `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id` (name, email, role, active, lang), `POST /api/admin/users/:id/password {password}`
    - `GET/POST /api/admin/departments`, `PATCH /api/admin/departments/:id`
    - `GET/POST /api/admin/packs`, `PATCH /api/admin/packs/:code` (grp, active, sort)
    - `GET/PUT /api/admin/settings {capPct}` (0 < capPct ≤ 100)
  - Every change writes an audit row.

- [ ] **Step 1:** Failing tests:
  - CRUD round-trips.
  - Duplicate username → 409.
  - Invalid `grp` → 400.
  - `capPct` of 0 or 150 → 400.
  - An audit row is written on each change.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: users, departments, packs, settings API`.

### Task 9: Hierarchy API (live tree)

**Files:** Create `src/worker/services/hierarchy.ts`; Modify `src/worker/routes/admin.ts`; Test `test/worker/hierarchy.test.ts`

**Interfaces:**
- Consumes: `tree.ts`, `logAudit`.
- Produces:
  - Node routes:
    - `GET /api/admin/nodes?dept=ID` returns a flat list `{id,parent_id,name,manager_user_id}`.
    - `POST /api/admin/nodes {deptId,parentId|null,name,managerUserId|null}`. Only one root per department → 409 on a second root.
    - `PATCH /api/admin/nodes/:id {name?, parentId?, managerUserId?}` rejects cycles (400).
    - `DELETE /api/admin/nodes/:id` only when the node has no child nodes and no leaves (else 409).
  - Leaf routes:
    - `GET /api/admin/leaves?dept=ID`
    - `POST /api/admin/leaves`
    - `PATCH /api/admin/leaves/:id {nodeId?, label?}`
    - `DELETE /api/admin/leaves/:id`
  - `POST /api/admin/leaves/bulk-map {deptId, rows:[{deliverySystem, routeCode, nodeName, label?}]}` → `{created, moved, errors:[{line, detail}]}`. Nodes are matched by name within the department; all or nothing.
  - Every live change calls `applyTreeChangeToOpenMonths` (Task 12). Until Task 12 exists, call a stub that returns `{applied:false, reason:'not_implemented'}`.

- [ ] **Step 1:** Failing tests:
  - Single root enforced.
  - A cycle is rejected.
  - A node with children can't be deleted.
  - bulk-map with one unknown node name → nothing written and an error on that line.
  - A re-run of bulk-map moves leaves.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: hierarchy and route mapping API`.

### Task 10: Months, uploads, start

**Files:** Create `src/worker/services/months.ts`, `src/worker/routes/months.ts`; Test `test/worker/months.test.ts`

**Interfaces:**
- Consumes: `LeafGrid` (Task 5), `logAudit`.
- Produces:
  - `POST /api/admin/months {period:'YYYY-MM', deadline?}`: snapshots active packs into `packs_json`, copies the live tree into `month_nodes` (status `waiting`), and creates `month_depts` rows in state `loading`.
  - `PATCH /api/admin/months/:id {deadline}`
  - `GET /api/admin/months/:id/context?dept=ID` → `{period, packs, leaves:[{leafId, deliverySystem, routeCode}], takenLeafIds}`. This is everything the browser's `checkForecast` needs.
  - `POST /api/admin/months/:id/files {deptId, name, sheet1?: Grid}` → `{fileId}`
  - `POST /api/admin/months/:id/files/:fileId/batch {grids: LeafGrid[]}` (≤ 200; 413 above). Upserts `month_leaves`. The server re-checks: integers ≥ 0, leaf belongs to the department, and the leaf isn't already in another file.
  - `POST /api/admin/months/:id/depts/:deptId/reset`: deletes the department's `month_leaves` and `month_files`, puts every department node back to `waiting` with no baseline or draft, and sets state `loading`. Audit row.
  - `POST /api/admin/months/:id/depts/:deptId/start`: requires ≥ 1 file and every department leaf present. Sets state `running` and calls `openTurn` (Task 11) on the root node.
  - `GET /api/admin/months` list with department states.

- [ ] **Step 1:** Failing tests:
  - Creating `2026-10` twice → 409.
  - A batch of 201 → 413.
  - A leaf already in another file → 409.
  - Start refused when a mapped leaf is missing.
  - Reset clears work.
  - **Review Focus 5:** deactivate a pack after the month is created → `context.packs` still lists it, and the month's grids keep it.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`openTurn` can be stubbed until Task 11, then wired). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: month creation, forecast upload and start`.

### Task 11: Distribution (manager workspace, draft, submit)

**Files:** Create `src/worker/services/distribution.ts`, `src/worker/routes/work.ts`; Test `test/worker/distribution.test.ts`

**Interfaces:**
- Consumes: `checkAll`, `rescale`, `tree.ts`, `logAudit`, `queueMail` (Task 14; stub to no-op until then).
- Produces:
  - `childTotals(db, monthId, nodeId): Promise<Record<ChildKey, Grid>>`. Child nodes are the sum of their leaves; child leaves are their own grid.
  - `openTurn(db, env, monthId, nodeId): Promise<void>`: `baseline_json` = `childTotals`, `draft_json` = null, status `in_progress`, `opened_at`, version+1, queue the "turn opened" email.
  - `interface Workspace { month:{id;period;deadline}; node:{id;name;status;deptCode}; capPct:number; packs:{code;grp;sort}[]; totals:Grid; children:{key:ChildKey; label:string; sub:string; starts:Grid; values:Grid}[]; version:number; editable:boolean }`
  - `GET /api/months/:mid/nodes/:nid` → `Workspace`.
    - Allowed if the user manages this node or an ancestor of it (else 403); admin can always view.
    - `editable` only for the node's own manager while it is `in_progress`.
    - `starts` = baseline; `values` = draft ?? baseline.
    - Child label: route code for a leaf, with `sub` = salesman ID; node name for a node, with `sub` = manager name.
  - `PUT /api/months/:mid/nodes/:nid/draft {values: Record<ChildKey,Grid>, version}` → `{version}`; 409 if `version` is stale (**Review Focus 3**). Values are not rule-checked; the server only checks that keys and packs belong to the node.
  - `POST /api/months/:mid/nodes/:nid/submit {version}`, also exported as `submitNode(db, env, monthId, nodeId, actorId, source: 'draft'|'baseline')`. In order:
    1. `checkAll` on every snapshot pack (400 with `byPack` on failure).
    2. Apply the values: a leaf child's grid is set directly; a node child whose pack total changed has its leaves `rescale`d.
    3. Status `submitted`, version+1, audit.
    4. For each child node: if it has a `held_status` (reopen path), run `restoreOrReopen(db, env, monthId, childId, totalsChanged)` from Task 12; else `openTurn`. Until Task 12 exists, treat any held child with `openTurn`.
    5. If no node in the department is still `waiting` or `in_progress`, set the department `complete` and queue the admin email.
  - `GET /api/my/tasks` → `[{monthId, period, nodeId, nodeName, deptCode, status, deadline}]` for the user's nodes.
  - `GET /api/months/:mid/nodes/:nid/branch` → read-only tree of `{nodeId, name, manager, status, totals:Grid}` for the node's subtree.

- [ ] **Step 1: Failing tests** (fixture tree: Head → Area → Sup A [r1 700, r2 300], Sup B [r3 600, r4 400] for pack `CSD_PET1000`; plus 3 more packs):
  - The area manager moves 50 from A to B and submits. Then the leaves are r1 665, r2 285, r3 630, r4 420. A's workspace totals are 950, starts are 665/285, cap is 47. A and B are `in_progress`.
  - The four-rep 100-moved case → 400 with `moved_too_much`.
  - Submit while an ancestor is not yet submitted → 409.
  - Supervisor A cannot GET Sup B's workspace (403). The area manager can, read-only.
  - **Review Focus 3:** two `PUT draft` calls with the same version → the second gets 409.
  - The grand total over all leaves per pack is unchanged after every submit (assert in each test).
  - The last submit sets the department `complete`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: manager workspace, draft and top-down submit`.

### Task 12: Admin flow controls and mid-month tree changes

**Files:** Create `src/worker/services/flow.ts`; Modify `src/worker/routes/months.ts`, `src/worker/services/hierarchy.ts` (replace stub); Test `test/worker/flow.test.ts`

**Interfaces:**
- Consumes: `submitNode`, `openTurn`, `checkAll`, `tree.ts`.
- Produces:
  - `GET /api/admin/months/:id/board?dept=ID` → `[{nodeId, name, parentId, manager, managerEmail, status, openedAt, submittedAt, link}]`. `link` is the absolute URL of the node's screen, used by the "copy link" button.
  - `POST /api/admin/months/:id/nodes/:nid/reopen`: allowed when the node is `submitted`. The node goes back to `in_progress` (baseline kept, draft = its submitted values). Each descendant gets `held_status = status` and `status = 'waiting'`. Audit.
  - `restoreOrReopen(db, env, monthId, childNodeId, totalsChanged: boolean)`:
    - unchanged totals → restore `held_status` across the whole subtree;
    - changed totals → clear `held_status`, baseline and draft in the subtree, then `openTurn(child)`.
  - `POST /api/admin/months/:id/nodes/:nid/push`: `in_progress` only. Submits the draft if it passes `checkAll`, else the baseline. Returns `{used:'draft'|'baseline'}`. Audit.
  - `applyTreeChangeToOpenMonths(db, change: {kind:'move_leaf'|'move_node'; id:number; fromParent:number; toParent:number} | {kind:'manager'; nodeId:number; userId:number|null}) → {appliedMonths:number[]; skippedMonths:number[]}`:
    - `manager` → always applied to `running` months.
    - Moves → applied to a running month only if every node on both paths up to and including their LCA is `waiting`; otherwise skipped (takes effect next month).
    - Months in state `loading` always take the change.

- [ ] **Step 1:** Failing tests:
  - Reopen the area node, then resubmit:
    - unchanged → Sup A and B return to their held statuses with their work intact;
    - changed → the changed sup's work is cleared and it is reopened with the rescaled starts.
  - Push forward with an invalid draft → `used:'baseline'`.
  - Moving a leaf between two `waiting` sups under a `waiting` area → applied.
  - The same move while the area is `in_progress` → skipped.
  - A manager change is applied immediately.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: reopen, push forward and safe mid-month tree changes`.

### Task 13: Export, history, backup

**Files:** Create `src/worker/services/export.ts`; Modify `src/worker/routes/months.ts`, `src/worker/routes/admin.ts`; Test `test/worker/export.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/months/:id/export?dept=ID|all` → `{columns: string[6], rows: (string|number)[][]}`.
    - Full grid in the spec column order.
    - Period `YYYY-MM`; codes as stored; Salesman ID from the month.
    - Rows ordered by file, route code, then pack sort order.
  - `GET /api/admin/audit?month=ID&limit=200&before=ID` → paged audit rows with user names.
  - `GET /api/admin/backup` → JSON dump of every table except `sessions`, `pw_hash` and `pw_salt`.

- [ ] **Step 1:** Failing tests:
  - Export row count = leaves × snapshot packs.
  - Sums per pack equal the uploaded rounded totals.
  - Column headers match the spec exactly.
  - The backup has no password fields.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: export, audit history and backup`.

### Task 14: Email and reminders

**Files:** Create `src/worker/email.ts`, `src/worker/emailTemplates.ts`; Modify `src/worker/index.ts` (`scheduled`), `wrangler.jsonc` (daily cron `0 5 * * *` = 08:00 Riyadh); Test `test/worker/email.test.ts`

**Interfaces:**
- Produces:
  - `queueMail(env, msg: {to: string; subject: string; text: string; html: string}): Promise<void>` awaits `sendMail` and never throws. Emails are few, so sending inline keeps the signatures simple.
  - `sendMail(env, msg): Promise<'sent'|'logged'|'failed'>`
    - Uses the Brevo API when secrets `BREVO_API_KEY` and `MAIL_FROM` are set; otherwise only writes `email_log`.
    - Always writes `email_log`; never throws.
  - Templates (EN+AR in one email, recipient's language first):
    - `turnOpened({name, period, nodeName, deadline, link})`
    - `deadlineReminder({...})`
    - `departmentComplete({period, deptName, link})`
  - `sendDeadlineReminders(db, env, now: Date)`: emails every `in_progress` node manager when the deadline is tomorrow (Asia/Riyadh).

- [ ] **Step 1:** Failing tests:
  - With no key → `'logged'` and an `email_log` row.
  - With a fake fetch returning 500 → `'failed'`, no throw.
  - Reminders go only to `in_progress` managers, only the day before.
- [ ] **Step 2:** FAIL. **Step 3:** Implement and wire it into `openTurn` and department completion. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: email notifications and deadline reminders`.

### Task 15: Web shell, login, i18n

**Files:** Create `src/web/app.tsx`, `src/web/api.ts`, `src/web/i18n/{index.ts,en.ts,ar.ts}`, `src/web/components/Layout.tsx`, `src/web/pages/Login.tsx`, `scripts/seed-dev.ts`, `playwright.config.ts`; Test `test/e2e/login.spec.ts`

**Interfaces:**
- Consumes: the auth routes.
- Produces:
  - `api<T>(method, path, body?): Promise<T>`, throwing `ApiError{status, body}`. On 401 it raises the event `auth:expired`.
  - `t(key: keyof typeof en): string`; `useLang()` → `[lang, setLang]`. Changing the language persists via `PATCH /api/me` and sets `<html lang dir>`.
  - `Layout`: header with the app name, the user, the language toggle and logout. Admin users get a nav with Users, Departments, Packs, Settings, Hierarchy, Months, History.
  - Routes:
    - `/login`
    - `/` (Home)
    - `/m/:mid/n/:nid` (Distribute)
    - `/m/:mid/n/:nid/branch`
    - `/admin/*`
  - `seed-dev.ts`: an admin, 2 managers, TT department, Head → Sup S-01 with the 4 mockup routes and their October grids (from the mockup data), and the 42 packs with groups.
- Visual style follows the mockup (`docs/mockups/distribution-screen-v4.html`): colours, cards and pill tabs. Use logical CSS properties only.

- [ ] **Step 1:** Failing e2e tests:
  - Login with the seed manager → Home.
  - A wrong password shows the error in both languages.
  - The toggle to Arabic sets `dir="rtl"` and persists after reload.
- [ ] **Step 2:** `npm run e2e -- login` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): shell, login and EN/AR i18n`.

### Task 16: Distribution screen

**Files:** Create `src/web/pages/Distribute.tsx`, `src/web/components/{DistributionTable,Filters,GroupTabs,StatusBadge}.tsx`; Test `test/e2e/distribute.spec.ts`, `test/shared/filters.test.ts`

**Interfaces:**
- Consumes: `Workspace` (Task 11), `checkAll`/`checkPack`/`parseCaseInput` (Task 3).
- Produces: `parseNumFilter(expr: string): (v: number) => boolean` in `src/web/components/Filters.tsx`, re-exported for tests. Accepts `>500`, `<100`, `>=`, `<=`, `=0`, `100-500` and blank (always true).
- Behaviour is the mockup v4 plus the spec §9 list:
  - summary cards; rules line; group tabs; search;
  - hide-zero; expand/collapse; clear filters; filter row; collapsible group rows with member subtotals;
  - per-cell start/delta; Moved / cap; status; per-pack reset.
  - Live checks run in the browser with the same `checkPack`.
  - Save draft and Submit send `version`. On 409 the screen shows "Changed elsewhere — reload".
  - Read-only mode when `editable` is false.
  - **Review Focus 4:** edits are mirrored to `sessionStorage` under `draft:{mid}:{nid}:{version}`. After `auth:expired` and re-login, they are restored with a notice.
  - Cells use `parseCaseInput`; invalid input shows a red cell and blocks Save until fixed.

- [ ] **Step 1: Failing tests:**
  - Unit: `parseNumFilter` cases.
  - e2e on the seed:
    - Changing CSD_PET1000 route 314023 to 4815 shows "Short by 200" and keeps Submit disabled.
    - Adding 200 to 314075 makes the pack OK and Submit enabled.
    - Typing `٣٥٠` is accepted.
    - Expiring the session (delete the cookie), saving and logging in again → the values are still there.
    - In Arabic the table is RTL.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): distribution screen`.

### Task 17: Manager home and branch view

**Files:** Create `src/web/pages/{Home,Branch}.tsx`; Test `test/e2e/home.spec.ts`

**Interfaces:**
- Consumes: `GET /api/my/tasks`, `GET …/branch`.
- Home lists tasks grouped by month, with the status badge, the deadline and an Open button. The `in_progress` ones come first.
- Branch shows a read-only nested tree with per-group totals (CSD / Water / LRB-Others). Each row has status and manager; clicking a node opens its workspace read-only.

- [ ] **Step 1:** Failing e2e tests:
  - The seed manager sees one `in_progress` task.
  - After submit it shows `submitted`, and the branch shows the node as submitted.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): manager home and branch view`.

### Task 18: Admin setup screens

**Files:** Create `src/web/pages/admin/{Users,Departments,Packs,Settings,Hierarchy}.tsx`, `src/web/excel.ts`; Test `test/e2e/admin-setup.spec.ts`

**Interfaces:**
- Consumes: the Task 8 and Task 9 routes.
- Produces in `excel.ts`:
  - `readSheet(file: File, sheetName?: string): Promise<unknown[][]>` (read-excel-file)
  - `writeXlsx(fileName: string, columns: string[], rows: (string|number)[][]): Promise<void>` (write-excel-file, triggers the download)
- Hierarchy page:
  - Tree per department: add child, rename, move (pick a new parent), assign manager, delete.
  - Leaves list with search and move.
  - "Upload route mapping" (columns `Delivery System`, `Route Code`, `Node`, `Label`) → shows the line errors, or a summary of what was created and moved.
  - A banner when a change was skipped for a running month: "applies from next month".

- [ ] **Step 1:** Failing e2e test:
  - Create a manager, a department and a 2-level tree.
  - Upload a mapping xlsx fixture.
  - Change the cap to 4.
  - The pack group dropdown only offers the three groups.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): admin setup screens`.

### Task 19: Admin month control

**Files:** Create `src/web/pages/admin/{Months,MonthDetail,History}.tsx`; Test `test/e2e/admin-month.spec.ts`, fixture `test/fixtures/tt-dmm-small.xlsx` (generated by the test setup from the seed data, with the TT quirks)

**Interfaces:**
- Consumes: the Task 10 and 12–13 routes; `checkForecast`, `compareToTotals`, `normalizeForecastRows`; `readSheet`/`writeXlsx`.
- Months page: list, plus "New month" (period, deadline).
- MonthDetail, per department:
  - **Upload:** choose the file and optionally the Sheet 1 total file. The browser runs the checks and shows errors and warnings with line numbers and the Sheet 1 differences. Accept is enabled only when there are no errors. Sending happens in 200-leaf batches with a progress bar.
  - **Reset:** confirm dialog that names the department.
  - **Start.**
  - **Status board:** status chips, plus Reopen, Push forward and Copy link per node.
  - **Export xlsx:** per department and for all departments.
  - **Deadline** edit.
- History: a paged audit list with a month filter.

- [ ] **Step 1:** Failing e2e test:
  - Upload the fixture → 2 warnings (blank salesman, split salesman) and 0 errors.
  - Accept → Start → the manager gets the task.
  - The manager submits.
  - Export → the downloaded xlsx row count = leaves × packs and the column headers are exact.
  - Reopen shows the node `in_progress` again.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): month control, upload checks and export`.

### Task 20: Deploy and owner guide

**Files:** Create `docs/OWNER-GUIDE.md` (EN + AR); Modify `wrangler.jsonc`, `package.json`

- [ ] **Step 1:** `npm test && npm run e2e` → all PASS.
- [ ] **Step 2:** Write `docs/OWNER-GUIDE.md` covering:
  - creating a Cloudflare account and an API token (exact permissions);
  - Brevo sender verification;
  - the secrets to set: `BOOTSTRAP_ADMIN_PASSWORD`, `BREVO_API_KEY`, `MAIL_FROM`, `APP_URL`;
  - first login;
  - a monthly checklist: new month → upload → start → watch the board → export;
  - how to download a backup.
- [ ] **Step 3:** Deploy the owner's account together with him:
  - `wrangler d1 create target-portal`
  - `wrangler d1 migrations apply target-portal --remote`
  - set the secrets
  - `npm run deploy`

  Expected: `https://target-portal.<account>.workers.dev/api/health` → `{"ok":true}`.
- [ ] **Step 4:** Smoke test on the live URL:
  - bootstrap admin login;
  - create one manager;
  - a test email lands in an inbox (or `email_log` shows the reason it didn't).
- [ ] **Step 5:** Commit `docs: owner guide and deployment config`.
