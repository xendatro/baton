import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Right-click menus: a board card moves to its next stage from its menu (strict moves apply), and
 * a normal click still opens the task.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

function column(page: Page, name: string) {
  return page.getByRole('region', { name: 'Board' }).getByRole('region', { name, exact: true });
}

test('right-click a task card → Move to its next stage', async ({ page }) => {
  await signedInUser(page);
  const slug = `menu-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `M ${slug}`, slug });
  const project = await post<{ id: string; path: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Menus',
    key: 'MNU',
  });
  // The default pipeline: Backlog (new tasks start here), To do, In progress, In review, Done.
  const task = await post<{ ref: string; path: string }>(
    page,
    `/api/projects/${project.id}/tasks`,
    { title: 'Menu task' },
  );
  await page.goto(`/t/${slug}/p/MNU/tasks`);
  const card = column(page, 'Backlog').getByRole('link', { name: /Menu task/ });
  await expect(card).toBeVisible();

  await card.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `${task.ref} actions` });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Move to' }).click();
  await page.getByRole('menuitem', { name: /To do/ }).click();

  await expect(column(page, 'To do').getByRole('link', { name: /Menu task/ })).toBeVisible();
  await expect(column(page, 'Backlog').getByRole('link', { name: /Menu task/ })).toHaveCount(0);
  // Saved on the server, not just on the board.
  await page.reload();
  await expect(column(page, 'To do').getByRole('link', { name: /Menu task/ })).toBeVisible();

  // A normal click still opens the task.
  await column(page, 'To do')
    .getByRole('link', { name: /Menu task/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`${task.path}$`));
});
