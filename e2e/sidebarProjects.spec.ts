import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * BAT#27: arrange a team's projects in the sidebar (they only move within their team): from the
 * project's menu with the keyboard, and by dragging. Your order survives a reload; a new project
 * goes to the end.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.status(), `${url}: ${await res.text()}`).toBe(201);
  return (await res.json()) as T;
}

/** The project names of a team in the sidebar, top first. */
function projectNames(page: Page, team: string): Promise<string[]> {
  return page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('list', { name: `${team} projects` })
    .locator('a[data-sidebar="menu-sub-button"] > span:last-child')
    .allTextContents();
}

test('reorder a team’s projects in the sidebar, kept after a reload', async ({ page }) => {
  await signedInUser(page);
  const team = await post<{ id: string; name: string }>(page, '/api/teams', { name: 'Orchard' });
  for (const [name, key] of [
    ['Apples', 'APL'],
    ['Bananas', 'BAN'],
    ['Cherries', 'CHR'],
  ]) {
    await post(page, `/api/teams/${team.id}/projects`, { name, key });
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect.poll(() => projectNames(page, 'Orchard')).toEqual(['Apples', 'Bananas', 'Cherries']);

  // With the keyboard: Cherries' menu → Move up.
  const options = page.getByRole('button', { name: 'Cherries options' });
  await options.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect.poll(() => projectNames(page, 'Orchard')).toEqual(['Apples', 'Cherries', 'Bananas']);

  // Drag Bananas to the top.
  const projects = page.getByRole('list', { name: 'Orchard projects' });
  const bananas = projects.getByRole('link', { name: 'Bananas' });
  const apples = projects.getByRole('link', { name: 'Apples' });
  const from = (await bananas.boundingBox())!;
  const to = (await apples.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y - 5, { steps: 5 });
  await page.mouse.move(to.x + 20, to.y + 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => projectNames(page, 'Orchard')).toEqual(['Bananas', 'Apples', 'Cherries']);
  // The drop didn't open the project.
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.reload();
  await expect.poll(() => projectNames(page, 'Orchard')).toEqual(['Bananas', 'Apples', 'Cherries']);

  // A new project goes to the end, even though it sorts earlier by name.
  await post(page, `/api/teams/${team.id}/projects`, { name: 'Apricots', key: 'APR' });
  await page.reload();
  await expect
    .poll(() => projectNames(page, 'Orchard'))
    .toEqual(['Bananas', 'Apples', 'Cherries', 'Apricots']);
});
