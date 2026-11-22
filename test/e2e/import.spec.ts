import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';

// Bulk import (Task E): upload -> preview -> apply on the Users, Packs and Hierarchy screens.
const SFX = Date.now().toString(36);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function signInAdmin(page: Page) {
  await page.goto('/admin/users');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
}

async function file(name: string, header: string[], rows: (string | number | null)[][]) {
  const data = [header.map((value) => ({ value, fontWeight: 'bold' as const })), ...rows.map((r) => r.map((v) => (v === null ? null : { value: v })))];
  return { name, mimeType: XLSX, buffer: await writeXlsxFile(data as never).toBuffer() };
}

test('packs: template, preview with an error, fix, apply, re-apply is unchanged', async ({ page }) => {
  await signInAdmin(page);
  await page.getByRole('link', { name: 'Packs' }).click();
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  const panel = page.getByTestId('import-packs');

  const dl = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download template' }).click();
  const tpl = await dl;
  expect(tpl.suggestedFilename()).toBe('packs-import-template.xlsx');
  expect((await readSheet(readFileSync((await tpl.path())!)))[0]).toEqual(['Code', 'Group', 'Sort order', 'Active']);

  const header = ['Code', 'Group', 'Sort order', 'Active'];
  // Inactive packs, so later months (other specs) are not affected.
  await panel.getByTestId('import-file-packs').setInputFiles(await file('bad.xlsx', header, [[`A${SFX}`, 'CSD', 900, 'no'], [`B${SFX}`, 'csd', 901, 'no']]));
  await expect(panel.getByTestId('import-summary')).toContainText('Fix the errors');
  await expect(panel.getByTestId('import-error')).toHaveCount(1);
  await expect(panel.getByTestId('import-error')).toContainText('3');
  await expect(panel.getByTestId('import-error')).toContainText(/Group\W+csd\W+is not allowed/);
  await expect(panel.getByTestId('import-apply')).toBeDisabled();

  const good = await file('packs.xlsx', header, [[`A${SFX}`, 'CSD', 900, 'no'], [`B${SFX}`, 'Water', 901, 'no']]);
  await panel.getByTestId('import-file-packs').setInputFiles(good);
  await expect(panel.getByTestId('import-summary')).toContainText('2 to add, 0 to update, 0 unchanged');
  await expect(page.getByTestId('pack-row').filter({ hasText: `A${SFX}` })).toHaveCount(0); // preview saved nothing
  await panel.getByTestId('import-apply').click();
  await expect(panel.getByTestId('import-done')).toContainText('2 added, 0 updated, 0 unchanged');
  await expect(page.getByTestId('pack-row').filter({ hasText: `B${SFX}` })).toBeVisible();
  await expect(page.getByTestId('pack-row').filter({ hasText: `B${SFX}` }).getByLabel('Group')).toHaveValue('Water');

  await panel.getByTestId('import-file-packs').setInputFiles(good);
  await expect(panel.getByTestId('import-summary')).toContainText('0 to add, 0 to update, 2 unchanged');
  await expect(panel.getByTestId('import-summary')).toContainText('already up to date');
  await expect(panel.getByTestId('import-apply')).toBeDisabled();
});

test('hierarchy from one file, then every person gets an account with a first password', async ({ page, request }) => {
  await signInAdmin(page);
  const head = `Imp Head ${SFX}`;
  await page.goto('/admin/hierarchy');
  await page.getByTestId('hier-file').setInputFiles(await file('hierarchy.xlsx',
    ['Channel Head', 'Sales Manager', 'Sales Supervisor', 'Route Code', 'Delivery System'],
    [[head, `Imp Mgr ${SFX}`, `Imp Sup ${SFX}`, `IR1${SFX}`, 'Presell'], [head, `Imp Mgr ${SFX}`, `Imp Sup ${SFX}`, `IR2${SFX}`, 'Presell']]));
  const plan = page.getByTestId('hier-plan');
  await expect(plan).toBeVisible();
  await plan.getByLabel(`Department ${head}`).selectOption('new');
  await expect(page.getByTestId('hier-problems')).toHaveCount(0);
  await page.getByTestId('hier-apply').click();
  await expect(page.getByTestId('hier-done')).toBeVisible();
  const headRow = page.getByTestId('hz-head').filter({ has: page.getByLabel(`Name ${head}`, { exact: true }) });
  await expect(headRow).toContainText('2'); // rolled-up routes

  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByTestId('create-missing').click();
  await expect(page.getByTestId('users-flash')).toContainText('accounts created');
  const row = page.getByTestId('user-row').filter({ hasText: `Imp Sup ${SFX}` });
  await expect(row).toContainText('Sales Supervisor');
  await expect(row.getByTestId('user-status')).toHaveText('Not signed in yet');
  const first = (await row.getByTestId('first-pw').textContent())!.trim();
  expect(first).toMatch(/^[A-Z]{4}[2-9]{4}$/);
  const username = (await row.locator('code').first().textContent())!.trim();

  const dl = page.waitForEvent('download');
  await page.getByTestId('dl-logins').click();
  const sheet = await readSheet(readFileSync((await (await dl).path())!));
  expect(sheet[0]).toEqual(['Name', 'Username', 'First password', 'Roles', 'Status']);
  expect(sheet.some((r) => r[1] === username && r[2] === first)).toBe(true);

  // The first password works (own request context: the admin stays signed in on the page).
  const login = await request.post('/api/auth/login', { data: { username, password: first } });
  expect(login.status()).toBe(200);
});
