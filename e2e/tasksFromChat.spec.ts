import { randomBytes, randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { createApiKeyResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import {
  expect,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * Tasks from issues and chat messages (Create task, Make task from this) and agent requests in a
 * chat: the owner approves inline under the message that asked, and everyone else's line follows.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function setup(page: Page, key: string) {
  const slug = `tfc-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string; slug: string }>(page, '/api/teams', {
    name: `Tasks ${slug}`,
    slug,
  });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'From chat',
    key,
  });
  const issue = await post<{ id: string; number: number }>(
    page,
    `/api/projects/${project.id}/issues`,
    { title: 'Export drops the last row', body: 'Every CSV export is one row short.' },
  );
  return { team, project, issue, path: `/t/${team.slug}/p/${key}` };
}

async function teammate(browser: Browser, teamId: string): Promise<{ page: Page; user: TestUser }> {
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();
  const user = await signedInUser(page);
  withDatabase((db) => {
    const id = (db.prepare('select id from user where email = ?').get(user.email) as { id: string })
      .id;
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      teamId,
      id,
      Date.now(),
    );
  });
  return { page, user };
}

test('Create task on an issue starts in the chosen stage and fixes the issue', async ({ page }) => {
  await signedInUser(page);
  const { issue, path } = await setup(page, 'TFI');

  await page.goto(`${path}/issues/${issue.number}`);
  const details = page.getByRole('complementary', { name: 'Issue details' });
  await details.getByRole('button', { name: 'Create task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByPlaceholder('Task title')).toHaveValue('Export drops the last row');
  await expect(dialog.getByTestId('linked-issue')).toHaveText(/Fixes TFI#1/);
  // The owner's agent isn't connected here yet: drafting waits for it (with Connect now).
  await expect(dialog.getByRole('button', { name: 'Have my agent draft it' })).toBeDisabled();

  // Only stages that accept new tasks are offered; pick To do instead of the default Backlog.
  await dialog.getByRole('button', { name: 'Status: Backlog' }).click();
  await expect(page.getByRole('option', { name: 'In progress' })).toHaveCount(0);
  await page.getByRole('option', { name: 'To do' }).click();
  await dialog.getByPlaceholder('Task title').fill('Keep the last row in CSV exports');
  await dialog.getByRole('button', { name: 'Create task' }).click();

  await expect(page).toHaveURL(new RegExp(`${path}/tasks/1$`));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Keep the last row in CSV exports' }),
  ).toBeVisible();
  const taskDetails = page.getByRole('complementary', { name: 'Task details' });
  await expect(taskDetails.getByRole('button', { name: 'Status: To do' })).toBeVisible();
  await expect(taskDetails.getByRole('link', { name: /TFI#1/ })).toBeVisible();

  await page.goto(`${path}/issues/${issue.number}`);
  await expect(
    details.getByRole('link', { name: /TFI-1\s*Keep the last row in CSV exports/ }),
  ).toBeVisible();
  await expect(details.getByText('fixes', { exact: true })).toBeVisible();
});

test('Make task from this on a chat message', async ({ page, browser }) => {
  await signedInUser(page);
  const { team, project, issue, path } = await setup(page, 'TFM');
  const mate = await teammate(browser, team.id);
  await post(mate.page, '/api/replies', {
    parentType: 'issue',
    parentId: issue.id,
    body: 'The writer skips the final flush\nSee `csv.ts` line 80.',
  });
  await post(mate.page, '/api/replies', {
    parentType: 'issue',
    parentId: issue.id,
    body: 'Imports are fine though.',
  });
  await mate.page.context().close();

  await page.goto(`${path}/issues/${issue.number}`);
  const message = page.getByTestId('chat-message').filter({ hasText: 'final flush' });
  await message.hover();
  await message.getByRole('button', { name: 'Make task from this' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByPlaceholder('Task title')).toHaveValue(
    'The writer skips the final flush',
  );
  await expect(dialog.getByTestId('task-source')).toContainText('From 1 message in TFM#1');
  await expect(dialog.getByTestId('linked-issue')).toHaveText(/Fixes TFM#1/);
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Created TFM-1' })).toBeVisible();
  // You stay in the conversation.
  await expect(page).toHaveURL(new RegExp(`${path}/issues/${issue.number}$`));

  const tasks = await page.request.get(`/api/projects/${project.id}/tasks/1`);
  const task = (await tasks.json()) as {
    description: string;
    issues: Array<{ id: string; kind: string }>;
  };
  expect(task.description).toContain(`${path}/issues/1#reply-`);
  expect(task.description).toContain('> The writer skips the final flush');
  expect(task.description).not.toContain('Imports are fine');
  expect(task.issues).toEqual([expect.objectContaining({ id: issue.id, kind: 'fixes' })]);

  // Several messages at once.
  await page.getByRole('button', { name: 'Select messages' }).click();
  await page
    .getByRole('checkbox', { name: /^Select message from / })
    .nth(0)
    .check();
  await page
    .getByRole('checkbox', { name: /^Select message from / })
    .nth(1)
    .check();
  await page.getByRole('button', { name: 'Make task from 2 messages' }).click();
  await expect(dialog.getByTestId('task-source')).toContainText('From 2 messages in TFM#1');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Created TFM-2' })).toBeVisible();
});

test('the owner approves a chat request inline and the requester’s line follows', async ({
  page,
  browser,
}) => {
  const owner = await signedInUser(page);
  const { team, issue, path } = await setup(page, 'TFR');
  // The owner's agent (created with their first API key).
  createApiKeyResponseSchema.parse(await post(page, '/api/me/api-keys', { name: 'Desktop' }));

  const mate = await teammate(browser, team.id);
  await post(mate.page, '/api/replies', {
    parentType: 'issue',
    parentId: issue.id,
    body: `@${owner.username}-ai can you look at the CSV writer?`,
  });
  await mate.page.goto(`${path}/issues/${issue.number}`);
  const asked = mate.page.getByTestId('chat-message').filter({ hasText: 'CSV writer' });
  await expect(asked.getByTestId('agent-request-line')).toHaveText(
    new RegExp(`is waiting for ${owner.name}’s OK`),
  );
  await expect(asked.getByRole('button', { name: /^Approve/ })).toHaveCount(0);

  // The owner sees the card right under the message, and approves.
  await page.goto(`${path}/issues/${issue.number}`);
  const card = page
    .getByTestId('chat-message')
    .filter({ hasText: 'CSV writer' })
    .getByRole('article', { name: /^Request: Reply to / });
  await expect(card).toContainText('Can I reply to');
  await card.getByRole('button', { name: /^Approve: / }).click();
  await expect(page.getByText(/^Approved: /)).toBeVisible();
  await expect(card).toHaveCount(0);

  // The requester's line changes live.
  await expect(asked.getByTestId('agent-request-line')).toHaveText(
    new RegExp(`^${owner.name} approved`),
  );
  await mate.page.context().close();
});
