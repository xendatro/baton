import { randomBytes, randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test, type TestUser } from './support/fixtures.ts';

/**
 * BAT-34: the Inbox filters by team and project, and "Your settings for this team" → Nothing
 * mutes that team's notifications.
 */

async function post<T>(page: Page, url: string, data?: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
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

test('inbox filters by project; a team set to Nothing stays quiet', async ({ page, browser }) => {
  const me: TestUser = await signedInUser(page);
  const slug = `inbox-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `Inbox ${slug}`, slug });
  const alpha = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Alpha',
    key: 'ALP',
  });
  const beta = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Beta',
    key: 'BET',
  });
  const inAlpha = await post<{ id: string }>(page, `/api/projects/${alpha.id}/tasks`, {
    title: 'Alpha work',
  });
  const inBeta = await post<{ id: string }>(page, `/api/projects/${beta.id}/tasks`, {
    title: 'Beta work',
  });
  const { code } = await post<{ code: string }>(page, `/api/teams/${team.id}/invites`, {
    expiresIn: '7d',
    maxUses: null,
  });

  // A teammate mentions me in each project.
  const mate = await secondUser(browser);
  await post(mate, `/api/invites/${code}/accept`);
  const mention = (taskId: string, body: string) =>
    post(mate, '/api/replies', {
      parentType: 'task',
      parentId: taskId,
      body: `@${me.username} ${body}`,
    });
  await mention(inAlpha.id, 'look at alpha');
  await mention(inBeta.id, 'look at beta');

  await page.goto('/inbox');
  const rows = page.getByTestId('notification');
  await expect(rows).toHaveCount(2);
  const project = page.getByRole('combobox', { name: 'Project' });
  await expect(project.locator('option')).toHaveText(['All projects (2)', 'Alpha (1)', 'Beta (1)']);
  await project.selectOption({ label: 'Beta (1)' });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Beta work');
  // Remembered: the inbox opens filtered.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue(beta.id);
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(2);

  // Your settings for this team → Nothing.
  await page.goto(`/t/${slug}`);
  await page.getByRole('link', { name: 'Your settings for this team' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/me$`));
  await page.getByRole('switch', { name: 'Use my defaults', exact: true }).click();
  await page.getByRole('radio', { name: 'Nothing' }).click();
  await page.getByRole('button', { name: 'Save notifications' }).click();
  await expect(page.getByText(`Saved your notifications for Inbox ${slug}`)).toBeVisible();

  await mention(inAlpha.id, 'are you there?');
  await mention(inBeta.id, 'hello?');
  const list = (await (await page.request.get('/api/notifications')).json()) as {
    items: unknown[];
  };
  expect(list.items).toHaveLength(2);
  await page.goto('/inbox');
  await expect(rows).toHaveCount(2);
  await mate.context().close();
});
