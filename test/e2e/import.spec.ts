import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';

// Bulk import (Task E): upload -> preview -> apply on the Users, Packs and Hierarchy screens.
const SFX = Date.now().toString(36);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEPT = `IM${SFX}`.toUpperCase();
const U1 = `imp1${SFX}`;
const U2 = `imp2${SFX}`;

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

test('users then hierarchy: generated password shown once, tree built from one file, moves applied', async ({ page, request }) => {
  await signInAdmin(page);
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  const users = page.getByTestId('import-users');
  await users.getByTestId('import-file-users').setInputFiles(await file('users.xlsx',
    ['Username', 'Full name', 'Role', 'Password', 'Language', 'Email'],
    [[U1, `Imported One ${SFX}`, 'manager', 'first-pass-123', 'ar', null], [U2, `Imported Two ${SFX}`, 'manager', null, null, null]]));
  await expect(users.getByTestId('import-summary')).toContainText('2 to add');
  await users.getByTestId('import-apply').click();
  await expect(users.getByTestId('import-done')).toContainText('2 added');
  const gen = users.getByTestId('generated-row');
  await expect(gen).toHaveCount(1);
  await expect(gen).toContainText(U2);
  const generated = (await gen.locator('code').textContent())!.trim();
  expect(generated).toMatch(/^[A-Za-z0-9]{12}$/);
  const dl = page.waitForEvent('download');
  await users.getByRole('button', { name: 'Download passwords (.xlsx)' }).click();
  const sheet = await readSheet(readFileSync((await (await dl).path())!));
  expect(sheet).toEqual([['Username', 'Password'], [U2, generated]]);
  await expect(page.getByTestId('user-row').filter({ hasText: U1 })).toBeVisible();

  // The generated password works (own request context: the admin stays signed in on the page).
  const login = await request.post('/api/auth/login', { data: { username: U2, password: generated } });
  expect(login.status()).toBe(200);

  // Hierarchy: a new department, the whole tree in one file (children before parents).
  const dept = await page.request.post('/api/admin/departments', { data: { code: DEPT, name: `Import ${SFX}` } });
  const deptId = ((await dept.json()) as { department: { id: number } }).department.id;
  await page.goto(`/admin/hierarchy?dept=${deptId}`);
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  const hier = page.getByTestId('import-hierarchy');
  const header = ['Department', 'Node name', 'Parent node name', 'Manager username'];
  await hier.getByTestId('import-file-hierarchy').setInputFiles(await file('bad-tree.xlsx', header, [
    [DEPT, 'Head', null, 'admin'], [DEPT, 'Sup', 'Area', 'nobody'],
  ]));
  await expect(hier.getByTestId('import-error')).toHaveCount(2); // unknown manager, unknown parent
  await expect(hier.getByTestId('import-apply')).toBeDisabled();

  await hier.getByTestId('import-file-hierarchy').setInputFiles(await file('tree.xlsx', header, [
    [DEPT, 'Sup 1', 'Area', U1], [DEPT, 'Sup 2', 'Area', U2], [DEPT, 'Area', 'Head', U1], [DEPT, 'Head', null, 'admin'],
  ]));
  await expect(hier.getByTestId('import-summary')).toContainText('4 to add, 0 to update, 0 unchanged');
  await hier.getByTestId('import-apply').click();
  await expect(hier.getByTestId('import-done')).toContainText('4 added');
  await expect(page.getByTestId('node-row')).toHaveCount(4);
  await expect(page.getByTestId('node-row').filter({ hasText: 'Sup 2' }).getByTestId('node-manager')).toContainText(`Imported Two ${SFX}`);

  // Move Sup 2 under Head and change its manager.
  await hier.getByTestId('import-file-hierarchy').setInputFiles(await file('move.xlsx', header, [[DEPT, 'Sup 2', 'Head', U1]]));
  await expect(hier.getByTestId('import-summary')).toContainText('0 to add, 1 to update, 0 unchanged');
  await hier.getByTestId('import-apply').click();
  await expect(hier.getByTestId('import-done')).toContainText('1 updated');
  const sup2 = page.getByTestId('node-row').filter({ hasText: 'Sup 2' });
  await expect(sup2.getByTestId('node-manager')).toContainText(`Imported One ${SFX}`);
  await expect(sup2).toHaveAttribute('aria-level', '2');
});
