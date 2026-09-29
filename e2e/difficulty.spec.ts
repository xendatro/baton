import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Difficulty levels (BAT-24): a new project's Easy / Normal / Hard (shown hardest first, BAT-30),
 * a level added in Project settings → Difficulty and moved with the keyboard on its grip, picked in
 * the New task dialog (hardest first), shown on the card and changed on the task page.
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
  const levels = page.getByRole('list', { name: 'Difficulty levels, hardest first' });
  const names = levels.getByRole('textbox');
  await expect(names).toHaveCount(3);
  await expect(names.nth(0)).toHaveValue('Hard');
  await expect(names.nth(2)).toHaveValue('Easy');
  await expect(page.getByText('Hardest', { exact: true })).toBeVisible();
  await expect(page.getByText('Easiest', { exact: true })).toBeVisible();

  // A new level goes to the easiest end (the bottom) by default.
  await page.getByRole('button', { name: 'New level' }).click();
  const dialog = page.getByRole('dialog', { name: 'New difficulty level' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Expert');
  await expect(dialog.getByRole('radio', { name: 'Easiest' })).toBeChecked();
  const moved = page.waitForResponse(
    (res) => res.url().endsWith('/difficulties/order') && res.request().method() === 'PUT',
  );
  await dialog.getByRole('button', { name: 'Add level' }).click();
  await moved;
  await expect(dialog).toBeHidden();
  await expect(names).toHaveCount(4);
  await expect(names.nth(3)).toHaveValue('Expert');

  // Reorder with the keyboard on the grip handle: pick up, up twice (harder), drop.
  const grip = page.getByRole('button', { name: 'Reorder Expert' });
  // The sidebar's lists have live regions of their own (BAT#27).
  const announcer = page.locator('[id^="DndLiveRegion"]', { hasText: 'Expert' });
  await grip.focus();
  await expect(grip).toBeFocused();
  await page.keyboard.press('Space');
  await expect(announcer).toHaveText('Expert is in its original place.');
  await page.keyboard.press('ArrowUp');
  await expect(announcer).toHaveText('Expert is at Easy’s place.');
  await page.keyboard.press('ArrowUp');
  await expect(announcer).toHaveText('Expert is at Normal’s place.');
  await page.keyboard.press('Space');
  await expect(names.nth(1)).toHaveValue('Expert');
  await page.reload();
  await expect(names.nth(0)).toHaveValue('Hard');
  await expect(names.nth(1)).toHaveValue('Expert');
  await expect(names.nth(3)).toHaveValue('Easy');

  await page.goto(`${base}/tasks`);
  await page.getByRole('button', { name: 'Create a task' }).click();
  const create = page.getByRole('dialog', { name: 'New task' });
  await create.getByPlaceholder('Task title').fill('Rewrite the parser');
  await create.getByRole('button', { name: 'Difficulty: none' }).click();
  await expect(page.getByRole('option')).toHaveText([
    'Hard',
    'Expert',
    'Normal',
    'Easy',
    /No difficulty/,
  ]);
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
