import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { Pipeline, Project, Status } from '@shared/schemas/projects';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/**
 * Warn, don't block: a pipeline's last stage can be deleted once no task is in it, and a pipeline
 * without stages is flagged (settings banner) instead of refused.
 */

const LAZY = { timeout: 15_000 };
const NOW = '2026-09-29T10:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

const only: Status = {
  id: 's-only',
  projectId: 'p1',
  pipelineId: 'pl1',
  name: 'Only',
  color: '#6b7280',
  icon: 'circle',
  position: 0,
  isDefault: true,
  taskCount: 0,
  rules: { ...DEFAULT_STAGE_RULES, allowCreate: true },
  defaultDifficultyId: null,
};

const pipeline: Pipeline = {
  id: 'pl1',
  projectId: 'p1',
  name: 'Main',
  slug: 'main',
  color: null,
  icon: null,
  position: 0,
  isDefault: true,
  viewRule: null,
  createRule: null,
  manageRule: null,
  statusCount: 1,
  taskCount: 0,
  openTaskCount: 0,
  canCreateTasks: true,
  canManage: true,
};

const project: Project = {
  id: 'p1',
  teamId: 't1',
  teamSlug: 'acme',
  name: 'Web app',
  key: 'WEB',
  ref: 'acme/WEB',
  description: '',
  icon: null,
  color: '#0ea5e9',
  counts: {
    tasks: 0,
    assignedTasks: 0,
    completedTasks: 0,
    openTasks: 0,
    doneTasks: 0,
    openIssues: 0,
    resolvedIssues: 0,
  },
  path: '/t/acme/p/WEB',
  createdAt: NOW,
  updatedAt: NOW,
  readme: '',
  createdBy: null,
  keyAliases: [],
  statuses: [],
  labels: [],
};

function setup() {
  let statuses: Status[] = [only];
  const deletes: string[] = [];
  mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': testMe(),
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/p1/statuses': () => jsonResponse({ items: statuses }),
    '/api/projects/p1/pipelines': { items: [pipeline] },
    '/api/projects/p1/difficulties': { items: [] },
    '/api/projects/p1/roles': { items: [] },
    '/api/teams/t1/roles': { items: [] },
    '/api/teams/t1/members': { items: [] },
    'DELETE /api/statuses/s-only': ({ url }: { url: URL }) => {
      deletes.push(url.search);
      statuses = [];
      return jsonResponse({ ok: true, movedTasks: 0 });
    },
  });
  const router = createMemoryRouter(routes, {
    initialEntries: ['/t/acme/p/WEB/settings/pipelines'],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { deletes };
}

describe('Deleting the last stage', { timeout: 30_000 }, () => {
  it('is allowed with a warning, and the empty pipeline is flagged', async () => {
    const user = userEvent.setup();
    const { deletes } = setup();
    await screen.findByRole('textbox', { name: 'Name of status Only' }, LAZY);
    expect(screen.queryByTestId('no-stages')).not.toBeInTheDocument();

    const remove = screen.getByRole('button', { name: 'Delete Only' });
    expect(remove).toBeEnabled();
    await user.click(remove);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('note')).toHaveTextContent('will have no stages');
    await user.click(within(dialog).getByRole('button', { name: 'Delete status' }));

    // Nothing to move: no target is sent.
    await waitFor(() => expect(deletes).toEqual(['']));
    expect(await screen.findByTestId('no-stages')).toHaveTextContent(
      'This pipeline has no stages — add one to put tasks in it.',
    );
  });
});
