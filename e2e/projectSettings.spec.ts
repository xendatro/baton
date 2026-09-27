import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Your settings for this project (BAT-29): opened from the project header, a model override for
 * one difficulty level (the others show where theirs come from), this project's notifications,
 * and Settings → Automatic agents listing the project among those with their own models.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface MySettings {
  notifications: { level: string } | null;
  models: { levels: Record<string, Array<{ harness: string; model: string; effort: string }>> };
}

test('your settings for a project: a model override and notifications', async ({ page }) => {
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

  // Models: every level uses my defaults until I override one.
  const levels = page.getByRole('list', { name: 'Models by difficulty level' });
  const hard = levels.getByRole('listitem').filter({ hasText: 'Hard' });
  await expect(hard.getByText('From your defaults: Claude Code opus')).toBeVisible();
  await hard.getByRole('switch', { name: 'Hard: use my defaults' }).click();
  const chain = page.getByRole('group', { name: 'Hard chain' });
  await chain.getByRole('combobox', { name: 'Hard chain: harness 1' }).selectOption('codex');
  await chain.getByLabel('Hard chain: model 1').fill('');
  await chain.getByLabel('Hard chain: effort 1').fill('high');
  const normal = levels.getByRole('listitem').filter({ hasText: 'Normal' });
  await expect(normal.getByText('From Hard, the closest level you mapped: Codex')).toBeVisible();
  await page.getByRole('button', { name: 'Save models' }).click();
  await expect(page.getByText('Saved your models for this project')).toBeVisible();
  expect(Object.values((await mySettings()).models.levels)).toEqual([
    [{ harness: 'codex', model: '', effort: 'high' }],
  ]);

  // Notifications: mentions and assignments only, for this project.
  await page.getByRole('switch', { name: 'Use my defaults', exact: true }).click();
  await page.getByRole('radio', { name: 'Mentions & assignments only' }).click();
  await page.getByRole('button', { name: 'Save notifications' }).click();
  await expect(page.getByText('Saved your notifications for this project')).toBeVisible();
  expect((await mySettings()).notifications?.level).toBe('mentions');

  // Automatic agents lists the project among those with their own models.
  await page.goto('/settings/automatic-agents');
  const own = page.getByRole('list', { name: 'Projects with their own models' });
  await own.getByRole('link', { name: /Personal/ }).click();
  await expect(page.getByRole('heading', { name: 'Your settings for this project' })).toBeVisible();
});
