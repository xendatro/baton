import type { Page } from '@playwright/test';
import { liveEventSchema, type LiveEvent } from '../shared/events.ts';
import { expect, signedInUser, test } from './support/fixtures.ts';

test.use({ colorScheme: 'light' });

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  await signedInUser(page);
});

// The signed-in shell talks to every core endpoint it needs without a failed request or CSP error.
test.afterEach(() => {
  expect(problems).toEqual([]);
});

async function openShell(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function chooseTheme(page: Page, label: string) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /Theme/ }).hover();
  await page.getByRole('menuitemradio', { name: label }).click();
}

test('the theme choice applies at once and survives a reload', async ({ page }) => {
  await openShell(page);
  const html = page.locator('html');
  await expect(html).not.toHaveClass(/dark/);

  await chooseTheme(page, 'Dark');
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(html).toHaveClass(/dark/);

  await chooseTheme(page, 'Light');
  await expect(html).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(html).not.toHaveClass(/dark/);
});

test('the sidebar is one navigation landmark (UX-15)', async ({ page }) => {
  await openShell(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Baton home' })).toBeVisible();
  await expect(nav.getByRole('button', { name: /^Search/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^Inbox/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^My tasks/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Account menu' })).toBeVisible();
});

test('Ctrl+K opens the command palette', async ({ page }) => {
  await openShell(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await expect(palette.getByPlaceholder('Search or jump to…')).toBeFocused();

  await palette.getByPlaceholder('Search or jump to…').fill('inbox');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/inbox$/);
});

test('? opens the keyboard shortcuts, but not while typing', async ({ page }) => {
  await openShell(page);
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Command palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // In a text field, ? is just a character.
  await page.keyboard.press('Control+k');
  const search = page.getByPlaceholder('Search or jump to…');
  await search.pressSequentially('?');
  await expect(search).toHaveValue('?');
  await expect(dialog).toBeHidden();
});

test('the live event stream connects and delivers the user’s events', async ({ page }) => {
  const stream = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/events',
  );
  await openShell(page);
  const response = await stream;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/event-stream');

  // A second stream in the page (same cookies) sees the security-log row of a new API key.
  const event = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const source = new EventSource('/api/events');
        const timer = setTimeout(() => {
          source.close();
          reject(new Error('no live event within 10 s'));
        }, 10_000);
        source.onopen = () => {
          void fetch('/api/me/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Live probe' }),
          });
        };
        source.onmessage = (message) => {
          clearTimeout(timer);
          source.close();
          resolve(JSON.parse(String(message.data)));
        };
      }),
  );
  const live: LiveEvent = liveEventSchema.parse(event);
  // activity.created names the activity row; parentType/parentId name what it is about.
  expect(live).toMatchObject({
    type: 'activity.created',
    teamId: null,
    entityType: 'activity',
    parentType: 'api_key',
  });
});
