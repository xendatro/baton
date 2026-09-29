import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Threaded replies (BAT-13): answering a reply nests the answer under it, the thread line
 * collapses it (kept across a reload), and a `#reply-` link opens its collapsed ancestors.
 */

async function setupTask(page: Page) {
  await signedInUser(page);
  const slug = `threads-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Threads ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const project = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Forum', key: 'FRM' },
    headers: ORIGIN,
  });
  expect(project.status(), await project.text()).toBe(201);
  const { id: projectId } = (await project.json()) as { id: string };
  const task = await page.request.post(`/api/projects/${projectId}/tasks`, {
    // Threads are the forum view (new tasks are chats unless asked).
    data: { title: 'Pick a database', conversationMode: 'forum' },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);
  return (await task.json()) as { id: string; path: string };
}

test('answer a reply in its thread, then collapse and reopen the thread', async ({ page }) => {
  const task = await setupTask(page);
  const top = await page.request.post('/api/replies', {
    data: { parentType: 'task', parentId: task.id, body: 'SQLite or Postgres?' },
    headers: ORIGIN,
  });
  expect(top.status(), await top.text()).toBe(201);
  const { author } = (await top.json()) as { author: { name: string } };

  await page.goto(task.path);
  const question = page.getByRole('article', { name: `Reply by ${author.name}` });
  await expect(question).toContainText('SQLite or Postgres?');

  // Answer the reply from its own Reply button.
  await question.getByRole('button', { name: `Reply to ${author.name}` }).click();
  const answerBox = page.getByRole('textbox', { name: `Reply to reply by ${author.name}` });
  await expect(answerBox).toBeFocused();
  await page.keyboard.type('SQLite: one file, no server.');
  await page.keyboard.press('Control+Enter');
  const answers = page.getByRole('list', { name: `Answers to reply by ${author.name}` });
  await expect(answers.getByRole('article')).toContainText('SQLite: one file, no server.');
  await expect(answerBox).toHaveCount(0);
  await page
    .getByRole('list', { name: 'Conversation' })
    .screenshot({ path: 'test-results/bat-13-thread.png' });

  // The answer is stored as an answer to the question.
  const tree = await page.request.get(`/api/replies?parentType=task&parentId=${task.id}`);
  const { items } = (await tree.json()) as {
    items: Array<{ id: string; parentReplyId: string | null; depth: number }>;
  };
  expect(items.map((item) => item.depth)).toEqual([0, 1]);
  const answerId = items[1]!.id;
  expect(items[1]!.parentReplyId).toBe(items[0]!.id);

  // Collapse with the thread line; the question and its answer fold into one line.
  const collapse = page.getByRole('button', { name: `Collapse thread: reply by ${author.name}` });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect(page.getByText('SQLite: one file, no server.')).toHaveCount(0);
  const collapsed = page.getByRole('button', { name: new RegExp(`Expand thread: ${author.name}`) });
  await expect(collapsed).toHaveAttribute('aria-expanded', 'false');
  await expect(collapsed).toContainText('1 reply hidden');

  // Still collapsed after a reload; a link to the answer opens it again.
  await page.reload();
  await expect(collapsed).toBeVisible();
  await page.goto(`${task.path}#reply-${answerId}`);
  await expect(page.locator(`#reply-${answerId}`)).toContainText('SQLite: one file, no server.');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');

  // Collapse and expand from the keyboard; the focus stays on the toggle.
  await collapse.focus();
  await page.keyboard.press('Enter');
  await expect(collapsed).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('SQLite: one file, no server.')).toBeVisible();
  await expect(collapse).toBeFocused();
});

test('a deleted reply with answers stays as [deleted]', async ({ page }) => {
  const task = await setupTask(page);
  const post = async (body: string, parentReplyId?: string) => {
    const res = await page.request.post('/api/replies', {
      data: { parentType: 'task', parentId: task.id, body, parentReplyId },
      headers: ORIGIN,
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const question = await post('A question that gets deleted');
  await post('An answer that stays', question.id);
  const removed = await page.request.delete(`/api/replies/${question.id}`, { headers: ORIGIN });
  expect(removed.status(), await removed.text()).toBe(200);

  await page.goto(task.path);
  await expect(page.getByRole('article', { name: 'Deleted reply' })).toContainText('[deleted]');
  await expect(page.getByText('An answer that stays')).toBeVisible();
  await expect(page.getByText('A question that gets deleted')).toHaveCount(0);
});
