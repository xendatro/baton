import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Difficulty } from '@shared/schemas/projects';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/** Project settings → Difficulty (BAT-30): hardest at the top, grip handles to reorder. */

const LAZY = { timeout: 15_000 };

const level = (id: string, name: string, position: number): Difficulty => ({
  id,
  projectId: 'p1',
  name,
  color: '#22c55e',
  position,
  taskCount: 0,
});

// As the API sends them: easiest first.
const levels = [
  level('d-easy', 'Easy', 0),
  level('d-normal', 'Normal', 1),
  level('d-hard', 'Hard', 2),
];

afterEach(() => vi.unstubAllGlobals());

describe('project settings → Difficulty', { timeout: 30_000 }, () => {
  it('lists levels hardest first between Hardest and Easiest, with grip handles', async () => {
    mockApi({
      '/api/auth/get-session': testSession,
      '/api/me': {
        ...testMe(),
        teams: testMe().teams.map((team) => ({
          ...team,
          permissions: ['VIEW_PROJECT', 'MANAGE_LABELS'],
        })),
      },
      '/api/notifications/unread-count': { count: 0 },
      '/api/config': testConfig,
      '/api/projects/p1/difficulties': { items: levels },
    });
    const router = createMemoryRouter(routes, {
      initialEntries: ['/t/acme/p/WEB/settings/difficulty'],
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const list = await screen.findByRole(
      'list',
      { name: 'Difficulty levels, hardest first' },
      LAZY,
    );
    const names = within(list)
      .getAllByRole('textbox')
      .map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(['Hard', 'Normal', 'Easy']);
    expect(screen.getByText('Hardest')).toBeVisible();
    expect(screen.getByText('Easiest')).toBeVisible();
    // BAT#21: each person maps levels to models in their own settings for the project.
    const intro = screen.getByText(/How hard a task is/);
    expect(
      within(intro).getByRole('link', { name: 'Your settings for this project' }),
    ).toHaveAttribute('href', '/t/acme/p/WEB/me');
    expect(screen.queryByText(/Account settings/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();

    // The grip is a focusable handle (the keyboard sensor reorders with Space and the arrows).
    const grip = screen.getByRole('button', { name: 'Reorder Hard' });
    await waitFor(() => expect(grip).toBeEnabled());
    grip.focus();
    expect(grip).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Reorder Easy' })).toBeVisible();
  });
});
