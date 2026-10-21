import { expect, test, type Page } from '@playwright/test';

// Seed (scripts/seed-dev.ts): month 1, Sup S-01 is node 2 (in progress), managed
// by sup1, with the 4 mockup routes. CSD_PET1000 starts 5015 / 8234 / 6278 / 7973
// (total 27,500, cap 1,375). The tests run in order on one database: the last one
// submits the node.
const MANAGER = { username: 'sup1', password: 'manager-pass-123' };
const SCREEN = '/m/1/n/2';
const PET = 'CSD_PET1000';

async function signIn(page: Page) {
  await page.getByLabel('Username').fill(MANAGER.username);
  await page.getByLabel('Password').fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function open(page: Page) {
  await page.goto(SCREEN);
  await signIn(page);
  await expect(page).toHaveURL(/\/m\/1\/n\/2$/);
  await expect(page.getByTestId('distribution-table')).toBeVisible();
}

const cell = (page: Page, pack: string, route: string) =>
  page.getByRole('textbox', { name: `${pack} · Route ${route}` });
const status = (page: Page, pack: string) => page.getByTestId(`status-${pack}`);
const submitBtn = (page: Page) => page.getByRole('button', { name: 'Submit to next level' });
const saveBtn = (page: Page) => page.getByRole('button', { name: 'Save draft' });

test('a short pack blocks submit; moving the cases to another route makes it OK', async ({ page }) => {
  await open(page);
  await expect(status(page, PET)).toHaveText('OK');
  await expect(page.getByTestId('passing')).toContainText('of');

  await cell(page, PET, '314023').fill('4815');
  await expect(status(page, PET)).toHaveText('Short by 200');
  await expect(page.getByTestId(`hint-${PET}-0`)).toHaveText('-200 from 5,015');
  await expect(submitBtn(page)).toBeDisabled();

  await cell(page, PET, '314075').fill('8434');
  await expect(status(page, PET)).toHaveText('OK');
  // Columns are in route order: 314023, 314052, 314062, 314075.
  await expect(page.getByTestId(`hint-${PET}-3`)).toHaveText('+200 from 8,234');
  await expect(page.getByTestId(`moved-${PET}`)).toHaveText('200 / 1,375');
  await expect(submitBtn(page)).toBeEnabled();

  // Per-pack reset puts the starting numbers back.
  await page.getByRole('button', { name: `Reset ${PET}` }).click();
  await expect(cell(page, PET, '314023')).toHaveValue('5015');
  await expect(page.getByTestId(`hint-${PET}-0`)).toHaveText('start 5,015');
});

test('Arabic-Indic digits are accepted; text and empty cells are invalid and block saving', async ({ page }) => {
  await open(page);
  const gat = cell(page, 'GATORADE', '314023'); // starts 21; pack total 66
  await gat.fill('٣٥٠');
  await expect(status(page, 'GATORADE')).toHaveText('Over by 329');
  await gat.press('Tab');
  await expect(gat).toHaveValue('350');
  await expect(saveBtn(page)).toBeEnabled();

  await gat.fill('12x');
  await expect(page.getByTestId('hint-GATORADE-0')).toHaveText('invalid number');
  await expect(gat).toHaveAttribute('aria-invalid', 'true');
  await expect(status(page, 'GATORADE')).toHaveText('Invalid number');
  await expect(saveBtn(page)).toBeDisabled();
  await expect(submitBtn(page)).toBeDisabled();

  await gat.fill('');
  await expect(page.getByTestId('hint-GATORADE-0')).toHaveText('invalid number');
  await expect(saveBtn(page)).toBeDisabled();

  await gat.fill('21');
  await expect(status(page, 'GATORADE')).toHaveText('OK');
  await expect(submitBtn(page)).toBeEnabled();
});

test('search, group tabs, filters and collapse narrow the table', async ({ page }) => {
  await open(page);
  // A route code shows only that member's column.
  await page.getByRole('searchbox').fill('314052');
  await expect(cell(page, PET, '314052')).toBeVisible();
  await expect(cell(page, PET, '314023')).toHaveCount(0);
  // A pack name filters rows.
  await page.getByRole('searchbox').fill('aquafina_5');
  await expect(page.locator('tr[data-pack]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('');

  await page.getByRole('button', { name: 'Water', exact: true }).click();
  await expect(page.locator('tr[data-pack="AquafinA_500"]')).toBeVisible();
  await expect(page.locator(`tr[data-pack="${PET}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'All packs' }).click();

  await page.getByRole('textbox', { name: 'Filter My target' }).fill('>20000');
  await expect(page.locator(`tr[data-pack="${PET}"]`)).toBeVisible();
  await expect(page.locator('tr[data-pack="GATORADE"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters' }).click();

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.locator('tr[data-pack]')).toHaveCount(0);
  await expect(page.getByTestId('group-CSD')).toContainText('OK');
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(page.locator(`tr[data-pack="${PET}"]`)).toBeVisible();
});

test('edits survive an expired session: saving sends to login, and after login the values are back', async ({ page }) => {
  await open(page);
  await cell(page, PET, '314023').fill('4815');
  await cell(page, PET, '314075').fill('8434');

  await page.context().clearCookies();
  await saveBtn(page).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fm%2F1%2Fn%2F2/);
  await signIn(page);
  await expect(page).toHaveURL(/\/m\/1\/n\/2$/);
  await expect(page.getByTestId('restored-notice')).toBeVisible();
  await expect(cell(page, PET, '314023')).toHaveValue('4815');
  await expect(cell(page, PET, '314075')).toHaveValue('8434');

  // Now the save goes through; the copy in this tab is dropped.
  await saveBtn(page).click();
  await expect(page.getByTestId('notice')).toHaveText('Draft saved.');
  await page.reload();
  await expect(cell(page, PET, '314023')).toHaveValue('4815'); // from the server's draft
  await expect(page.getByTestId('restored-notice')).toHaveCount(0);
});

test('in Arabic the table is right-to-left', async ({ page }) => {
  await open(page);
  const toAr = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await toAr;
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'التوزيع على الفريق' })).toBeVisible();
  const table = page.getByTestId('distribution-table');
  await expect(table).toHaveCSS('direction', 'rtl');
  // The Pack column is on the right, the Status column to its left.
  const pack = await page.getByRole('columnheader', { name: 'العبوة', exact: true }).boundingBox();
  const st = await page.getByRole('columnheader', { name: 'الحالة', exact: true }).boundingBox();
  expect(pack!.x).toBeGreaterThan(st!.x);
  // Pack codes stay codes, numbers stay Western, inputs stay left-to-right.
  await expect(page.locator(`tr[data-pack="${PET}"] td.pack`)).toHaveText(PET);
  const input = page.getByRole('textbox', { name: `${PET} · الخط 314023` });
  await expect(input).toHaveAttribute('dir', 'ltr');
  await expect(status(page, PET)).toHaveText('سليم');

  const back = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await back;
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('a change made elsewhere shows "Changed elsewhere — reload" instead of overwriting', async ({ page }) => {
  await open(page);
  await cell(page, PET, '314023').fill('4816');
  // Another tab saves the draft: the version moves on.
  const ws = await (await page.request.get('/api/months/1/nodes/2')).json();
  const values = Object.fromEntries(ws.children.map((c: { key: string; values: unknown }) => [c.key, c.values]));
  const put = await page.request.put('/api/months/1/nodes/2/draft', { data: { values, version: ws.version } });
  expect(put.ok()).toBe(true);

  await saveBtn(page).click();
  await expect(page.getByTestId('stale-banner')).toContainText('Changed elsewhere — reload');
  await page.getByTestId('stale-banner').getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('stale-banner')).toHaveCount(0);
  await expect(cell(page, PET, '314023')).toHaveValue('4815');
});

test('submitting a passing distribution makes the node submitted and read-only', async ({ page }) => {
  await open(page);
  await cell(page, PET, '314023').fill('4815');
  await cell(page, PET, '314075').fill('8434');
  await expect(submitBtn(page)).toBeEnabled();
  await submitBtn(page).click();
  await page.getByRole('button', { name: 'Yes, submit' }).click();

  await expect(page.getByTestId('node-status')).toHaveText('Submitted');
  await expect(page.getByTestId('notice')).toContainText('Submitted');
  await expect(cell(page, PET, '314023')).toBeDisabled();
  await expect(cell(page, PET, '314023')).toHaveValue('4815');
  await expect(saveBtn(page)).toHaveCount(0);
  await expect(submitBtn(page)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('node-status')).toHaveText('Submitted');
  await expect(page.getByTestId('read-only')).toBeVisible();
  await expect(cell(page, PET, '314075')).toHaveValue('8434');
});
