import { expect, test } from '@playwright/test';

// Admin › Users: the people of the sales hierarchy by position, and creating
// the missing sign-in accounts in one go.
test('admin sees the hierarchy by position and creates the missing accounts', async ({ page }) => {
  await page.goto('/admin/users');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('people-by-position')).toBeVisible();
  const rows = [
    { head: 'Pos Head', manager: 'Pos Manager', supervisor: 'Pos Supervisor', route: '999101' },
    { head: 'Pos Head', manager: 'Pos Manager', supervisor: 'Pos Supervisor Two', route: '999102' },
  ];
  // A department of its own so the seeded tree stays as it is.
  const res = await page.request.post('/api/admin/hierarchy/sync/apply', { data: { rows, depts: { 'Pos Head': 'new' } } });
  expect(res.ok(), await res.text()).toBe(true);
  await page.reload();

  const box = page.getByTestId('people-by-position');
  await expect(box).toBeVisible();
  await box.getByTestId('pp-supervisor').click();
  await box.getByRole('searchbox').fill('Pos ');
  await expect(box.getByTestId('pp-row')).toHaveCount(2);
  await box.getByRole('button', { name: 'All positions' }).click();
  await expect(box.getByTestId('pp-row')).toHaveCount(4);
  await box.getByTestId('pp-create').click();
  await expect(box.getByRole('status')).toContainText('accounts created and linked');
  await expect(box.getByTestId('pp-download')).toBeVisible();
  await expect(box.getByTestId('pp-create')).toHaveCount(0);
});
