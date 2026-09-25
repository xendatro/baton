import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const OUT = path.join(import.meta.dirname, '..', '..', 'test-results', 'visual');

const session = {
  session: { id: 's1', expiresAt: '2099-01-01T00:00:00.000Z' },
  user: { id: 'u1', email: 'ada@example.com', emailVerified: true, name: 'Ada', username: 'ada' },
};

function me(username: string | null = 'ada') {
  return {
    user: {
      id: 'u1',
      email: 'ada@example.com',
      emailVerified: true,
      username,
      displayUsername: username,
      name: 'Ada Lovelace',
      image: null,
      theme: 'system',
    },
    teams: [
      {
        id: 't1',
        slug: 'acme',
        name: 'Acme',
        icon: '🚀',
        color: '#6366f1',
        isOwner: true,
        permissions: ['ADMINISTRATOR'],
        projects: [
          { id: 'p1', key: 'WEB', name: 'Web app', icon: null, color: '#0ea5e9' },
          { id: 'p2', key: 'API', name: 'Public API', icon: '🧩', color: '#22c55e' },
        ],
      },
      {
        id: 't2',
        slug: 'side-projects',
        name: 'Side projects',
        icon: null,
        color: '#ec4899',
        isOwner: false,
        permissions: ['REPLY'],
        projects: [{ id: 'p3', key: 'BLOG', name: 'Blog', icon: '📝', color: '#f59e0b' }],
      },
    ],
    unreadNotifications: 3,
  };
}

interface MockOptions {
  signedIn?: boolean;
  username?: string | null;
}

/** Answers the API in the browser; the SSE stream is left pending. */
async function mockApi(page: Page, { signedIn = false, username = 'ada' }: MockOptions = {}) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (url.pathname) {
      case '/api/config':
        return json({
          version: 'dev',
          signupsEnabled: true,
          providers: { google: true, github: true },
          maxUploadMb: 25,
        });
      case '/api/auth/get-session':
        return json(signedIn ? session : null);
      case '/api/me':
        return signedIn
          ? json(me(username))
          : json({ error: { code: 'unauthorized', message: 'Sign in' } }, 401);
      case '/api/notifications/unread-count':
        return json({ count: 3 });
      case '/api/auth/is-username-available':
        return json({ available: true });
      case '/api/events':
        return route.abort();
      default:
        return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    }
  });
}

type Theme = 'light' | 'dark';
const VIEWPORTS = {
  desktop: { width: 1280, height: 860 },
  mobile: { width: 375, height: 812 },
} as const;

async function prepare(page: Page, theme: Theme, viewport: keyof typeof VIEWPORTS) {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.addInitScript((value) => localStorage.setItem('baton-theme', value), theme);
}

async function shoot(page: Page, name: string) {
  // Horizontal overflow is a layout bug at every width.
  // A string expression: this file is type-checked without the DOM library.
  const overflow = Number(
    await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    ),
  );
  expect(overflow, `${name} scrolls horizontally`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

const AUTH_PAGES = [
  { name: 'login', url: '/login', heading: 'Log in to Baton' },
  { name: 'signup', url: '/signup', heading: 'Create your account' },
  {
    name: 'verify-email',
    url: '/verify-email?email=ada%40example.com',
    heading: 'Check your email',
  },
  { name: 'forgot-password', url: '/forgot-password', heading: 'Reset your password' },
  {
    name: 'reset-password',
    url: '/reset-password?email=ada%40example.com',
    heading: 'Choose a new password',
  },
];

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of ['desktop', 'mobile'] as const) {
    test.describe(`${theme} ${viewport}`, () => {
      test.beforeEach(async ({ page }) => {
        await prepare(page, theme, viewport);
      });

      for (const screen of AUTH_PAGES) {
        test(screen.name, async ({ page }) => {
          await mockApi(page);
          await page.goto(screen.url);
          await expect(page.getByRole('heading', { name: screen.heading })).toBeVisible();
          if (screen.name === 'signup') {
            await page.getByLabel('Username').fill('ada_l');
            await page.getByLabel('Password', { exact: true }).fill('Tr0ub4dor&3');
            await expect(page.getByText('@ada_l is available')).toBeVisible();
          }
          await shoot(page, `${screen.name}-${theme}-${viewport}`);
        });
      }

      test('onboarding', async ({ page }) => {
        await mockApi(page, { signedIn: true, username: null });
        await page.goto('/onboarding/username');
        await expect(page.getByRole('heading', { name: 'Choose a username' })).toBeVisible();
        await shoot(page, `onboarding-${theme}-${viewport}`);
      });

      test('app shell', async ({ page }) => {
        await mockApi(page, { signedIn: true });
        await page.goto('/t/acme/p/WEB/tasks');
        await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toBeVisible();
        await expect(page).toHaveTitle('Tasks · Web app · Baton');
        await shoot(page, `shell-${theme}-${viewport}`);
        if (viewport === 'mobile') {
          await page.getByRole('button', { name: 'Toggle sidebar' }).click();
          await expect(page.getByRole('link', { name: 'Inbox' })).toBeVisible();
          // Let the sheet finish sliding in.
          await page.waitForTimeout(700);
          await shoot(page, `shell-sheet-${theme}-${viewport}`);
        } else {
          await page.keyboard.press('Control+k');
          await expect(page.getByPlaceholder('Search or jump to…')).toBeVisible();
          await shoot(page, `palette-${theme}-${viewport}`);
          await page.keyboard.press('Escape');
          await page.keyboard.press('Shift+?');
          await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
          await shoot(page, `shortcuts-${theme}-${viewport}`);
        }
      });

      test('component gallery', async ({ page }) => {
        await mockApi(page, { signedIn: true });
        await page.goto('/__dev/components');
        await expect(page.getByRole('heading', { name: 'Component gallery' })).toBeVisible();
        await expect(page.getByText('changed status from')).toBeVisible();
        await shoot(page, `components-${theme}-${viewport}`);
        if (viewport === 'desktop') {
          const editor = page.getByRole('textbox', { name: 'Compact editor' });
          await editor.click();
          await page.keyboard.type('/');
          await expect(page.getByRole('listbox', { name: 'Insert block' })).toBeVisible();
          await page.screenshot({ path: path.join(OUT, `slash-menu-${theme}.png`) });
          await page.keyboard.press('Escape');
          await page.keyboard.type(' hi @a');
          const mentions = page.getByRole('listbox', { name: 'Mention someone' });
          await expect(mentions.getByText('Ada Lovelace')).toBeVisible();
          await page.screenshot({ path: path.join(OUT, `mention-menu-${theme}.png`) });
          await page.keyboard.press('Enter');
          await expect(editor.locator('.mention')).toHaveText('@ada');
          await page.getByRole('button', { name: 'Labels: Bug' }).click();
          await expect(page.getByPlaceholder('Find or create a label…')).toBeVisible();
          await page.screenshot({ path: path.join(OUT, `label-picker-${theme}.png`) });
        }
      });
    });
  }
}
