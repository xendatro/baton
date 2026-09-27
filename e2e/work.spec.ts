import { randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  createVerifiedUser,
  expect,
  ORIGIN,
  signedInUser,
  test,
  trimToOpenAndDone,
} from './support/fixtures.ts';

/**
 * Work module flows: the dashboard (first run with an invite link, stats, lists, live activity,
 * teams), My tasks (grouping, URL filters, search, keyboard navigation) and the inbox (live
 * notifications and toasts, open marks read, mark all read). Teams, projects, roles, invites,
 * tasks, claims and replies go through the REST API.
 */

test.use({ colorScheme: 'light' });

interface World {
  userId: string;
  team: { id: string; slug: string; name: string };
  project: { id: string; key: string; name: string; openStatusId: string; doneStatusId: string };
  /** A role the user has ("Design"), for tasks assigned through a role. */
  roleId: string;
}

/** `YYYY-MM-DD` in this machine's time zone (the browser's), `days` from today. */
function localDate(days = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const response = await request.post(url, { data, headers: ORIGIN });
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/**
 * A team with a "Web app" (WEB) project created through the API by `user`, who also gets a
 * "Design" role.
 */
async function createWorld(request: APIRequestContext, projectName = 'Web app'): Promise<World> {
  const suffix = randomBytes(3).toString('hex');
  const team = await post<{ id: string; slug: string; name: string; ownerId: string }>(
    request,
    '/api/teams',
    { name: `Work ${suffix}` },
  );
  const project = await post<{
    id: string;
    key: string;
    name: string;
    statuses: Array<{ id: string; name: string }>;
  }>(request, `/api/teams/${team.id}/projects`, { name: projectName, key: 'WEB' });
  // Trimmed to two stages: Open (default) and Done (assigns nobody, finishes the task).
  const [open, done] = await trimToOpenAndDone(request, project.id);
  const status = (name: 'Open' | 'Done') => (name === 'Open' ? open.id : done.id);
  const role = await post<{ id: string }>(request, `/api/teams/${team.id}/roles`, {
    name: 'Design',
  });
  const granted = await request.put(
    `/api/teams/${team.id}/members/${team.ownerId}/roles/${role.id}`,
    { headers: ORIGIN },
  );
  expect(granted.ok()).toBe(true);
  return {
    userId: team.ownerId,
    team,
    project: { ...project, openStatusId: status('Open'), doneStatusId: status('Done') },
    roleId: role.id,
  };
}

interface TaskSeed {
  title: string;
  priority?: number;
  dueDate?: string | null;
  statusId?: string;
  assignUser?: string;
  assignRole?: string;
  /** Claimed through this API key (bearer token). */
  claimWith?: string;
}

/** Creates tasks in `projectId` through the tasks API, in order. */
async function createTasks(
  request: APIRequestContext,
  projectId: string,
  tasks: TaskSeed[],
): Promise<Array<{ id: string; number: number }>> {
  const created: Array<{ id: string; number: number }> = [];
  for (const task of tasks) {
    const row = await post<{ id: string; number: number }>(
      request,
      `/api/projects/${projectId}/tasks`,
      {
        title: task.title,
        priority: task.priority ?? 0,
        dueDate: task.dueDate ?? null,
        assigneeUserIds: task.assignUser ? [task.assignUser] : [],
        assigneeRoleIds: task.assignRole ? [task.assignRole] : [],
      },
    );
    // Moved there after creation, so the stage's hand-off applies (Done assigns nobody).
    if (task.statusId) {
      const moved = await request.post(`/api/tasks/${row.id}/move`, {
        data: { statusId: task.statusId },
        headers: ORIGIN,
      });
      expect(moved.ok(), await moved.text()).toBe(true);
    }
    if (task.claimWith) {
      const claimed = await request.post(`/api/tasks/${row.id}/claim`, {
        data: {},
        headers: { Authorization: `Bearer ${task.claimWith}` },
      });
      expect(claimed.ok(), await claimed.text()).toBe(true);
    }
    created.push(row);
  }
  return created;
}

async function openDashboard(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/**
 * Opens the dashboard and waits until live updates can arrive: the event stream is connected and
 * the shell extensions (mounted together, lazily) are running, which the sidebar's "New team"
 * button (registered by one of them) shows. The inbox extension shows the toasts.
 */
async function openDashboardLive(page: Page) {
  const stream = page.waitForResponse((response) => response.url().endsWith('/api/events'));
  await openDashboard(page);
  await stream;
  await expect(page.getByRole('button', { name: 'New team' })).toBeVisible();
}

test('first run: welcome, then join a team with a pasted invite link', async ({
  page,
  request,
}) => {
  await createVerifiedUser(request);
  const world = await createWorld(request);
  const invite = await post<{ code: string; url: string }>(
    request,
    `/api/teams/${world.team.id}/invites`,
    { expiresIn: '7d', maxUses: null },
  );

  await signedInUser(page);
  await openDashboard(page);
  await expect(page.getByText(new RegExp(`Good (morning|afternoon|evening), E2E`))).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Welcome to Baton/ })).toBeVisible();

  await page.getByRole('button', { name: 'Create a team' }).click();
  await expect(page.getByRole('dialog', { name: 'Create a team' })).toBeVisible();
  await page.keyboard.press('Escape');

  const box = page.getByRole('textbox', { name: 'Invite link or code' });
  await box.fill('definitely not a link');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Paste an invite link');

  await box.fill(`${invite.url}`);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/join/${invite.code}$`));
  await expect(page.getByRole('heading', { name: world.team.name })).toBeVisible();
  await page.getByRole('button', { name: /^Join/ }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${world.team.slug}$`));

  await openDashboard(page);
  const teams = page.getByRole('region', { name: 'Teams and projects' });
  await expect(teams.getByRole('link', { name: world.team.name })).toBeVisible();
  await expect(teams.getByRole('link', { name: /Web app/ })).toBeVisible();
});

test('the dashboard shows my work, claims, live activity and my teams', async ({ page }) => {
  const user = await signedInUser(page);
  const world = await createWorld(page.request);
  const { key } = await post<{ key: string }>(page.request, '/api/me/api-keys', {
    name: 'Claude on laptop',
  });
  const [urgent] = await createTasks(page.request, world.project.id, [
    { title: 'Ship the release', priority: 4, assignUser: world.userId },
    {
      title: 'Write the postmortem',
      priority: 2,
      dueDate: localDate(-2),
      assignUser: world.userId,
    },
    { title: 'Review the design', dueDate: localDate(2), assignRole: world.roleId },
    { title: 'Already done', statusId: world.project.doneStatusId, assignUser: world.userId },
    { title: 'Someone else’s', dueDate: localDate(-1) },
    { title: 'Refactor the auth flow', claimWith: key },
  ]);

  await openDashboardLive(page);
  await expect(page.getByRole('link', { name: /^Assigned to you: 3\./ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Overdue: 1\./ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Due this week: 1\./ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Claimed: 1\./ })).toBeVisible();

  const assigned = page.getByRole('region', { name: 'Assigned to you' });
  await expect(assigned.getByRole('listitem')).toHaveCount(3);
  await expect(assigned.getByRole('listitem').first()).toContainText('Ship the release');
  await expect(assigned.getByRole('link', { name: /Review the design/ })).toContainText(
    'via Design',
  );

  const due = page.getByRole('region', { name: 'Overdue and due soon' });
  await expect(due.getByRole('link', { name: /Write the postmortem/ })).toContainText('(overdue)');
  await expect(due.getByRole('link', { name: /Review the design/ })).toBeVisible();
  await expect(due).not.toContainText('Someone else’s');

  // Claimed through the key: by the user's agent member (agents A), named with its key.
  const claimed = page.getByRole('region', { name: 'Claimed by you and your agents' });
  const claimedTask = claimed.getByRole('link', { name: /Refactor the auth flow/ });
  await expect(claimedTask).toContainText(`${user.name} AI`);
  await expect(claimedTask).toContainText('via the Claude on laptop key');

  const feed = page.getByRole('list', { name: 'Recent activity' });
  await expect(feed).toContainText('created task WEB-1 “Ship the release”');

  const teams = page.getByRole('region', { name: 'Teams and projects' });
  // Tasks of the project someone holds in their current stage, whoever it is.
  await expect(teams.getByRole('link', { name: /Web app/ })).toContainText('Assigned tasks:3');

  // A reply is written through the API: the activity feed updates live.
  await post(page.request, '/api/replies', {
    parentType: 'task',
    parentId: urgent?.id,
    body: 'Cutting the branch now.',
  });
  await expect(feed.getByRole('listitem').first()).toContainText('replied on WEB-1');

  await assigned.getByRole('link', { name: /Ship the release/ }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${world.team.slug}/p/WEB/tasks/1$`));
});

test('My tasks groups by project, filters from the URL and the keyboard', async ({ page }) => {
  await signedInUser(page);
  const world = await createWorld(page.request);
  const api = await post<{ id: string }>(page.request, `/api/teams/${world.team.id}/projects`, {
    name: 'API platform',
    key: 'API',
  });
  await createTasks(page.request, world.project.id, [
    {
      title: 'Fix the login redirect',
      priority: 3,
      dueDate: localDate(-1),
      assignUser: world.userId,
    },
    { title: 'Polish the empty states', priority: 1, assignUser: world.userId },
  ]);
  await createTasks(page.request, api.id, [
    { title: 'Rate limit the webhooks', priority: 4, assignRole: world.roleId },
  ]);

  await openDashboard(page);
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/my-tasks$/);
  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
  await expect(page.getByText('3 assigned tasks')).toBeVisible();

  const team = page.getByRole('region', { name: world.team.name });
  await expect(team.getByRole('heading', { level: 3 })).toHaveText(['API platform', 'Web app']);
  await expect(page.getByRole('link', { name: /Rate limit the webhooks/ })).toContainText(
    'via Design',
  );

  await page.getByRole('button', { name: 'Filter by due' }).click();
  await page.getByRole('option', { name: 'Overdue' }).click();
  await expect(page).toHaveURL(/due=overdue/);
  await expect(page.getByText('1 assigned task')).toBeVisible();
  await expect(page.getByRole('link', { name: /Fix the login redirect/ })).toBeVisible();

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('3 assigned tasks')).toBeVisible();

  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search my tasks' })).toBeFocused();
  await page.keyboard.type('webhooks');
  await expect(page).toHaveURL(/q=webhooks/);
  await expect(page.getByText('1 assigned task')).toBeVisible();

  // Filters survive a reload, since they live in the URL.
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search my tasks' })).toHaveValue('webhooks');
  await expect(page.getByRole('link', { name: /Rate limit the webhooks/ })).toBeVisible();

  await page.locator('body').click();
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await expect(page).toHaveURL(/\/inbox$/);
  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('the inbox: live notifications, a toast elsewhere, open marks read, mark all read', async ({
  page,
  request,
}) => {
  const user = await signedInUser(page);
  const world = await createWorld(page.request);
  const [task] = await createTasks(page.request, world.project.id, [
    { title: 'Fix the flaky test', assignUser: world.userId },
  ]);
  const invite = await post<{ code: string }>(page.request, `/api/teams/${world.team.id}/invites`, {
    expiresIn: '7d',
    maxUses: null,
  });
  const colleague = await createVerifiedUser(request);
  await post(request, `/api/invites/${invite.code}/accept`, {});
  const mention = (body: string) =>
    post(request, '/api/replies', {
      parentType: 'task',
      parentId: task?.id,
      body: `@${user.username} ${body}`,
    });

  // Elsewhere in the app a new notification shows a toast with an Open action.
  await openDashboardLive(page);
  await mention('can you take a look?');
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'mentioned you' });
  await expect(toast).toContainText(`${colleague.name} mentioned you`);
  await expect(toast).toContainText('WEB-1');
  const inboxLink = page.getByRole('link', { name: /^Inbox \(1 unread\)/ });
  await expect(inboxLink).toBeVisible();
  await toast.getByRole('button', { name: 'Open' }).click();
  // The reply that mentioned me, in its thread.
  await expect(page).toHaveURL(new RegExp(`/t/${world.team.slug}/p/WEB/tasks/1#reply-`));
  await expect(page.getByRole('link', { name: /^Inbox \(1 unread\)/ })).toHaveCount(0);

  // On the inbox, new notifications slide in without a toast.
  await page.getByRole('link', { name: /^Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  const rows = page.getByTestId('notification');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).not.toHaveAttribute('data-unread', 'true');
  await mention('one more thing');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-unread', 'true');
  await expect(rows.first()).toContainText('one more thing');
  await expect(rows.first()).toContainText(world.team.name);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

  await page.getByRole('tab', { name: /Unread/ }).click();
  await expect(page).toHaveURL(/filter=unread/);
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Inbox \(\d+ unread\)/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'View all notifications' }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-testid="notification"][data-unread="true"]')).toHaveCount(0);
});
