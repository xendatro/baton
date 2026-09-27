import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVERYONE_DEFAULTS, PERMISSIONS, type Permission } from '@shared/permissions';
import type { MeResponse } from '@shared/schemas/core';
import type { ProjectPermissionsResponse, ProjectRole } from '@shared/schemas/projectAccess';
import type { Project } from '@shared/schemas/projects';
import type { Member, Role } from '@shared/schemas/teams';
import { projectPermissions } from '@web/lib/permissions';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

const LAZY = { timeout: 15_000 };
const NOW = '2026-09-27T10:00:00.000Z';

function me(team: Permission[], project: Permission[] | undefined, isOwner = false): MeResponse {
  const base = testMe();
  return {
    ...base,
    teams: base.teams.map((t) => ({
      ...t,
      isOwner,
      permissions: team,
      projects: t.projects.map((p) => ({ ...p, ...(project ? { permissions: project } : {}) })),
    })),
  };
}

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

const role = (overrides: Partial<Role> & Pick<Role, 'id' | 'name'>): Role => ({
  teamId: 't1',
  slug: overrides.name.toLowerCase(),
  color: null,
  position: 1,
  permissions: [],
  mentionable: false,
  hoist: false,
  isEveryone: false,
  memberCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const teamRoles: Role[] = [
  role({ id: 'r-admin', name: 'Admin', position: 2, permissions: ['ADMINISTRATOR'] }),
  role({
    id: 'r-everyone',
    name: '@everyone',
    slug: 'everyone',
    position: 0,
    isEveryone: true,
    permissions: [...EVERYONE_DEFAULTS],
  }),
];

const reviewers: ProjectRole = {
  id: 'pr1',
  projectId: 'p1',
  name: 'Reviewers',
  slug: 'reviewers',
  color: '#22c55e',
  position: 1,
  members: [
    { id: 'u2', username: 'bob', name: 'Bob Builder', image: null, isAgent: false },
    { id: 'u3', username: 'bob-ai', name: 'Bob AI', image: null, isAgent: true },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

const members: Member[] = [
  {
    user: { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null },
    joinedAt: NOW,
    isOwner: true,
    roles: [],
    color: null,
  },
  {
    user: { id: 'u4', username: 'cy', name: 'Cy Twombly', image: null },
    joinedAt: NOW,
    isOwner: false,
    roles: [],
    color: null,
  },
];

function permissionsResponse(canManage: boolean): ProjectPermissionsResponse {
  return {
    projectId: 'p1',
    canManage,
    permissions: canManage ? [...PERMISSIONS] : ['VIEW_PROJECT', 'REPLY'],
    overrides: [
      {
        subjectType: 'project_role',
        subjectId: 'pr1',
        subjectName: 'Reviewers',
        subjectColor: '#22c55e',
        allow: ['RESOLVE_ISSUES'],
        deny: [],
        updatedAt: NOW,
      },
    ],
  };
}

function mockAccessApi(meResponse: MeResponse, canManage: boolean) {
  const puts: unknown[] = [];
  const fetchMock = mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': meResponse,
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/p1/labels': { items: [] },
    '/api/projects/p1/roles': { items: [reviewers] },
    '/api/projects/p1/permissions': permissionsResponse(canManage),
    '/api/teams/t1/roles': { items: teamRoles },
    '/api/teams/t1/members': { items: members },
    'PUT /api/projects/p1/permissions/overrides': ({ init }: { init?: RequestInit }) => {
      puts.push(JSON.parse(init?.body as string));
      return jsonResponse(permissionsResponse(true));
    },
  });
  return { fetchMock, puts };
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

describe('project settings → Access', { timeout: 30_000 }, () => {
  it('lists project roles with their members and edits a subject’s permissions', async () => {
    const user = userEvent.setup();
    const { puts } = mockAccessApi(me(['ADMINISTRATOR'], [...PERMISSIONS], true), true);
    renderAt('/t/acme/p/WEB/settings/access');

    expect(await screen.findByRole('heading', { name: 'Access' }, LAZY)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Access' })).toHaveAttribute('aria-current', 'page');
    const row = await screen.findByTestId('project-role-row', {}, LAZY);
    expect(within(row).getByText('Reviewers')).toBeVisible();
    expect(within(row).getByText('Bob Builder')).toBeVisible();
    expect(within(row).getByText('AI')).toBeVisible();
    expect(within(row).getByRole('button', { name: 'Remove Bob AI from Reviewers' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New role' })).toBeVisible();

    // Subjects: team roles (@everyone first), then project roles; the first one is selected.
    const subjects = await screen.findByRole('navigation', { name: 'Permission subjects' });
    const everyone = within(subjects).getByRole('button', { name: /@everyone/ });
    expect(everyone).toHaveAttribute('aria-pressed', 'true');
    expect(within(subjects).getByRole('button', { name: /Reviewers/ })).toBeVisible();

    const reply = screen.getByTestId('permission-REPLY');
    expect(within(reply).getByRole('radio', { name: 'Inherit Reply' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(reply).getByRole('radio', { name: 'Deny Reply' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(puts).toEqual([
        { subjectType: 'team_role', subjectId: 'r-everyone', allow: [], deny: ['REPLY'] },
      ]),
    );

    // A project role's existing override shows as set.
    await user.click(within(subjects).getByRole('button', { name: /Reviewers/ }));
    const resolve = screen.getByTestId('permission-RESOLVE_ISSUES');
    expect(within(resolve).getByRole('radio', { name: 'Allow Resolve issues' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Team-level permissions are never offered per project.
    expect(screen.queryByTestId('permission-MANAGE_TEAM')).toBeNull();
  });

  it('is read-only without Manage project access', async () => {
    mockAccessApi(me([...EVERYONE_DEFAULTS], ['VIEW_PROJECT', 'REPLY']), false);
    renderAt('/t/acme/p/WEB/settings/access');
    expect(await screen.findByText('Manage project access', {}, LAZY)).toBeVisible();
    await screen.findByTestId('project-role-row', {}, LAZY);
    expect(screen.queryByRole('button', { name: 'New role' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove .* from Reviewers/ })).toBeNull();
    const reply = await screen.findByTestId('permission-REPLY', {}, LAZY);
    expect(within(reply).getByRole('radio', { name: 'Deny Reply' })).toBeDisabled();
  });
});

describe('project permissions gate the UI', { timeout: 30_000 }, () => {
  it('uses the project’s permissions over the team’s', async () => {
    // The team grants Manage labels, but this project takes it away.
    mockAccessApi(me([...EVERYONE_DEFAULTS], ['VIEW_PROJECT', 'REPLY']), false);
    renderAt('/t/acme/p/WEB/settings/labels');
    expect(await screen.findByText('Manage labels', {}, LAZY)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New label' })).toBeNull();
  });

  it('falls back to the team’s permissions when the project has none listed', () => {
    const response = me(['REPLY'], undefined);
    expect(projectPermissions(response, 't1', 'p1')).toEqual(['REPLY']);
    expect(projectPermissions(me(['REPLY'], ['VIEW_PROJECT']), 't1', 'p1')).toEqual([
      'VIEW_PROJECT',
    ]);
    expect(projectPermissions(response, 'nope', 'p1')).toBeNull();
  });
});
