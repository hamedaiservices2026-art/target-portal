import { expect, test, type Page } from '@playwright/test';

// Seed: month 1 (2026-10, deadline 27 Oct 2026). Head is node 1 (head1, submitted at
// seed time), Sup S-01 is node 2 (sup1). The distribute spec runs first on the same
// database and may already have submitted S-01, so nothing here depends on that:
// the test that needs a submitted node submits it itself when it is still open.
const PASSWORD = 'manager-pass-123';

async function signIn(page: Page, username: string, path = '/') {
  await page.goto(path);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Submits S-01 unchanged (the starting numbers pass the rules) unless it is already submitted. */
async function ensureSupSubmitted(page: Page) {
  const ws = await (await page.request.get('/api/months/1/nodes/2')).json();
  if (ws.node.status === 'submitted') return;
  const values = Object.fromEntries(ws.children.map((c: { key: string; values: unknown }) => [c.key, c.values]));
  const put = await page.request.put('/api/months/1/nodes/2/draft', { data: { values, version: ws.version } });
  expect(put.ok()).toBe(true);
  const { version } = await put.json();
  const sub = await page.request.post('/api/months/1/nodes/2/submit', { data: { version } });
  expect(sub.ok()).toBe(true);
}

test('a manager sees one task on Home; after submit it shows Submitted and the branch agrees', async ({ page }) => {
  await signIn(page, 'sup1');
  const tasks = page.getByTestId('task');
  await expect(tasks).toHaveCount(1);
  await expect(tasks.first()).toContainText('Sup S-01');
  await expect(tasks.first().getByTestId('task-status')).toHaveText(/^(In progress|Submitted)$/);
  await expect(tasks.first()).toContainText('27 Oct 2026');

  await ensureSupSubmitted(page);
  await page.reload();
  await expect(page.getByTestId('task').first().getByTestId('task-status')).toHaveText('Submitted');

  // The branch of S-01 shows itself as submitted, with its total (the 4 routes of the mockup).
  await page.getByRole('link', { name: 'View branch' }).click();
  await expect(page).toHaveURL(/\/m\/1\/n\/2\/branch$/);
  const row = page.getByTestId('branch-row-2');
  await expect(row).toContainText('Sup S-01');
  await expect(row.getByTestId('branch-status')).toHaveText('Submitted');
  await expect(row.getByTestId('branch-total')).toHaveText(/^[\d,]+$/);

  // Open goes to the workspace.
  await page.goto('/');
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/m\/1\/n\/2$/);
});

test('the head sees the whole branch, with manager, per-group totals and a read-only link into a node', async ({ page }) => {
  await signIn(page, 'head1');
  await page.goto('/m/1/n/1/branch');

  const head = page.getByTestId('branch-row-1');
  const sup = page.getByTestId('branch-row-2');
  await expect(head).toContainText('Head TT');
  await expect(head.getByTestId('branch-status')).toHaveText('Submitted');
  await expect(sup).toContainText('Supervisor S-01');
  await expect(sup.getByTestId('branch-status')).toHaveText(/^(In progress|Submitted)$/); // either, whatever ran before
  // The child is indented under the parent.
  const hb = await head.getByRole('link', { name: 'Head' }).boundingBox();
  const sb = await sup.getByRole('link', { name: 'Sup S-01' }).boundingBox();
  expect(sb!.x).toBeGreaterThan(hb!.x);
  // Group totals add up to the grand total, and the head holds the whole branch.
  const num = async (id: string, r = sup) => Number((await r.getByTestId(id).innerText()).replace(/,/g, ''));
  for (const r of [head, sup]) {
    expect((await num('branch-csd', r)) + (await num('branch-water', r)) + (await num('branch-lrb', r))).toBe(await num('branch-total', r));
  }
  expect(await num('branch-total', head)).toBe(await num('branch-total', sup));
  expect(await num('branch-csd', sup)).toBeGreaterThan(0);

  await sup.getByRole('link', { name: 'Sup S-01' }).click();
  await expect(page).toHaveURL(/\/m\/1\/n\/2$/);
  await expect(page.getByTestId('read-only')).toBeVisible();

  // The Distribute header links back to the branch.
  await page.getByRole('link', { name: 'View branch' }).click();
  await expect(page).toHaveURL(/\/m\/1\/n\/2\/branch$/);
});

test('Home groups by month with in-progress tasks first, a dash for no deadline, and an empty state', async ({ page }) => {
  await signIn(page, 'sup1');
  await expect(page.getByTestId('home')).toBeVisible();
  await page.route('**/api/my/tasks', (route) => route.fulfill({
    json: [
      { monthId: 2, period: '2026-11', nodeId: 5, nodeName: 'Zeta', deptCode: 'TT', status: 'submitted', deadline: null },
      { monthId: 2, period: '2026-11', nodeId: 6, nodeName: 'Alpha', deptCode: 'TT', status: 'waiting', deadline: null },
      { monthId: 2, period: '2026-11', nodeId: 7, nodeName: 'Mid', deptCode: 'TT', status: 'in_progress', deadline: null },
      { monthId: 1, period: '2026-10', nodeId: 2, nodeName: 'Old', deptCode: 'TT', status: 'submitted', deadline: '2026-10-27' },
    ],
  }));
  await page.reload();
  await expect(page.getByTestId('task')).toHaveCount(4);
  await expect(page.getByTestId('month-group')).toHaveCount(2);
  const nov = page.getByTestId('month-group').first();
  await expect(nov.getByTestId('task')).toHaveText([/Mid/, /Zeta|Alpha/, /Zeta|Alpha/]);
  await expect(nov.getByTestId('task').first().getByTestId('task-status')).toHaveText('In progress');
  await expect(nov.getByTestId('task').first().getByTestId('task-deadline')).toHaveText('—');
  await expect(nov.getByTestId('task-status').nth(1)).toHaveText(/Submitted|Waiting/);

  await page.unroute('**/api/my/tasks');
  await page.route('**/api/my/tasks', (route) => route.fulfill({ json: [] }));
  await page.reload();
  await expect(page.getByTestId('no-tasks')).toBeVisible();
});

test('/m/:mid sends a manager home and an admin to the month page; in Arabic Home is right-to-left', async ({ page }) => {
  await signIn(page, 'sup1', '/m/1');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('home')).toBeVisible();

  const toAr = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await toAr;
  await expect(page.getByRole('heading', { name: 'مهامي' })).toBeVisible();
  await expect(page.getByTestId('task').first()).toBeVisible();
  await expect(page.getByTestId('task').first()).toHaveCSS('direction', 'rtl');
  const back = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await back;

  await page.getByTestId('logout').click();
  await page.goto('/m/1');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/months\/1$/);
});
