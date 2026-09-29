import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@shared/schemas/core';
import type { Pipeline, Status } from '@shared/schemas/projects';
import type { BoardResponse } from '@shared/schemas/tasks';
import { SidebarProvider } from '@web/components/ui/sidebar';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import TasksPage from '@web/pages/tasks/TasksPage';
import { AppSidebar } from './AppSidebar';

/** The sidebar's hierarchy: teams → projects → the active project's pipelines (and the tabs). */

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function pipeline(id: string, name: string, position: number, openTaskCount: number): Pipeline {
  return {
    id,
    projectId: 'p1',
    name,
    slug: name.toLowerCase(),
    color: null,
    icon: null,
    position,
    isDefault: position === 0,
    viewRule: null,
    createRule: null,
    manageRule: null,
    statusCount: 1,
    taskCount: openTaskCount + 1,
    openTaskCount,
    canCreateTasks: true,
    canManage: true,
  };
}

const open: Status = {
  id: 's-open',
  projectId: 'p1',
  name: 'Open',
  color: '#6b7280',
  icon: 'circle',
  position: 0,
  isDefault: true,
  taskCount: 0,
};
const board: BoardResponse = { columns: [{ status: open, count: 0, tasks: [] }], total: 0 };

function me(): MeResponse {
  const base = testMe();
  return {
    ...base,
    teams: base.teams.map((team) => ({
      ...team,
      projects: [
        ...team.projects,
        { id: 'p2', key: 'API', name: 'API', icon: null, color: '#0ea5e9' },
      ],
    })),
  };
}

function Frame({ children }: { children?: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <main>{children}</main>
    </SidebarProvider>
  );
}

function renderAt(path: string) {
  mockApi({
    '/api/me': me(),
    '/api/projects/p1/pipelines': {
      items: [pipeline('pl-a', 'Scripting', 0, 3), pipeline('pl-b', 'Modeling', 1, 0)],
    },
    '/api/projects/p1/board': board,
    '/api/projects/p1/statuses': { items: [open] },
    '/api/projects/p1/labels': { items: [] },
  });
  const router = createMemoryRouter(
    [
      {
        path: '/t/:team/p/:key/tasks',
        element: (
          <Frame>
            <TasksPage />
          </Frame>
        ),
      },
      { path: '*', element: <Frame /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('AppSidebar pipelines', () => {
  it('lists the pipelines of the project you are in, with their open tasks', async () => {
    renderAt('/t/acme/p/WEB');
    const list = await screen.findByRole('list', { name: 'Web app pipelines' });
    const links = await within(list).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Scripting3(3 open tasks)',
      'Modeling0(0 open tasks)',
    ]);
    expect(links[0]).toHaveAttribute('href', '/t/acme/p/WEB/tasks?pipeline=pl-a');
    // Not on a board: no pipeline is the current page; the project is.
    expect(links.every((link) => !link.hasAttribute('aria-current'))).toBe(true);
    expect(screen.getByRole('link', { name: 'Web app' })).toHaveAttribute('aria-current', 'page');
    // Other projects stay collapsed.
    expect(screen.getByRole('link', { name: 'API' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'API pipelines' })).not.toBeInTheDocument();
  });

  it('highlights the pipeline the board shows, both ways', async () => {
    const user = userEvent.setup();
    const router = renderAt('/t/acme/p/WEB/tasks');
    const list = await screen.findByRole('list', { name: 'Web app pipelines' });
    const tabs = await screen.findByRole('tablist', { name: 'Pipelines' });
    // The default pipeline, in the tabs and the sidebar alike.
    await waitFor(() =>
      expect(within(list).getByRole('link', { name: /Scripting/ })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    expect(within(tabs).getByRole('tab', { name: /Scripting/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Sidebar → tabs.
    await user.click(within(list).getByRole('link', { name: /Modeling/ }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('tablist', { name: 'Pipelines' })).getByRole('tab', {
          name: /Modeling/,
        }),
      ).toHaveAttribute('aria-selected', 'true'),
    );
    expect(router.state.location.search).toBe('?pipeline=pl-b');
    expect(within(list).getByRole('link', { name: /Modeling/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Tabs → sidebar.
    await user.click(
      within(screen.getByRole('tablist', { name: 'Pipelines' })).getByRole('tab', {
        name: /Scripting/,
      }),
    );
    await waitFor(() =>
      expect(within(list).getByRole('link', { name: /Scripting/ })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    expect(within(list).getByRole('link', { name: /Modeling/ })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

describe('AppSidebar team order, pinned projects and right-click menus', () => {
  function team(id: string, name: string, extra: Partial<MeResponse['teams'][number]> = {}) {
    return { ...testMe().teams[0]!, id, slug: name.toLowerCase(), name, projects: [], ...extra };
  }

  function renderTeams(teams: MeResponse['teams'], pinnedProjectIds: string[] = []) {
    let current: MeResponse = { ...testMe(), teams, pinnedProjectIds };
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const bodyOf = (init: RequestInit | undefined) =>
      init?.body ? (JSON.parse(init.body as string) as object) : undefined;
    const save = (method: string, url: URL, init: RequestInit | undefined, next: MeResponse) => {
      sent.push({ method, path: url.pathname, body: bodyOf(init) });
      current = next;
      return jsonResponse(current);
    };
    const projectIds = teams.flatMap((entry) => entry.projects.map((project) => project.id));
    mockApi({
      'GET /api/me': () => jsonResponse(current),
      'PUT /api/me/teams/order': ({ url, init }: { url: URL; init?: RequestInit }) => {
        const { teamIds } = bodyOf(init) as { teamIds: string[] };
        const byId = new Map(current.teams.map((entry) => [entry.id, entry]));
        return save('PUT', url, init, {
          ...current,
          teams: teamIds.map((id) => byId.get(id)!),
        });
      },
      ...Object.fromEntries(
        teams.map((entry) => [
          `PATCH /api/me/teams/${entry.id}`,
          ({ url, init }: { url: URL; init?: RequestInit }) =>
            save('PATCH', url, init, {
              ...current,
              teams: current.teams.map((t) => (t.id === entry.id ? { ...t, ...bodyOf(init) } : t)),
            }),
        ]),
      ),
      ...Object.fromEntries(
        projectIds.flatMap((id) => [
          [
            `PUT /api/me/projects/${id}/pin`,
            ({ url, init }: { url: URL; init?: RequestInit }) =>
              save('PUT', url, init, {
                ...current,
                pinnedProjectIds: [...(current.pinnedProjectIds ?? []), id],
              }),
          ],
          [
            `DELETE /api/me/projects/${id}/pin`,
            ({ url, init }: { url: URL; init?: RequestInit }) =>
              save('DELETE', url, init, {
                ...current,
                pinnedProjectIds: (current.pinnedProjectIds ?? []).filter((p) => p !== id),
              }),
          ],
        ]),
      ),
    });
    const router = createMemoryRouter([{ path: '*', element: <Frame /> }], {
      initialEntries: ['/'],
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    return { sent, router };
  }

  function names(list: HTMLElement) {
    return within(list)
      .getAllByRole('link')
      .map((link) => link.querySelector('span:last-child')?.textContent);
  }

  const projects = () => [
    ...testMe().teams[0]!.projects,
    { id: 'p2', key: 'API', name: 'API', icon: null, color: '#0ea5e9' },
  ];

  it('no longer pins teams: the team menu only moves it', async () => {
    const user = userEvent.setup();
    renderTeams([team('t1', 'Alpha'), team('t2', 'Bravo')]);
    await user.click(await screen.findByRole('button', { name: 'Bravo options' }));
    expect(await screen.findByRole('menuitem', { name: 'Move up' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Pin to top' })).not.toBeInTheDocument();
  });

  it('moves a team from the menu', async () => {
    const user = userEvent.setup();
    const { sent } = renderTeams([team('t1', 'Alpha'), team('t2', 'Bravo'), team('t3', 'Charlie')]);
    await user.click(await screen.findByRole('button', { name: 'Charlie options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));
    await waitFor(() =>
      expect(names(screen.getByRole('list', { name: 'Teams' }))).toEqual([
        'Alpha',
        'Charlie',
        'Bravo',
      ]),
    );
    expect(sent).toEqual([
      { method: 'PUT', path: '/api/me/teams/order', body: { teamIds: ['t1', 't3', 't2'] } },
    ]);
  });

  it('remembers a folded team', async () => {
    const user = userEvent.setup();
    const { sent } = renderTeams([team('t1', 'Acme', { projects: testMe().teams[0]!.projects })]);
    expect(await screen.findByRole('link', { name: 'Web app' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse Acme' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Web app' })).not.toBeInTheDocument(),
    );
    expect(sent).toEqual([
      { method: 'PATCH', path: '/api/me/teams/t1', body: { collapsed: true } },
    ]);
    expect(screen.getByRole('button', { name: 'Expand Acme' })).toBeInTheDocument();
  });

  it('shows pinned projects at the top, labelled with their team', async () => {
    renderTeams([team('t1', 'Acme', { projects: projects() })], ['p2']);
    const pinned = await screen.findByRole('list', { name: 'Pinned projects' });
    const links = within(pinned).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('API');
    expect(links[0]).toHaveTextContent('in Acme');
    expect(links[0]).toHaveAttribute('href', '/t/acme/p/API');
    // Still listed under its team, marked as pinned.
    const teamList = screen.getByRole('list', { name: 'Acme projects' });
    expect(within(teamList).getByRole('link', { name: /API/ })).toContainElement(
      within(teamList).getByRole('img', { name: 'Pinned' }),
    );
  });

  it('pins and unpins a project from its right-click menu', async () => {
    const user = userEvent.setup();
    const { sent } = renderTeams([team('t1', 'Acme', { projects: projects() })]);
    const link = await screen.findByRole('link', { name: 'API' });
    expect(screen.queryByRole('list', { name: 'Pinned projects' })).not.toBeInTheDocument();

    fireEvent.contextMenu(link);
    const menu = await screen.findByRole('menu', { name: 'API actions' });
    for (const item of ['Open board', 'New task…', 'Issues', 'Project settings', 'Your settings']) {
      if (item === 'New task…') continue; // Only with the New task dialog mounted.
      expect(within(menu).getByRole('menuitem', { name: item })).toBeInTheDocument();
    }
    await user.click(within(menu).getByRole('menuitem', { name: 'Pin to top' }));
    const pinned = await screen.findByRole('list', { name: 'Pinned projects' });
    expect(within(pinned).getByRole('link')).toHaveAttribute('href', '/t/acme/p/API');
    expect(sent).toEqual([{ method: 'PUT', path: '/api/me/projects/p2/pin', body: undefined }]);

    fireEvent.contextMenu(within(pinned).getByRole('link'));
    await user.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Pinned projects' })).not.toBeInTheDocument(),
    );
    expect(sent.at(-1)).toEqual({
      method: 'DELETE',
      path: '/api/me/projects/p2/pin',
      body: undefined,
    });
  });

  it('gives a team a right-click menu that respects permissions', async () => {
    const user = userEvent.setup();
    const { sent, router } = renderTeams([
      team('t1', 'Acme', { projects: projects(), isOwner: false, permissions: ['VIEW_PROJECT'] }),
    ]);
    fireEvent.contextMenu(await screen.findByRole('link', { name: 'Acme' }));
    const menu = await screen.findByRole('menu', { name: 'Acme actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Open team',
      'Members',
      'Team settings',
      'Fold projects',
      'Copy link',
      'Leave team…',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Fold projects' }));
    await waitFor(() =>
      expect(sent).toEqual([
        { method: 'PATCH', path: '/api/me/teams/t1', body: { collapsed: true } },
      ]),
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Acme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Team settings' }));
    expect(router.state.location.pathname).toBe('/t/acme/settings/general');
  });
});
