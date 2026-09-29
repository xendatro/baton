import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@shared/permissions';
import type { MeResponse } from '@shared/schemas/core';
import type { Issue, IssueListResponse, IssueSummary } from '@shared/schemas/issues';
import type { Label, Project } from '@shared/schemas/projects';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';
import { requestUrl } from '@web/pages/my-tasks/testing';
import { labelColorFor } from './labels';

const LAZY = { timeout: 15_000 };

function me(permissions: readonly Permission[]): MeResponse {
  const base = testMe();
  return {
    ...base,
    teams: base.teams.map((team) => ({ ...team, isOwner: false, permissions: [...permissions] })),
  };
}

const bug: Label = {
  id: 'l1',
  projectId: 'p1',
  name: 'Bug',
  color: '#ef4444',
  description: 'Something is broken',
  issueCount: 1,
  taskCount: 0,
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
    openIssues: 1,
    resolvedIssues: 0,
  },
  path: '/t/acme/p/WEB',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  readme: '',
  createdBy: null,
  keyAliases: [],
  statuses: [],
  labels: [bug],
};

const author = { id: 'u2', username: 'grace', name: 'Grace Hopper', image: null };

const summary: IssueSummary = {
  id: 'i1',
  teamId: 't1',
  projectId: 'p1',
  number: 12,
  ref: 'WEB#12',
  title: 'Export fails for large projects',
  resolved: false,
  resolvedAt: null,
  labels: [{ id: 'l1', name: 'Bug', color: '#ef4444', description: 'Something is broken' }],
  author,
  via: { keyId: 'k1', keyName: 'Claude on laptop' },
  replyCount: 3,
  lastActivityAt: '2026-09-20T10:00:00.000Z',
  createdAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  editedAt: null,
  path: '/t/acme/p/WEB/issues/12',
};

const issue: Issue = {
  ...summary,
  body: 'Exports time out after **30 seconds**.',
  attachments: [],
  reactions: [],
  resolvedBy: null,
  linkedTasks: [
    {
      id: 'x1',
      number: 4,
      ref: 'WEB-4',
      title: 'Stream the export',
      kind: 'fixes',
      status: { id: 's1', name: 'In Progress', color: '#f59e0b', icon: 'circle' },
      path: '/t/acme/p/WEB/tasks/4',
    },
  ],
  subscribed: false,
};

function mockIssueApi(permissions: readonly Permission[], list: IssueListResponse) {
  return mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(permissions),
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/p1/labels': { items: [bug] },
    '/api/teams/t1/members': { items: [] },
    '/api/projects/p1/issues': list,
    '/api/projects/p1/issues/12': issue,
    '/api/replies': { items: [], total: 0, topLevelCount: 0, ancestors: [] },
    '/api/activity': { items: [] },
    '/api/teams/t1/mentionables': { users: [], roles: [] },
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

describe('issue list', { timeout: 20_000 }, () => {
  it('lists issues with counts, and filters by the labels named in the URL', async () => {
    const fetchMock = mockIssueApi([...PERMISSIONS], {
      items: [summary],
      nextCursor: null,
      counts: { open: 1, resolved: 4, all: 5 },
    });
    renderAt('/t/acme/p/WEB/issues?label=bug&state=all');
    const rows = await screen.findByRole('list', { name: 'Issues' }, LAZY);
    const row = within(rows).getByRole('listitem');
    expect(
      within(row).getByRole('link', { name: 'Export fails for large projects' }),
    ).toHaveAttribute('href', '/t/acme/p/WEB/issues/12');
    expect(within(row).getByText('Claude on laptop')).toBeVisible();
    expect(within(row).getByText('#12')).toBeVisible();
    expect(screen.getByRole('button', { name: /^All\s*5$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /^Resolved\s*4$/ })).toBeVisible();
    const request = fetchMock.mock.calls
      .map(([input]) =>
        input instanceof URL
          ? input
          : new URL(typeof input === 'string' ? input : input.url, 'http://localhost'),
      )
      .find((url) => url.pathname === '/api/projects/p1/issues');
    expect(request?.searchParams.get('labels')).toBe('l1');
    expect(request?.searchParams.get('state')).toBe('all');
    expect(screen.getByRole('link', { name: /New issue/ })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/issues/new',
    );
  });

  it('invites the first issue when there are none, without a button for viewers', async () => {
    mockIssueApi(['REPLY'], {
      items: [],
      nextCursor: null,
      counts: { open: 0, resolved: 0, all: 0 },
    });
    renderAt('/t/acme/p/WEB/issues');
    expect(await screen.findByRole('heading', { name: 'No issues yet' }, LAZY)).toBeVisible();
    expect(screen.queryByRole('link', { name: /New issue/ })).toBeNull();
  });

  it('removes a label from the row’s right-click menu (BAT-40)', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    let current: IssueSummary = summary;
    mockIssueApi([...PERMISSIONS], {
      items: [summary],
      nextCursor: null,
      counts: { open: 1, resolved: 0, all: 1 },
    });
    // The list follows the server's answer once refreshed.
    const base = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = new URL(requestUrl(input), 'http://localhost');
      if (url.pathname === '/api/issues/i1' && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string));
        current = { ...summary, labels: [] };
        return Promise.resolve(jsonResponse({ ...issue, labels: [] }));
      }
      if (url.pathname === '/api/projects/p1/issues') {
        return Promise.resolve(
          jsonResponse({
            items: [current],
            nextCursor: null,
            counts: { open: 1, resolved: 0, all: 1 },
          }),
        );
      }
      return base!(input, init);
    });
    renderAt('/t/acme/p/WEB/issues');
    const rows = await screen.findByRole('list', { name: 'Issues' }, LAZY);
    const row = within(rows).getByRole('listitem');
    expect(within(row).getByText('Bug')).toBeInTheDocument();
    fireEvent.contextMenu(
      within(row).getByRole('link', { name: 'Export fails for large projects' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Labels' }));
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Bug' });
    expect(item).toHaveAttribute('aria-checked', 'true');
    item.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patches).toEqual([{ labels: { remove: ['l1'] } }]));
    await waitFor(() => expect(within(row).queryByText('Bug')).toBeNull());
    expect(screen.getByRole('menuitemcheckbox', { name: 'Bug' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

describe('issue page', { timeout: 20_000 }, () => {
  it('shows the post, the tasks addressing it and triage actions for RESOLVE_ISSUES', async () => {
    mockIssueApi(['RESOLVE_ISSUES', 'REPLY'], {
      items: [],
      nextCursor: null,
      counts: { open: 0, resolved: 0, all: 0 },
    });
    renderAt('/t/acme/p/WEB/issues/12');
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: /Export fails for large projects/ },
        LAZY,
      ),
    ).toBeVisible();
    // The issue is the page's only h1: the project header above it is not a heading (UX-15).
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('30 seconds')).toBeVisible();
    const details = screen.getByRole('complementary', { name: 'Issue details' });
    expect(
      within(details).getByRole('link', { name: /WEB-4\s*Stream the export/ }),
    ).toHaveAttribute('href', '/t/acme/p/WEB/tasks/4');
    expect(within(details).getByText('fixes')).toBeVisible();
    expect(within(details).getByRole('button', { name: 'Subscribe' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeVisible();
    // Not the author and no EDIT_ANY_CONTENT / CREATE_TASKS.
    expect(screen.queryByRole('button', { name: 'Edit title' })).toBeNull();
    expect(within(details).queryByRole('button', { name: 'Create task' })).toBeNull();
  });

  it('explains a missing issue', async () => {
    mockIssueApi([...PERMISSIONS], {
      items: [],
      nextCursor: null,
      counts: { open: 0, resolved: 0, all: 0 },
    });
    renderAt('/t/acme/p/WEB/issues/99');
    expect(await screen.findByRole('heading', { name: 'Issue not found' }, LAZY)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to issues' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/issues',
    );
  });
});

describe('new issue page', { timeout: 20_000 }, () => {
  it('explains when the viewer can’t open issues', async () => {
    mockIssueApi(['REPLY'], {
      items: [],
      nextCursor: null,
      counts: { open: 0, resolved: 0, all: 0 },
    });
    renderAt('/t/acme/p/WEB/issues/new');
    expect(
      await screen.findByRole('heading', { name: 'You can’t open issues here' }, LAZY),
    ).toBeVisible();
  });
});

describe('labelColorFor', () => {
  it('picks a stable, non-gray palette color from the name', () => {
    expect(labelColorFor('Performance')).toBe(labelColorFor('performance'));
    expect(labelColorFor('Performance')).toMatch(/^#[0-9a-f]{6}$/);
    expect(labelColorFor('Performance')).not.toBe('#6b7280');
  });
});
