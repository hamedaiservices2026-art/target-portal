import { expect, test, type Page } from '@playwright/test';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';

// Unique names per run so this spec does not depend on what other specs created.
const SFX = Date.now().toString(36);
const MANAGER = `mgr${SFX}`;
const DEPT_CODE = `QA${SFX}`.toUpperCase();
const DEPT_NAME = `QA dept ${SFX}`;
const ROOT = `Root ${SFX}`;
const CHILD = `Child ${SFX}`;
const SYSTEM = `Presell ${SFX}`;

async function signInAdmin(page: Page) {
  await page.goto('/admin/users');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
}

async function mappingFile(rows: (string | undefined)[][]): Promise<Buffer> {
  const header = ['Delivery System', 'Route Code', 'Node', 'Label'].map((value) => ({ value, fontWeight: 'bold' as const }));
  const data = [
    [{ value: 'Route mapping export' }], // a title row above the header: the page must find the header row
    header,
    ...rows.map((r) => r.map((value) => (value === undefined ? null : { value }))),
  ];
  return writeXlsxFile(data as never).toBuffer();
}

test('admin sets up a manager, a department, a two-level tree, a route mapping, the cap and packs', async ({ page }) => {
  await signInAdmin(page);

  // --- Users: create a manager.
  await page.getByRole('button', { name: 'Add user' }).click();
  await page.getByLabel('Username').fill(MANAGER);
  await page.getByLabel('Full name').fill(`Manager ${SFX}`);
  await page.getByLabel('Role').selectOption('manager');
  await page.getByLabel('Password').fill('manager-pass-123');
  await page.getByRole('button', { name: 'Save user' }).click();
  const userRow = page.getByTestId('user-row').filter({ hasText: MANAGER });
  await expect(userRow).toBeVisible();
  // The admin cannot disable or demote themself.
  const own = page.getByTestId('user-row').filter({ hasText: 'admin' }).first();
  await expect(own.getByRole('button', { name: 'Disable' })).toBeDisabled();
  // Disable needs an inline confirmation.
  await userRow.getByRole('button', { name: 'Disable' }).click();
  await expect(userRow.getByRole('button', { name: 'Yes, disable' })).toBeVisible();
  await userRow.getByRole('button', { name: 'Cancel' }).click();
  await expect(userRow.getByTestId('user-status')).toHaveText('Active');

  // --- Departments.
  await page.getByRole('link', { name: 'Departments' }).click();
  await page.getByLabel('Code').fill(DEPT_CODE);
  await page.getByLabel('Name').fill(DEPT_NAME);
  await page.getByRole('button', { name: 'Add department' }).click();
  await expect(page.getByTestId('dept-row').filter({ hasText: DEPT_CODE })).toBeVisible();

  // --- Hierarchy: a two-level tree.
  await page.getByRole('link', { name: 'Hierarchy' }).click();
  await page.getByLabel('Department').selectOption({ label: `${DEPT_CODE} — ${DEPT_NAME}` });
  await page.getByRole('button', { name: 'Add top node' }).click();
  await page.getByLabel('Node name').fill(ROOT);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const rootRow = page.getByTestId('node-row').filter({ hasText: ROOT });
  await expect(rootRow).toBeVisible();

  await rootRow.getByRole('button', { name: 'Add child' }).click();
  await page.getByLabel('Node name').fill(CHILD);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const childRow = page.getByTestId('node-row').filter({ hasText: CHILD });
  await expect(childRow).toBeVisible();

  // Assign the manager to the child; delete is blocked on a node with children.
  await childRow.getByRole('button', { name: 'Assign manager' }).click();
  await page.getByLabel('Manager', { exact: true }).selectOption({ label: `Manager ${SFX} (${MANAGER})` });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(childRow.getByTestId('node-manager')).toContainText(`Manager ${SFX}`);
  await expect(rootRow.getByRole('button', { name: 'Delete' })).toBeDisabled();

  // --- Route mapping: bad file first (unknown node), then a good one.
  const bad = await mappingFile([[SYSTEM, 'R-1', 'No such node', 'One']]);
  await page.getByTestId('map-file').setInputFiles({ name: 'bad.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bad });
  await expect(page.getByTestId('map-errors')).toContainText('Unknown node');
  await expect(page.getByTestId('map-errors')).toContainText('Line 3'); // header on Excel row 2, first data row = Excel row 3

  const good = await mappingFile([
    [SYSTEM, 'R-1', CHILD, 'Route one'],
    [SYSTEM, 'R-2', CHILD, undefined],
    [undefined, undefined, undefined, undefined], // blank row is skipped
  ]);
  await page.getByTestId('map-file').setInputFiles({ name: 'good.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: good });
  await expect(page.getByTestId('map-summary')).toContainText('2 created');
  await expect(page.getByTestId('map-summary')).toContainText('0 moved');
  await expect(page.getByTestId('leaf-row')).toHaveCount(2);
  await expect(page.getByTestId('leaf-row').first()).toContainText(SYSTEM);

  // Same file again: nothing changes.
  await page.getByTestId('map-file').setInputFiles({ name: 'good.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: good });
  await expect(page.getByTestId('map-summary')).toContainText('2 unchanged');

  // Leaves search.
  await page.getByLabel('Search routes').fill('R-2');
  await expect(page.getByTestId('leaf-row')).toHaveCount(1);

  // --- Settings: cap 4 (restored in finally so other specs keep the default).
  try {
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText('5% of 1,000 = 50 cases')).toBeVisible();
    await page.getByLabel('Cap (%)').fill('4');
    await page.getByRole('button', { name: 'Save cap' }).click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Cap (%)')).toHaveValue('4');
    expect(((await (await page.request.get('/api/admin/settings')).json()) as { capPct: number }).capPct).toBe(4);
    await page.getByLabel('Cap (%)').fill('0');
    await expect(page.getByRole('button', { name: 'Save cap' })).toBeDisabled();
  } finally {
    await page.request.put('/api/admin/settings', { data: { capPct: 5 } });
  }

  // --- Packs: the group dropdown offers exactly the three groups.
  await page.getByRole('link', { name: 'Packs' }).click();
  await expect(page.getByTestId('pack-row').first()).toBeVisible();
  const options = await page.getByTestId('pack-row').first().getByLabel('Group').locator('option').allTextContents();
  expect(options).toEqual(['CSD', 'Water', 'LRB-Others']);
  const addOptions = await page.getByTestId('new-pack-group').locator('option').allTextContents();
  expect(addOptions).toEqual(['CSD', 'Water', 'LRB-Others']);
});

test('hierarchy: move choices exclude the node and its descendants, banners show, routes can be edited, template downloads', async ({ page }) => {
  await signInAdmin(page);
  const post = async (path: string, data: object) => {
    const res = await page.request.post(path, { data });
    expect(res.ok()).toBe(true);
    return res.json();
  };
  const code = `HX${SFX}`.toUpperCase();
  const { department } = await post('/api/admin/departments', { code, name: `Hier ${SFX}` });
  const mk = async (name: string, parentId: number | null) =>
    (await post('/api/admin/nodes', { deptId: department.id, name, parentId })).node.id as number;
  const a = await mk(`A-${SFX}`, null);
  const b = await mk(`B-${SFX}`, a);
  await mk(`C-${SFX}`, b);
  const d = await mk(`D-${SFX}`, a);
  await post('/api/admin/leaves', { deptId: department.id, nodeId: d, deliverySystem: `DS-${SFX}`, routeCode: 'X-1', label: 'Old label' });

  await page.goto(`/admin/hierarchy?dept=${department.id}`);
  await expect(page.getByLabel('Department')).toHaveValue(String(department.id));
  const rowOf = (n: string) => page.getByTestId('node-row').filter({ has: page.locator('.node-name', { hasText: `${n}-${SFX}` }) }).first();

  // The top node cannot be moved; B's choices are A and D only (not B itself, not its child C).
  await expect(rowOf('A').getByRole('button', { name: 'Move' })).toBeDisabled();
  await rowOf('B').getByRole('button', { name: 'Move' }).click();
  const choices = (await page.getByLabel('New parent').locator('option').allTextContents()).map((s) => s.trim());
  expect(choices).toEqual([`A-${SFX}`, `D-${SFX}`]);

  // A move whose month was skipped shows the "next month" banner with the period (server answer faked).
  await page.route('**/api/admin/nodes/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const real = await route.fetch();
    const body = await real.json();
    await route.fulfill({ response: real, json: { ...body, treeChange: { appliedMonths: [], skippedMonths: [1], error: 'boom' } } });
  });
  await page.getByLabel('New parent').selectOption({ label: `D-${SFX}` });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('tree-skipped')).toContainText('This change applies from next month for: Oct 2026');
  await expect(page.getByTestId('tree-error')).toBeVisible();
  await page.unroute('**/api/admin/nodes/*');

  // Delete asks first; a node with routes cannot be deleted.
  await expect(rowOf('D').getByRole('button', { name: 'Delete' })).toBeDisabled();
  await rowOf('A').getByRole('button', { name: 'Add child' }).click();
  await page.getByLabel('Node name').fill(`E-${SFX}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await rowOf('E').getByRole('button', { name: 'Delete' }).click();
  await rowOf('E').getByRole('button', { name: 'Cancel' }).click();
  await expect(rowOf('E')).toBeVisible();
  await rowOf('E').getByRole('button', { name: 'Delete' }).click();
  await rowOf('E').getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.locator('.node-name', { hasText: `E-${SFX}` })).toHaveCount(0);

  // Routes: edit the label, move to another node, delete.
  const leaf = page.getByTestId('leaf-row');
  await expect(leaf).toHaveCount(1);
  await leaf.getByRole('button', { name: 'Edit label' }).click();
  await page.getByLabel('Label', { exact: true }).fill('New label');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(leaf).toContainText('New label');
  await leaf.getByRole('button', { name: 'Move' }).click();
  await page.getByLabel('Move to node').selectOption({ label: `A-${SFX}` });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(leaf).toContainText(`A-${SFX}`);
  await leaf.getByRole('button', { name: 'Delete' }).click();
  await leaf.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByTestId('leaf-row')).toHaveCount(0);

  // Template download has exactly the four column names.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download template' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('route-mapping-template.xlsx');
  const sheet = await readSheet(await file.path() as string);
  expect(sheet[0]).toEqual(['Delivery System', 'Route Code', 'Node', 'Label']);
});

test('users: reset password, disable and enable; the pages work in Arabic', async ({ page }) => {
  await signInAdmin(page);
  const username = `usr${SFX}`;
  const created = await page.request.post('/api/admin/users', { data: { username, name: `User ${SFX}`, role: 'manager', password: 'first-pass-123' } });
  expect(created.status()).toBe(201);
  await page.reload();
  const row = page.getByTestId('user-row').filter({ hasText: username });
  await page.getByLabel('Search users…').fill(username);
  await expect(page.getByTestId('user-row')).toHaveCount(1);

  await row.getByRole('button', { name: 'Reset password' }).click();
  await page.getByLabel(`New password for ${username}`).fill('short');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('at least 8');
  await page.getByLabel(`New password for ${username}`).fill('second-pass-123');
  await page.getByRole('button', { name: 'Set password', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Password changed');

  await row.getByRole('button', { name: 'Disable' }).click();
  await row.getByRole('button', { name: 'Yes, disable' }).click();
  await expect(row.getByTestId('user-status')).toHaveText('Disabled');
  await row.getByRole('button', { name: 'Enable' }).click();
  await expect(row.getByTestId('user-status')).toHaveText('Active');

  // Arabic: right-to-left, translated headings.
  const toAr = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await toAr;
  await expect(page.getByRole('heading', { name: 'المستخدمون' })).toBeVisible();
  await expect(page.getByTestId('admin-users')).toHaveCSS('direction', 'rtl');
  const back = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await back;
});
