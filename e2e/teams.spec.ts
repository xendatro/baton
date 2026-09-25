import { randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test, type TestUser } from './support/fixtures.ts';

/**
 * Teams module flows: creating a team, inviting someone and joining with the link, roles and
 * member roles, the unsaved-changes bar, leaving, and deleting a team (typed confirmation, undo).
 */

test.use({ colorScheme: 'light' });

/** A second signed-in person in their own browser context (own client IP). */
async function secondUser(browser: Browser): Promise<{ page: Page; user: TestUser }> {
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();
  const user = await signedInUser(page);
  return { page, user };
}

async function createTeam(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'New team' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a team' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

/** A team's entry in the sidebar. */
function sidebarTeam(page: Page, name: string) {
  return page.locator('[data-sidebar="menu-button"]').filter({ hasText: name });
}

/** Creates an invite link through the settings page and returns its code. */
async function createInvite(page: Page, slug: string): Promise<string> {
  await page.goto(`/t/${slug}/settings/invites`);
  await page.getByRole('button', { name: 'Create invite link' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const link = await dialog.getByLabel('Invite link').inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  return link.split('/join/')[1] ?? '';
}

test('create a team, invite someone, and they join with the link', async ({ page, browser }) => {
  await signedInUser(page);
  const slug = await createTeam(page, 'Orbital Mechanics');
  expect(slug).toBe('orbital-mechanics');
  await expect(page.getByText('No projects yet')).toBeVisible();
  await expect(sidebarTeam(page, 'Orbital Mechanics')).toBeVisible();

  const code = await createInvite(page, slug);
  await expect(page.getByRole('row').filter({ hasText: code })).toBeVisible();

  const guest = await secondUser(browser);
  await guest.page.goto(`/join/${code}`);
  await expect(guest.page.getByRole('heading', { name: 'Orbital Mechanics' })).toBeVisible();
  await guest.page.getByRole('button', { name: 'Join Orbital Mechanics' }).click();
  await expect(guest.page).toHaveURL(new RegExp(`/t/${slug}$`));
  await expect(guest.page.getByText('Welcome to Orbital Mechanics!')).toBeVisible();

  // Visiting the link again says they are already in.
  await guest.page.goto(`/join/${code}`);
  await expect(guest.page.getByText('You’re already a member of')).toBeVisible();

  // The owner sees the new member and the use counted.
  await page.goto(`/t/${slug}/settings/members`);
  await expect(page.getByText(`@${guest.user.username}`)).toBeVisible();
  await page.goto(`/t/${slug}/settings/invites`);
  await expect(page.getByRole('row').filter({ hasText: code })).toContainText('1');
  await guest.page.context().close();
});

test('logged-out visitors are sent to log in and come back to the invite', async ({
  page,
  browser,
}) => {
  await signedInUser(page);
  const slug = await createTeam(page, 'Launch Crew');
  const code = await createInvite(page, slug);

  const context = await browser.newContext({ baseURL: E2E_BASE_URL });
  const visitor = await context.newPage();
  await visitor.goto(`/join/${code}`);
  await expect(visitor).toHaveURL(
    new RegExp(`/login\\?next=${encodeURIComponent(`/join/${code}`)}`),
  );
  await context.close();
});

test('unusable invite links explain what is wrong', async ({ page, browser }) => {
  await signedInUser(page);
  const slug = await createTeam(page, 'Revoked Team');
  const code = await createInvite(page, slug);
  await page.goto(`/t/${slug}/settings/invites`);
  await page.getByRole('button', { name: `Revoke invite ${code}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke link' }).click();
  await expect(page.getByText('Invite link revoked')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: code })).toHaveCount(0);

  const guest = await secondUser(browser);
  await guest.page.goto(`/join/${code}`);
  await expect(guest.page.getByRole('heading', { name: 'This invite was revoked' })).toBeVisible();
  await guest.page.goto('/join/not-a-code');
  await expect(guest.page.getByRole('heading', { name: 'This invite isn’t valid' })).toBeVisible();
  await guest.page.context().close();
});

test('roles: create, grant permissions, assign to a member, reorder', async ({ page, browser }) => {
  await signedInUser(page);
  const slug = await createTeam(page, 'Role Players');
  const code = await createInvite(page, slug);
  const guest = await secondUser(browser);
  const joined = await guest.page.request.post(`/api/invites/${code}/accept`, { headers: ORIGIN });
  expect(joined.ok()).toBe(true);

  await page.goto(`/t/${slug}/settings/roles`);
  await page.getByRole('button', { name: 'Create role' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create role' });
  await dialog.getByLabel('Role name').fill('Navigators');
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByRole('heading', { name: 'Edit role: Navigators' })).toBeVisible();

  // Permissions with the unsaved-changes bar.
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await page.getByRole('switch', { name: 'Manage labels' }).click();
  const bar = page.getByRole('region', { name: 'Unsaved changes' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Manage labels' })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Manage labels' }).click();
  await page.getByRole('switch', { name: 'View audit log' }).click();
  await bar.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved Navigators')).toBeVisible();
  await expect(bar).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'View audit log' })).toBeChecked();

  // Leaving with unsaved changes asks first.
  await page.getByRole('switch', { name: 'Reply' }).click();
  await page.getByRole('link', { name: 'Members', exact: true }).first().click();
  const discard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/\/roles\//);
  await page.getByRole('link', { name: 'Members', exact: true }).first().click();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/settings/members$`));

  // Grant the role from the members page.
  await page.getByRole('button', { name: `Edit roles of ${guest.user.name}` }).click();
  await page.getByRole('option', { name: /Navigators/ }).click();
  await expect(page.getByText(`Gave ${guest.user.name} the Navigators role`)).toBeVisible();
  await page.keyboard.press('Escape');
  const row = page.getByRole('row').filter({ hasText: `@${guest.user.username}` });
  await expect(row.getByText('Navigators')).toBeVisible();

  // The member now has the role's permission (their /api/me reflects it).
  await expect
    .poll(async () => {
      const me = (await (await guest.page.request.get('/api/me')).json()) as {
        teams: Array<{ slug: string; permissions: string[] }>;
      };
      return me.teams.find((team) => team.slug === slug)?.permissions ?? [];
    })
    .toContain('VIEW_AUDIT_LOG');

  // Reorder with the keyboard: move Navigators above Admin.
  await page.goto(`/t/${slug}/settings/roles`);
  const handle = page.getByRole('button', { name: 'Reorder Navigators' });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Reorder Navigators' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await expect(page.getByText(/Navigators is over position 1/)).toBeAttached();
  await page.keyboard.press('Space');
  const firstRole = page.locator('#main a[href*="/settings/roles/"]').first();
  await expect(firstRole).toHaveText('Navigators');
  await page.reload();
  await expect(firstRole).toHaveText('Navigators');
  await guest.page.context().close();
});

test('members can leave; the owner deletes the team and can undo', async ({ page, browser }) => {
  await signedInUser(page);
  const slug = await createTeam(page, 'Short Lived');
  const code = await createInvite(page, slug);
  const guest = await secondUser(browser);
  await guest.page.goto(`/join/${code}`);
  await guest.page.getByRole('button', { name: 'Join Short Lived' }).click();
  await expect(guest.page).toHaveURL(new RegExp(`/t/${slug}$`));

  await guest.page.goto(`/t/${slug}/settings/general`);
  await expect(
    guest.page.getByText('Changing them needs the Manage team permission'),
  ).toBeVisible();
  await guest.page.getByRole('button', { name: 'Leave team' }).click();
  await guest.page.getByRole('alertdialog').getByRole('button', { name: 'Leave team' }).click();
  await expect(guest.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(guest.page.getByText('You left Short Lived')).toBeVisible();
  await expect(sidebarTeam(guest.page, 'Short Lived')).toHaveCount(0);
  await guest.page.context().close();

  // Rename first (the URL follows), then delete with typed confirmation.
  await page.goto(`/t/${slug}/settings/general`);
  await page.getByLabel('Name').fill('Short Lived Team');
  await page
    .getByRole('region', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Save changes' })
    .click();
  await expect(page.getByText('Team settings saved')).toBeVisible();
  await expect(sidebarTeam(page, 'Short Lived Team')).toBeVisible();

  await page.getByRole('button', { name: 'Delete team' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete Short Lived Team?' });
  const submit = confirm.getByRole('button', { name: 'Delete team' });
  await expect(submit).toBeDisabled();
  await confirm.getByRole('textbox').fill(slug);
  await submit.click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(sidebarTeam(page, 'Short Lived Team')).toHaveCount(0);

  const deleted = (await (await page.request.get('/api/me/deleted-teams')).json()) as {
    items: Array<{ slug: string }>;
  };
  expect(deleted.items.map((item) => item.slug)).toContain(slug);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Short Lived Team' })).toBeVisible();
});
