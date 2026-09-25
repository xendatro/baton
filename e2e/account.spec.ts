import { randomInt } from 'node:crypto';
import type { APIRequest, APIRequestContext, Page } from '@playwright/test';
import { meResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import {
  createVerifiedUser,
  expect,
  newUser,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * Account settings end to end: profile, API keys with agent setup, password and sessions, theme
 * persistence across sign-ins, connections and account deletion.
 */

test.use({ colorScheme: 'light' });

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * `GET /api/me/deleted-teams` belongs to the teams module. Until it is merged, answer it with an
 * empty list so the account page renders; once it exists, the real endpoint answers.
 */
async function deletedTeamsFallback(page: Page) {
  await page.route('**/api/me/deleted-teams', async (route) => {
    const response = await route.fetch();
    if (response.status() === 404) await route.fulfill({ json: { items: [] } });
    else await route.fulfill({ response });
  });
}

/** A cookie-less API client (another browser, a script), with its own client IP. */
function newClient(
  factory: APIRequest,
  headers: Record<string, string> = {},
): Promise<APIRequestContext> {
  return factory.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
      ...headers,
    },
  });
}

async function signInOver(client: APIRequestContext, user: TestUser, password = user.password) {
  return client.post('/api/auth/sign-in/email', {
    data: { email: user.email, password },
    headers: ORIGIN,
  });
}

test('edits the profile: display name, username and picture', async ({ page }) => {
  await signedInUser(page);
  await page.goto('/settings/profile');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Profile · Settings · Baton');

  const nameForm = page.getByRole('form', { name: 'Display name' });
  await nameForm.getByLabel('Name').fill('Ada Lovelace');
  await nameForm.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Display name saved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText('Ada Lovelace');

  const username = `ada_${Date.now().toString(36)}`;
  const usernameForm = page.getByRole('form', { name: 'Username' });
  await usernameForm.getByLabel('Username').fill(username);
  await expect(usernameForm.getByText(`@${username} is available`)).toBeVisible();
  await expect(usernameForm.getByRole('note')).toContainText('will stop pointing at you');
  await usernameForm.getByRole('button', { name: 'Change username' }).click();
  await expect(page.getByText(`You are now @${username}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText(`@${username}`);

  await page.getByLabel('Choose a profile picture').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByText('Profile picture updated')).toBeVisible();
  const me = meResponseSchema.parse(await (await page.request.get('/api/me')).json());
  expect(me.user.image).toMatch(/^\/api\/attachments\/[A-Z0-9]+\/me\.png$/);
  const image = await page.request.get(me.user.image ?? '');
  expect(image.headers()['content-type']).toBe('image/png');

  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Profile picture removed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload picture' })).toBeVisible();
});

test('creates an API key, shows it once with agent setup, and revokes it', async ({
  page,
  playwright,
}) => {
  const user = await signedInUser(page);
  await page.goto('/settings/api-keys');
  await expect(page.getByText('No API keys yet')).toBeVisible();

  await page.getByRole('button', { name: 'New API key' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Claude on laptop');
  await dialog.getByRole('combobox', { name: 'Expires' }).click();
  await page.getByRole('option', { name: '30 days' }).click();
  await dialog.getByRole('button', { name: 'Create key' }).click();

  const keyText = dialog.getByLabel('Your new API key');
  await expect(keyText).toHaveText(/^bat_[A-Za-z0-9]{40}$/);
  const key = (await keyText.textContent()) ?? '';
  await expect(
    dialog.getByText(
      `claude mcp add --transport http baton ${E2E_BASE_URL}/mcp --header "Authorization: Bearer ${key}"`,
    ),
  ).toBeVisible();
  await dialog.getByRole('tab', { name: 'Codex' }).click();
  await expect(dialog.getByText(`url = "${E2E_BASE_URL}/mcp"`)).toBeVisible();
  await expect(dialog.getByText(`export BATON_API_KEY="${key}"`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(key)).toHaveCount(0);

  const list = page.getByRole('list', { name: 'API keys' });
  await expect(list).toContainText('Claude on laptop');
  await expect(list).toContainText('Active');
  await expect(list).toContainText(`bat_${key.slice(4, 12)}…`);

  const script = await newClient(playwright.request, { Authorization: `Bearer ${key}` });
  try {
    const me = await script.get('/api/me');
    expect(meResponseSchema.parse(await me.json()).user.username).toBe(user.username);

    await page.getByRole('button', { name: 'Revoke Claude on laptop' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.getByText('“Claude on laptop” revoked')).toBeVisible();
    await expect(list).toContainText('Revoked');
    expect((await script.get('/api/me')).status()).toBe(401);
  } finally {
    await script.dispose();
  }
});

test('changes the password, signs out other sessions and logs it all', async ({
  page,
  playwright,
}) => {
  const user = await signedInUser(page);
  const laptop = await newClient(playwright.request);
  try {
    expect((await signInOver(laptop, user)).ok()).toBe(true);

    await page.goto('/settings/security');
    const sessions = page.getByRole('list', { name: 'Active sessions' });
    await expect(sessions.getByRole('listitem')).toHaveCount(2);
    await expect(sessions.getByRole('listitem').first()).toContainText('This device');

    await deletedTeamsFallback(page);
    await page.goto('/settings/account');
    const form = page.getByRole('form', { name: 'Change password' });
    await form.getByLabel('Current password').fill('not my password');
    await form.getByLabel('New password', { exact: true }).fill('a whole new passphrase');
    await form.getByLabel('Confirm new password').fill('a whole new passphrase');
    await form.getByRole('button', { name: 'Change password' }).click();
    await expect(form.getByText('That isn’t your current password')).toBeVisible();

    await form.getByLabel('Current password').fill(user.password);
    await form.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password changed. 1 other session signed out.')).toBeVisible();

    // The other session is gone; this one still works.
    expect((await laptop.get('/api/me')).status()).toBe(401);
    expect((await page.request.get('/api/me')).ok()).toBe(true);
    expect((await signInOver(laptop, user, 'a whole new passphrase')).ok()).toBe(true);

    await page.goto('/settings/security');
    await expect(
      page.getByRole('list', { name: 'Active sessions' }).getByRole('listitem'),
    ).toHaveCount(2);
    await page.getByRole('button', { name: 'Sign out other sessions' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out others' }).click();
    await expect(page.getByText('Signed out 1 other session')).toBeVisible();
    expect((await laptop.get('/api/me')).status()).toBe(401);

    const log = page.getByRole('list', { name: 'Security log' });
    await expect(log).toContainText('Signed out 1 other session');
    await expect(log).toContainText('Changed your password and signed out 1 other session');
    await expect(log).toContainText('Signed in with a password');
    await expect(log).toContainText('Created your account');
  } finally {
    await laptop.dispose();
  }
});

test('the theme is saved to the profile and follows the user to a new sign-in', async ({
  page,
  browser,
}) => {
  const user = await signedInUser(page);
  await page.goto('/settings/appearance');
  await page.getByRole('radio', { name: /Dark/ }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect
    .poll(
      async () =>
        meResponseSchema.parse(await (await page.request.get('/api/me')).json()).user.theme,
    )
    .toBe('dark');

  // Another browser, where this user never chose a theme.
  const other = await browser.newContext({
    colorScheme: 'light',
    extraHTTPHeaders: { 'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.9` },
  });
  try {
    const otherPage = await other.newPage();
    await otherPage.goto('/login');
    await expect(otherPage.locator('html')).not.toHaveClass(/dark/);
    await otherPage.getByLabel('Email or username').fill(user.email);
    await otherPage.getByLabel('Password', { exact: true }).fill(user.password);
    await otherPage.getByRole('button', { name: 'Log in' }).click();
    await expect(otherPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(otherPage.locator('html')).toHaveClass(/dark/);
  } finally {
    await other.close();
  }
});

test('connections show which providers this server offers', async ({ page }) => {
  await signedInUser(page);
  await page.goto('/settings/connections');
  await expect(page.getByText('Google sign-in is not configured on this server.')).toBeVisible();
  await expect(page.getByText('GitHub sign-in is not configured on this server.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Google' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Connect GitHub' })).toBeDisabled();
  await expect(
    page.getByText('You can sign in with your email address and password.'),
  ).toBeVisible();
});

test('account deletion is blocked by an owned team, then deletes the account', async ({
  page,
  playwright,
}) => {
  const user = await signedInUser(page);
  const me = meResponseSchema.parse(await (await page.request.get('/api/me')).json());
  const teamId = `01TEAM${Date.now().toString(36).toUpperCase()}`.slice(0, 26);
  withDatabase((db) => {
    const now = Date.now();
    db.prepare(
      `insert into team (id, name, slug, description, icon, color, owner_id, created_at, updated_at)
       values (?, ?, ?, '', null, '#6366f1', ?, ?, ?)`,
    ).run(teamId, 'Blocking team', `blocking-${now.toString(36)}`, me.user.id, now, now);
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      teamId,
      me.user.id,
      now,
    );
  });

  await deletedTeamsFallback(page);
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Delete account' }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('You own a team');
  await expect(dialog).toContainText('Blocking team');
  await expect(dialog.getByRole('button', { name: 'Delete my account' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  withDatabase((db) => {
    db.prepare('delete from team where id = ?').run(teamId);
  });
  await page.reload();
  await page.getByRole('button', { name: 'Delete account' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your password').fill(user.password);
  await dialog.getByRole('button', { name: 'Delete my account' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(/Your account was deleted/)).toBeVisible();

  const client = await newClient(playwright.request);
  try {
    expect((await signInOver(client, user)).ok()).toBe(false);
    // The username is free again.
    const again = await createVerifiedUser(client, { ...newUser(), username: user.username });
    expect(again.username).toBe(user.username);
  } finally {
    await client.dispose();
  }
});
