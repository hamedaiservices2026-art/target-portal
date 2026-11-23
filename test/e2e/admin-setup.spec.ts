import { expect, test, type Page } from '@playwright/test';

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

test('admin sets up a manager, a department, a two-level tree, a route mapping, the cap and packs', async ({ page }) => {
  await signInAdmin(page);

  // --- Users: add an account (not part of the hierarchy: no role yet).
  await page.getByRole('button', { name: 'Add account' }).click();
  const add = page.getByTestId('add-account');
  await add.getByLabel('Name', { exact: true }).fill(`Manager ${SFX}`);
  await add.getByLabel('Username').fill(MANAGER);
  await add.getByLabel('Position').selectOption('manager');
  await add.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('users-flash')).toContainText(`Account ${MANAGER} created. First password:`);
  const userRow = page.getByTestId('user-row').filter({ hasText: MANAGER });
  await expect(userRow.getByTestId('user-status')).toHaveText('No role');
  await expect(page.getByTestId('save-toast')).toContainText('Saved.');
  // The admin cannot disable themself.
  const own = page.getByTestId('user-row').filter({ has: page.locator('code', { hasText: /^admin$/ }) });
  await expect(own.getByRole('button', { name: 'Disable' })).toHaveCount(0);

  // --- Departments.
  await page.getByRole('link', { name: 'Departments' }).click();
  await page.getByLabel('Code').fill(DEPT_CODE);
  await page.getByLabel('Name').fill(DEPT_NAME);
  await page.getByRole('button', { name: 'Add department' }).click();
  await expect(page.getByTestId('dept-row').filter({ hasText: DEPT_CODE })).toBeVisible();

  // --- Hierarchy (v16 layout): a Head, a manager, a supervisor and a route.
  await page.getByRole('link', { name: 'Hierarchy' }).click();
  const addBox = page.getByTestId('hz-add');
  await addBox.getByLabel('New Channel Head name').fill(ROOT);
  await addBox.getByRole('button', { name: 'Add' }).first().click();
  await expect(page.getByTestId('hz-msg')).toHaveText(`${ROOT} added.`);
  await addBox.getByLabel('New Sales Manager name').fill(CHILD);
  const headSel = addBox.getByLabel('Channel Head of the new manager');
  await headSel.selectOption((await headSel.locator('option', { hasText: ROOT }).getAttribute('value'))!);
  await addBox.getByRole('button', { name: 'Add' }).nth(1).click();
  await expect(page.getByTestId('hz-manager').filter({ has: page.getByLabel(`Name ${CHILD}`, { exact: true }) })).toBeVisible();
  await addBox.getByLabel('New Sales Supervisor name').fill(`Sup ${SFX}`);
  await addBox.getByLabel('Sales Manager of the new supervisor').selectOption({ label: `${CHILD} · ${ROOT}` });
  await addBox.getByRole('button', { name: 'Add' }).nth(2).click();
  await addBox.getByLabel('New route code').fill(`R1${SFX}`);
  await addBox.getByLabel('Delivery System').fill(SYSTEM);
  await addBox.getByLabel('Supervisor of the new route').selectOption({ label: `Sup ${SFX} · ${CHILD}` });
  await addBox.getByRole('button', { name: 'Add' }).nth(3).click();
  await expect(page.getByTestId('hz-msg')).toHaveText('Route added.');
  const headRow = page.getByTestId('hz-head').filter({ has: page.getByLabel(`Name ${ROOT}`, { exact: true }) });
  await expect(headRow).toContainText('1');
  // Deleting a Head (with everything under it) asks first.
  await headRow.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/with all the people and 1 routes under it/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

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

test('hierarchy: rename in place, move with the lists, banners show, routes edited and deleted', async ({ page }) => {
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
  const c = await mk(`C-${SFX}`, b);
  const d = await mk(`D-${SFX}`, a);
  await mk(`E-${SFX}`, d);
  await post('/api/admin/leaves', { deptId: department.id, nodeId: c, deliverySystem: `DS-${SFX}`, routeCode: `X1${SFX}`, label: 'Old label' });

  await page.goto('/admin/hierarchy');
  const sup = (n: string) => page.getByTestId('hz-supervisor').filter({ has: page.getByLabel(`Name ${n}-${SFX}`, { exact: true }) });

  // Rename in place.
  await sup('E').getByRole('textbox').fill(`E2-${SFX}`);
  await sup('E').getByRole('textbox').press('Enter');
  await expect(page.getByTestId('hz-msg')).toHaveText('Saved.');
  await expect(sup('E2')).toBeVisible();

  // A supervisor's manager choices are the managers of the same Head; a move whose month was skipped shows the banner.
  const choices = (await sup('C').getByLabel(`Sales Manager C-${SFX}`).locator('option').allTextContents()).map((s) => s.trim());
  expect(choices).toEqual([`B-${SFX}`, `D-${SFX}`]);
  await page.route('**/api/admin/nodes/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const real = await route.fetch();
    const body = await real.json();
    await route.fulfill({ response: real, json: { ...body, treeChange: { appliedMonths: [], skippedMonths: [1], error: 'boom' } } });
  });
  await sup('C').getByLabel(`Sales Manager C-${SFX}`).selectOption({ label: `D-${SFX}` });
  await expect(page.getByTestId('tree-skipped')).toContainText('This change applies from next month for: Oct 2026');
  await expect(page.getByTestId('tree-error')).toBeVisible();
  await page.unroute('**/api/admin/nodes/*');

  // A supervisor with a route cannot be deleted; an empty one asks first.
  await expect(sup('C').getByRole('button', { name: 'Delete' })).toBeDisabled();
  await sup('E2').getByRole('button', { name: 'Delete' }).click();
  await expect(sup('E2').getByRole('button', { name: 'Confirm delete' })).toBeVisible();
  await sup('E2').getByRole('button', { name: 'Confirm delete' }).click();
  await expect(sup('E2')).toHaveCount(0);

  // Routes: salesman, move, delete.
  await page.getByLabel('Filter by route, salesman, supervisor or manager…').fill(`X1${SFX}`);
  const leaf = page.getByTestId('hz-route');
  await expect(leaf).toHaveCount(1);
  await leaf.getByLabel(`Salesman ID X1${SFX}`).fill('42059');
  await leaf.getByLabel(`Salesman ID X1${SFX}`).press('Enter');
  await expect(page.getByTestId('hz-msg')).toHaveText('Saved.');
  await expect(leaf.getByLabel(`Salesman ID X1${SFX}`)).toHaveValue('42059');
  await leaf.getByRole('button', { name: 'Delete' }).click();
  await leaf.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByTestId('hz-route')).toHaveCount(0);
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

  // Reset asks first, then shows the new first password.
  await row.getByRole('button', { name: 'Reset password' }).click();
  await row.getByRole('button', { name: 'Confirm new password' }).click();
  await expect(page.getByTestId('users-flash')).toContainText(`New first password for ${username}:`);
  const first = (await page.getByTestId('users-flash').textContent())!.split(':').pop()!.trim();
  expect(first).toMatch(/^[A-Z]{4}[2-9]{4}$/);
  await expect(row.getByTestId('first-pw')).toHaveText(first);

  // The admin sets a password of their choice.
  await row.getByRole('button', { name: 'Change password' }).click();
  await page.getByLabel(`New password for ${username}`).fill('short');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('at least 8');
  await page.getByLabel(`New password for ${username}`).fill('second-pass-123');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByTestId('users-flash')).toContainText(`Password saved for ${username}.`);
  await expect(row.getByTestId('first-pw')).toHaveText('second-pass-123');

  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(row.getByTestId('user-status')).toHaveText('Disabled');
  await row.getByRole('button', { name: 'Enable' }).click();
  await expect(row.getByTestId('user-status')).toHaveText('No role'); // not in the hierarchy

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

test('hierarchy: one tab for Operation and one for Key Account', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/hierarchy');
  await expect(page.getByTestId('hz-tabs')).toBeVisible();
  await expect(page.getByTestId('ka-cleanup')).toBeVisible();
  await page.getByRole('tab', { name: 'Key Account hierarchy' }).click();
  await expect(page.getByRole('heading', { name: 'Upload the Key Account hierarchy' })).toBeVisible();
  await expect(page.getByTestId('ka-cleanup')).toHaveCount(0);
  await expect(page.getByTestId('hz-heads')).toContainText('KAM');
});
