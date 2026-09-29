import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyProjectSettings } from '@shared/schemas/projectSettings';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { MODEL_OPTIONS } from '@web/test/agentRequests';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/** A project's Your settings: one default model chain for the project (difficulty is gone). */

const LAZY = { timeout: 15_000 };

afterEach(() => vi.unstubAllGlobals());

function settings(chain: MyProjectSettings['models']['chain']): MyProjectSettings {
  return {
    projectId: 'p1',
    notifications: null,
    agentNotifications: null,
    models: { chain },
    defaults: {
      notifications: {
        level: 'all',
        kinds: { replies: true, roleMentions: true, issueStatus: true, stages: true },
      },
      agentNotifications: 'all',
      models: { chain: [{ harness: 'claude', model: 'opus', effort: 'high' }] },
    },
  };
}

describe('Your settings for a project', () => {
  it('uses the account default until the project gets its own chain, saved as { chain }', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    mockApi({
      '/api/auth/get-session': testSession,
      '/api/me': testMe(),
      '/api/config': testConfig,
      '/api/notifications/unread-count': { count: 0 },
      '/api/projects/p1/my-settings': settings([]),
      'PUT /api/projects/p1/my-settings': ({ init }: { init?: RequestInit }) => {
        const body = JSON.parse(init?.body as string) as { models: MyProjectSettings['models'] };
        saved.push(body);
        return jsonResponse(settings(body.models.chain));
      },
      '/api/me/agent/model-options': MODEL_OPTIONS,
      '/api/me/agent/model-failures': { failures: [] },
    });
    const router = createMemoryRouter(routes, { initialEntries: ['/t/acme/p/WEB/me'] });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>,
    );
    const card = await screen.findByTestId('project-default-model', {}, LAZY);
    expect(screen.queryByText(/difficulty/i)).not.toBeInTheDocument();
    const inherit = within(card).getByRole('switch', { name: 'Use my account default' });
    expect(inherit).toBeChecked();
    expect(card).toHaveTextContent('Claude Code opus');

    await user.click(inherit);
    const model = await within(card).findByRole('combobox', {
      name: 'Default model for this project: model 1',
    });
    await user.selectOptions(model, 'sonnet');
    await user.click(screen.getByRole('button', { name: 'Save model' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      models: { chain: [{ harness: 'claude', model: 'sonnet', effort: '' }] },
    });
  });
});
