import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Organizing your teams in the sidebar (BAT-36): pin to top, move and drag within a group, fold a
 * team; all of it still there after a reload.
 */

test.use({ colorScheme: 'light' });

async function createTeam(page: Page, name: string): Promise<{ id: string; slug: string }> {
  const res = await page.request.post('/api/teams', { data: { name }, headers: ORIGIN });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

function sidebar(page: Page) {
  return page.getByRole('navigation', { name: 'Main' });
}

/** The team names of a sidebar group, top first. */
async function groupNames(page: Page, list: 'Pinned teams' | 'Teams'): Promise<string[]> {
  const names = sidebar(page)
    .getByRole('list', { name: list, exact: true })
    .locator('a[data-sidebar="menu-button"] > span:last-child');
  return names.allTextContents();
}

test('pin, reorder and fold teams in the sidebar, kept after a reload', async ({ page }) => {
  await signedInUser(page);
  await createTeam(page, 'Alpha');
  await createTeam(page, 'Bravo');
  const charlie = await createTeam(page, 'Charlie');
  const project = await page.request.post(`/api/teams/${charlie.id}/projects`, {
    data: { name: 'Rocket', key: 'RKT' },
    headers: ORIGIN,
  });
  expect(project.status()).toBe(201);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect.poll(() => groupNames(page, 'Teams')).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await expect(page.getByRole('list', { name: 'Pinned teams' })).toHaveCount(0);

  // Pin Charlie from its menu.
  await page.getByRole('button', { name: 'Charlie options' }).click();
  await page.getByRole('menuitem', { name: 'Pin to top' }).click();
  await expect.poll(() => groupNames(page, 'Pinned teams')).toEqual(['Charlie']);
  await expect.poll(() => groupNames(page, 'Teams')).toEqual(['Alpha', 'Bravo']);

  // Move Bravo up from its menu.
  await page.getByRole('button', { name: 'Bravo options' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect.poll(() => groupNames(page, 'Teams')).toEqual(['Bravo', 'Alpha']);

  // Drag Alpha back above Bravo.
  const teams = page.getByRole('list', { name: 'Teams', exact: true });
  const alpha = teams.getByRole('link', { name: 'Alpha' });
  const bravo = teams.getByRole('link', { name: 'Bravo' });
  const from = (await alpha.boundingBox())!;
  const to = (await bravo.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y - 5, { steps: 5 });
  await page.mouse.move(to.x + 20, to.y + 4, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => groupNames(page, 'Teams')).toEqual(['Alpha', 'Bravo']);
  // The drop didn't open the team.
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Fold Charlie.
  await expect(sidebar(page).getByRole('link', { name: 'Rocket' })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse Charlie' }).click();
  await expect(sidebar(page).getByRole('link', { name: 'Rocket' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect.poll(() => groupNames(page, 'Pinned teams')).toEqual(['Charlie']);
  await expect.poll(() => groupNames(page, 'Teams')).toEqual(['Alpha', 'Bravo']);
  await expect(page.getByRole('button', { name: 'Expand Charlie' })).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: 'Rocket' })).toHaveCount(0);

  // Unpin: back among the others, in its place in your order (it was first).
  await page.getByRole('button', { name: 'Charlie options' }).click();
  await page.getByRole('menuitem', { name: 'Unpin' }).click();
  await expect(page.getByRole('list', { name: 'Pinned teams' })).toHaveCount(0);
  await expect.poll(() => groupNames(page, 'Teams')).toEqual(['Charlie', 'Alpha', 'Bravo']);
});
