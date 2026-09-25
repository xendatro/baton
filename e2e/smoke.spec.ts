import { expect, test } from '@playwright/test';

test('health endpoint reports ok', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ ok: true });
});

test('SPA shell renders client routes without CSP or console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  await page.goto('/settings');
  await expect(page).toHaveTitle(/Baton/);
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(problems).toEqual([]);
});

test('theme bootstrap applies the saved dark theme before render', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('baton-theme', 'dark'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
});
