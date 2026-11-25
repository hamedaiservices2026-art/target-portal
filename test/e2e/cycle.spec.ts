import { expect, test, type Page } from '@playwright/test';
import { readSheet } from 'read-excel-file/node';

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
  await expect(page.getByText('0 of 6 steps done')).toBeVisible();
  await page.getByRole('button', { name: 'Open the cycle' }).click();
  await expect(page.getByText('1 of 6 steps done')).toBeVisible();
  await expect(page.getByTestId('step-6')).toBeVisible();
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
  await page.getByRole('tab', { name: 'Workflow' }).click();
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

test('the whole cycle: CD splits and submits, Admin calculates and sends, the Head approves', async ({ page, browser }, testInfo) => {
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

  // The CD (head1 here) approves the New Target (the split by department is
  // made on approval), checks the department tab and returns it to Admin.
  const cdCtx = await browser.newContext();
  const cd = await cdCtx.newPage();
  await signIn(cd, 'head1', 'manager-pass-123', `/cd/ops/${P}`);
  await expect(cd.getByTestId('cd-page')).toBeVisible();
  await expect(cd.getByTestId('submit-reason')).toContainText('the New Target is not approved');
  await expect(cd.getByTestId('gm-table')).toContainText('CSD_CANS150');
  await cd.getByTestId('approve-nt').click();
  await expect(cd.getByTestId('dept-table')).toContainText('CSD_CANS150');
  await expect(cd.getByTestId('month-picker')).toBeVisible();
  // No Key Account button on the CD screen.
  await expect(cd.getByRole('button', { name: 'Key Accounts' })).toHaveCount(0);
  // The CD raises a cell freely: the pack's New Target follows, and the split can still be submitted.
  const cell = cd.getByLabel('CSD_CANS150 Presell – TT');
  await cell.fill('500');
  await cell.press('Tab');
  await expect(cd.getByTestId('submit-reason')).toHaveCount(0);
  await expect(cd.getByTestId('split-formula')).toContainText('Formula:');
  // Uplift: +10% on every category (500 + 10 cases -> 561, kept per pack).
  await cd.getByTestId('uplift-pct').fill('10');
  await cd.getByTestId('uplift-apply').click();
  await expect(cell).toHaveValue(/550/);
  // Avg sales / PAGO / YAGO columns can be hidden and shown again.
  const catTable = cd.getByTestId('cd-by-category');
  await expect(catTable.getByRole('columnheader', { name: 'PAGO' }).first()).toBeVisible();
  await cd.getByTestId('cd-cat-bench').uncheck();
  await expect(catTable.getByRole('columnheader', { name: 'PAGO' })).toHaveCount(0);
  await cd.getByTestId('cd-cat-bench').check();
  await expect(catTable.getByRole('columnheader', { name: 'PAGO' }).first()).toBeVisible();
  await cd.getByRole('tab', { name: 'vs PAGO sales' }).click();
  await expect(cd.getByTestId('head-sales-cat')).toContainText('CSD');
  await cd.getByRole('button', { name: 'Approve and return to Admin' }).click();
  await expect(cd.getByTestId('cd-status')).toHaveText('Submitted by the Commercial Director');
  // After the approval: the approval template for signing.
  await expect(cd.getByTestId('approval-banner')).toBeVisible();
  const [dl] = await Promise.all([cd.waitForEvent('download'), cd.getByTestId('approval-download-banner').click()]);
  const xlsx = testInfo.outputPath('approval.xlsx');
  await dl.saveAs(xlsx);
  const sheets = await readSheet(xlsx, 'By Manager').then(() => true).catch(() => false);
  expect(sheets).toBe(true);
  const s1 = await readSheet(xlsx, 'June');
  expect(s1.flat()).toContain('TARGET vs YAGO');
  expect(s1.flat()).toContain('CSD_CANS150');

  // Admin calculates the route targets, applies them and sends to the Head.
  await page.reload();
  await page.getByRole('tab', { name: 'Target calculator' }).click();
  await page.getByRole('button', { name: 'Calculate target on route by pack' }).click();
  await expect(page.getByText('Matches').first()).toBeVisible();
  await page.getByTestId('apply-calc').click();
  await expect(page.getByTestId('calc-applied')).toContainText(/Applied for \d+ Heads/);
  await page.getByRole('tab', { name: 'Workflow' }).click();
  await expect(page.getByTestId('wf-head').filter({ hasText: 'Head TT' })).toBeVisible();
  await page.getByRole('tab', { name: 'Send to Heads' }).click();
  const row = page.getByTestId('head-row').filter({ hasText: 'Head TT' });
  await row.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(row).toContainText('Waiting for approval');

  // The Head reviews and distributes first (the turn is open), then approves: the split goes to the managers.
  await cd.goto('/approve');
  const item = cd.getByTestId('approval').filter({ hasText: P });
  await expect(item).toContainText('561');
  await expect(item.getByTestId('head-summary')).toBeVisible();
  await expect(item.getByTestId('review-distribute')).toBeVisible();
  await item.getByRole('button', { name: 'Approve and send to managers' }).click();
  await expect(item).toContainText('Approved');
  await cd.getByTestId('bell').click();
  await expect(cd.getByRole('dialog', { name: 'Notifications' })).toContainText(P);
  await cdCtx.close();
});

test('admin sets the department columns of the CD screen', async ({ page }) => {
  await signIn(page, 'admin', 'admin-pass-123', `/admin/cycle/ops/2031-08`);
  await page.getByRole('button', { name: 'Open the cycle' }).click();
  const step = page.getByTestId('dept-columns');
  await expect(step).toBeVisible();
  const boxes = step.locator('tbody tr').first().getByRole('checkbox');
  await boxes.nth(1).check(); // TT Outer
  await boxes.nth(0).check(); // TT DMM
  await step.getByTestId('dc-save').click();
  await expect(step.getByRole('status')).toContainText('Saved');
  await expect(step.getByTestId('dc-order')).toContainText(/TT DMM · TT Outer · .*Total TT/);
  // Before sending to the CD the missing steps are named.
  await expect(page.getByTestId('send-missing')).toContainText('1. AOP');
  // Revert the month to the beginning.
  await page.getByTestId('revert').click();
  await page.getByRole('button', { name: 'Revert the target' }).last().click();
  await expect(page.getByTestId('revert-done')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the cycle' })).toBeVisible();
});
