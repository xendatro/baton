import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogFacets, TrashPage as TrashPageData } from '@shared/schemas/admin';
import type { ActivityEntry, MeResponse, TrashItem } from '@shared/schemas/core';
import { PERMISSIONS } from '@shared/permissions';
import { createQueryClient } from '@web/lib/queryClient';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import AuditLogPage from './AuditLogPage';
import TrashPage from './TrashPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL a mocked `fetch` was called with. */
function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function renderPage(path: string, element: React.ReactNode, pattern: string) {
  const router = createMemoryRouter(
    [
      { path: pattern, element },
      { path: '*', element: <p>Elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function meWith(permissions: MeResponse['teams'][number]['permissions']): MeResponse {
  const me = testMe();
  return { ...me, teams: me.teams.map((team) => ({ ...team, isOwner: false, permissions })) };
}

const mia = { id: 'u2', username: 'mia', name: 'Mia Chen', image: null };

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'a1',
    teamId: 't1',
    projectId: 'p1',
    actor: { user: mia, via: { keyId: 'k1', keyName: 'Claude on laptop' }, source: 'mcp' },
    entityType: 'task',
    entityId: 'task1',
    action: 'task.status_changed',
    changes: { status: { from: 'Open', to: 'Done' } },
    meta: { ref: 'WEB-12', title: 'Fix login' },
    url: '/t/acme/p/WEB/tasks/12',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const facets: AuditLogFacets = {
  actors: [mia],
  sources: ['web', 'mcp'],
  keys: [{ keyId: 'k1', keyName: 'Claude on laptop', user: mia }],
  entityTypes: ['task', 'role'],
  actions: ['role.permissions_changed', 'task.status_changed'],
  projects: [{ id: 'p1', key: 'WEB', name: 'Web app', deleted: false }],
};

describe('AuditLogPage', () => {
  it('shows rows grouped by day with sentences, links and expandable diffs', async () => {
    const fetchMock = mockApi({
      '/api/me': meWith([...PERMISSIONS]),
      '/api/teams/t1/audit-log/facets': facets,
      '/api/teams/t1/audit-log': {
        items: [
          entry({}),
          entry({
            id: 'a2',
            actor: { user: mia, via: null, source: 'web' },
            entityType: 'role',
            entityId: 'r1',
            action: 'role.permissions_changed',
            changes: { permissions: { from: [], to: ['MANAGE_ROLES'] } },
            meta: { name: 'Admin' },
            url: '/t/acme/settings/roles/r1',
          }),
        ],
        nextCursor: null,
      },
    });
    const user = userEvent.setup();
    renderPage(
      '/t/acme/settings/audit-log?source=mcp',
      <AuditLogPage />,
      '/t/:team/settings/audit-log',
    );

    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    const rows = await screen.findAllByTestId('audit-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    const first = rows[0] as HTMLElement;
    expect(first).toHaveTextContent('Mia Chen');
    expect(first).toHaveTextContent('via Claude on laptop');
    expect(first).toHaveTextContent('moved WEB-12 from Open to Done');
    expect(within(first).getByRole('link', { name: 'WEB-12' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/tasks/12',
    );
    expect(rows[1]).toHaveTextContent('changed permissions of Admin: +MANAGE_ROLES');

    await user.click(within(first).getByRole('button', { name: 'Show changes (1)' }));
    expect(within(first).getByText('status')).toBeInTheDocument();
    expect(within(first).getByText('task.status_changed')).toBeInTheDocument();

    // The URL's filter reached the API, and the filter button shows it.
    const listCall = fetchMock.mock.calls
      .map(([input]) => urlOf(input))
      .find((url) => url.startsWith('/api/teams/t1/audit-log?'));
    expect(listCall).toContain('source=mcp');
    expect(screen.getByRole('button', { name: 'Source: MCP (agents)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clear filter/ })).toBeInTheDocument();
  });

  it('explains the permission it needs', async () => {
    mockApi({ '/api/me': meWith(['CREATE_ISSUES']) });
    renderPage('/t/acme/settings/audit-log', <AuditLogPage />, '/t/:team/settings/audit-log');
    expect(await screen.findByText('You can’t view the audit log')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Acme' })).toHaveAttribute('href', '/t/acme');
  });

  it('shows an empty state, and a clear-filters one when filtered', async () => {
    mockApi({
      '/api/me': meWith([...PERMISSIONS]),
      '/api/teams/t1/audit-log/facets': facets,
      '/api/teams/t1/audit-log': { items: [], nextCursor: null },
    });
    const user = userEvent.setup();
    const router = renderPage(
      '/t/acme/settings/audit-log?entity=role',
      <AuditLogPage />,
      '/t/:team/settings/audit-log',
    );
    expect(await screen.findByText('No matching activity')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });
});

function trashItem(overrides: Partial<TrashItem>): TrashItem {
  return {
    type: 'task',
    id: 'task1',
    teamId: 't1',
    projectId: 'p1',
    title: 'Fix login',
    ref: 'WEB-12',
    author: mia,
    deletedBy: mia,
    via: { keyId: 'k1', keyName: 'Codex' },
    deletedAt: new Date().toISOString(),
    daysLeft: 30,
    ...overrides,
  };
}

describe('TrashPage', () => {
  it('lists deleted items and restores one with a link to it', async () => {
    let restored = false;
    const page = (): TrashPageData => ({
      items: restored
        ? [trashItem({ type: 'reply', id: 'r1', title: 'Old reply', ref: 'WEB#3', daysLeft: 2 })]
        : [
            trashItem({}),
            trashItem({ type: 'reply', id: 'r1', title: 'Old reply', ref: 'WEB#3', daysLeft: 2 }),
          ],
      nextCursor: null,
    });
    const fetchMock = mockApi({
      '/api/me': meWith(['CREATE_TASKS']),
      '/api/teams/t1/trash': () => jsonResponse(page()),
      'POST /api/trash/restore': () => {
        restored = true;
        return jsonResponse({ ok: true, type: 'task', id: 'task1', url: '/t/acme/p/WEB/tasks/12' });
      },
    });
    const user = userEvent.setup();
    renderPage('/t/acme/settings/trash', <TrashPage />, '/t/:team/settings/trash');

    const rows = await screen.findAllByTestId('trash-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Fix login');
    expect(rows[0]).toHaveTextContent('WEB-12');
    expect(rows[0]).toHaveTextContent('in Web app');
    expect(rows[0]).toHaveTextContent(/via\s*Codex/);
    expect(rows[0]).toHaveTextContent('30 days left');
    expect(rows[1]).toHaveTextContent('on WEB#3');
    expect(rows[1]).toHaveTextContent('2 days left');
    expect(screen.getByText(/You see the items you created/)).toBeInTheDocument();

    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: /Restore task/ }));
    await waitFor(() => expect(screen.getAllByTestId('trash-row')).toHaveLength(1));
    const call = fetchMock.mock.calls.find(([input]) => urlOf(input) === '/api/trash/restore');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ type: 'task', id: 'task1' });
  });

  it('explains the 30-day rule when empty and filters by type through the URL', async () => {
    const fetchMock = mockApi({
      '/api/me': meWith([...PERMISSIONS]),
      '/api/teams/t1/trash': { items: [], nextCursor: null },
    });
    renderPage('/t/acme/settings/trash?type=reply', <TrashPage />, '/t/:team/settings/trash');
    expect(await screen.findByText('No deleted replies')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        urlOf(input).includes('/api/teams/t1/trash?type=reply'),
      ),
    ).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all types' }));
    expect(await screen.findByText('Trash is empty')).toBeInTheDocument();
    expect(screen.getByText(/restored for 30 days/)).toBeInTheDocument();
  });
});
