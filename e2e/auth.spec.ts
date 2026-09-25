import type { Page } from '@playwright/test';
import {
  createVerifiedUser,
  expect,
  mailbox,
  newUser,
  ORIGIN,
  readCode,
  test,
  typeCode,
  withDatabase,
} from './support/fixtures.ts';

/** The dashboard placeholder: where a signed-in, onboarded user lands. */
async function expectDashboard(page: Page) {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
}

async function logIn(page: Page, identifier: string, password: string) {
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

test('signs up with email, verifies the emailed code and lands on the dashboard', async ({
  page,
}) => {
  const user = newUser();
  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Display name').fill(user.name);
  await page.getByLabel('Username').fill(user.username.toUpperCase());
  await expect(page.getByText(`@${user.username} is available`)).toBeVisible();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/verify-email\?/);
  await expect(page.getByText(user.email)).toBeVisible();
  const code = await readCode(user.email, 'email-verification');
  // Sign-up emails the code once; the page must not send a second, superseding one.
  expect(mailbox(user.email, 'email-verification')).toHaveLength(1);
  await expect(page.getByRole('button', { name: /resend in \d+s/ })).toBeDisabled();

  await typeCode(page, code);
  await expectDashboard(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu').getByText(user.email)).toBeVisible();
});

test('a wrong verification code is refused and the right one still works', async ({ page }) => {
  const user = newUser();
  await page.goto('/signup');
  await page.getByLabel('Display name').fill(user.name);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/verify-email\?/);

  const code = await readCode(user.email, 'email-verification');
  const wrong = code === '000000' ? '111111' : '000000';
  await typeCode(page, wrong);
  await expect(page.getByRole('alert')).toHaveText(/code isn’t right/);
  await expect(page).toHaveURL(/\/verify-email\?/);

  await typeCode(page, code);
  await expectDashboard(page);
});

test('signs out and back in with email or username', async ({ page, request }) => {
  const user = await createVerifiedUser(request);

  await page.goto('/login');
  await logIn(page, user.email, user.password);
  await expectDashboard(page);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Log in to Baton' })).toBeVisible();

  // Signed out for real: guarded pages bounce back to the login page.
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login\?next=%2Finbox$/);

  await logIn(page, user.username, user.password);
  await expect(page).toHaveURL(/\/inbox$/);
});

test('a wrong password shows an error and keeps the user signed out', async ({ page, request }) => {
  const user = await createVerifiedUser(request);

  await page.goto('/login');
  await logIn(page, user.email, `${user.password}-wrong`);
  await expect(page.getByRole('alert')).toHaveText('That email and password don’t match.');
  await expect(page).toHaveURL(/\/login$/);

  const session = await page.request.get('/api/auth/get-session');
  expect(await session.json()).toBeNull();
});

test('resets a forgotten password with an emailed code', async ({ page, request }) => {
  const user = await createVerifiedUser(request);
  const newPassword = `${user.password}-new`;

  await page.goto('/login');
  await page.getByRole('link', { name: /forgot/i }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await page.getByLabel('Email').fill(user.email);
  await page.getByRole('button', { name: 'Send reset code' }).click();

  await expect(page).toHaveURL(/\/reset-password\?email=/);
  const code = await readCode(user.email, 'forget-password');
  await typeCode(page, code);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page).toHaveURL(/\/login\?email=/);
  // The old session (from sign-up in `request`) was revoked by the reset.
  expect(await (await request.get('/api/auth/get-session')).json()).toBeNull();

  await logIn(page, user.email, newPassword);
  await expectDashboard(page);

  const oldPassword = await request.post('/api/auth/sign-in/email', {
    data: { email: user.email, password: user.password },
    headers: ORIGIN,
  });
  expect(oldPassword.status()).toBe(401);
});

test('a user without a username chooses one before anything else', async ({ page, request }) => {
  // OAuth sign-ups arrive without a username; with no OAuth app in e2e, clear it in the database.
  const user = await createVerifiedUser(request);
  withDatabase((db) =>
    db
      .prepare('UPDATE user SET username = NULL, display_username = NULL WHERE email = ?')
      .run(user.email),
  );

  // The API refuses everything but /api/me until a username is chosen.
  const blocked = await request.get('/api/notifications');
  expect(blocked.status()).toBe(403);
  expect(await blocked.json()).toMatchObject({ error: { code: 'username_required' } });
  expect((await request.get('/api/me')).ok()).toBe(true);

  await page.goto('/login?next=%2Finbox');
  await logIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/onboarding\/username\?next=%2Finbox$/);
  await expect(page.getByRole('heading', { name: 'Choose a username' })).toBeVisible();

  const chosen = `${user.username}_x`;
  await page.getByLabel('Username').fill(chosen);
  await expect(page.getByText(`@${chosen} is available`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/inbox$/);
  const me = (await (await page.request.get('/api/me')).json()) as { user: { username: string } };
  expect(me.user.username).toBe(chosen);
  expect((await request.get('/api/notifications')).ok()).toBe(true);
});
