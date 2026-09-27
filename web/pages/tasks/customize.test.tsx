import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVERYONE_DEFAULTS, type Permission } from '@shared/permissions';
import type { MeResponse } from '@shared/schemas/core';
import type { Label, Project, Status } from '@shared/schemas/projects';
import type { BoardResponse, TaskCard } from '@shared/schemas/tasks';
import { LabelPicker } from '@web/components/pickers/LabelPicker';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/**
 * Ways into the statuses and labels settings from the Tasks page: the toolbar's Customize menu,
 * a board column's "…" menu, the label picker's "Manage labels" link, and the way back.
 */

const LAZY = { timeout: 15_000 };
/** Members' defaults without Manage labels (which @everyone has out of the box). */
const MEMBER = EVERYONE_DEFAULTS.filter((permission) => permission !== 'MANAGE_LABELS');
const NOW = '2026-09-27T10:00:00.000Z';

function me(permissions: Permission[]): MeResponse {
  const base = testMe();
  return {
    ...base,
    teams: base.teams.map((team) => ({
      ...team,
      isOwner: false,
      permissions,
      projects: team.projects.map((project) => ({ ...project, permissions })),
    })),
  };
}

const status = (id: string, name: string, position: number): Status => ({
  id,
  projectId: 'p1',
  name,
  color: '#6366f1',
  category: 'open',
  position,
  isDefault: position === 0,
  taskCount: position === 0 ? 1 : 0,
});

const statuses = [status('s-open', 'Open', 0), status('s-review', 'In Review', 1)];

const label: Label = {
  id: 'l1',
  projectId: 'p1',
  name: 'bug',
  color: '#ef4444',
  description: '',
  issueCount: 0,
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
  counts: { openTasks: 1, doneTasks: 0, openIssues: 0, resolvedIssues: 0 },
  path: '/t/acme/p/WEB',
  createdAt: NOW,
  updatedAt: NOW,
  readme: '',
  createdBy: null,
  keyAliases: [],
  statuses,
  labels: [label],
};

const card: TaskCard = {
  id: 'task1',
  ref: 'WEB-1',
  number: 1,
  title: 'Ship it',
  projectId: 'p1',
  teamId: 't1',
  status: { id: 's-open', name: 'Open', color: '#6366f1', category: 'open' },
  priority: 0,
  dueDate: null,
  labels: [],
  assignees: { users: [], roles: [] },
  claim: null,
  blocked: false,
  replyCount: 0,
  updatedAt: NOW,
  position: 'a0',
  blockers: [],
  createdAt: NOW,
  completedAt: null,
  path: '/t/acme/p/WEB/tasks/1',
};

const board: BoardResponse = {
  columns: [
    { status: statuses[0]!, count: 1, tasks: [card] },
    { status: statuses[1]!, count: 0, tasks: [] },
  ],
  total: 1,
};

function mockProjectApi(permissions: Permission[]) {
  return mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(permissions),
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/p1/statuses': { items: statuses },
    '/api/projects/p1/labels': { items: [label] },
    '/api/projects/p1/board': board,
    '/api/projects/p1/roles': { items: [] },
    '/api/teams/t1/roles': { items: [] },
    '/api/teams/t1/members': { items: [] },
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
  window.localStorage.clear();
});

describe('Tasks page → Customize menu', { timeout: 30_000 }, () => {
  it('offers statuses and labels to a viewer who can manage both', async () => {
    const user = userEvent.setup();
    mockProjectApi([...MEMBER, 'MANAGE_STATUSES', 'MANAGE_LABELS']);
    const router = renderAt('/t/acme/p/WEB/tasks');

    await user.click(await screen.findByRole('button', { name: 'Customize board' }, LAZY));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Edit statuses' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/settings/statuses',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Edit labels' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/settings/labels',
    );

    await user.click(within(menu).getByRole('menuitem', { name: 'Edit statuses' }));
    // Lazy routes: the location changes once the page's module has loaded.
    await waitFor(
      () => expect(router.state.location.pathname).toBe('/t/acme/p/WEB/settings/statuses'),
      LAZY,
    );
    // The settings page leads back to the board.
    const back = await screen.findByRole('link', { name: 'Back to Board' }, LAZY);
    expect(back).toHaveAttribute('href', '/t/acme/p/WEB/tasks');
  });

  it('shows only the items the viewer may use', async () => {
    const user = userEvent.setup();
    mockProjectApi([...MEMBER, 'MANAGE_LABELS']);
    renderAt('/t/acme/p/WEB/tasks');

    await user.click(await screen.findByRole('button', { name: 'Customize board' }, LAZY));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Edit labels' })).toBeVisible();
    expect(within(menu).queryByRole('menuitem', { name: 'Edit statuses' })).toBeNull();
  });

  it('is hidden from viewers who can manage neither', async () => {
    mockProjectApi(MEMBER);
    renderAt('/t/acme/p/WEB/tasks');
    await screen.findByRole('heading', { name: 'In Review' }, LAZY);
    expect(screen.queryByRole('button', { name: 'Customize board' })).toBeNull();
    expect(screen.queryByRole('button', { name: /column actions/ })).toBeNull();
  });
});

describe('board column menu', { timeout: 30_000 }, () => {
  it('links a column to its status in the settings, which highlights it', async () => {
    const user = userEvent.setup();
    mockProjectApi([...MEMBER, 'MANAGE_STATUSES']);
    const router = renderAt('/t/acme/p/WEB/tasks');

    await user.click(await screen.findByRole('button', { name: 'In Review column actions' }, LAZY));
    const item = within(await screen.findByRole('menu')).getByRole('menuitem', {
      name: 'Edit statuses',
    });
    expect(item).toHaveAttribute('href', '/t/acme/p/WEB/settings/statuses?status=s-review');
    await user.click(item);
    await waitFor(() => expect(router.state.location.search).toBe('?status=s-review'), LAZY);

    const rows = await screen.findAllByTestId('status-row', {}, LAZY);
    const targeted = rows.filter((row) => row.dataset.targeted === 'true');
    expect(targeted).toHaveLength(1);
    expect(within(targeted[0]!).getByRole('textbox')).toHaveValue('In Review');
  });
});

describe('LabelPicker → Manage labels', () => {
  function renderPicker(manageHref?: string) {
    render(
      <MemoryRouter>
        <LabelPicker labels={[label]} value={[]} onChange={() => {}} manageHref={manageHref} />
      </MemoryRouter>,
    );
  }

  it('links to the label settings when given a manageHref', async () => {
    const user = userEvent.setup();
    renderPicker('/t/acme/p/WEB/settings/labels');
    await user.click(screen.getByRole('button', { name: 'Add labels' }));
    expect(await screen.findByRole('link', { name: 'Manage labels' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/settings/labels',
    );
  });

  it('has no link without one', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('button', { name: 'Add labels' }));
    await screen.findByRole('option', { name: /bug/ });
    expect(screen.queryByRole('link', { name: 'Manage labels' })).toBeNull();
  });
});
