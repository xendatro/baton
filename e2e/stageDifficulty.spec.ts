import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Difficulty per stage (BAT-28): the ▾ beside the green button moves on with a difficulty for the
 * next stage (prefilled with its default), and the Send back… dialog sets the difficulty for the
 * stage it goes back to (prefilled with its last value there).
 */

async function api<T>(
  page: Page,
  method: 'get' | 'post' | 'put' | 'patch',
  url: string,
  data?: unknown,
): Promise<T> {
  const res =
    method === 'get'
      ? await page.request.get(url)
      : await page.request[method](url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test('moves with a difficulty for the next stage and sends back with one', async ({ page }) => {
  await signedInUser(page);
  const slug = `diff-${randomBytes(4).toString('hex')}`;
  const team = await api<{ id: string }>(page, 'post', '/api/teams', { name: `D ${slug}`, slug });
  const project = await api<{ id: string; statuses: Array<{ id: string; name: string }> }>(
    page,
    'post',
    `/api/teams/${team.id}/projects`,
    { name: 'Difficulty', key: 'DIF' },
  );
  const levels = (
    await api<{ items: Array<{ id: string; name: string }> }>(
      page,
      'get',
      `/api/projects/${project.id}/difficulties`,
    )
  ).items;
  const normal = levels.find((level) => level.name === 'Normal')?.id;
  const build = await api<{ id: string }>(page, 'post', `/api/projects/${project.id}/statuses`, {
    name: 'Build',
    defaultDifficultyId: normal,
  });
  const review = await api<{ id: string }>(page, 'post', `/api/projects/${project.id}/statuses`, {
    name: 'Review',
  });
  const [open, done] = project.statuses;
  await api(page, 'put', `/api/projects/${project.id}/statuses/order`, {
    statusIds: [open?.id, build.id, review.id, done?.id],
  });
  await api(page, 'patch', `/api/statuses/${review.id}`, { rules: { sendBackTo: [build.id] } });
  const task = await api<{ path: string }>(page, 'post', `/api/projects/${project.id}/tasks`, {
    title: 'Hard problem',
  });

  await page.goto(task.path);
  const stage = page.getByTestId('stage-panel');
  const details = page.getByRole('complementary', { name: 'Task details' });
  await expect(details.getByRole('button', { name: 'Difficulty: none' })).toBeVisible();

  // ▾: prefilled with Build's default, moved on at Hard instead.
  await stage.getByRole('button', { name: 'Move with difficulty…' }).click();
  const popover = page.getByTestId('move-with-difficulty');
  const select = popover.getByRole('combobox', { name: 'Difficulty for Build' });
  await expect(select).toHaveValue(normal ?? '');
  await select.selectOption({ label: 'Hard' });
  await popover.getByRole('button', { name: 'Move to Build' }).click();
  await expect(details.getByRole('button', { name: 'Status: Build' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Difficulty: Hard' })).toBeVisible();

  // Review has no default: it keeps Hard.
  await stage.getByRole('button', { name: 'Move to Review' }).click();
  await expect(details.getByRole('button', { name: 'Status: Review' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Difficulty: Hard' })).toBeVisible();

  // Send back: prefilled with Build's last difficulty; sent back at Easy.
  await stage.getByRole('button', { name: 'Send back…' }).click();
  const dialog = page.getByTestId('send-back-dialog');
  const difficulty = dialog.getByRole('combobox', { name: 'Difficulty for Build' });
  await expect(difficulty).toHaveValue(levels.find((level) => level.name === 'Hard')?.id ?? '');
  await difficulty.selectOption({ label: 'Easy' });
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Simpler than it looked');
  await dialog.getByRole('button', { name: 'Send back to Build' }).click();
  await expect(details.getByRole('button', { name: 'Status: Build' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Difficulty: Easy' })).toBeVisible();
});
