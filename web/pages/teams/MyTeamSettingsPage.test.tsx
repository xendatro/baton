import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyTeamSettings } from '@shared/schemas/projectSettings';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/** BAT-34: your notifications for a whole team, "Use my defaults" until overridden. */

const LAZY = { timeout: 15_000 };

afterEach(() => vi.unstubAllGlobals());

function settings(patch: Partial<MyTeamSettings> = {}): MyTeamSettings {
  return {
    teamId: 't1',
    notifications: null,
    agentNotifications: null,
    defaults: {
      notifications: {
        level: 'all',
        kinds: { replies: true, roleMentions: true, issueStatus: true, stages: true },
      },
      agentNotifications: 'needs_me',
    },
    ...patch,
  };
}

describe('Your settings for a team', () => {
  it('overrides the account defaults with Nothing', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    mockApi({
      '/api/auth/get-session': testSession,
      '/api/me': testMe(),
      '/api/config': testConfig,
      '/api/notifications/unread-count': { count: 0 },
      '/api/teams/t1/my-settings': settings(),
      'PUT /api/teams/t1/my-settings': ({ init }: { init?: RequestInit }) => {
        const body = JSON.parse(init?.body as string) as Partial<MyTeamSettings>;
        saved.push(body);
        return jsonResponse(settings(body));
      },
    });
    const router = createMemoryRouter(routes, { initialEntries: ['/t/acme/me'] });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Your settings for Acme' }, LAZY),
    ).toBeInTheDocument();
    const useDefaults = await screen.findByRole('switch', { name: 'Use my defaults' });
    expect(useDefaults).toBeChecked();
    expect(screen.getByText('Your account’s: all activity.')).toBeInTheDocument();

    await user.click(useDefaults);
    await user.click(screen.getByRole('radio', { name: 'Nothing' }));
    await user.click(screen.getByRole('button', { name: 'Save notifications' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      notifications: { level: 'none' },
      agentNotifications: null,
    });
    expect(await screen.findByText('Saved your notifications for Acme')).toBeInTheDocument();
  });
});
