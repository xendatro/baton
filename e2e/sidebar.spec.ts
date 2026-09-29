import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Organizing the sidebar: teams are moved, dragged and folded (BAT-36; no longer pinned), and
 * projects are pinned to a Pinned section at the top from their right-click menu; all of it still
 * there after a reload.
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

/** The team names in the sidebar, top first. */
async function teamNames(page: Page): Promise<string[]> {
  const names = sidebar(page)
    .getByRole('list', { name: 'Teams', exact: true })
    .locator('a[data-sidebar="menu-button"] > span:last-child');
  return names.allTextContents();
}

test('reorder and fold teams in the sidebar, kept after a reload', async ({ page }) => {
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
  await expect.poll(() => teamNames(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);

  // Teams can't be pinned any more: their menu only moves them.
  await page.getByRole('button', { name: 'Charlie options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Pin to top' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Move Bravo up from its menu.
  await page.getByRole('button', { name: 'Bravo options' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect.poll(() => teamNames(page)).toEqual(['Bravo', 'Alpha', 'Charlie']);

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
  await expect.poll(() => teamNames(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  // The drop didn't open the team.
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Fold Charlie from its right-click menu.
  await expect(sidebar(page).getByRole('link', { name: 'Rocket' })).toBeVisible();
  await teams.getByRole('link', { name: 'Charlie' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fold projects' }).click();
  await expect(sidebar(page).getByRole('link', { name: 'Rocket' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect.poll(() => teamNames(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await expect(page.getByRole('button', { name: 'Expand Charlie' })).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: 'Rocket' })).toHaveCount(0);
});

test('pin a project from its right-click menu: it tops the sidebar, after a reload too', async ({
  page,
}) => {
  await signedInUser(page);
  const alpha = await createTeam(page, 'Alpha');
  const zulu = await createTeam(page, 'Zulu');
  for (const [team, name, key] of [
    [alpha, 'Apples', 'APL'],
    [zulu, 'Zeppelin', 'ZEP'],
  ] as const) {
    const res = await page.request.post(`/api/teams/${team.id}/projects`, {
      data: { name, key },
      headers: ORIGIN,
    });
    expect(res.status()).toBe(201);
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const pinned = sidebar(page).getByRole('list', { name: 'Pinned projects' });
  await expect(pinned).toHaveCount(0);

  // Right-click Zeppelin (under Zulu, the last team) → Pin to top.
  await sidebar(page)
    .getByRole('list', { name: 'Zulu projects' })
    .getByRole('link', { name: 'Zeppelin' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin to top' }).click();
  await expect(pinned.getByRole('link')).toHaveCount(1);
  await expect(pinned.getByRole('link')).toContainText('Zeppelin');
  await expect(pinned.getByRole('link')).toContainText('Zulu');
  // The Pinned section sits above the teams.
  const pinnedBox = (await pinned.boundingBox())!;
  const teamsBox = (await sidebar(page)
    .getByRole('list', { name: 'Teams', exact: true })
    .boundingBox())!;
  expect(pinnedBox.y).toBeLessThan(teamsBox.y);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(pinned.getByRole('link')).toContainText('Zeppelin');
  // A normal click still opens the project.
  await pinned.getByRole('link').click();
  await expect(page).toHaveURL(/\/t\/zulu\/p\/ZEP$/);

  // Unpin from the project header.
  await page.getByRole('button', { name: 'Pin project', pressed: true }).click();
  await expect(pinned).toHaveCount(0);
});
