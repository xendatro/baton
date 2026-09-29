import { randomBytes, randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test, type TestUser } from './support/fixtures.ts';

/**
 * Chat conversations: a new issue is a chat by default; messages are sent with Enter, reacted to,
 * answered with an inline quote, and images show inline. Two people see each other typing.
 */

test.use({ colorScheme: 'light' });

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function teamAndProject(page: Page, key: string) {
  const slug = `chat-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Chat ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const project = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Chatty', key },
    headers: ORIGIN,
  });
  expect(project.status(), await project.text()).toBe(201);
  const { id: projectId } = (await project.json()) as { id: string };
  return { teamId, slug, projectId };
}

/** A second signed-in person in their own browser context (own client IP). */
async function secondUser(browser: Browser): Promise<{ page: Page; user: TestUser }> {
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    colorScheme: 'light',
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();
  const user = await signedInUser(page);
  return { page, user };
}

test('a new issue is a chat: send, react, reply to a message, and share an image', async ({
  page,
}) => {
  const me = await signedInUser(page);
  const { slug } = await teamAndProject(page, 'CHT');

  // New issue: the response style defaults to Chat.
  await page.goto(`/t/${slug}/p/CHT/issues/new`);
  await page.getByLabel('Title').fill('Deploy is failing');
  await expect(page.getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Create issue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Deploy is failing/ })).toBeVisible();
  const chat = page.getByTestId('chat-view');
  await expect(chat.getByText('No messages yet')).toBeVisible();

  // Enter sends; Shift+Enter makes a new line first.
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await page.keyboard.type('The build broke');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('after the last merge');
  await page.keyboard.press('Enter');
  const first = chat.getByTestId('chat-message').filter({ hasText: 'The build broke' });
  await expect(first).toContainText('after the last merge');
  await expect(first).toContainText(me.name);
  await expect(box).toHaveText('');

  // React from the hover toolbar.
  await first.hover();
  await first.getByRole('button', { name: 'React with 👍' }).click();
  await expect(first.getByRole('button', { name: 'React with 👍 (1)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Reply to the message: stored as an answer, shown flat with a quote of it.
  await first.getByRole('button', { name: 'Reply' }).click();
  await expect(page.getByTestId('reply-to-chip')).toContainText('The build broke');
  await expect(box).toBeFocused();
  await page.keyboard.type('Reverting it now');
  await page.keyboard.press('Enter');
  const answer = chat.getByTestId('chat-message').filter({ hasText: 'Reverting it now' });
  await expect(answer.getByTestId('chat-quote')).toContainText('The build broke');
  await expect(page.getByTestId('reply-to-chip')).toHaveCount(0);

  // An image on its own (no text) shows inline.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('chat-composer').getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(page.getByTestId('chat-composer').getByText('screenshot.png')).toBeVisible();
  await page.getByRole('button', { name: 'Send message' }).click();
  const image = chat.getByRole('img', { name: 'screenshot.png' });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => (element as unknown as { naturalWidth: number }).naturalWidth),
    )
    .toBe(1);

  // All of it survives a reload, still as a chat.
  await page.reload();
  await expect(chat.getByTestId('chat-message')).toHaveCount(3);
  await expect(
    chat
      .getByTestId('chat-message')
      .filter({ hasText: 'Reverting it now' })
      .getByTestId('chat-quote'),
  ).toContainText('The build broke');
  await chat.screenshot({ path: 'test-results/chat-issue.png' });
});

test('two people see each other typing in a chat', async ({ page, browser }) => {
  await signedInUser(page);
  const { teamId, slug, projectId } = await teamAndProject(page, 'TYP');
  const issue = await page.request.post(`/api/projects/${projectId}/issues`, {
    data: { title: 'Standup' },
    headers: ORIGIN,
  });
  expect(issue.status(), await issue.text()).toBe(201);
  const { path, conversationMode } = (await issue.json()) as {
    path: string;
    conversationMode: string;
  };
  expect(conversationMode).toBe('chat');
  const invite = await page.request.post(`/api/teams/${teamId}/invites`, {
    data: { expiresIn: '7d', maxUses: null },
    headers: ORIGIN,
  });
  const { code } = (await invite.json()) as { code: string };
  const mate = await secondUser(browser);
  expect(
    (await mate.page.request.post(`/api/invites/${code}/accept`, { headers: ORIGIN })).status(),
  ).toBe(200);

  await page.goto(path);
  await mate.page.goto(path);
  await expect(page.getByTestId('chat-view')).toBeVisible();
  await expect(mate.page.getByTestId('chat-view')).toBeVisible();
  expect(path).toContain(`/t/${slug}/p/TYP/issues/`);

  // Mate types: I see it, and it goes away once they send.
  await mate.page.getByRole('textbox', { name: 'Message' }).click();
  await mate.page.keyboard.type('Morning all');
  await expect(page.getByTestId('chat-activity')).toContainText(`${mate.user.name} is typing…`);
  await mate.page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-message').filter({ hasText: 'Morning all' })).toBeVisible();
  await expect(page.getByTestId('chat-activity')).not.toContainText('is typing');
  // Their own screen never says they are typing.
  await expect(mate.page.getByTestId('chat-activity')).not.toContainText('is typing');
  await mate.page.context().close();
});
