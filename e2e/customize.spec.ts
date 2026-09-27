import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * The Tasks page's ways into the statuses and labels settings (the toolbar's Customize menu and
 * a column's "…" menu) and the "← Board" link back.
 */

interface Project {
  id: string;
  key: string;
  path: string;
  statuses: Array<{ id: string; name: string }>;
}

async function setup(page: Page): Promise<Project> {
  await signedInUser(page);
  const slug = `custom-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Customize ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const res = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Rocket', key: 'RKT' },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  const project = (await res.json()) as Project;
  const task = await page.request.post(`/api/projects/${project.id}/tasks`, {
    data: { title: 'Build the engine' },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);
  return project;
}

test('Customize → Edit stages opens the pipeline settings, and ← Board comes back', async ({
  page,
}) => {
  const project = await setup(page);
  await page.goto(`${project.path}/tasks`);
  await expect(page.getByRole('link', { name: /Build the engine/ })).toBeVisible();

  await page.getByRole('button', { name: 'Customize board' }).click();
  await page.getByRole('menuitem', { name: 'Edit stages' }).click();
  // The stages of the board's pipeline.
  await expect(page).toHaveURL(new RegExp(`${project.path}/settings/pipelines\\?pipeline=\\w+$`));
  await expect(page.getByRole('heading', { name: 'Pipelines', level: 2 })).toBeVisible();

  await page.getByRole('link', { name: 'Back to Board' }).click();
  await expect(page).toHaveURL(new RegExp(`${project.path}/tasks\\?pipeline=\\w+$`));
  await expect(page.getByRole('region', { name: 'Board' })).toBeVisible();

  // A column's "…" menu goes to that status, highlighted and ready to rename.
  const done = project.statuses.find((status) => status.name === 'Done');
  expect(done).toBeDefined();
  await page.getByRole('button', { name: 'Done column actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit stage' }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/pipelines\\?status=${done!.id}$`));
  const row = page.locator('[data-testid="status-row"][data-targeted="true"]');
  await expect(row.getByRole('textbox')).toHaveValue('Done');
  await expect(row.getByRole('textbox')).toBeFocused();

  // Labels: the toolbar menu too.
  await page.goBack();
  await page.getByRole('button', { name: 'Customize board' }).click();
  await page.getByRole('menuitem', { name: 'Edit labels' }).click();
  await expect(page).toHaveURL(new RegExp(`${project.path}/settings/labels$`));
  await expect(page.getByRole('link', { name: 'Back to Board' })).toBeVisible();
});

test('the Customize menu fits the toolbar at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const project = await setup(page);
  await page.goto(`${project.path}/tasks`);
  const button = page.getByRole('button', { name: 'Customize board' });
  await expect(button).toBeVisible();
  await expect(button).toBeInViewport({ ratio: 1 });
  const overflow = await page.evaluate(() => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  await button.click();
  await expect(page.getByRole('menuitem', { name: 'Edit stages' })).toBeInViewport();
});
