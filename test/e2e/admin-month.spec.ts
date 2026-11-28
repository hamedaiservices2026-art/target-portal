import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { MOCKUP_ROUTES } from '../../scripts/seed-data.ts';

// A fresh department, tree, routes and month (unique names) so this spec does not
// depend on what the seed or other specs did. Tree: Root (managed by MANAGER) ->
// Branch (no manager) holding the 3 routes of the fixture.
const SFX = Date.now().toString(36);
const MANAGER = { username: `mc${SFX}`, name: `Month Manager ${SFX}`, password: 'manager-pass-123' };
const DEPT = { code: `MC${SFX}`.toUpperCase(), name: `Month dept ${SFX}` };
const ROOT = `Root ${SFX}`;
const BRANCH = `Branch ${SFX}`;
const DS = `Presell – TT ${SFX}`; // en dash, as in the real TT DMM file
const ROUTES = ['0914023', '914075', '914052']; // the leading zero must survive import and export
// A period far from the seed month (2026-10), unique enough per run.
const PERIOD = `${2100 + (Date.now() % 800)}-${String((Math.floor(Date.now() / 1000) % 12) + 1).padStart(2, '0')}`;
const FIXTURE = 'test/fixtures/tt-dmm-small.xlsx';
const SHEET1 = 'test-results/tt-dmm-small-sheet1.xlsx';
const HEADERS = ['Period (YYYY-MM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases'];

async function signIn(page: Page, username: string, password: string, path = '/') {
  await page.goto(path);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function post(req: APIRequestContext, path: string, data: unknown) {
  const res = await req.post(path, { data });
  expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
  return res.json();
}

/**
 * The TT DMM file in miniature, built from the seed numbers: the header on row 1,
 * one row per route x pack (the full grid), and the two TT quirks:
 * route 2 has a blank Salesman ID, route 3 has one stray row under another ID.
 */
async function writeFixtures(packs: string[]): Promise<{ totals: Record<string, number> }> {
  const totals: Record<string, number> = {};
  const rows: unknown[][] = [HEADERS.map((value) => ({ value, fontWeight: 'bold' }))];
  ROUTES.forEach((route, i) => {
    const seed = MOCKUP_ROUTES[i]!;
    packs.forEach((pack, k) => {
      const cases = seed.values[pack] ?? 0;
      totals[pack] = (totals[pack] ?? 0) + cases;
      const salesman = i === 1 ? null : i === 2 && k === 5 ? '42999' : seed.salesman;
      rows.push([{ value: PERIOD }, { value: DS }, { value: route }, salesman === null ? null : { value: salesman }, { value: pack }, { value: cases }]);
    });
  });
  mkdirSync('test/fixtures', { recursive: true });
  mkdirSync('test-results', { recursive: true });
  await writeXlsxFile(rows as never).toFile(FIXTURE);

  // Sheet 1: pack / total, with a subtotal row that is not a pack and one pack off by 5.
  const off = packs[0]!;
  const sheet1: unknown[][] = [[{ value: 'Sales Target Category' }, { value: 'Total' }]];
  packs.forEach((pack, k) => {
    sheet1.push([{ value: pack }, { value: totals[pack]! + (pack === off ? 5 : 0) }]);
    if (k === 2) sheet1.push([{ value: 'Total CANS' }, { value: 99999 }]);
  });
  await writeXlsxFile(sheet1 as never).toFile(SHEET1);
  return { totals };
}

test('admin opens a month, uploads the checked forecast, starts, pushes, exports, reopens, resets', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page, 'admin', 'admin-pass-123', '/admin/months');
  await expect(page.getByRole('heading', { name: 'Months' })).toBeVisible();

  // --- Setup through the API: a manager, the department, its tree and routes.
  const req = page.request;
  const { user } = await post(req, '/api/admin/users', { username: MANAGER.username, name: MANAGER.name, role: 'manager', password: MANAGER.password });
  const { department } = await post(req, '/api/admin/departments', DEPT);
  const { node: root } = await post(req, '/api/admin/nodes', { deptId: department.id, name: ROOT, parentId: null, managerUserId: user.id });
  const { node: branch } = await post(req, '/api/admin/nodes', { deptId: department.id, name: BRANCH, parentId: root.id });
  for (const route of ROUTES) {
    await post(req, '/api/admin/leaves', { deptId: department.id, nodeId: branch.id, deliverySystem: DS, routeCode: route, label: route });
  }

  // --- New month from the Months page.
  await page.getByLabel('Month (YYYY-MM)').fill(PERIOD);
  await page.getByLabel('Deadline').fill('2026-12-20');
  await page.getByRole('button', { name: 'Open month' }).click();
  const monthRow = page.getByTestId('month-row').filter({ hasText: PERIOD });
  await expect(monthRow).toBeVisible();
  await monthRow.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/admin\/months\/\d+$/);
  const monthId = Number(/\/admin\/months\/(\d+)$/.exec(page.url())![1]);

  const ctx = await (await req.get(`/api/admin/months/${monthId}/context?dept=${department.id}`)).json();
  const packs: string[] = ctx.packs.map((p: { code: string }) => p.code);
  await writeFixtures(packs);

  const card = page.getByTestId('dept-card').filter({ hasText: DEPT.code });
  await expect(card.getByTestId('dept-state')).toHaveText('Loading');

  // --- Upload: Sheet 1 first, then the forecast; the checks run in the browser.
  await card.getByRole('button', { name: 'Upload forecast' }).click();
  await card.getByTestId('sheet1-file').setInputFiles(SHEET1);
  await card.getByTestId('forecast-file').setInputFiles(FIXTURE);
  await expect(card.getByTestId('check-summary')).toContainText('0 errors');
  await expect(card.getByTestId('check-summary')).toContainText('2 warnings');
  const warnings = card.getByTestId('issue-warning');
  await expect(warnings).toHaveCount(2);
  await expect(warnings.filter({ hasText: 'Blank Salesman ID' })).toContainText(ROUTES[1]!);
  await expect(warnings.filter({ hasText: 'two Salesman IDs' })).toContainText(ROUTES[2]!);
  await expect(card.getByTestId('issue-error')).toHaveCount(0);
  await expect(card.getByTestId('sheet1-diff')).toHaveCount(1);
  await expect(card.getByTestId('sheet1-diff')).toContainText(packs[0]!);
  await expect(card.getByTestId('sheet1-diff')).toContainText('-5');
  await expect(card.getByTestId('pack-totals')).toContainText('CSD');

  await card.getByRole('button', { name: 'Accept and upload' }).click();
  await expect(card.getByTestId('upload-done')).toContainText('3 routes');
  await expect(card.getByTestId('dept-files')).toContainText('1');

  // --- Start: the manager gets his task.
  await card.getByRole('button', { name: 'Start' }).click();
  await expect(card.getByTestId('dept-state')).toHaveText('Running');

  const mctx = await browser.newContext();
  const mpage = await mctx.newPage();
  await signIn(mpage, MANAGER.username, MANAGER.password);
  // First sign-in of an account Admin made: the person chooses their own password before anything else.
  await expect(mpage.getByTestId('change-password')).toBeVisible();
  await mpage.getByLabel('New password', { exact: true }).fill(MANAGER.password);
  await mpage.getByLabel('New password again').fill(MANAGER.password);
  await mpage.getByRole('button', { name: 'Save password' }).click();
  const task = mpage.getByTestId('task').filter({ hasText: ROOT });
  await expect(task.getByTestId('task-status')).toHaveText('In progress');
  await task.getByRole('link', { name: 'Open' }).click();
  // The top of the department (the Head's level) sends the split to the managers.
  await mpage.getByRole('button', { name: 'Approve and send to managers' }).click();
  await mpage.getByRole('button', { name: 'Yes, submit' }).click();
  await expect(mpage.getByTestId('read-only')).toBeVisible();
  await mctx.close();

  // --- Status board: root submitted; the branch has no manager, so the admin pushes it.
  await card.getByRole('button', { name: 'Refresh' }).click();
  const rootRow = card.getByTestId('board-row').filter({ hasText: ROOT });
  const branchRow = card.getByTestId('board-row').filter({ hasText: BRANCH });
  await expect(rootRow.getByTestId('board-status')).toHaveText('Submitted');
  await expect(branchRow.getByTestId('board-status')).toHaveText('In progress');
  await expect(branchRow).toContainText('Only Push forward can move this node');
  await expect(rootRow.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await branchRow.getByRole('button', { name: 'Push forward' }).click();
  await branchRow.getByRole('button', { name: 'Yes, push forward' }).click();
  await expect(card.getByTestId('board-flash')).toContainText('starting numbers');
  await expect(branchRow.getByTestId('board-status')).toHaveText('Submitted');
  await expect(card.getByTestId('dept-state')).toHaveText('Complete');

  // --- Export this department: exact headers, full grid.
  const dl = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Export Excel' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe(`targets-${PERIOD}-${DEPT.code}.xlsx`);
  const sheet = await readSheet((await file.path()) as string);
  expect(sheet[0]).toEqual(HEADERS);
  expect(sheet.length - 1).toBe(ROUTES.length * packs.length);
  // Code columns are text cells, Cases a number cell.
  const zero = sheet.find((r) => r[2] === ROUTES[0])!;
  expect(zero).toBeDefined();
  expect(zero[0]).toBe(PERIOD);
  expect(typeof zero[3]).toBe('string');
  expect(zero[3]).toBe(MOCKUP_ROUTES[0]!.salesman);
  expect(typeof zero[5]).toBe('number');

  // "All departments" includes the seed department, which is still loading in this month: a warning first.
  await page.getByRole('button', { name: 'Export all departments' }).click();
  await expect(page.getByTestId('export-warning')).toContainText('TT');
  const dlAll = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download anyway' }).click();
  expect((await dlAll).suggestedFilename()).toBe(`targets-${PERIOD}-all.xlsx`);

  // --- Reopen the branch: in progress again.
  await branchRow.getByRole('button', { name: 'Reopen' }).click();
  await expect(branchRow.getByTestId('board-status')).toHaveText('In progress');
  await expect(card.getByTestId('dept-state')).toHaveText('Running');

  // --- Deadline edit.
  await page.getByLabel('Deadline').fill('2026-12-24');
  await page.getByRole('button', { name: 'Save deadline' }).click();
  await expect(page.getByTestId('deadline-flash')).toBeVisible();

  // --- Reset names the department, and empties it.
  await card.getByRole('button', { name: 'Reset' }).click();
  await expect(card.getByRole('group')).toContainText(DEPT.name);
  await card.getByRole('button', { name: 'Yes, reset' }).click();
  await expect(card.getByTestId('dept-state')).toHaveText('Loading');
  await expect(card.getByTestId('dept-files')).toContainText('0');

  // --- Refresh tree is offered while loading and reports what it did.
  await card.getByRole('button', { name: 'Refresh tree' }).click();
  await expect(card.getByRole('status')).toContainText('0 added, 0 removed');

  // --- History, filtered to this month, newest first.
  await page.getByRole('link', { name: 'History' }).click();
  await page.getByLabel('Month', { exact: true }).selectOption({ value: String(monthId) });
  const first = page.getByTestId('audit-row').first();
  await expect(first).toContainText('Tree refreshed');
  await expect(page.getByTestId('audit-row').filter({ hasText: 'Department reset' })).toHaveCount(1);
  await expect(page.getByTestId('audit-row').filter({ hasText: 'Forecast rows uploaded' })).toHaveCount(1);
  const backupDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  expect((await backupDl).suggestedFilename()).toMatch(/^target-portal-backup-\d{4}-\d{2}-\d{2}\.json$/);
});
