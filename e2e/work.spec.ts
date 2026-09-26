import { randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  createVerifiedUser,
  expect,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * Work module flows: the dashboard (first run with an invite link, stats, lists, live activity,
 * teams), My tasks (grouping, URL filters, search, keyboard navigation) and the inbox (live
 * notifications and toasts, open marks read, mark all read). Teams, projects, invites and replies
 * go through the REST API; tasks are inserted into the database, since the tasks module owns
 * their API.
 */

test.use({ colorScheme: 'light' });

type Db = Parameters<Parameters<typeof withDatabase>[0]>[0];

interface World {
  userId: string;
  team: { id: string; slug: string; name: string };
  project: { id: string; key: string; name: string; openStatusId: string; doneStatusId: string };
}

const rowId = (prefix: string) => `${prefix}${randomBytes(10).toString('hex')}`;

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

function userIdOf(db: Db, user: TestUser): string {
  return (db.prepare('select id from user where email = ?').get(user.email) as { id: string }).id;
}

/** A team with a "Web app" (WEB) project created through the API by `user`. */
async function createWorld(
  request: APIRequestContext,
  user: TestUser,
  projectName = 'Web app',
): Promise<World> {
  const suffix = randomBytes(3).toString('hex');
  const team = await post<{ id: string; slug: string; name: string }>(request, '/api/teams', {
    name: `Work ${suffix}`,
  });
  const project = await post<{
    id: string;
    key: string;
    name: string;
    statuses: Array<{ id: string; category: 'open' | 'done' }>;
  }>(request, `/api/teams/${team.id}/projects`, { name: projectName, key: 'WEB' });
  const status = (category: 'open' | 'done') =>
    project.statuses.find((candidate) => candidate.category === category)?.id ?? '';
  return {
    userId: withDatabase((db) => userIdOf(db, user)),
    team,
    project: { ...project, openStatusId: status('open'), doneStatusId: status('done') },
  };
}

interface TaskSeed {
  title: string;
  priority?: number;
  dueDate?: string | null;
  statusId?: string;
  assignUser?: string;
  assignRole?: string;
  claim?: { userId: string; keyId: string | null };
}

/** Inserts tasks into the world's project (numbered after the existing ones). */
function insertTasks(world: World, tasks: TaskSeed[]): Array<{ id: string; number: number }> {
  return withDatabase((db) => {
    const now = Date.now();
    const { task_seq: seq } = db
      .prepare('select task_seq from project where id = ?')
      .get(world.project.id) as { task_seq: number };
    const created = tasks.map((task, index) => {
      const id = rowId('tk');
      const number = seq + index + 1;
      db.prepare(
        `insert into task (id, project_id, team_id, number, title, status_id, priority, due_date, position,
           author_id, claimed_by_id, claimed_via_key_id, claimed_at, claim_expires_at, last_activity_at,
           created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        world.project.id,
        world.team.id,
        number,
        task.title,
        task.statusId ?? world.project.openStatusId,
        task.priority ?? 0,
        task.dueDate ?? null,
        `a${number}`,
        world.userId,
        task.claim?.userId ?? null,
        task.claim?.keyId ?? null,
        task.claim ? now - 4 * 60_000 : null,
        task.claim ? now + 26 * 60_000 : null,
        now,
        now + index,
        now + index,
      );
      if (task.assignUser) {
        db.prepare('insert into task_assignee_user (task_id, user_id) values (?, ?)').run(
          id,
          task.assignUser,
        );
      }
      if (task.assignRole) {
        db.prepare('insert into task_assignee_role (task_id, role_id) values (?, ?)').run(
          id,
          task.assignRole,
        );
      }
      return { id, number };
    });
    db.prepare('update project set task_seq = ? where id = ?').run(
      seq + tasks.length,
      world.project.id,
    );
    return created;
  });
}

function everyoneRoleId(world: World): string {
  return withDatabase(
    (db) =>
      (
        db
          .prepare('select id from role where team_id = ? and is_everyone = 1')
          .get(world.team.id) as { id: string }
      ).id,
  );
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
  const owner = await createVerifiedUser(request);
  const world = await createWorld(request, owner);
  const invite = await post<{ code: string; url: string }>(
    request,
    `/api/teams/${world.team.id}/invites`,
    { expiresIn: '7d', maxUses: null },
  );

  const user = await signedInUser(page);
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
  expect(user.username).toBeTruthy();
});

test('the dashboard shows my work, claims, live activity and my teams', async ({ page }) => {
  const user = await signedInUser(page);
  const world = await createWorld(page.request, user);
  const key = await post<{ apiKey: { id: string; name: string } }>(
    page.request,
    '/api/me/api-keys',
    { name: 'Claude on laptop' },
  );
  const [urgent] = insertTasks(world, [
    { title: 'Ship the release', priority: 4, assignUser: world.userId },
    {
      title: 'Write the postmortem',
      priority: 2,
      dueDate: localDate(-2),
      assignUser: world.userId,
    },
    { title: 'Review the design', dueDate: localDate(2), assignRole: everyoneRoleId(world) },
    { title: 'Already done', statusId: world.project.doneStatusId, assignUser: world.userId },
    { title: 'Someone else’s', dueDate: localDate(-1) },
    {
      title: 'Refactor the auth flow',
      claim: { userId: world.userId, keyId: key.apiKey.id },
    },
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
    'via @everyone',
  );

  const due = page.getByRole('region', { name: 'Overdue and due soon' });
  await expect(due.getByRole('link', { name: /Write the postmortem/ })).toContainText('(overdue)');
  await expect(due.getByRole('link', { name: /Review the design/ })).toBeVisible();
  await expect(due).not.toContainText('Someone else’s');

  const claimed = page.getByRole('region', { name: 'Claimed by you and your agents' });
  await expect(claimed.getByRole('link', { name: /Refactor the auth flow/ })).toContainText(
    'via Claude on laptop',
  );

  const feed = page.getByRole('list', { name: 'Recent activity' });
  await expect(feed).toContainText('created project Web app');

  const teams = page.getByRole('region', { name: 'Teams and projects' });
  // Open tasks of the project, whoever they are assigned to.
  await expect(teams.getByRole('link', { name: /Web app/ })).toContainText('Open tasks:5');

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
  const user = await signedInUser(page);
  const world = await createWorld(page.request, user);
  const api = await post<{ id: string; statuses: Array<{ id: string; category: string }> }>(
    page.request,
    `/api/teams/${world.team.id}/projects`,
    { name: 'API platform', key: 'API' },
  );
  insertTasks(world, [
    {
      title: 'Fix the login redirect',
      priority: 3,
      dueDate: localDate(-1),
      assignUser: world.userId,
    },
    { title: 'Polish the empty states', priority: 1, assignUser: world.userId },
  ]);
  insertTasks(
    {
      ...world,
      project: {
        ...world.project,
        id: api.id,
        key: 'API',
        openStatusId: api.statuses.find((status) => status.category === 'open')?.id ?? '',
      },
    },
    [{ title: 'Rate limit the webhooks', priority: 4, assignRole: everyoneRoleId(world) }],
  );

  await openDashboard(page);
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/my-tasks$/);
  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
  await expect(page.getByText('3 open tasks')).toBeVisible();

  const team = page.getByRole('region', { name: world.team.name });
  await expect(team.getByRole('heading', { level: 3 })).toHaveText(['API platform', 'Web app']);
  await expect(page.getByRole('link', { name: /Rate limit the webhooks/ })).toContainText(
    'via @everyone',
  );

  await page.getByRole('button', { name: 'Filter by due' }).click();
  await page.getByRole('option', { name: 'Overdue' }).click();
  await expect(page).toHaveURL(/due=overdue/);
  await expect(page.getByText('1 open task')).toBeVisible();
  await expect(page.getByRole('link', { name: /Fix the login redirect/ })).toBeVisible();

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('3 open tasks')).toBeVisible();

  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search my tasks' })).toBeFocused();
  await page.keyboard.type('webhooks');
  await expect(page).toHaveURL(/q=webhooks/);
  await expect(page.getByText('1 open task')).toBeVisible();

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
  const world = await createWorld(page.request, user);
  const [task] = insertTasks(world, [{ title: 'Fix the flaky test', assignUser: world.userId }]);
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
