import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * What the production build sends to browsers: the rich text editor and the date picker load only
 * where they are used (PERF-04), and source maps are not published (SEC-01).
 */

/**
 * Markers of the code that must load lazily: ProseMirror's editor (Tiptap) and react-day-picker's
 * class names (the date picker's calendar). Chunk names alone are ambiguous (lucide's calendar
 * icon has a chunk of the same name), so the scripts' contents are checked.
 */
const MARKERS = { editor: 'ProseMirror', calendar: 'rdp-' } as const;

/** Which markers the scripts the page has loaded so far contain. */
async function loadedCode(page: Page): Promise<{ editor: boolean; calendar: boolean }> {
  const scripts = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.js')),
  );
  const found = { editor: false, calendar: false };
  for (const script of scripts) {
    const source = await (await page.request.get(script)).text();
    if (source.includes(MARKERS.editor)) found.editor = true;
    if (source.includes(MARKERS.calendar)) found.calendar = true;
  }
  return found;
}

test('the dashboard loads no editor or calendar code until the New task dialog opens', async ({
  page,
}) => {
  await signedInUser(page);
  const slug = `bundles-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Bundles ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const project = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Rocket', key: 'RKT' },
    headers: ORIGIN,
  });
  expect(project.status(), await project.text()).toBe(201);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // The shell extensions (the New task dialog among them) are mounted.
  await expect(page.getByRole('button', { name: 'New team' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await loadedCode(page)).toEqual({ editor: false, calendar: false });

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('Search or jump to…').fill('New task');
  await palette
    .getByRole('option', { name: /New task/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByPlaceholder('Task title')).toBeFocused();
  await expect(dialog.getByRole('textbox', { name: 'Description' })).toBeVisible();
  expect(await loadedCode(page)).toEqual({ editor: true, calendar: true });
});

test('publishes no source maps', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="(\/assets\/[^"]+\.js)"/g)].map(
    (match) => match[1] ?? '',
  );
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    const source = await (await request.get(script)).text();
    expect(source, script).not.toContain('sourceMappingURL');
    const map = await request.get(`${script}.map`);
    expect(map.status(), `${script}.map`).toBe(404);
  }
});
