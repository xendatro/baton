import { randomBytes, randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { EVERYONE_DEFAULTS, type Permission } from '../shared/permissions.ts';
import {
  expect,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * Issues module (SPEC §1.7): opening issues, the forum-style list (tabs, filters, search,
 * keyboard), the issue page (inline edits, labels, resolve/reopen, replies, subscription,
 * "Addressed by"), deleting with Undo, and what members without permissions see. Teams are
 * inserted directly and projects created through the API, so this spec depends on no other UI.
 */

interface SeededTeam {
  id: string;
  slug: string;
}

function userId(email: string): string {
  return withDatabase(
    (db) => (db.prepare('select id from user where email = ?').get(email) as { id: string }).id,
  );
}

/** A team owned by `owner`, with `members` who only have `@everyone` (`everyone` permissions). */
function seedTeam(
  owner: TestUser,
  members: TestUser[] = [],
  everyone: readonly Permission[] = EVERYONE_DEFAULTS,
): SeededTeam {
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const id = `e2e${randomBytes(8).toString('hex')}`;
  const now = Date.now();
  withDatabase((db) => {
    db.prepare(
      'insert into team (id, name, slug, color, owner_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, 'Acme', slug, '#6366f1', userId(owner.email), now, now);
    db.prepare(
      `insert into role (id, team_id, name, slug, position, permissions, mentionable, is_everyone, created_at, updated_at)
       values (?, ?, '@everyone', 'everyone', 0, ?, 0, 1, ?, ?)`,
    ).run(`${id}r`, id, JSON.stringify(everyone), now, now);
    for (const user of [owner, ...members]) {
      db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
        id,
        userId(user.email),
        now,
      );
    }
  });
  return { id, slug };
}

async function createProject(page: Page, team: SeededTeam, key: string) {
  const res = await page.request.post(`/api/teams/${team.id}/projects`, {
    data: { name: `Project ${key}`, key },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

async function createLabel(page: Page, projectId: string, name: string, color = '#ef4444') {
  const res = await page.request.post(`/api/projects/${projectId}/labels`, {
    data: { name, color },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

async function createIssue(
  page: Page,
  projectId: string,
  body: { title: string; body?: string; labelIds?: string[] },
) {
  // These specs cover the threaded forum view; new issues are chats unless asked (e2e/chat.spec.ts).
  const res = await page.request.post(`/api/projects/${projectId}/issues`, {
    data: { conversationMode: 'forum', ...body },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; number: number; ref: string };
}

/** A second signed-in browser with its own client IP. */
async function secondUser(browser: Browser) {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();
  const user = await signedInUser(page);
  return { context, page, user };
}

test('open an issue with a new label, then find it in the list', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team, 'WEB');
  await createIssue(page, project.id, { title: 'An older question' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`/t/${team.slug}/p/WEB/issues`);
  await expect(page.getByRole('link', { name: 'An older question' })).toBeVisible();
  // `i` opens the new issue page from anywhere in the project.
  await page.keyboard.press('i');
  await expect(page).toHaveURL(/\/issues\/new$/);
  await expect(page.getByRole('heading', { name: 'New issue' })).toBeVisible();

  // The title is required.
  await page.getByRole('button', { name: 'Create issue' }).click();
  await expect(page.getByText('Required')).toBeVisible();

  await page.getByLabel('Title').fill('Export fails for large projects');
  await page.getByRole('textbox', { name: 'Description' }).click();
  await page.keyboard.type('Exporting 5,000 tasks times out after 30 seconds.');
  await page.getByRole('button', { name: 'Add labels' }).click();
  await page.getByPlaceholder('Find or create a label…').fill('Performance');
  await page.getByRole('option', { name: /Create label/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Labels: Performance' })).toBeVisible();
  await page.getByLabel('Title').focus();
  await page.keyboard.press('Control+Enter');

  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/WEB/issues/2$`));
  await expect(page.locator('[data-sonner-toast]').getByText('Issue WEB#2 opened')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Export fails for large projects #2' }),
  ).toBeVisible();
  await expect(page.getByText('Exporting 5,000 tasks times out after 30 seconds.')).toBeVisible();
  const details = page.getByRole('complementary', { name: 'Issue details' });
  await expect(details.getByText('Performance')).toBeVisible();
  await expect(details.getByRole('button', { name: 'Unsubscribe' })).toBeVisible();

  // Back in the list: tabs count, the label filter, the search box and the author filter.
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Issues' })
    .click();
  await expect(page.getByRole('button', { name: /^Open\s*2$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Filter by label' }).click();
  await page.getByRole('option', { name: 'Performance' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/label=Performance/);
  await expect(page.getByRole('list', { name: 'Issues' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('list', { name: 'Issues' }).getByRole('listitem')).toHaveCount(2);

  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search issues' })).toBeFocused();
  await page.keyboard.type('older');
  await expect(page).toHaveURL(/q=older/);
  await expect(page.getByRole('list', { name: 'Issues' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search issues' }).fill('nothing matches this');
  await expect(page.getByRole('heading', { name: 'No issues match these filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('list', { name: 'Issues' }).getByRole('listitem')).toHaveCount(2);

  // Keyboard: j/k move through the rows, Enter opens the selected one.
  await page.getByRole('searchbox', { name: 'Search issues' }).blur();
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/issues\/2$/);
  expect(errors).toEqual([]);
});

test('edit, label, reply to, resolve and reopen an issue', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team, 'API');
  const bug = await createLabel(page, project.id, 'Bug');
  await createLabel(page, project.id, 'Docs', '#14b8a6');
  const issue = await createIssue(page, project.id, {
    title: 'Rate limit headers missng',
    body: 'No Retry-After on 429.',
    labelIds: [bug.id],
  });

  await page.goto(`/t/${team.slug}/p/API/issues/${issue.number}`);
  await expect(page.getByText('No Retry-After on 429.')).toBeVisible();

  // `e` edits the title in place.
  await page.keyboard.press('e');
  const title = page.getByRole('textbox', { name: 'Title' });
  await expect(title).toBeFocused();
  await title.fill('Rate limit headers missing');
  await title.press('Enter');
  await expect(page.locator('[data-sonner-toast]').getByText('Title updated')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Rate limit headers missing #1' }),
  ).toBeVisible();

  // Edit the body.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Description' });
  await body.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Agents retry at once.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('No Retry-After on 429. Agents retry at once.')).toBeVisible();
  await expect(page.getByText('(edited)')).toBeVisible();

  // `l` opens the labels: swap Bug for Docs.
  await page.keyboard.press('l');
  await page.getByRole('option', { name: 'Docs' }).click();
  await page.getByRole('option', { name: 'Bug' }).click();
  await page.keyboard.press('Escape');
  const details = page.getByRole('complementary', { name: 'Issue details' });
  await expect(details.getByText('Docs')).toBeVisible();
  await expect(details.getByText('Bug')).toHaveCount(0);

  // Reply, then resolve.
  await page.getByRole('textbox', { name: 'Reply' }).click();
  await page.keyboard.type('Fixed in the shared middleware.');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('article', { name: /Reply by/ })).toContainText(
    'Fixed in the shared middleware.',
  );
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('[data-sonner-toast]').getByText('API#1 resolved')).toBeVisible();
  await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
  // The history is in the Activity drawer.
  await page.getByRole('button', { name: /^Activity/ }).click();
  await expect(
    page.getByRole('list', { name: 'History' }).getByText('resolved this issue'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: 'History' })).toBeHidden();

  // Reopen from the command palette.
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search or jump to…').fill('reopen');
  await page.getByRole('option', { name: 'Reopen API#1' }).click();
  await expect(page.locator('[data-sonner-toast]').getByText('API#1 reopened')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // Unsubscribe from replies.
  await details.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(details.getByRole('button', { name: 'Subscribe' })).toBeVisible();
  await page.reload();
  await expect(details.getByRole('button', { name: 'Subscribe' })).toBeVisible();
});

test('an unsent reply survives leaving the issue and coming back (UX-13)', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team, 'API');
  const issue = await createIssue(page, project.id, { title: 'Draft keeper' });
  const draft = 'draft text that should not vanish';

  await page.goto(`/t/${team.slug}/p/API/issues/${issue.number}`);
  const reply = page.getByRole('textbox', { name: 'Reply' });
  await reply.click();
  await page.keyboard.type(draft);
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Issues' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/API/issues$`));
  await page.goBack();
  await expect(reply).toContainText(draft);
  await page.reload();
  await expect(reply).toContainText(draft);

  // Once sent, the draft is gone.
  await reply.click();
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('article', { name: /Reply by/ })).toContainText(draft);
  await page.reload();
  await expect(page.getByRole('article', { name: /Reply by/ })).toContainText(draft);
  await expect(reply).not.toContainText(draft);
});

test('signing out forgets unsent reply drafts', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team, 'SGN');
  const issue = await createIssue(page, project.id, { title: 'Shared computer' });
  const draftKeys = () =>
    page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('baton:reply-draft:')),
    );

  await page.goto(`/t/${team.slug}/p/SGN/issues/${issue.number}`);
  await page.getByRole('textbox', { name: 'Reply' }).click();
  await page.keyboard.type('not for the next person');
  await expect.poll(draftKeys).toHaveLength(1);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await draftKeys()).toEqual([]);
});

test('delete an issue, then undo from the toast', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team, 'DEL');
  const issue = await createIssue(page, project.id, { title: 'Posted by mistake' });

  await page.goto(`/t/${team.slug}/p/DEL/issues/${issue.number}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete issue' }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete DEL#1?' })
    .getByRole('button', { name: 'Delete issue' })
    .click();

  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/DEL/issues$`));
  await expect(page.getByRole('heading', { name: 'No issues yet' })).toBeVisible();
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'DEL#1 moved to Trash' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/DEL/issues/1$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Posted by mistake #1' })).toBeVisible();

  // A deleted issue's URL explains itself.
  await page.goto(`/t/${team.slug}/p/DEL/issues/99`);
  await expect(page.getByRole('heading', { name: 'Issue not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to issues' }).click();
  await expect(page.getByRole('link', { name: 'Posted by mistake' })).toBeVisible();
});

test('members see only what their permissions allow, and the tasks addressing an issue', async ({
  page,
  browser,
}) => {
  const owner = await signedInUser(page);
  const other = await secondUser(browser);
  // Members can open issues and reply, but not triage, create tasks or edit others' content.
  const team = seedTeam(owner, [other.user], ['VIEW_PROJECT', 'CREATE_ISSUES', 'REPLY']);
  const project = await createProject(page, team, 'SEC');
  const issue = await createIssue(page, project.id, { title: 'Owner’s issue' });
  const task = await page.request.post(`/api/projects/${project.id}/tasks`, {
    data: {
      title: 'Add Retry-After everywhere',
      issueLinks: [{ issueId: issue.id, kind: 'fixes' }],
    },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);

  const memberPage = other.page;
  await memberPage.goto(`/t/${team.slug}/p/SEC/issues/${issue.number}`);
  await expect(
    memberPage.getByRole('heading', { level: 1, name: 'Owner’s issue #1' }),
  ).toBeVisible();
  const details = memberPage.getByRole('complementary', { name: 'Issue details' });
  await expect(
    details.getByRole('link', { name: /SEC-1\s*Add Retry-After everywhere/ }),
  ).toHaveAttribute('href', `/t/${team.slug}/p/SEC/tasks/1`);
  await expect(details.getByText('fixes')).toBeVisible();
  await expect(memberPage.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  await expect(memberPage.getByRole('button', { name: 'Edit title' })).toHaveCount(0);
  await expect(memberPage.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Edit labels' })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Create task' })).toHaveCount(0);
  await memberPage.getByRole('button', { name: 'More actions' }).click();
  await expect(memberPage.getByRole('menuitem', { name: 'Delete issue' })).toHaveCount(0);
  await memberPage.keyboard.press('Escape');
  // Members are not subscribed to issues they haven't joined.
  await expect(details.getByRole('button', { name: 'Subscribe' })).toBeVisible();

  // The owner has every permission: triage and Create task are there.
  await page.goto(`/t/${team.slug}/p/SEC/issues/${issue.number}`);
  await expect(page.getByRole('button', { name: 'Resolve' })).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Issue details' }).getByRole('button', {
      name: 'Create task',
    }),
  ).toBeVisible();

  // Without CREATE_ISSUES there is no New issue button, and the page says why.
  withDatabase((db) =>
    db
      .prepare('update role set permissions = ? where id = ?')
      .run(JSON.stringify(['VIEW_PROJECT', 'REPLY']), `${team.id}r`),
  );
  await memberPage.goto(`/t/${team.slug}/p/SEC/issues`);
  await expect(memberPage.getByRole('link', { name: 'Owner’s issue' })).toBeVisible();
  await expect(memberPage.getByRole('link', { name: 'New issue' })).toHaveCount(0);
  await memberPage.goto(`/t/${team.slug}/p/SEC/issues/new`);
  await expect(
    memberPage.getByRole('heading', { name: 'You can’t open issues here' }),
  ).toBeVisible();
  await other.context.close();
});

test('the back link returns to the filtered issue list where it was left (BAT-11)', async ({
  page,
}) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team, 'BCK');
  const bug = await createLabel(page, project.id, 'Bug');
  await createIssue(page, project.id, { title: 'Not a bug at all' });
  for (let index = 1; index <= 20; index += 1) {
    await createIssue(page, project.id, { title: `Crash number ${index}`, labelIds: [bug.id] });
  }
  const rows = page.getByRole('list', { name: 'Issues' }).getByRole('listitem');
  const scrollY = () => page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY);

  // Opened directly, the link goes to the issue list.
  await page.goto(`/t/${team.slug}/p/BCK/issues/1`);
  await page.getByRole('link', { name: 'Back to Issues' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/BCK/issues$`));
  await expect(rows).toHaveCount(21);

  // Filter the list, scroll down and open an issue from it.
  await page.getByRole('button', { name: 'Filter by label' }).click();
  await page.getByRole('option', { name: 'Bug' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/label=Bug/);
  await expect(rows).toHaveCount(20);
  // Closing the popover returns focus to its button at the top; scroll only after that.
  await expect(page.getByRole('button', { name: 'Labels: 1 selected' })).toBeFocused();
  const oldest = page.getByRole('link', { name: 'Crash number 1', exact: true });
  await oldest.scrollIntoViewIfNeeded();
  const scrolled = await scrollY();
  expect(scrolled).toBeGreaterThan(0);
  await oldest.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Crash number 1 #2' })).toBeVisible();

  // Back: the filter and the scroll position are kept.
  await page.getByRole('link', { name: 'Back to Issues' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/BCK/issues\\?label=Bug$`));
  await expect(rows).toHaveCount(20);
  await expect.poll(scrollY).toBeGreaterThan(scrolled - 5);

  // `u` does the same.
  await page.getByRole('link', { name: 'Crash number 2', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Crash number 2 #3' })).toBeVisible();
  await page.keyboard.press('u');
  await expect(page).toHaveURL(/label=Bug$/);
  await expect(rows).toHaveCount(20);
});
