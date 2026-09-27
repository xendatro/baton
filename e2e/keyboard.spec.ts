import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Keyboard flows across modules (SPEC §1.9, §6): `/` on a freshly loaded page, focus returning
 * to where a dialog was opened from, Esc on a task page, and the palette's type-then-Enter jump
 * to search hits and refs.
 */

interface Project {
  id: string;
  key: string;
  path: string;
}

async function setup(page: Page): Promise<Project> {
  await signedInUser(page);
  const slug = `keys-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Keys ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const res = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Rocket', key: 'RKT' },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Project;
}

async function post(page: Page, path: string, data: Record<string, unknown>) {
  const res = await page.request.post(path, { data, headers: ORIGIN });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { number: number; path: string };
}

/** The palette opens lazily with the shell; wait until the shell's `/` binding is registered. */
async function shellReady(page: Page) {
  await expect(page.getByRole('button', { name: 'New team' })).toBeVisible();
}

test('`/` focuses the page’s search on a fresh load, not the palette (UX-05)', async ({ page }) => {
  const project = await setup(page);
  await post(page, `/api/projects/${project.id}/issues`, { title: 'Printer on fire' });
  await post(page, `/api/projects/${project.id}/tasks`, { title: 'Refill paper' });
  const palette = page.getByRole('dialog', { name: 'Command palette' });

  for (const [path, label] of [
    [`${project.path}/issues`, 'Search issues'],
    ['/my-tasks', 'Search my tasks'],
    [`${project.path}/tasks`, 'Filter tasks by text'],
  ] as const) {
    await page.goto(path);
    const search = page.getByLabel(label, { exact: true });
    await expect(search).toBeVisible();
    await shellReady(page);
    await page.locator('#main').focus();
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    await expect(palette).toBeHidden();
  }

  // Elsewhere `/` still opens the palette.
  await page.goto('/inbox');
  await shellReady(page);
  await page.keyboard.press('/');
  await expect(palette).toBeVisible();
});

test('closing a dialog returns focus to what opened it (UX-02)', async ({ page }) => {
  const project = await setup(page);
  await page.goto(`${project.path}/tasks`);
  await shellReady(page);

  // "New task", plus its `C` key cap on wide screens.
  const newTask = page.getByRole('button', { name: /^New task( C)?$/ });
  await newTask.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(newTask).toBeFocused();

  // The command palette, from the sidebar's Search button.
  const searchButton = page.getByRole('button', { name: /^Search/ }).first();
  await searchButton.focus();
  await page.keyboard.press('Enter');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(searchButton).toBeFocused();
});

test('Esc on a task page goes back to the board with its filters (UX-16)', async ({ page }) => {
  const project = await setup(page);
  const task = await post(page, `/api/projects/${project.id}/tasks`, {
    title: 'Urgent thing',
    priority: 4,
  });
  await page.goto(`${project.path}/tasks?priority=4`);
  await page.getByRole('link', { name: /Urgent thing/ }).click();
  await expect(page).toHaveURL(new RegExp(`${task.path}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Urgent thing' })).toBeVisible();

  // Esc first closes an open picker, and only then the task.
  await page.keyboard.press('s');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`${task.path}$`));

  await page.locator('#main').focus();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`${project.path}/tasks\\?priority=4&pipeline=\\w+$`));
  await expect(page.getByRole('link', { name: /Urgent thing/ })).toBeVisible();
});

test('the palette opens a search hit or a ref with type-then-Enter (UX-01, UX-04)', async ({
  page,
}) => {
  const project = await setup(page);
  await post(page, `/api/projects/${project.id}/tasks`, { title: 'Split the main bundle' });
  await post(page, `/api/projects/${project.id}/tasks`, { title: 'Board columns overflow' });
  const issue = await post(page, `/api/projects/${project.id}/issues`, {
    title: 'Crash report',
    body: 'Seen after RKT-2 shipped.',
  });
  await page.goto('/');
  await shellReady(page);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const input = palette.getByPlaceholder('Search or jump to…');

  // "board" also matches the Dashboard command; the search hit shown first is what Enter opens.
  await page.keyboard.press('Control+k');
  await input.fill('board');
  await expect(palette.getByRole('option', { name: /Board columns overflow/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${project.path}/tasks/2$`));

  // No command matches at all: the only result is selected.
  await page.keyboard.press('Control+k');
  await input.fill('split the main');
  await expect(palette.getByRole('option', { name: /Split the main bundle/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${project.path}/tasks/1$`));

  // Refs: the issue itself, not the task its body mentions.
  await page.keyboard.press('Control+k');
  await input.fill(`RKT#${issue.number}`);
  await expect(palette.getByRole('option', { name: /Crash report/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${issue.path}$`));

  await page.keyboard.press('Control+k');
  await input.fill('RKT-2');
  await expect(palette.getByRole('option', { name: /Board columns overflow/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${project.path}/tasks/2$`));
});
