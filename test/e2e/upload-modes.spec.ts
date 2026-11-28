import { expect, test } from '@playwright/test';
import writeXlsxFile from 'write-excel-file/node';

// Uploaded files: a monthly sales file can add only the new months, or update the months it holds.
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function file(rows: (string | number)[][]) {
  const data = [['Route Code', 'Sales Target Category', 'Period', 'Cases'].map((value) => ({ value })), ...rows.map((r) => r.map((value) => ({ value })))];
  return { name: 'sales.xlsx', mimeType: XLSX, buffer: await writeXlsxFile(data as never).toBuffer() };
}

test('sales upload: add new months only, then update existing months', async ({ page }) => {
  await page.goto('/admin/cycle/ops/2033-01?tab=files');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('admin-cycle')).toBeVisible();
  const api = async (method: 'post' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](`/api${path}`, data === undefined ? undefined : { data });
    expect(res.ok(), await res.text()).toBe(true);
    return res.json();
  };
  await api('post', '/admin/data/ops/routes', { kind: 'sales', rows: [{ month: '2032-10', routeCode: '314023', values: { CSD_CANS150: 30 } }] });
  await page.reload();
  const step = page.getByTestId('step-2');
  const xlsx = await file([['314023', 'CSD_CANS150', '2032-10', 99], ['314023', 'CSD_CANS150', '2032-11', 40]]);
  await step.locator('input[type=file]').setInputFiles(xlsx);
  await expect(step.getByTestId('up-months')).toContainText('New months: 2032-11');
  await expect(step.getByTestId('up-months')).toContainText('Already loaded: 2032-10');
  await step.getByTestId('up-add').check();
  await step.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(step.getByRole('status')).toContainText('left as they are');
  const oct = await api('get', '/data/ops/routes?kind=sales&month=2032-10') as { r: string; v: Record<string, number> }[];
  expect(oct.find((x) => x.r === '314023')!.v.CSD_CANS150).toBe(30);
  const nov = await api('get', '/data/ops/routes?kind=sales&month=2032-11') as { r: string; v: Record<string, number> }[];
  expect(nov.find((x) => x.r === '314023')!.v.CSD_CANS150).toBe(40);
  // Update: the months in the file replace what was loaded.
  await step.locator('input[type=file]').setInputFiles(xlsx);
  await step.getByTestId('up-update').check();
  await step.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(step.getByRole('status')).toBeVisible();
  const oct2 = await api('get', '/data/ops/routes?kind=sales&month=2032-10') as { r: string; v: Record<string, number> }[];
  expect(oct2.find((x) => x.r === '314023')!.v.CSD_CANS150).toBe(99);
});

test('upload the target by pack in Uploaded files, then use it as the New Target in Start cycle', async ({ page }) => {
  const P = '2034-02';
  await page.goto(`/admin/cycle/ops/${P}?tab=files`);
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('admin-cycle')).toBeVisible();
  const step = page.getByTestId('step-3');
  await expect(step).toContainText('Upload target');
  await step.getByTestId('target-up-pack').check();
  const data = [['Pack', 'Cases'], ['CSD_CANS150', 120], ['AquafinA_330', 30]].map((r) => r.map((value) => ({ value })));
  await step.locator('input[type=file]').setInputFiles({ name: 'target.xlsx', mimeType: XLSX, buffer: await writeXlsxFile(data as never).toBuffer() });
  await step.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(step.getByRole('status')).toBeVisible();

  await page.goto(`/admin/cycle/ops/${P}?tab=start`);
  await page.getByRole('button', { name: 'Open the cycle' }).click();
  const src = page.getByTestId('nt-source');
  await src.getByTestId('nt-src-upload').click();
  await expect(src.getByTestId('nt-src-upload')).toBeChecked();
  await src.getByTestId('nt-by-pack').click();
  await expect(src.getByTestId('nt-by-pack')).toBeChecked();
  const use = page.getByTestId('up-target-use');
  await expect(use).toContainText('target.xlsx');
  await use.getByTestId('up-target-use-btn').click();
  await expect(use).toHaveClass(/done/);
  // By pack and department needs a target uploaded by department.
  await src.getByTestId('nt-by-dept').click();
  await expect(src.getByTestId('nt-by-dept')).toBeChecked();
  await expect(use).toContainText('by pack only');
});
