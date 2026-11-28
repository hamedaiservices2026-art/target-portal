import { expect, test, type Page } from '@playwright/test';

// Accounts created by scripts/seed-dev.ts. head1 is only used for the language
// test (it changes the account's saved language and puts it back).
const MANAGER = { username: 'sup1', password: 'manager-pass-123' };
const OTHER = { username: 'head1', password: 'manager-pass-123' };

async function signIn(page: Page, user: { username: string; password: string }) {
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a seeded manager signs in and lands on Home', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, MANAGER);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('user-name')).toContainText('Supervisor S-01');
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0); // admin-only nav

  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login/);
});

test('a wrong password shows the error in English and in Arabic', async ({ page }) => {
  await page.goto('/login');
  await signIn(page, { username: MANAGER.username, password: 'not-the-password' });
  await expect(page.getByTestId('login-error')).toHaveText('Wrong username or password.');

  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('login-error')).toHaveText('اسم المستخدم أو كلمة المرور غير صحيحة.');

  // A second attempt made while the page is Arabic.
  await page.getByLabel('كلمة المرور').fill('still-wrong');
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page.getByTestId('login-error')).toHaveText('اسم المستخدم أو كلمة المرور غير صحيحة.');
});

test('the Arabic toggle sets dir=rtl and survives a reload', async ({ page }) => {
  await page.goto('/login');
  await signIn(page, OTHER);
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  const saved = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await saved;
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { name: 'مهامي' })).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'مهامي' })).toBeVisible();

  // The choice lives on the account, not only in this browser.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  const back = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await back;
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('the language chosen on the login screen is remembered and then saved to the account', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); // localStorage, before any login

  const saved = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByLabel('اسم المستخدم').fill(MANAGER.username);
  await page.getByLabel('كلمة المرور').fill(MANAGER.password);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await saved;
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // Put the account back to English for the other tests.
  const back = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH');
  await page.getByTestId('lang-toggle').click();
  await back;
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('an expired session returns to login and then to the page that was asked for', async ({ page }) => {
  await page.goto('/approve');
  await expect(page).toHaveURL(/\/login\?next=%2Fapprove/);
  await signIn(page, MANAGER);
  await expect(page).toHaveURL(/\/approve$/);

  // The session disappears on the server side: the next API call gets a 401.
  await page.context().clearCookies();
  await page.evaluate(() => fetch('/api/me').then(() => window.dispatchEvent(new CustomEvent('auth:expired'))));
  await expect(page).toHaveURL(/\/login\?next=%2Fapprove/);
});

test('a team page that is not yours sends you to your Home', async ({ page }) => {
  await page.goto('/m/1/n/99999');
  await signIn(page, MANAGER);
  await expect(page).toHaveURL(/\/$/);
});

test('the admin sees the admin navigation', async ({ page }) => {
  await page.goto('/login');
  await signIn(page, { username: 'admin', password: 'admin-pass-123' });
  await page.getByTestId('nav-settings').click();
  await expect(page).toHaveURL(/\/admin\/packs$/);
  for (const name of ['Packs', 'Users', 'Hierarchy', 'History', 'Departments']) {
    await expect(page.getByTestId('settings-nav').getByRole('link', { name })).toBeVisible();
  }
  await page.getByRole('link', { name: 'Hierarchy' }).click();
  await expect(page).toHaveURL(/\/admin\/hierarchy$/);
  await expect(page.getByRole('heading', { name: 'Hierarchy', exact: true })).toBeVisible();
});

test('login and layout never scroll sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await page.goto('/login');
  expect(await sideways()).toBe(false);
  await signIn(page, { username: 'admin', password: 'admin-pass-123' });
  await expect(page.getByTestId('user-name')).toBeVisible();
  expect(await sideways()).toBe(false);
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await sideways()).toBe(false);
  await page.getByTestId('lang-toggle').click();
});
