import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { EVERYONE_DEFAULTS } from '../shared/permissions.ts';
import {
  expect,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * BAT-44 (the rail of open issues beside an issue, by latest activity; right-click Mark resolved)
 * and BAT-43 (a chat issue is one screen tall: its composer shows without scrolling, whatever the
 * length of the post).
 */

function userId(email: string): string {
  return withDatabase(
    (db) => (db.prepare('select id from user where email = ?').get(email) as { id: string }).id,
  );
}

function seedTeam(owner: TestUser) {
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
    ).run(`${id}r`, id, JSON.stringify(EVERYONE_DEFAULTS), now, now);
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      id,
      userId(owner.email),
      now,
    );
  });
  return { id, slug };
}

async function createProject(page: Page, teamId: string, key: string) {
  const res = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: `Project ${key}`, key },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

async function createIssue(page: Page, projectId: string, title: string, body = '') {
  const res = await page.request.post(`/api/projects/${projectId}/issues`, {
    data: { title, body },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; number: number };
}

function setActivity(issueId: string, minutesAgo: number) {
  withDatabase((db) =>
    db
      .prepare('update issue set last_activity_at = ? where id = ?')
      .run(Date.now() - minutesAgo * 60_000, issueId),
  );
}

test('the issue rail lists open issues by latest activity; Mark resolved drops one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team.id, 'RAIL');
  const oldest = await createIssue(page, project.id, 'Oldest question');
  const busiest = await createIssue(page, project.id, 'Busiest thread');
  const middle = await createIssue(page, project.id, 'Middle report');
  const resolved = await createIssue(page, project.id, 'Already settled');
  const res = await page.request.post(`/api/issues/${resolved.id}/resolve`, { headers: ORIGIN });
  expect(res.status()).toBe(200);
  const reply = await page.request.post('/api/replies', {
    data: { parentType: 'issue', parentId: busiest.id, body: 'sounds good' },
    headers: ORIGIN,
  });
  expect(reply.status(), await reply.text()).toBe(201);
  setActivity(oldest.id, 30);
  setActivity(middle.id, 10);
  setActivity(busiest.id, 1);

  await page.goto(`/t/${team.slug}/p/RAIL/issues/${middle.number}`);
  const rail = page.getByRole('navigation', { name: 'Issues' });
  const rows = rail.getByTestId('item-rail-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Busiest thread');
  await expect(rows.nth(0)).toContainText('sounds good');
  await expect(rows.nth(1)).toContainText('Middle report');
  await expect(rows.nth(2)).toContainText('Oldest question');
  await expect(rail.getByText('Already settled')).toHaveCount(0);
  await expect(rail.locator('[aria-current="page"]')).toContainText('Middle report');

  // Clicking a row switches issues in place.
  await rows.nth(2).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${oldest.number}$`));
  await expect(page.getByRole('heading', { level: 1, name: /Oldest question/ })).toBeVisible();
  await expect(rail.locator('[aria-current="page"]')).toContainText('Oldest question');

  // Right-click → Mark resolved: the issue leaves the rail.
  await rail.getByRole('link', { name: /Busiest thread/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark resolved' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rail.getByText('Busiest thread')).toHaveCount(0);
});

test('a long chat issue keeps its composer on screen without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProject(page, team.id, 'LONG');
  const body = Array.from(
    { length: 60 },
    (_, n) => `Paragraph ${n + 1}: the export stalls on large projects.`,
  ).join('\n\n');
  const issue = await createIssue(page, project.id, 'A very long report', body);

  await page.goto(`/t/${team.slug}/p/LONG/issues/${issue.number}`);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeVisible();
  await expect(composer).toBeInViewport();
  expect(await page.evaluate('window.scrollY')).toBe(0);
  // The page itself doesn't scroll: it is exactly one screen tall.
  expect(
    await page.evaluate('document.documentElement.scrollHeight <= window.innerHeight + 1'),
  ).toBe(true);
  await expect(page.getByText('Paragraph 60:')).not.toBeInViewport();

  // Read more shows the whole post inline; Show less cuts it again.
  await page.getByRole('button', { name: 'Read more' }).click();
  await page.getByText('Paragraph 60:').scrollIntoViewIfNeeded();
  await expect(page.getByText('Paragraph 60:')).toBeInViewport();
  await expect(composer).toBeInViewport();
  await page.getByRole('button', { name: 'Show less' }).click();
  await expect(page.getByRole('button', { name: 'Read more' })).toBeVisible();
});
