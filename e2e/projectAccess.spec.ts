import { randomBytes, randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import {
  expect,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * Project permissions (docs/design/agents-and-pipelines.md §3): an override set on the project's
 * Access page changes what a member can do in that project only, and a project without
 * VIEW_PROJECT disappears for them.
 */

function userId(email: string): string {
  return withDatabase(
    (db) => (db.prepare('select id from user where email = ?').get(email) as { id: string }).id,
  );
}

async function memberPage(browser: Browser) {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();
  const user = await signedInUser(page);
  return { context, page, user };
}

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.status(), `${url}: ${await res.text()}`).toBe(201);
  return (await res.json()) as T;
}

/** A team (through the API) with two projects, a "Contractors" role and `member` holding it. */
async function seed(owner: Page, member: TestUser) {
  const slug = `acc-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(owner, '/api/teams', { name: `Access ${slug}`, slug });
  const role = await post<{ id: string }>(owner, `/api/teams/${team.id}/roles`, {
    name: 'Contractors',
  });
  const memberId = userId(member.email);
  withDatabase((db) => {
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      team.id,
      memberId,
      Date.now(),
    );
    db.prepare('insert into member_role (team_id, user_id, role_id) values (?, ?, ?)').run(
      team.id,
      memberId,
      role.id,
    );
  });
  const closed = await post<{ id: string }>(owner, `/api/teams/${team.id}/projects`, {
    name: 'Closed',
    key: 'CLO',
  });
  const open = await post<{ id: string }>(owner, `/api/teams/${team.id}/projects`, {
    name: 'Open',
    key: 'OPN',
  });
  const closedTask = await post<{ id: string; path: string }>(
    owner,
    `/api/projects/${closed.id}/tasks`,
    { title: 'Closed task' },
  );
  const openTask = await post<{ id: string; path: string }>(
    owner,
    `/api/projects/${open.id}/tasks`,
    { title: 'Open task' },
  );
  return { slug, team, role, closed, open, closedTask, openTask };
}

test('denying a role REPLY in one project removes the reply box there only', async ({
  page,
  browser,
}) => {
  await signedInUser(page);
  const member = await memberPage(browser);
  const seeded = await seed(page, member.user);

  // The owner denies Reply to Contractors on the Closed project's Access page.
  await page.goto(`/t/${seeded.slug}/p/CLO/settings/access`);
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();
  const subjects = page.getByRole('navigation', { name: 'Permission subjects' });
  await subjects.getByRole('button', { name: /Contractors/ }).click();
  await expect(page.getByRole('heading', { name: /Contractors/, level: 4 })).toBeVisible();
  await page.getByTestId('permission-REPLY').getByRole('radio', { name: 'Deny Reply' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved permissions for Contractors')).toBeVisible();
  await expect(subjects.getByRole('button', { name: /Contractors/ })).toContainText('1 set');

  // The member can still read the Closed task, but not reply to it.
  await member.page.goto(seeded.closedTask.path);
  await expect(member.page.getByRole('heading', { name: 'Closed task' })).toBeVisible();
  await expect(member.page.getByRole('region', { name: 'Description' })).toBeVisible();
  // New tasks are chats: the message box is gone, with a note saying why.
  await expect(member.page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
  await expect(
    member.page.getByText('You don’t have permission to send messages here.'),
  ).toBeVisible();
  const refused = await member.page.request.post('/api/replies', {
    data: { parentType: 'task', parentId: seeded.closedTask.id, body: 'Let me in' },
    headers: ORIGIN,
  });
  expect(refused.status()).toBe(403);

  // In the Open project nothing changed.
  await member.page.goto(seeded.openTask.path);
  await expect(member.page.getByRole('heading', { name: 'Open task' })).toBeVisible();
  await expect(member.page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await member.context.close();
});

test('a project without VIEW_PROJECT disappears for the member', async ({ page, browser }) => {
  await signedInUser(page);
  const member = await memberPage(browser);
  const seeded = await seed(page, member.user);
  const everyone = withDatabase(
    (db) =>
      (
        db
          .prepare('select id from role where team_id = ? and is_everyone = 1')
          .get(seeded.team.id) as { id: string }
      ).id,
  );
  const hidden = await page.request.put(`/api/projects/${seeded.closed.id}/permissions/overrides`, {
    data: { subjectType: 'team_role', subjectId: everyone, allow: [], deny: ['VIEW_PROJECT'] },
    headers: ORIGIN,
  });
  expect(hidden.status(), await hidden.text()).toBe(200);

  await member.page.goto(`/t/${seeded.slug}`);
  await expect(member.page.getByRole('link', { name: 'Open', exact: true }).first()).toBeVisible();
  await expect(member.page.getByRole('link', { name: 'Closed', exact: true })).toHaveCount(0);
  await member.page.goto(seeded.closedTask.path);
  await expect(member.page.getByRole('heading', { name: 'Project not found' })).toBeVisible();

  // The owner still sees it (owners bypass overrides).
  await page.goto(seeded.closedTask.path);
  await expect(page.getByRole('heading', { name: 'Closed task' })).toBeVisible();
  await member.context.close();
});
