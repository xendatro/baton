import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  newUser,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * Error states, edge-case navigation and palette behaviour found in review: failed page chunks
 * (after a deploy), crafted ?next values, the palette's ranking and toggle, username sign-in with
 * an unverified email, and the collapsed sidebar.
 */

async function openDashboard(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

// Regression (WEB-1): a failed page chunk replaced the app with React Router's raw error page.
test('a page chunk that fails to load shows a styled error with a way back', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Log in to Baton' })).toBeVisible();
  await page.route('**/assets/SignupPage-*.js', (route) => route.abort());
  await page.getByRole('link', { name: 'Sign up' }).click();

  // One automatic reload (a new deploy), then the error, since the chunk still fails.
  await expect(page.getByRole('heading', { name: 'Baton was updated' })).toBeVisible();
  await expect(page.getByText('Unexpected Application Error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await page.unroute('**/assets/SignupPage-*.js');
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
});

test('inside the app, a failed page chunk keeps the sidebar usable', async ({ page }) => {
  await signedInUser(page);
  await openDashboard(page);
  await page.route('**/assets/InboxPage-*.js', (route) => route.abort());
  await page.getByRole('link', { name: /^Inbox/ }).click();

  await expect(page.getByRole('heading', { name: 'Baton was updated' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  await page.getByRole('link', { name: /^My tasks/ }).click();
  await expect(page).toHaveURL(/\/my-tasks$/);
  await expect(page.getByRole('heading', { name: 'Baton was updated' })).toHaveCount(0);
});

// Regression (WEB-5): control characters in ?next crashed the auth pages.
test('a crafted ?next with control characters falls back to the dashboard', async ({ page }) => {
  await signedInUser(page);
  for (const next of ['%2F%09%2Fevil.example', '%2F%0A%2Fevil.example']) {
    await page.goto(`/login?next=${next}`);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  }
});

// Regression (WEB-6): "sign out" + Enter ran the weak "Settings" match instead.
test('the palette runs the best match: "sign out" signs out', async ({ page }) => {
  await signedInUser(page);
  await openDashboard(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('Search or jump to…').fill('sign out');
  await expect(palette.getByRole('option')).toHaveText(['Sign out']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Log in to Baton' })).toBeVisible();
});

// Regression (WEB-10): Ctrl+K inside the palette moved the selection instead of closing it.
test('Ctrl+K toggles the palette', async ({ page }) => {
  await signedInUser(page);
  await openDashboard(page);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette).toBeHidden();
});

// Regression (WEB-9): signing in by username with an unverified email was a dead end.
test('signing in by username with an unverified email leads to verification', async ({
  page,
  request,
}) => {
  const user: TestUser = newUser();
  const signUp = await request.post('/api/auth/sign-up/email', { data: user, headers: ORIGIN });
  expect(signUp.ok()).toBe(true);

  await page.goto('/login?next=%2Finbox');
  await page.getByLabel('Email or username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page).toHaveURL(/\/verify-email\?next=%2Finbox$/);
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
});

// Regression (WEB-12): the collapsed sidebar showed a clipped "B" and no unread signal.
test('the collapsed sidebar shows the logo mark alone and an unread dot', async ({ page }) => {
  const user = await signedInUser(page);
  withDatabase((db) => {
    const userId = (
      db.prepare('select id from user where email = ?').get(user.email) as { id: string }
    ).id;
    const teamId = `e2e${randomBytes(8).toString('hex')}`;
    const now = Date.now();
    db.prepare(
      'insert into team (id, name, slug, color, owner_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(teamId, 'Unread team', teamId, '#6366f1', userId, now, now);
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      teamId,
      userId,
      now,
    );
    db.prepare(
      `insert into notification (id, user_id, team_id, type, entity_type, entity_id, title, url, created_at)
       values (?, ?, ?, 'mention', 'task', 'x', 'Ping', '/', ?)`,
    ).run(`n${randomBytes(8).toString('hex')}`, userId, teamId, now);
  });

  await openDashboard(page);
  await expect(page.getByRole('link', { name: /^Inbox \(1 unread\)/ })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle sidebar' }).first().click();

  const home = page.getByRole('link', { name: 'Baton home' });
  await expect(home.getByText('Baton', { exact: true })).toBeHidden();
  const inbox = page.getByRole('link', { name: /^Inbox/ });
  const dot = inbox.locator('span.rounded-full');
  await expect(dot).toBeVisible();
});
