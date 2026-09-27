import { randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Flows that cross module boundaries: the team home's "New project" opening the projects
 * module's dialog, the team settings layout hosting the admin module's Audit log and Trash (with
 * permission-based navigation), project and issue restores from Trash (and issue rows in the
 * audit log), deleted teams restored from account settings, and an issue turned into a task whose
 * completion resolves the issue and notifies its author.
 */

test.use({ colorScheme: 'light' });

async function createTeam(page: Page, name: string): Promise<{ id: string; slug: string }> {
  const res = await page.request.post('/api/teams', { data: { name }, headers: ORIGIN });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

/** A second signed-in person in their own browser context (own client IP). */
async function secondUser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();
  await signedInUser(page);
  return page;
}

function settingsNav(page: Page) {
  return page.getByRole('navigation', { name: 'Team settings' });
}

test('the team home creates a project through the projects dialog; Trash restores it', async ({
  page,
}) => {
  await signedInUser(page);
  const team = await createTeam(page, 'Integration Crew');

  await page.goto(`/t/${team.slug}`);
  await expect(page.getByText('No projects yet')).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog.getByText('In Integration Crew.')).toBeVisible();
  // The team comes from the team home, so the dialog doesn't ask for one.
  await expect(dialog.getByLabel('Team')).toHaveCount(0);
  await dialog.getByLabel('Name', { exact: true }).fill('Mission Control');
  await dialog.getByLabel('Name your first pipeline').fill('Operations');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/MC$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Mission Control' })).toBeVisible();
  await expect(
    page.locator('[data-sidebar="menu-sub-button"]').filter({ hasText: 'Mission Control' }),
  ).toBeVisible();

  await page.goto(`/t/${team.slug}`);
  await expect(page.locator('#main').getByRole('link', { name: /Mission Control/ })).toBeVisible();

  // Owner: every settings section, including the admin module's pages.
  await page.goto(`/t/${team.slug}/settings/general`);
  const nav = settingsNav(page);
  for (const section of ['General', 'Members', 'Roles', 'Invites', 'Audit log', 'Trash']) {
    await expect(nav.getByRole('link', { name: section })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Audit log' })).toBeVisible();
  await expect(page.getByText('created project Mission Control')).toBeVisible();
  await expect(page.getByText('created the team')).toBeVisible();

  // Delete the project from its settings, then restore it from the team Trash.
  await page.goto(`/t/${team.slug}/p/MC/settings/general`);
  await page.getByRole('button', { name: 'Delete project' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('textbox').fill('MC');
  await confirm.getByRole('button', { name: 'Delete project' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}$`));

  await page.goto(`/t/${team.slug}/settings/trash`);
  await expect(page.getByRole('heading', { level: 2, name: 'Trash' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore project Mission Control' }).first().click();
  await expect(page.getByText('Restored project Mission Control')).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/MC$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Mission Control' })).toBeVisible();
});

test('an issue deleted from its page shows in Trash and the audit log, and restores', async ({
  page,
}) => {
  await signedInUser(page);
  const team = await createTeam(page, 'Issue Triage');
  const project = await page.request.post(`/api/teams/${team.id}/projects`, {
    data: { name: 'Help Desk', key: 'HD' },
    headers: ORIGIN,
  });
  const { id: projectId } = (await project.json()) as { id: string };
  const created = await page.request.post(`/api/projects/${projectId}/issues`, {
    data: { title: 'Printer on fire' },
    headers: ORIGIN,
  });
  expect(created.status()).toBe(201);

  await page.goto(`/t/${team.slug}/p/HD/issues/1`);
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('resolved this issue')).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete issue' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete issue' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/HD/issues$`));

  await page.goto(`/t/${team.slug}/settings/audit-log`);
  await expect(page.getByText('resolved issue HD#1')).toBeVisible();
  await expect(page.getByText('deleted issue HD#1')).toBeVisible();

  await page.goto(`/t/${team.slug}/settings/trash`);
  await page.getByRole('button', { name: 'Restore issue Printer on fire' }).click();
  await expect(page.locator('[data-sonner-toast]').getByText(/Restored HD#1/)).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/HD/issues/1$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Printer on fire #1' })).toBeVisible();
});

test('members see Trash but not the Audit log, and no New project without the permission', async ({
  page,
  browser,
}) => {
  await signedInUser(page);
  const team = await createTeam(page, 'Plain Members');
  const invite = await page.request.post(`/api/teams/${team.id}/invites`, {
    data: {},
    headers: ORIGIN,
  });
  const { code } = (await invite.json()) as { code: string };

  const guest = await secondUser(browser);
  await guest.goto(`/join/${code}`);
  await guest.getByRole('button', { name: 'Join Plain Members' }).click();
  await expect(guest).toHaveURL(new RegExp(`/t/${team.slug}$`));
  await expect(guest.getByText('No projects yet')).toBeVisible();
  await expect(guest.getByRole('button', { name: 'New project' })).toHaveCount(0);

  await guest.goto(`/t/${team.slug}/settings/general`);
  const nav = settingsNav(guest);
  await expect(nav.getByRole('link', { name: 'Trash' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Trash' }).click();
  await expect(guest.getByText('You see the items you created.')).toBeVisible();

  // Opened from a link anyway, the audit log explains what is missing.
  await guest.goto(`/t/${team.slug}/settings/audit-log`);
  await expect(guest.getByText('You can’t view the audit log')).toBeVisible();
  await guest.context().close();
});

test('a deleted team is listed in account settings and restores from there', async ({ page }) => {
  await signedInUser(page);
  const team = await createTeam(page, 'Phoenix Crew');
  const removed = await page.request.delete(`/api/teams/${team.id}`, { headers: ORIGIN });
  expect(removed.status()).toBe(200);

  await page.goto('/settings/account');
  const card = page.getByRole('region', { name: 'Deleted teams' });
  await expect(card.getByText('Phoenix Crew')).toBeVisible();
  await card.getByRole('button', { name: 'Restore Phoenix Crew' }).click();
  await expect(page.getByText('Phoenix Crew restored')).toBeVisible();
  await expect(card.getByText('No deleted teams')).toBeVisible();
  await expect(
    page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Phoenix Crew' }),
  ).toBeVisible();
});

test('a task deleted from its page is counted on the team home and restores from Trash', async ({
  page,
}) => {
  await signedInUser(page);
  const team = await createTeam(page, 'Task Force');
  const { ownerId } = (await (
    await page.request.get(`/api/teams/${team.id}`, { headers: ORIGIN })
  ).json()) as { ownerId: string };
  const project = await page.request.post(`/api/teams/${team.id}/projects`, {
    data: { name: 'Operations', key: 'OPS' },
    headers: ORIGIN,
  });
  const { id: projectId } = (await project.json()) as { id: string };
  const created = await page.request.post(`/api/projects/${projectId}/tasks`, {
    data: { title: 'Rotate the keys', assigneeUserIds: [ownerId] },
    headers: ORIGIN,
  });
  expect(created.status()).toBe(201);

  // The team home counts the tasks someone is assigned to in their current stage.
  await page.goto(`/t/${team.slug}`);
  await expect(page.locator('#main').getByText('1 task assigned')).toBeVisible();

  await page.goto(`/t/${team.slug}/p/OPS/tasks/1`);
  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete task' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete task' }).click();
  // The board, on its pipeline's tab.
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/OPS/tasks\\?pipeline=\\w+$`));

  await page.goto(`/t/${team.slug}/settings/trash`);
  await page.getByRole('button', { name: 'Restore task Rotate the keys' }).click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Restored OPS-1' })).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/OPS/tasks/1$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Rotate the keys' })).toBeVisible();
});

test('an issue becomes a task; finishing the task resolves the issue and tells its author live', async ({
  page,
  browser,
}) => {
  await signedInUser(page);
  const team = await createTeam(page, 'Fix Crew');
  const project = await page.request.post(`/api/teams/${team.id}/projects`, {
    data: { name: 'Storefront', key: 'SF' },
    headers: ORIGIN,
  });
  const { id: projectId } = (await project.json()) as { id: string };
  const invite = await page.request.post(`/api/teams/${team.id}/invites`, {
    data: { expiresIn: '7d', maxUses: null },
    headers: ORIGIN,
  });
  const { code } = (await invite.json()) as { code: string };

  // Someone else reports the bug and watches their inbox.
  const reporter = await secondUser(browser);
  expect(
    (await reporter.request.post(`/api/invites/${code}/accept`, { headers: ORIGIN })).status(),
  ).toBe(200);
  const issue = await reporter.request.post(`/api/projects/${projectId}/issues`, {
    data: { title: 'Coupon codes are case-sensitive', body: '`SAVE10` works, `save10` does not.' },
    headers: ORIGIN,
  });
  expect(issue.status()).toBe(201);
  const stream = reporter.waitForResponse((response) => response.url().endsWith('/api/events'));
  await reporter.goto('/inbox');
  await stream;
  await expect(reporter.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // The issue page's "Create task" opens the new task, linked with "fixes".
  await page.goto(`/t/${team.slug}/p/SF/issues/1`);
  const issueDetails = page.getByRole('complementary', { name: 'Issue details' });
  await issueDetails.getByRole('button', { name: 'Create task' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/SF/tasks/1$`));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Coupon codes are case-sensitive' }),
  ).toBeVisible();
  const taskDetails = page.getByRole('complementary', { name: 'Task details' });
  await expect(taskDetails.getByRole('link', { name: /SF#1/ })).toBeVisible();

  // Done: the issue resolves itself.
  await page.keyboard.press('s');
  await page.getByRole('option', { name: 'Done' }).click();
  await expect(taskDetails.getByRole('button', { name: 'Status: Done' })).toBeVisible();

  // The reporter hears about it right away.
  const rows = reporter.getByTestId('notification');
  await expect(rows.first()).toContainText('Coupon codes are case-sensitive');
  await expect(rows.first()).toHaveAttribute('data-unread', 'true');
  await expect(rows.first()).toContainText(/resolved/i);

  await page.goto(`/t/${team.slug}/p/SF/issues/1`);
  await expect(page.getByRole('heading', { level: 1, name: /Coupon codes/ })).toBeVisible();
  await expect(page.locator('#main').getByText('Resolved', { exact: true }).first()).toBeVisible();
  await expect(
    issueDetails.getByRole('link', { name: /SF-1\s*Coupon codes are case-sensitive/ }),
  ).toHaveAttribute('href', `/t/${team.slug}/p/SF/tasks/1`);
  await expect(issueDetails.getByText('fixes')).toBeVisible();
  await reporter.context().close();
});
