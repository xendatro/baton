import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Your settings for this project (BAT-29): opened from the project header, this project's own
 * default model (over the account default; difficulty is gone), this project's notifications,
 * and Settings → Automatic agents listing the project among those with their own default.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface MySettings {
  notifications: { level: string } | null;
  models: { chain: Array<{ harness: string; model: string; effort: string }> };
}

test('your settings for a project: its own default model and notifications', async ({ page }) => {
  await signedInUser(page);
  const slug = `mine-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `Mine ${slug}`, slug });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Personal',
    key: 'PER',
  });
  const mySettings = async () =>
    (await (
      await page.request.get(`/api/projects/${project.id}/my-settings`)
    ).json()) as MySettings;

  await page.goto(`/t/${slug}/p/PER`);
  await page.getByRole('link', { name: 'Your settings for this project' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/p/PER/me$`));
  await expect(page.getByRole('heading', { name: 'Your settings for this project' })).toBeVisible();

  // Model: the account default until the project gets its own.
  const card = page.getByTestId('project-default-model');
  await expect(card.getByText(/Claude Code opus/)).toBeVisible();
  await expect(page.getByText(/difficulty/i)).toHaveCount(0);
  await card.getByRole('switch', { name: 'Use my account default' }).click();
  const chain = page.getByRole('group', { name: 'Default model for this project' });
  await chain
    .getByRole('combobox', { name: 'Default model for this project: harness 1' })
    .selectOption('codex');
  // No desktop app reports anything here: its default model, and a generic effort.
  await chain.getByLabel('Default model for this project: model 1').selectOption('');
  await chain.getByLabel('Default model for this project: effort 1').selectOption('high');
  await page.getByRole('button', { name: 'Save model' }).click();
  await expect(page.getByText('Saved your default model for this project')).toBeVisible();
  expect((await mySettings()).models.chain).toEqual([
    { harness: 'codex', model: '', effort: 'high' },
  ]);

  // Notifications: mentions and assignments only, for this project.
  await page.getByRole('switch', { name: 'Use my defaults', exact: true }).click();
  await page.getByRole('radio', { name: 'Mentions & assignments only' }).click();
  await page.getByRole('button', { name: 'Save notifications' }).click();
  await expect(page.getByText('Saved your notifications for this project')).toBeVisible();
  expect((await mySettings()).notifications?.level).toBe('mentions');

  // Automatic agents lists the project among those with their own default.
  await page.goto('/settings/automatic-agents');
  const own = page.getByRole('list', { name: 'Projects with their own default' });
  await expect(own.getByRole('listitem').filter({ hasText: 'Personal' })).toContainText('Codex');
  await own.getByRole('link', { name: /Personal/ }).click();
  await expect(page.getByRole('heading', { name: 'Your settings for this project' })).toBeVisible();
});
