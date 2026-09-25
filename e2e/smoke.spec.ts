import { expect, test } from '@playwright/test';

test('health endpoint reports ok', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ ok: true });
});

test('SPA serves the login page without CSP or console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  await page.goto('/login');
  await expect(page).toHaveTitle('Log in to Baton · Baton');
  await expect(page.getByRole('heading', { name: 'Log in to Baton' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('signed-out visitors are sent to the login page with a return path', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fprofile$/);
  await expect(page.getByRole('heading', { name: 'Log in to Baton' })).toBeVisible();
});

test('theme bootstrap applies the saved dark theme before render', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('baton-theme', 'dark'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
});
