import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@shared/permissions';
import type { MeResponse } from '@shared/schemas/core';
import type { Project, ProjectSummary } from '@shared/schemas/projects';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

const LAZY = { timeout: 15_000 };

function me(permissions: MeResponse['teams'][number]['permissions']): MeResponse {
  const base = testMe();
  return {
    ...base,
    teams: base.teams.map((team) => ({ ...team, isOwner: false, permissions })),
  };
}

const summary: ProjectSummary = {
  id: 'p1',
  teamId: 't1',
  teamSlug: 'acme',
  name: 'Web app',
  key: 'WEB',
  ref: 'acme/WEB',
  description: 'The customer-facing web app',
  icon: null,
  color: '#0ea5e9',
  counts: { openTasks: 3, doneTasks: 1, openIssues: 2, resolvedIssues: 0 },
  path: '/t/acme/p/WEB',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

const project: Project = {
  ...summary,
  readme: '',
  createdBy: { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null },
  keyAliases: ['OLD'],
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      name: 'Open',
      color: '#6b7280',
      category: 'open',
      position: 0,
      isDefault: true,
      taskCount: 3,
    },
    {
      id: 's2',
      projectId: 'p1',
      name: 'Done',
      color: '#22c55e',
      category: 'done',
      position: 1,
      isDefault: false,
      taskCount: 1,
    },
  ],
  labels: [],
};

function mockProjectApi(permissions: MeResponse['teams'][number]['permissions']) {
  return mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(permissions),
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/resolve': ({ url }: { url: URL }) =>
      url.searchParams.get('ref') === 'acme/OLD'
        ? jsonResponse(summary)
        : jsonResponse({ error: { code: 'not_found', message: 'Project not found' } }, 404),
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project layout', { timeout: 20_000 }, () => {
  it('shows the header, tabs and an empty README with a call to action', async () => {
    mockProjectApi([...PERMISSIONS]);
    renderAt('/t/acme/p/WEB');
    expect(await screen.findByRole('heading', { level: 1, name: 'Web app' }, LAZY)).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Project' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('button', { name: 'Write a README' }, LAZY)).toBeVisible();
    expect(screen.getByText('(was OLD)')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Tasks done' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
  });

  it('hides README editing without MANAGE_PROJECTS', async () => {
    mockProjectApi(['REPLY']);
    renderAt('/t/acme/p/WEB');
    expect(
      await screen.findByText('Nobody has written a README for this project yet.', {}, LAZY),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Write a README' })).toBeNull();
  });

  it('redirects a previous key to the current one, keeping the rest of the URL', async () => {
    mockProjectApi([...PERMISSIONS]);
    const router = renderAt('/t/acme/p/OLD/settings/labels?x=1');
    await vi.waitFor(
      () => expect(router.state.location.pathname).toBe('/t/acme/p/WEB/settings/labels'),
      LAZY,
    );
    expect(router.state.location.search).toBe('?x=1');
  });

  it('canonicalizes a lowercase key', async () => {
    mockProjectApi([...PERMISSIONS]);
    const router = renderAt('/t/acme/p/web');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/t/acme/p/WEB'), LAZY);
  });

  it('shows a 404 for unknown keys', async () => {
    mockProjectApi([...PERMISSIONS]);
    renderAt('/t/acme/p/NOPE/tasks');
    expect(await screen.findByRole('heading', { name: 'Project not found' }, LAZY)).toBeVisible();
  });
});
