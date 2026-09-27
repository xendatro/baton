import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Difficulty levels (BAT-24): a new project's Easy / Normal / Hard, a level added in Project
 * settings → Difficulty, picked in the New task dialog, shown on the card and changed on the task
 * page.
 */

async function api<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test('difficulty levels: manage them, pick one for a task, see it on the board', async ({
  page,
}) => {
  await signedInUser(page);
  const slug = `diff-${randomBytes(4).toString('hex')}`;
  const team = await api<{ id: string }>(page, '/api/teams', { name: `Diff ${slug}`, slug });
  await api(page, `/api/teams/${team.id}/projects`, { name: 'Levels', key: 'LVL' });
  const base = `/t/${slug}/p/LVL`;

  await page.goto(`${base}/settings/difficulty`);
  const levels = page.getByRole('list', { name: 'Difficulty levels, easiest first' });
  await expect(levels.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByLabel('Name of level Easy')).toHaveValue('Easy');
  await page.getByRole('button', { name: 'New level' }).click();
  const dialog = page.getByRole('dialog', { name: 'New difficulty level' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Expert');
  await dialog.getByRole('button', { name: 'Add level' }).click();
  await expect(levels.getByRole('listitem')).toHaveCount(4);
  await page.getByRole('button', { name: 'Move Expert easier' }).click();
  await expect(levels.getByRole('listitem').nth(2).getByRole('textbox')).toHaveValue('Expert');

  await page.goto(`${base}/tasks`);
  await page.getByRole('button', { name: 'Create a task' }).click();
  const create = page.getByRole('dialog', { name: 'New task' });
  await create.getByPlaceholder('Task title').fill('Rewrite the parser');
  await create.getByRole('button', { name: 'Difficulty: none' }).click();
  await page.getByRole('option', { name: 'Hard' }).click();
  await create.getByRole('button', { name: 'Create task' }).click();
  const card = page.getByRole('link', { name: /Rewrite the parser/ });
  await expect(card.getByTitle('Difficulty: Hard')).toBeVisible();

  await card.click();
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: 'Difficulty: Hard' }).click();
  await page.getByRole('option', { name: 'Expert' }).click();
  await expect(details.getByRole('button', { name: 'Difficulty: Expert' })).toBeVisible();
});
