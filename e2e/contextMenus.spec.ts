import { randomBytes, randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
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

test('right-click a task card → Labels → check one: the chip appears', async ({ page }) => {
  await signedInUser(page);
  const slug = `lbl-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `L ${slug}`, slug });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Labels',
    key: 'LBL',
  });
  await post(page, `/api/projects/${project.id}/labels`, { name: 'frontend', color: '#6366f1' });
  const task = await post<{ ref: string; id: string }>(page, `/api/projects/${project.id}/tasks`, {
    title: 'Label me',
  });
  await page.goto(`/t/${slug}/p/LBL/tasks`);
  const card = column(page, 'Backlog').getByRole('link', { name: /Label me/ });
  await expect(card).toBeVisible();
  await expect(card.getByText('frontend')).toHaveCount(0);

  await card.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `${task.ref} actions` });
  await menu.getByRole('menuitem', { name: 'Labels' }).click();
  const item = page.getByRole('menuitemcheckbox', { name: 'frontend' });
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(card.getByText('frontend')).toBeVisible();

  // Saved on the server.
  const saved = (await (await page.request.get(`/api/tasks/${task.id}`)).json()) as {
    labels: Array<{ name: string }>;
  };
  expect(saved.labels.map((label) => label.name)).toEqual(['frontend']);
  await page.reload();
  await expect(column(page, 'Backlog').getByRole('link', { name: /Label me/ })).toContainText(
    'frontend',
  );
});

/** BAT#33: the "⋯" button in a card's top-right corner. */
async function menuBoard(page: Page, prefix: string, key: string, title: string) {
  const slug = `${prefix}-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `D ${slug}`, slug });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Dots',
    key,
  });
  const task = await post<{ id: string; ref: string }>(page, `/api/projects/${project.id}/tasks`, {
    title,
  });
  return { slug, team, project, task };
}

test('⋯ on a task card → Rename: the title changes on the board', async ({ page }) => {
  await signedInUser(page);
  const { slug, task } = await menuBoard(page, 'ren', 'REN', 'Old name');
  await page.goto(`/t/${slug}/p/REN/tasks`);
  const card = column(page, 'Backlog').getByRole('link', { name: /Old name/ });
  await expect(card).toBeVisible();

  await card.hover();
  await page.getByRole('button', { name: `Actions for ${task.ref}` }).click();
  // The button opens the menu, not the task.
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/p/REN/tasks(\\?|$)`));
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const dialog = page.getByRole('dialog', { name: `Rename ${task.ref}` });
  await dialog.getByRole('textbox', { name: 'Title' }).fill('New name');
  await dialog.getByRole('button', { name: 'Rename' }).click();
  await expect(dialog).toBeHidden();

  await expect(column(page, 'Backlog').getByRole('link', { name: /New name/ })).toBeVisible();
  const saved = (await (await page.request.get(`/api/tasks/${task.id}`)).json()) as {
    title: string;
  };
  expect(saved.title).toBe('New name');
  await page.reload();
  await expect(column(page, 'Backlog').getByRole('link', { name: /New name/ })).toBeVisible();
});

test('⋯ on a task card → Assign → a teammate is added', async ({ page, browser }) => {
  await signedInUser(page);
  const { slug, team, task } = await menuBoard(page, 'asg', 'ASG', 'Needs a hand');
  const invite = await post<{ code: string }>(page, `/api/teams/${team.id}/invites`, {
    expiresIn: '7d',
    maxUses: null,
  });
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const matePage = await context.newPage();
  const mate = await signedInUser(matePage);
  const accepted = await matePage.request.post(`/api/invites/${invite.code}/accept`, {
    headers: ORIGIN,
  });
  expect(accepted.status()).toBe(200);
  await context.close();

  await page.goto(`/t/${slug}/p/ASG/tasks`);
  const card = column(page, 'Backlog').getByRole('link', { name: /Needs a hand/ });
  await expect(card).toBeVisible();
  await card.hover();
  await page.getByRole('button', { name: `Actions for ${task.ref}` }).click();
  await page.getByRole('menuitem', { name: 'Assign', exact: true }).click();
  // Their agent is listed too ("<name> AI").
  const item = page.getByRole('menuitemcheckbox', { name: mate.name, exact: true });
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(card).toContainText(`Assigned to ${mate.name}`);

  const saved = (await (await page.request.get(`/api/tasks/${task.id}`)).json()) as {
    assignees: { users: Array<{ name: string }> };
  };
  expect(saved.assignees.users.map((user) => user.name)).toEqual([mate.name]);
});
