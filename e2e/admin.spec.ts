import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Browser, Page } from '@playwright/test';
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
 * Admin module flows: the team Trash (restore with a link back), the team audit log (filters in
 * the URL, live rows, diffs, CSV export, permission gate) and palette search. Teams, projects and
 * items are seeded straight into the database (their modules own those APIs); replies go through
 * the REST API so their audit rows and trash entries are real.
 */

const EVERYONE = [
  'VIEW_PROJECT',
  'CREATE_INVITES',
  'MANAGE_LABELS',
  'CREATE_ISSUES',
  'CREATE_TASKS',
  'REPLY',
  'UPDATE_TASKS',
  'RESOLVE_ISSUES',
];

interface Seed {
  teamId: string;
  slug: string;
  projectId: string;
  key: string;
  issueId: string;
  taskId: string;
}

const id = (prefix: string) => `${prefix}${randomBytes(10).toString('hex')}`;

function userId(db: Parameters<Parameters<typeof withDatabase>[0]>[0], user: TestUser): string {
  return (db.prepare('select id from user where email = ?').get(user.email) as { id: string }).id;
}

/** A team owned by `owner` with one project, an issue (#1) and a task (-1), searchable. */
function seedTeam(owner: TestUser, words = 'checkout'): Seed {
  const suffix = randomBytes(3).toString('hex');
  const seed: Seed = {
    teamId: id('tm'),
    slug: `adm-${suffix}`,
    projectId: id('pr'),
    key: `A${suffix.slice(0, 3).toUpperCase().replace(/[0-9]/g, 'X')}`,
    issueId: id('is'),
    taskId: id('tk'),
  };
  withDatabase((db) => {
    const ownerId = userId(db, owner);
    const now = Date.now();
    db.prepare(
      'insert into team (id, name, slug, color, owner_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(seed.teamId, 'Acme Admin', seed.slug, '#6366f1', ownerId, now, now);
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      seed.teamId,
      ownerId,
      now,
    );
    db.prepare(
      `insert into role (id, team_id, name, slug, position, permissions, mentionable, is_everyone, created_at, updated_at)
       values (?, ?, '@everyone', 'everyone', 0, ?, 0, 1, ?, ?)`,
    ).run(id('rl'), seed.teamId, JSON.stringify(EVERYONE), now, now);
    db.prepare(
      `insert into project (id, team_id, name, key, color, issue_seq, task_seq, created_by_id, created_at, updated_at)
       values (?, ?, 'Storefront', ?, '#0ea5e9', 1, 1, ?, ?, ?)`,
    ).run(seed.projectId, seed.teamId, seed.key, ownerId, now, now);
    const pipelineId = id('pl');
    db.prepare(
      `insert into pipeline (id, project_id, name, slug, position, is_default, created_at, updated_at)
       values (?, ?, 'Default', 'default', 0, 1, ?, ?)`,
    ).run(pipelineId, seed.projectId, now, now);
    const statusId = id('st');
    db.prepare(
      `insert into status (id, project_id, pipeline_id, name, color, category, position, is_default, created_at, updated_at)
       values (?, ?, ?, 'Open', '#6b7280', 'open', 0, 1, ?, ?)`,
    ).run(statusId, seed.projectId, pipelineId, now, now);
    db.prepare(
      `insert into issue (id, project_id, team_id, number, title, body, author_id, last_activity_at, created_at, updated_at)
       values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.issueId,
      seed.projectId,
      seed.teamId,
      `Payment fails at ${words}`,
      `The ${words} page times out`,
      ownerId,
      now,
      now,
      now,
    );
    db.prepare(
      `insert into task (id, project_id, team_id, number, title, status_id, position, author_id, last_activity_at, created_at, updated_at)
       values (?, ?, ?, 1, ?, ?, 'a0', ?, ?, ?, ?)`,
    ).run(
      seed.taskId,
      seed.projectId,
      seed.teamId,
      `Retry ${words} requests`,
      statusId,
      ownerId,
      now,
      now,
      now,
    );
    const index = db.prepare(
      'insert into search_index (entity_type, entity_id, team_id, project_id, title, body) values (?, ?, ?, ?, ?, ?)',
    );
    index.run(
      'issue',
      seed.issueId,
      seed.teamId,
      seed.projectId,
      `Payment fails at ${words}`,
      `The ${words} page times out`,
    );
    index.run('task', seed.taskId, seed.teamId, seed.projectId, `Retry ${words} requests`, '');
  });
  return seed;
}

function addMember(seed: Seed, user: TestUser) {
  withDatabase((db) => {
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      seed.teamId,
      userId(db, user),
      Date.now(),
    );
  });
}

async function reply(page: Page, seed: Seed, body: string): Promise<string> {
  const res = await page.request.post('/api/replies', {
    data: { parentType: 'issue', parentId: seed.issueId, body },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function deleteReply(page: Page, replyId: string) {
  const res = await page.request.delete(`/api/replies/${replyId}`, { headers: ORIGIN });
  expect(res.ok()).toBe(true);
}

/** A second signed-in browser for another member. */
async function memberPage(browser: Browser, seed: Seed): Promise<{ page: Page; user: TestUser }> {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.9.${randomBytes(1)[0] ?? 1}.${((randomBytes(1)[0] ?? 0) % 250) + 1}`,
    },
  });
  const page = await context.newPage();
  const user = await createVerifiedUser(page.request);
  addMember(seed, user);
  return { page, user };
}

test.describe('trash', () => {
  test('restores a deleted reply and links back to it', async ({ page }) => {
    const owner = await signedInUser(page);
    const seed = seedTeam(owner);
    const replyId = await reply(page, seed, 'A reply that should come back');
    await deleteReply(page, replyId);

    await page.goto(`/t/${seed.slug}/settings/trash`);
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
    const row = page.getByTestId('trash-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('A reply that should come back');
    await expect(row).toContainText(`on ${seed.key}#1`);
    await expect(row).toContainText('30 days left');

    await row.getByRole('button', { name: /Restore reply/ }).click();
    const toast = page.getByText('Restored the reply');
    await expect(toast).toBeVisible();
    await expect(page.getByText('Trash is empty')).toBeVisible();
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/t/${seed.slug}/p/${seed.key}/issues/1#reply-${replyId}$`),
    );
  });

  test('members see their own deleted items; the type filter lives in the URL', async ({
    page,
    browser,
  }) => {
    const owner = await signedInUser(page);
    const seed = seedTeam(owner);
    const ownerReply = await reply(page, seed, 'Owner reply');
    await deleteReply(page, ownerReply);
    const member = await memberPage(browser, seed);
    const memberReply = await reply(member.page, seed, 'Member reply');
    await deleteReply(member.page, memberReply);

    await member.page.goto(`/t/${seed.slug}/settings/trash`);
    await expect(member.page.getByText(/You see the items you created/)).toBeVisible();
    await expect(member.page.getByTestId('trash-row')).toHaveCount(1);
    await expect(member.page.getByTestId('trash-row')).toContainText('Member reply');

    // The owner sees everything, and can narrow it down by type.
    await page.goto(`/t/${seed.slug}/settings/trash`);
    await expect(page.getByTestId('trash-row')).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Filter by type' }).click();
    await page.getByRole('option', { name: 'Tasks' }).click();
    await expect(page).toHaveURL(/\?type=task$/);
    await expect(page.getByText('No deleted tasks')).toBeVisible();
    await page.getByRole('button', { name: 'Show all types' }).click();
    await expect(page.getByTestId('trash-row')).toHaveCount(2);
    await member.page.context().close();
  });
});

test.describe('audit log', () => {
  test('shows, filters, expands, updates live and exports the log', async ({ page }) => {
    const owner = await signedInUser(page);
    const seed = seedTeam(owner);
    const first = await reply(page, seed, 'First thoughts');
    const res = await page.request.patch(`/api/replies/${first}`, {
      data: { body: 'Second thoughts' },
      headers: ORIGIN,
    });
    expect(res.ok()).toBe(true);

    await page.goto(`/t/${seed.slug}/settings/audit-log`);
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    const rows = page.getByTestId('audit-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`edited a reply on ${seed.key}#1`);
    await expect(rows.nth(1)).toContainText(`replied on ${seed.key}#1`);
    await expect(rows.nth(1).getByRole('link', { name: `${seed.key}#1` })).toHaveAttribute(
      'href',
      `/t/${seed.slug}/p/${seed.key}/issues/1#reply-${first}`,
    );

    // Expand the edit: the text diff.
    await rows.nth(0).getByRole('button', { name: 'Show changes (1)' }).click();
    await expect(rows.nth(0).getByText('First thoughts')).toBeVisible();
    await expect(rows.nth(0).getByText('Second thoughts')).toBeVisible();
    await expect(rows.nth(0).getByText('reply.edited')).toBeVisible();

    // Filter by action through the menu; the URL keeps it.
    await page.getByRole('button', { name: 'Filter by action' }).click();
    await page.getByRole('option', { name: /Created/ }).click();
    await expect(page).toHaveURL(/action=reply\.created/);
    await expect(rows).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Action: Created' })).toBeVisible();
    await expect(rows).toHaveCount(1);
    await page.getByRole('button', { name: /Clear filter/ }).click();
    await expect(rows).toHaveCount(2);

    // Live: a new change slides in at the top.
    await reply(page, seed, 'Live one');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(`replied on ${seed.key}#1`);

    // CSV export of the loaded rows.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^audit-log-${seed.slug}-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
    );
    const csv = fs.readFileSync((await download.path()) ?? '', 'utf8');
    expect(csv).toContain('time,actor_username,actor_name,source,via_key,via_agent,action,summary');
    expect(csv).toContain(`edited a reply on ${seed.key}#1`);
    expect(csv.trim().split('\r\n')).toHaveLength(4);
  });

  test('is gated by the View audit log permission', async ({ page, browser }) => {
    const owner = await signedInUser(page);
    const seed = seedTeam(owner);
    const member = await memberPage(browser, seed);
    await member.page.goto(`/t/${seed.slug}/settings/audit-log`);
    await expect(member.page.getByText('You can’t view the audit log')).toBeVisible();
    const api = await member.page.request.get(`/api/teams/${seed.teamId}/audit-log`);
    expect(api.status()).toBe(403);
    await member.page.context().close();
  });
});

test.describe('palette search', () => {
  test('finds tasks, issues and replies and opens the result', async ({ page }) => {
    const owner = await signedInUser(page);
    const word = `zephyr${randomBytes(2).toString('hex')}`;
    const seed = seedTeam(owner, word);
    await reply(page, seed, `Seen the ${word} bug again`);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByPlaceholder('Search or jump to…').fill(word);
    await expect(palette.getByText('Tasks', { exact: true })).toBeVisible();
    await expect(palette.getByText('Issues', { exact: true })).toBeVisible();
    await expect(palette.getByText('Replies', { exact: true })).toBeVisible();
    await expect(palette.locator('mark', { hasText: word }).first()).toBeVisible();

    await palette.getByRole('option', { name: new RegExp(`Retry ${word} requests`) }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${seed.slug}/p/${seed.key}/tasks/1$`));
  });
});
