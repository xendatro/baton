import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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
import { mockApi, testMe } from '@web/test/mockApi';
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
