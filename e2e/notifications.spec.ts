import { randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test, type TestUser } from './support/fixtures.ts';

/**
 * BAT-15 and BAT-16: a task card shows the viewer's unread notifications about it, and opening
 * the task marks them read, clearing the card's badge and the Inbox count.
 */

test.use({ colorScheme: 'light' });

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

test('a mention shows as a badge on the card and in the Inbox until the task is opened', async ({
  page,
  browser,
}) => {
  const me: TestUser = await signedInUser(page);
  const teamRes = await page.request.post('/api/teams', {
    data: { name: 'Badge Crew' },
    headers: ORIGIN,
  });
  const team = (await teamRes.json()) as { id: string; slug: string };
  const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
    data: { name: 'Notices', key: 'NT' },
    headers: ORIGIN,
  });
  const { id: projectId } = (await projectRes.json()) as { id: string };
  const taskRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
    data: { title: 'Ship the badge' },
    headers: ORIGIN,
  });
  expect(taskRes.status()).toBe(201);
  const task = (await taskRes.json()) as { id: string };
  const invite = await page.request.post(`/api/teams/${team.id}/invites`, {
    data: { expiresIn: '7d', maxUses: null },
    headers: ORIGIN,
  });
  const { code } = (await invite.json()) as { code: string };

  // A teammate mentions me on the task.
  const mate = await secondUser(browser);
  expect(
    (await mate.request.post(`/api/invites/${code}/accept`, { headers: ORIGIN })).status(),
  ).toBe(200);
  const reply = await mate.request.post('/api/replies', {
    data: { parentType: 'task', parentId: task.id, body: `@${me.username} can you check this?` },
    headers: ORIGIN,
  });
  expect(reply.status()).toBe(201);

  const inboxLink = page.getByRole('link', { name: /^Inbox/ });
  const card = page.getByRole('link', { name: /Ship the badge/ });
  await page.goto(`/t/${team.slug}/p/NT/tasks`);
  await expect(card.getByRole('img', { name: '1 unread notification' })).toBeVisible();
  await expect(card.getByRole('img', { name: '1 unread notification' })).toHaveText('1');
  await expect(inboxLink).toHaveAccessibleName(/\(1 unread\)/);

  // Opening the task reads the mention: the Inbox count drops at once.
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/NT/tasks/1$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Ship the badge' })).toBeVisible();
  await expect(page.getByRole('log').getByText('can you check this?')).toBeVisible();
  await expect(inboxLink).not.toHaveAccessibleName(/unread/);

  // Back on the board, the card has no badge.
  await page.goto(`/t/${team.slug}/p/NT/tasks`);
  await expect(card).toBeVisible();
  await expect(page.getByRole('img', { name: /unread notification/ })).toHaveCount(0);
  await expect(inboxLink).not.toHaveAccessibleName(/unread/);
  await mate.context().close();
});
