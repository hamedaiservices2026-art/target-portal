import { expect, test, type Page } from '@playwright/test';

// Smoke test of the target cycle screens (handover design): Admin opens a
// cycle, the setup page saves the rules, the reports load, a Head sees the
// approvals page and the notification bell.
const PERIOD = '2031-03';

async function signIn(page: Page, username: string, password: string, path = '/') {
  await page.goto(path);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('admin opens a cycle, saves the rules, and reads the reports', async ({ page }) => {
  await signIn(page, 'admin', 'admin-pass-123', `/admin/cycle/ops/${PERIOD}`);
  await expect(page.getByTestId('admin-cycle')).toBeVisible();
  await expect(page.getByText('0 of 8 steps done')).toBeVisible();
  await page.getByRole('button', { name: 'Open the cycle' }).click();
  await expect(page.getByText('1 of 8 steps done')).toBeVisible();
  await expect(page.getByTestId('step-5')).toBeVisible();
  await expect(page.getByTestId('cd-status')).toHaveText('With Admin');

  await page.getByRole('tab', { name: 'Send to Heads' }).click();
  await expect(page.getByTestId('head-row').first()).toBeVisible();

  await page.getByRole('link', { name: 'Cycle setup' }).click();
  await expect(page.getByTestId('cycle-setup')).toBeVisible();
  await page.getByLabel('Manager cap %').fill('5');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByRole('status').first()).toContainText('Saved');
  await expect(page.getByTestId('dept-setup').first()).toBeVisible();

  await page.goto(`/reports/ops/${PERIOD}`);
  await expect(page.getByTestId('reports')).toBeVisible();
  await expect(page.getByText('Cycle opened')).toBeVisible();
  await page.getByRole('tab', { name: 'Summary' }).click();
  await expect(page.getByText('There is no department target for this month yet.')).toBeVisible();
});

test('a Head sees the approvals page and the bell', async ({ page }) => {
  await signIn(page, 'head1', 'manager-pass-123');
  await expect(page.getByTestId('bell')).toBeVisible();
  await page.getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByTestId('approve-page')).toBeVisible();
  await expect(page.getByText('Nothing is waiting for your approval.')).toBeVisible();
  // Not a Commercial Director: the CD page is not allowed.
  await page.goto(`/cd/ops/${PERIOD}`);
  await expect(page.getByTestId('cd-page')).toHaveCount(0);
});

test('the whole cycle: CD splits and submits, Admin calculates and sends, the Head approves', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const P = '2031-06';
  await signIn(page, 'admin', 'admin-pass-123', `/admin/cycle/ops/${P}`);
  await expect(page.getByTestId('admin-cycle')).toBeVisible();
  const api = async (method: 'post' | 'put' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`/api${path}`, data === undefined ? undefined : { data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const { departments } = await api('get', '/admin/departments') as { departments: { id: number; code: string }[] };
  const tt = departments.find((d) => d.code === 'TT')!;
  const { users } = await api('get', '/admin/users') as { users: { id: number; username: string }[] };
  const head = users.find((u) => u.username === 'head1')!;
  await api('put', `/admin/departments/${tt.id}/workspace`, { workspace: 'ops' });
  await api('put', `/admin/departments/${tt.id}/channels`, { channels: [{ channel: 'Presell – TT', grp: 'TT' }] });
  await api('put', `/admin/users/${head.id}/cd`, { cd: ['ops'] });
  await api('put', `/admin/cycle/ops/${P}/settings`, {});
  // Sales of the three months before: one route, two packs.
  const rows = ['2031-03', '2031-04', '2031-05'].map((month) => ({ month, routeCode: '314023', values: { CSD_CANS150: 30, AquafinA_330: 10 } }));
  await api('post', '/admin/data/ops/routes', { kind: 'sales', rows });
  await page.reload();

  // Step 8: the starting New Target is the 3-month average; send it.
  await page.getByRole('button', { name: 'Work out the New Target' }).click();
  await expect(page.getByText('average sales of the last 3 months')).toBeVisible();
  await page.getByRole('button', { name: 'Send to the Commercial Director' }).click();
  await expect(page.getByTestId('cd-status')).toHaveText('With the Commercial Director');

  // The CD (head1 here) approves the New Target, copies column I to J and submits.
  const cdCtx = await browser.newContext();
  const cd = await cdCtx.newPage();
  await signIn(cd, 'head1', 'manager-pass-123', `/cd/ops/${P}`);
  await expect(cd.getByTestId('cd-page')).toBeVisible();
  await expect(cd.getByTestId('submit-reason')).toContainText('the New Target is not approved');
  await cd.getByRole('button', { name: 'Approve New Target' }).click();
  await cd.getByRole('tab', { name: 'Target by department' }).click();
  await expect(cd.getByRole('cell', { name: 'CSD_CANS150' })).toBeVisible();
  await cd.getByRole('tab', { name: 'Share of mix' }).click();
  await cd.getByRole('button', { name: 'Copy column I to J' }).click();
  await cd.getByRole('tab', { name: 'Water' }).click();
  await cd.getByRole('button', { name: 'Copy column I to J' }).click();
  await cd.getByRole('tab', { name: 'LRB-Others' }).click();
  await cd.getByRole('button', { name: 'Copy column I to J' }).click();
  await cd.getByRole('tab', { name: 'Dashboard' }).click();
  await expect(cd.getByText('Total LRB')).toBeVisible();
  await cd.getByRole('button', { name: 'Submit to Admin' }).click();
  await expect(cd.getByTestId('cd-status')).toHaveText('Submitted by the Commercial Director');

  // Admin calculates the route targets, applies them and sends to the Head.
  await page.reload();
  await page.getByRole('tab', { name: 'Target calculator' }).click();
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByText('Reconciliation')).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('status')).toContainText(/Applied for \d+ Heads/);
  await page.getByRole('tab', { name: 'Send to Heads' }).click();
  const row = page.getByTestId('head-row').filter({ hasText: 'Head TT' });
  await row.getByRole('button', { name: 'Send' }).click();
  await expect(row).toContainText('Waiting for approval');

  // The Head approves; the distribution starts.
  await cd.goto('/approve');
  const item = cd.getByTestId('approval').filter({ hasText: P });
  await expect(item).toContainText('40');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item).toContainText('Approved');
  await cd.getByTestId('bell').click();
  await expect(cd.getByRole('dialog', { name: 'Notifications' })).toContainText(P);
  await cdCtx.close();
});
