import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeProject, MeResponse, MeTeam } from '@shared/schemas/core';
import { SidebarProvider } from '@web/components/ui/sidebar';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { AppSidebar } from './AppSidebar';
import { moveProject } from './sidebarTeams';

/** BAT#27: your own order of each team's projects in the sidebar (within their team only). */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const project = (id: string, name: string): MeProject => ({
  id,
  key: name.toUpperCase().slice(0, 4),
  name,
  icon: null,
  color: '#0ea5e9',
});

function team(id: string, name: string, projects: MeProject[]): MeTeam {
  return { ...testMe().teams[0]!, id, slug: name.toLowerCase(), name, projects };
}

function renderSidebar({ fail = false } = {}) {
  let current: MeResponse = {
    ...testMe(),
    teams: [
      team('t1', 'Acme', [project('p1', 'Api'), project('p2', 'Docs'), project('p3', 'Web')]),
      team('t2', 'Globex', [project('p4', 'Game')]),
    ],
  };
  const sent: unknown[] = [];
  mockApi({
    'GET /api/me': () => jsonResponse(current),
    'PUT /api/me/teams/t1/projects/order': ({ init }: { init?: RequestInit }) => {
      const body = JSON.parse(init?.body as string) as { projectIds: string[] };
      sent.push(body);
      if (fail) {
        return jsonResponse({ error: { code: 'validation_failed', message: 'Nope' } }, 400);
      }
      const byId = new Map(current.teams[0]!.projects.map((entry) => [entry.id, entry]));
      current = {
        ...current,
        teams: current.teams.map((entry) =>
          entry.id === 't1'
            ? { ...entry, projects: body.projectIds.map((id) => byId.get(id)!) }
            : entry,
        ),
      };
      return jsonResponse(current);
    },
  });
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <SidebarProvider>
            <AppSidebar />
          </SidebarProvider>
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole('link')
    .map((link) => link.querySelector('span:last-child')?.textContent);

describe('AppSidebar project order (BAT#27)', { timeout: 30_000 }, () => {
  it('moveProject moves within the list, or returns null', () => {
    const projects = [project('a', 'A'), project('b', 'B'), project('c', 'C')];
    expect(moveProject(projects, 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveProject(projects, 'a', 'a')).toBeNull();
    expect(moveProject(projects, 'a', 'elsewhere')).toBeNull();
  });

  it('moves a project within its team from its menu, saving your order', async () => {
    const user = userEvent.setup();
    const sent = renderSidebar();
    const acme = await screen.findByRole('list', { name: 'Acme projects' });
    expect(names(acme)).toEqual(['Api', 'Docs', 'Web']);
    // A team's only project has nothing to move past.
    const globex = screen.getByRole('list', { name: 'Globex projects' });
    expect(within(globex).queryByRole('button', { name: 'Game options' })).toBeNull();

    await user.click(within(acme).getByRole('button', { name: 'Web options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(names(acme)).toEqual(['Api', 'Web', 'Docs']));
    expect(sent).toEqual([{ projectIds: ['p1', 'p3', 'p2'] }]);

    // The first project can't go further up.
    await user.click(within(acme).getByRole('button', { name: 'Api options' }));
    expect(await screen.findByRole('menuitem', { name: 'Move up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('puts the old order back and toasts when saving fails', async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(toast, 'error');
    renderSidebar({ fail: true });
    const acme = await screen.findByRole('list', { name: 'Acme projects' });
    await user.click(within(acme).getByRole('button', { name: 'Api options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Nope'));
    expect(names(acme)).toEqual(['Api', 'Docs', 'Web']);
  });
});
