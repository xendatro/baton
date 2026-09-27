import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Tasks module (SPEC §1.8, §1.9): the board and list, the New task dialog, keyboard drags, the
 * task page (title, status, claim, delete with undo) and an agent's claim seen on the web.
 */

interface Project {
  id: string;
  key: string;
  teamId: string;
  path: string;
  statuses: Array<{ id: string; name: string }>;
}

interface TaskJson {
  id: string;
  number: number;
  ref: string;
  title: string;
  status: { name: string };
  path: string;
}

async function setup(page: Page): Promise<Project> {
  await signedInUser(page);
  const slug = `tasks-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Tasks ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const res = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Rocket', key: 'RKT' },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  const project = (await res.json()) as Omit<Project, 'teamId'>;
  return { ...project, teamId };
}

async function createTask(page: Page, project: Project, body: Record<string, unknown>) {
  const res = await page.request.post(`/api/projects/${project.id}/tasks`, {
    data: body,
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as TaskJson;
}

async function boardOrder(page: Page, project: Project) {
  const res = await page.request.get(`/api/projects/${project.id}/board`);
  const board = (await res.json()) as {
    columns: Array<{ status: { name: string }; tasks: Array<{ title: string }> }>;
  };
  return Object.fromEntries(
    board.columns.map((column) => [column.status.name, column.tasks.map((task) => task.title)]),
  );
}

/** dnd-kit's live region: announces pick-ups, moves and drops. */
function announcement(page: Page, text: string | RegExp) {
  return expect(page.getByRole('status').filter({ hasText: text })).toBeAttached();
}

/** Picks up a card with Space, presses `key`, and drops it (waiting for each step). */
async function keyboardMove(page: Page, card: ReturnType<Page['getByRole']>, key: string) {
  await card.focus();
  await page.keyboard.press('Space');
  await announcement(page, /Picked up/);
  // dnd-kit starts listening for arrow keys on a timer after the pick-up.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await page.keyboard.press(key);
  await announcement(page, /is over/);
  await page.keyboard.press('Space');
  await announcement(page, /Dropped/);
}

function column(page: Page, name: string) {
  return page.getByRole('region', { name: 'Board' }).getByRole('region', { name, exact: true });
}

test('creates tasks from the dialog and a column quick-add', async ({ page }) => {
  const project = await setup(page);
  await page.goto(`${project.path}/tasks`);
  await expect(page.getByRole('heading', { name: 'No tasks yet' })).toBeVisible();
  // `c` works once the shell has loaded the dialog (the New task button shows it).
  await expect(page.getByRole('button', { name: 'Create a task' })).toBeVisible();

  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Task title').fill('Launch checklist');
  await dialog.getByRole('button', { name: 'Priority: No priority' }).click();
  await page.getByRole('option', { name: 'High' }).click();
  await dialog.getByRole('switch').click();
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Created RKT-1' })).toBeVisible();
  // "Create more" keeps the dialog open with an empty title.
  await expect(dialog.getByPlaceholder('Task title')).toHaveValue('');
  await dialog.getByPlaceholder('Task title').fill('Write the press release');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Created RKT-2' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const open = column(page, 'Open');
  await expect(open.getByRole('link', { name: /Launch checklist/ })).toBeVisible();
  await expect(open.getByRole('link', { name: /Write the press release/ })).toBeVisible();

  await page.getByRole('button', { name: 'New task in Done' }).click();
  await expect(dialog.getByRole('button', { name: 'Status: Done' })).toBeVisible();
  await dialog.getByPlaceholder('Task title').fill('Pick a launch date');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(
    column(page, 'Done').getByRole('link', { name: /Pick a launch date/ }),
  ).toBeVisible();
  expect(await boardOrder(page, project)).toEqual({
    Open: ['Launch checklist', 'Write the press release'],
    Done: ['Pick a launch date'],
  });
});

test('the slash menu opens above the New task dialog and is clickable (BAT-3)', async ({
  page,
}) => {
  const project = await setup(page);
  await page.goto(`${project.path}/tasks`);
  await expect(page.getByRole('button', { name: 'Create a task' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('textbox', { name: 'Description' }).click();
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Insert block' });
  await expect(menu).toBeVisible();
  // A real click lands on the menu (not the dialog underneath) and keeps the dialog open.
  await menu.getByRole('option', { name: /Bulleted list/ }).click();
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Description' }).locator('ul')).toHaveCount(1);
});

test('attaches files from the New task dialog (BAT-4)', async ({ page }) => {
  const project = await setup(page);
  await page.goto(`${project.path}/tasks`);
  await expect(page.getByRole('button', { name: 'Create a task' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByPlaceholder('Task title').fill('Ship the logs');

  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Attach files' }).click();
  await (
    await chooser
  ).setFiles({ name: 'build.log', mimeType: 'text/plain', buffer: Buffer.from('all green') });
  await expect(dialog.getByText('build.log')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Created RKT-1' })).toBeVisible();

  await page.goto(`${project.path}/tasks/1`);
  const files = page.locator('section', { has: page.getByRole('heading', { name: 'Files' }) });
  await expect(files.getByText('build.log')).toBeVisible();
});

test('moves cards with the keyboard, within and between columns', async ({ page }) => {
  const project = await setup(page);
  for (const title of ['Alpha', 'Bravo', 'Charlie']) await createTask(page, project, { title });
  await page.goto(`${project.path}/tasks`);
  const open = column(page, 'Open');
  await expect(open.getByRole('link')).toHaveCount(3);

  // Alpha one place down.
  await keyboardMove(page, open.getByRole('link', { name: /Alpha/ }), 'ArrowDown');
  await expect
    .poll(() => boardOrder(page, project))
    .toEqual({
      Open: ['Bravo', 'Alpha', 'Charlie'],
      Done: [],
    });
  // The moved card keeps focus (UX-07).
  await expect(open.getByRole('link', { name: /Alpha/ })).toBeFocused();

  // Charlie to the Done column: the card is re-created there, and focus follows it.
  await keyboardMove(page, open.getByRole('link', { name: /Charlie/ }), 'ArrowRight');
  const charlie = column(page, 'Done').getByRole('link', { name: /Charlie/ });
  await expect(charlie).toBeVisible();
  await expect
    .poll(() => boardOrder(page, project))
    .toEqual({
      Open: ['Bravo', 'Alpha'],
      Done: ['Charlie'],
    });
  await expect(charlie).toBeFocused();
  // So the next move starts from where the last one ended, without tabbing back.
  await page.keyboard.press('Space');
  await announcement(page, /Picked up RKT-3 in Done/);
  await page.keyboard.press('Escape');
  await announcement(page, /Cancelled moving RKT-3/);
  await expect(charlie).toBeFocused();

  await page.reload();
  await expect(column(page, 'Done').getByRole('link', { name: /Charlie/ })).toBeVisible();
  // Enter opens the task.
  await column(page, 'Open').getByRole('link', { name: /Bravo/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${project.path}/tasks/2$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Bravo' })).toBeVisible();
});

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  /** Touches (CDP, as a finger would), optionally holding still before moving. */
  async function touchDrag(
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
    holdMs: number,
  ) {
    const cdp = await page.context().newCDPSession(page);
    const touch = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      point: { x: number; y: number },
    ) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: point.x, y: point.y }],
      });
    await touch('touchStart', from);
    if (holdMs) await page.waitForTimeout(holdMs);
    const steps = 12;
    for (let step = 1; step <= steps; step += 1) {
      await touch('touchMove', {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      });
      await page.waitForTimeout(16);
    }
    await touch('touchEnd', to);
    await cdp.detach();
  }

  const center = async (locator: ReturnType<Page['getByRole']>) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('not visible');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  test('press and hold drags a card; a swipe still scrolls the board (UX-03)', async ({ page }) => {
    const project = await setup(page);
    for (const title of ['Alpha', 'Bravo']) await createTask(page, project, { title });
    await page.goto(`${project.path}/tasks`);
    const open = column(page, 'Open');
    const alpha = open.getByRole('link', { name: /Alpha/ });
    await expect(open.getByRole('link')).toHaveCount(2);

    // Holding first picks the card up: Alpha goes below Bravo.
    const from = await center(alpha);
    const bravo = await center(open.getByRole('link', { name: /Bravo/ }));
    await touchDrag(page, from, { x: from.x, y: bravo.y + 30 }, 400);
    await expect
      .poll(() => boardOrder(page, project))
      .toEqual({
        Open: ['Bravo', 'Alpha'],
        Done: [],
      });
    await expect(page).toHaveURL(new RegExp(`${project.path}/tasks$`));
    await expect(open.getByRole('link')).toHaveText([/Bravo/, /Alpha/]);

    // A quick horizontal swipe on a card still pans the board to the next column.
    // The e2e project has no DOM types: the board is read as a plain scroll box.
    type ScrollBox = { scrollLeft: number };
    const board = page.getByRole('region', { name: 'Board' });
    const scrollLeft = () => board.evaluate((element) => (element as ScrollBox).scrollLeft);
    expect(await scrollLeft()).toBe(0);
    const start = await center(open.getByRole('link', { name: /Bravo/ }));
    await touchDrag(page, start, { x: start.x - 200, y: start.y }, 0);
    await expect.poll(scrollLeft).toBeGreaterThan(50);
    expect(await boardOrder(page, project)).toEqual({ Open: ['Bravo', 'Alpha'], Done: [] });
    await expect(page).toHaveURL(new RegExp(`${project.path}/tasks$`));
  });
});

test('list view: toggles with b, sorts, groups and keeps filters in the URL', async ({ page }) => {
  const project = await setup(page);
  await createTask(page, project, { title: 'Low one', priority: 1 });
  await createTask(page, project, { title: 'Urgent one', priority: 4, dueDate: '2030-01-01' });
  await createTask(page, project, { title: 'Nobody cares', priority: 0 });
  await page.goto(`${project.path}/tasks`);
  await expect(page.getByRole('region', { name: 'Board' })).toBeVisible();

  await page.keyboard.press('b');
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  await table.getByRole('button', { name: 'Priority' }).click();
  await expect(page).toHaveURL(/sort=priority&order=desc/);
  const titles = table.locator('tbody tr td:nth-child(2) a');
  await expect(titles).toHaveText(['Urgent one', 'Low one', 'Nobody cares']);

  await page.getByRole('combobox', { name: 'Group by' }).click();
  await page.getByRole('option', { name: 'Priority' }).click();
  await expect(page).toHaveURL(/group=priority/);
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(table.getByRole('columnheader', { name: /Urgent 1/ })).toBeVisible();

  await page.keyboard.press('/');
  await expect(page.getByRole('textbox', { name: 'Filter tasks by text' })).toBeFocused();
  await page.keyboard.type('urgent');
  await expect(page).toHaveURL(/q=urgent/);
  await expect(titles).toHaveText(['Urgent one']);

  // The choice of view is remembered for the project.
  await page.goto(`${project.path}/tasks`);
  await expect(page.getByRole('table')).toBeVisible();
  await page.goto(`${project.path}/tasks?priority=0`);
  await expect(titles).toHaveText(['Nobody cares']);
});

test('task page: edit the title, change status, claim, release, delete and undo', async ({
  page,
}) => {
  const project = await setup(page);
  const task = await createTask(page, project, {
    title: 'Draft the plan',
    description: 'We need a **plan**.',
  });
  await page.goto(task.path);
  await expect(page.getByRole('heading', { level: 1, name: 'Draft the plan' })).toBeVisible();

  await page.keyboard.press('e');
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await title.fill('Draft the launch plan');
  await title.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Draft the launch plan' }),
  ).toBeVisible();

  await page.keyboard.press('s');
  await page.getByRole('option', { name: 'Done' }).click();
  const details = page.getByRole('complementary', { name: 'Task details' });
  await expect(details.getByRole('button', { name: 'Status: Done' })).toBeVisible();
  await expect(page.getByText(/moved from Open to Done/)).toBeVisible();
  // The picker closes with a short animation; shortcuts wait until it has.
  await expect(page.getByRole('listbox')).toBeHidden();
  await page.keyboard.press('s');
  await page.getByRole('option', { name: 'Open' }).click();
  await expect(details.getByRole('button', { name: 'Status: Open' })).toBeVisible();

  await details.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(details.getByText('(web)')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Replies and history' }).getByText(/claimed this task/),
  ).toBeVisible();
  await details.getByRole('button', { name: 'Release' }).click();
  await expect(details.getByText('Nobody is working on this.')).toBeVisible();

  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete task' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete task' }).click();
  await expect(page).toHaveURL(new RegExp(`${project.path}/tasks$`));
  const toast = page.locator('[data-sonner-toast]', { hasText: `Deleted ${task.ref}` });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(new RegExp(`${task.path}$`));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Draft the launch plan' }),
  ).toBeVisible();
});

/** The signed-in user's agent member (agents A): what their API keys act as. */
async function agentOf(page: Page): Promise<{ name: string; username: string; owner: string }> {
  const me = (await (await page.request.get('/api/me')).json()) as {
    user: { name: string; username: string };
  };
  return {
    name: `${me.user.name} AI`,
    username: `${me.user.username}-ai`,
    owner: me.user.username,
  };
}

test("shows an agent's claim with its key, live", async ({ page, playwright }) => {
  const project = await setup(page);
  const agentMember = await agentOf(page);
  const task = await createTask(page, project, { title: 'Refactor the parser' });
  const created = await page.request.post('/api/me/api-keys', {
    data: { name: 'Claude on laptop' },
    headers: ORIGIN,
  });
  expect(created.status(), await created.text()).toBe(201);
  const { key } = (await created.json()) as { key: string };

  await page.goto(`${project.path}/tasks`);
  const card = column(page, 'Open').getByRole('link', { name: /Refactor the parser/ });
  await expect(card).toBeVisible();

  const agent = await playwright.request.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${key}` },
  });
  try {
    const claim = await agent.post(`/api/projects/${project.id}/claim-next`, {
      data: { leaseMinutes: 60 },
    });
    expect(claim.status(), await claim.text()).toBe(200);
    // The board updates through the live event stream: the holder is the owner's agent member.
    await expect(card.getByText(agentMember.name, { exact: true })).toBeVisible();
    await card.click();
    const details = page.getByRole('complementary', { name: 'Task details' });
    await expect(details.getByText(agentMember.name, { exact: true })).toBeVisible();
    await expect(details.getByText('Claude on laptop')).toBeVisible();
    await expect(details.getByText(/min left/)).toBeVisible();
    await expect(details.getByRole('button', { name: 'Release' })).toBeVisible();

    const done = await agent.post(`/api/tasks/${task.id}/move`, {
      data: { statusId: project.statuses.find((status) => status.name === 'Done')?.id },
    });
    expect(done.status(), await done.text()).toBe(200);
    await expect(details.getByText('Done — nobody is working on it.')).toBeVisible();
  } finally {
    await agent.dispose();
  }
});

// BAT-1: through a Cloudflare quick tunnel the event stream opened but never delivered, so pages
// only changed on refresh. Holding the stream back here makes the app fall back to long-polling.
test('updates live by long-polling when the event stream is held back', async ({ page }) => {
  const project = await setup(page);
  const task = await createTask(page, project, { title: 'Tune the tunnel' });
  await page.route(/\/api\/events$/, () => {
    // Never answer, like a proxy that buffers the whole stream.
  });
  const polled = page.waitForRequest(/\/api\/events\/poll/, { timeout: 20_000 });
  await page.goto(task.path);
  await expect(page.getByRole('heading', { name: 'Tune the tunnel' })).toBeVisible();
  await polled;

  const reply = await page.request.post('/api/replies', {
    data: { parentType: 'task', parentId: task.id, body: 'Arrived without a refresh' },
    headers: ORIGIN,
  });
  expect(reply.status(), await reply.text()).toBe(201);
  await expect(page.getByText('Arrived without a refresh')).toBeVisible();
});

// Agents A: a reply through a key is the owner's agent member's ("Ethan AI", AI badge), with the
// harness's logo and the owner's picture; mentioning the owner reaches the owner's inbox.
test("shows an agent's reply as the owner's agent member", async ({ page, playwright }) => {
  const project = await setup(page);
  const agentMember = await agentOf(page);
  const task = await createTask(page, project, { title: 'Agent identity' });
  const created = await page.request.post('/api/me/api-keys', {
    data: { name: 'MSI' },
    headers: ORIGIN,
  });
  expect(created.status(), await created.text()).toBe(201);
  const { key } = (await created.json()) as { key: string };

  const agent = await playwright.request.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${key}` },
  });
  try {
    const hello = await agent.post('/mcp', {
      headers: { Accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '2.1.0' },
        },
      },
    });
    expect(hello.status(), await hello.text()).toBe(200);
    const reply = await agent.post('/api/replies', {
      data: {
        parentType: 'task',
        parentId: task.id,
        body: `Found the cause in the tunnel, @${agentMember.owner}.`,
      },
    });
    expect(reply.status(), await reply.text()).toBe(201);
  } finally {
    await agent.dispose();
  }

  await page.goto(task.path);
  const item = page.getByRole('article', { name: /^Reply by / });
  await expect(item.getByText(/Found the cause in the tunnel/)).toBeVisible();
  await expect(item.getByText(agentMember.name, { exact: true }).first()).toBeVisible();
  await expect(item.getByText('AI', { exact: true }).first()).toBeVisible();
  await expect(item.locator('[data-agent-logo="Claude"]').first()).toBeVisible();
  await item.screenshot({ path: 'test-results/agents-a-agent-reply.png' });

  await page.goto('/inbox');
  await expect(page.getByText(agentMember.name).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/agents-a-inbox.png' });
});

// BAT-7: after a mouse drop in another column, a ghost of the card flew back to its old column
// (the card rendered there for a moment before the optimistic move landed).
test('a card dropped in another column never shows up in its old column again', async ({
  page,
}) => {
  const project = await setup(page);
  await createTask(page, project, { title: 'Ghostbuster' });
  await page.goto(`${project.path}/tasks`);
  const card = column(page, 'Open').getByRole('link', { name: /Ghostbuster/ });
  await expect(card).toBeVisible();
  const done = column(page, 'Done');

  // Record whether the card is ever put back into the Open column after the drop.
  await column(page, 'Open')
    .locator('ol')
    .evaluate((list: unknown) => {
      // No DOM types in e2e/.
      const page = globalThis as unknown as {
        dropped?: boolean;
        ghost?: boolean;
        MutationObserver: new (callback: () => void) => {
          observe(target: unknown, options: { childList: boolean; subtree: boolean }): void;
        };
      };
      const element = list as { querySelector(selector: string): unknown };
      new page.MutationObserver(() => {
        if (page.dropped && element.querySelector('[data-task-id]')) page.ghost = true;
      }).observe(list, { childList: true, subtree: true });
    });

  const from = await card.boundingBox();
  const to = await done.boundingBox();
  if (!from || !to) throw new Error('no layout');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 12 });
  await expect(done.getByRole('link', { name: /Ghostbuster/ })).toBeVisible();
  await page.evaluate(() => {
    (globalThis as unknown as { dropped: boolean }).dropped = true;
  });
  await page.mouse.up();

  await expect(done.getByRole('link', { name: /Ghostbuster/ })).toBeVisible();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (globalThis as unknown as { ghost?: boolean }).ghost)).toBe(
    undefined,
  );
  expect(await boardOrder(page, project)).toMatchObject({ Open: [], Done: ['Ghostbuster'] });
});
