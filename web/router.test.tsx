import { render, screen } from '@testing-library/react';
import { createMemoryRouter, matchRoutes, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from './router';

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
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/profile');
  });
});
