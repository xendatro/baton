import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, matchRoutes, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from './lib/queryClient';
import { routes } from './router';
import { mockApi, testConfig, testMe, testSession } from './test/mockApi';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Lazy route modules are transformed on first import, which can be slow in a cold run. */
const LAZY = { timeout: 15_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every path of SPEC §6 must resolve to a route (and not fall through to the 404 page). */
const SPEC_PATHS = [
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/onboarding/username',
  '/join/abc123XYZ0',
  '/',
  '/inbox',
  '/my-tasks',
  '/t/acme',
  '/t/acme/settings/general',
  '/t/acme/settings/members',
  '/t/acme/settings/roles',
  '/t/acme/settings/roles/01HZX',
  '/t/acme/settings/invites',
  '/t/acme/settings/audit-log',
  '/t/acme/settings/trash',
  '/t/acme/p/BAT',
  '/t/acme/p/BAT/settings/general',
  '/t/acme/p/BAT/settings/statuses',
  '/t/acme/p/BAT/settings/labels',
  '/t/acme/p/BAT/issues',
  '/t/acme/p/BAT/issues/new',
  '/t/acme/p/BAT/issues/51',
  '/t/acme/p/BAT/tasks',
  '/t/acme/p/BAT/tasks/12',
  '/settings/profile',
  '/settings/account',
  '/settings/connections',
  '/settings/api-keys',
  '/settings/appearance',
  '/settings/security',
];

describe('router', () => {
  it.each(SPEC_PATHS)('declares %s', (path) => {
    const matches = matchRoutes(routes, path);
    expect(matches, path).not.toBeNull();
    expect(matches?.at(-1)?.route.path).not.toBe('*');
  });

  it('falls back to the 404 page for unknown paths', () => {
    expect(matchRoutes(routes, '/nope/nope')?.at(-1)?.route.path).toBe('*');
  });

  it('lazily renders page modules and redirects settings indexes', async () => {
    mockApi({
      '/api/auth/get-session': testSession,
      '/api/me': testMe(),
      '/api/notifications/unread-count': { count: 0 },
      '/api/config': testConfig,
    });
    const router = renderAt('/settings');
    expect(await screen.findByRole('heading', { name: 'Profile' }, LAZY)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/profile');
  });

  it('sends signed-out visitors to the login page, remembering where they were going', async () => {
    mockApi({ '/api/auth/get-session': null, '/api/config': testConfig });
    const router = renderAt('/t/acme/p/WEB/tasks');
    expect(
      await screen.findByRole('heading', { name: 'Log in to Baton' }, LAZY),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent('/t/acme/p/WEB/tasks')}`);
  });

  it('sends users without a username to onboarding first', async () => {
    mockApi({
      '/api/auth/get-session': testSession,
      '/api/me': testMe({ username: null, displayUsername: null }),
      '/api/config': testConfig,
    });
    const router = renderAt('/inbox');
    expect(
      await screen.findByRole('heading', { name: 'Choose a username' }, LAZY),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/onboarding/username');
  });

  it('sends unverified users to email verification', async () => {
    mockApi({
      '/api/auth/get-session': testSession,
      '/api/me': testMe({ emailVerified: false }),
      '/api/config': testConfig,
    });
    const router = renderAt('/');
    expect(
      await screen.findByRole('heading', { name: 'Check your email' }, LAZY),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/verify-email');
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('redirects signed-in users away from the login page to next', async () => {
    mockApi({
      '/api/auth/get-session': testSession,
      '/api/me': testMe(),
      '/api/notifications/unread-count': { count: 0 },
      '/api/config': testConfig,
    });
    const router = renderAt('/login?next=%2Fsettings%2Fprofile');
    expect(await screen.findByRole('heading', { name: 'Profile' }, LAZY)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/profile');
  });
});
