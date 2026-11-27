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
  await page.getByLabel('Manager threshold %').fill('5');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByRole('status').first()).toContainText('Saved');
  await expect(page.getByTestId('dept-setup').first()).toBeVisible();
  // Target emails: on by default, can be turned off and on.
  const mail = page.getByTestId('mail-form');
  await expect(mail.getByTestId('mail-on')).toBeChecked();
  await mail.getByTestId('mail-on').click();
  await expect(mail.getByTestId('mail-on')).not.toBeChecked();
  await mail.getByTestId('mail-on').click();
  await expect(mail.getByTestId('mail-on')).toBeChecked();
  // The company name and logo of the approval template.
  const brand = page.getByTestId('brand-form');
  await brand.getByTestId('brand-company').fill('Test Company');
  await brand.getByTestId('brand-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
  await expect(brand.getByRole('img', { name: 'Logo' })).toBeVisible();
  await brand.getByTestId('brand-save').click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).last()).toBeVisible();

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
  // Nothing changed yet: back to the uploaded target has nothing to do.
  await expect(cd.getByTestId('reset-to-uploaded')).toBeDisabled();
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
  // Reset uplift undoes it; Reset on a category goes back to the split as opened.
  await cd.getByTestId('uplift-reset').click();
  await expect(cell).toHaveValue(/^500$/);
  await expect(cd.getByTestId('uplift-reset')).toBeDisabled();
  await cd.getByTestId('cat-reset-CSD').click();
  await expect(cell).toHaveValue(/^30$/);
  // The Total row of all categories.
  await expect(cd.getByTestId('cd-by-category').locator('tr.cd-cat-total')).toContainText('Total');
  // Reset all categories: every pack back to the uploaded target.
  await cell.fill('500');
  await cell.press('Tab');
  await expect(cd.getByTestId('reset-all-cat')).toBeEnabled();
  await cd.getByTestId('reset-all-cat').click();
  await expect(cell).toHaveValue(/^30$/);
  await expect(cd.getByTestId('reset-all-cat')).toBeDisabled();
  await cell.fill('500');
  await cell.press('Tab');
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
  // PAGO is not closed yet: the forecast closing (sales by day x remaining days) is offered before the download.
  await expect(cd.getByTestId('pago-forecast')).toBeVisible();
  await cd.getByTestId('pago-fc-on').check();
  await cd.getByTestId('pago-fc-done').fill('21');
  await cd.getByTestId('pago-fc-left').fill('4');
  await expect(cd.getByTestId('pago-fc-table')).toBeVisible();
  const [dl] = await Promise.all([cd.waitForEvent('download'), cd.getByTestId('approval-download-banner').click()]);
  const xlsx = testInfo.outputPath('approval.xlsx');
  await dl.saveAs(xlsx);
  const sheets = await readSheet(xlsx, 'By Manager').then(() => true).catch(() => false);
  expect(sheets).toBe(true);
  const s1 = await readSheet(xlsx, 'June');
  expect(s1.flat()).toContain('TARGET vs YAGO');
  expect(s1.flat()).toContain('CSD_CANS150');
  expect(s1.flat()).toContain('Test Company');
  expect(s1.flat()).toContain('June 2031 Target');
  // With the admin's own template: the download fills it (same file, the numbers written in).
  const { strFromU8, strToU8, unzipSync, zipSync } = await import('fflate');
  const tplZip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="November" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Pack</t></is></c><c r="C1" t="inlineStr"><is><t>TARGET</t></is></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>CSD_CANS150</t></is></c><c r="C2"><v>1</v></c></row></sheetData></worksheet>'),
  });
  const put = await cd.request.put('/api/admin/approval-template', { data: { name: 'mine.xlsx', data: Buffer.from(tplZip).toString('base64') } });
  expect(put.status()).toBe(403); // the CD can't set it; the admin can
  const putA = await page.request.put('/api/admin/approval-template', { data: { name: 'mine.xlsx', data: Buffer.from(tplZip).toString('base64') } });
  expect(putA.ok()).toBe(true);
  const [dl2] = await Promise.all([cd.waitForEvent('download'), cd.getByTestId('approval-download-banner').click()]);
  expect(dl2.suggestedFilename()).toBe(`Target_For_Approval_${P}.xlsx`);
  const filled = unzipSync(new Uint8Array(await (await import('node:fs/promises')).readFile(await dl2.path())));
  expect(strFromU8(filled['xl/workbook.xml']!)).toContain('name="June"');
  expect(strFromU8(filled['xl/worksheets/sheet1.xml']!)).toContain('<c r="C2"><v>550</v></c>');
  await page.request.put('/api/admin/approval-template', { data: { data: null } });

  // Admin calculates the route targets, applies them and sends to the Head.
  await page.reload();
  await page.getByRole('tab', { name: 'Target calculator' }).click();
  // Upload instead of the system calculation: the admin's MTFL file, checked against the department target.
  await page.getByTestId('src-upload').check();
  const { default: writeX } = await import('write-excel-file/node');
  const mtfl = await (writeX as unknown as (d: unknown) => { toBuffer: () => Promise<Buffer> })([
    ['Creation Date:', null], ['Period (YYYYMM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases', 'Amount', 'Format'],
    [P, 'Presell – TT', 314023, 42464, 'CSD_CANS150', 10, null, 'Small'], [P, 'Presell – TT', 314023, 42464, 'AquafinA_330', 5, null, 'Small'],
  ].map((r) => r.map((value) => (value === null ? null : { value })))).toBuffer();
  await page.getByTestId('route-upload-file').setInputFiles({ name: 'MTFL_Targets.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: mtfl });
  await expect(page.getByTestId('route-upload-check')).toContainText('Under by');
  await page.getByTestId('apply-upload').click();
  await expect(page.getByTestId('calc-applied')).toContainText(/Applied for \d+ Heads/);
  await page.getByTestId('src-system').check();
  await page.getByRole('button', { name: 'Calculate target on route by pack' }).click();
  await expect(page.getByText('Matches').first()).toBeVisible();
  // The export is the MTFL file.
  const [dlM] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export target (MTFL)' }).click()]);
  expect(dlM.suggestedFilename()).toBe(`MTFL_Targets_${P}.xlsx`);
  const mt = await readSheet(await dlM.path(), 'Sheet1');
  expect(mt[0]![0]).toBe('Creation Date:');
  expect(mt[1]).toEqual(['Period (YYYYMM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases', 'Amount', 'Format']);
  expect(mt[2]![0]).toBe(P);
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
