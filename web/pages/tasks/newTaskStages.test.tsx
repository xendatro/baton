import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@shared/permissions';
import type { MeResponse } from '@shared/schemas/core';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { Status, UpdateStatusInput } from '@shared/schemas/projects';
import type { BoardResponse } from '@shared/schemas/tasks';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { registerShellAction } from '@web/lib/shellActions';
import { mockApi, testConfig, testMe } from '@web/test/mockApi';
import { renderWorkPage } from '../my-tasks/testing';
import { StatusDialog } from '../project-settings/StatusDialog';
import TasksPage from './TasksPage';

/** BAT-34: "New tasks can start here" on the board and in the status dialog. */

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
});

function status(id: string, name: string, position: number, allowCreate: boolean): Status {
  return {
    id,
    projectId: 'p1',
    pipelineId: 'pl-a',
    name,
    color: '#6b7280',
    icon: 'circle',
    position,
    isDefault: position === 0,
    taskCount: 0,
    rules: { ...DEFAULT_STAGE_RULES, allowCreate },
  };
}

const pipeline = {
  id: 'pl-a',
  projectId: 'p1',
  name: 'Default',
  slug: 'default',
  color: null,
  icon: null,
  position: 0,
  isDefault: true,
  viewRule: null,
  createRule: null,
  manageRule: null,
  statusCount: 3,
  taskCount: 0,
  canCreateTasks: true,
  canManage: true,
};

function meWith(permissions: Permission[]): MeResponse {
  const me = testMe();
  return {
    ...me,
    teams: me.teams.map((team) => ({
      ...team,
      isOwner: false,
      permissions,
      projects: team.projects.map((project) => ({ ...project, permissions })),
    })),
  };
}

function renderBoard(statuses: Status[]) {
  const create = vi.fn();
  unregister = registerShellAction('task.create', create);
  const board: BoardResponse = {
    columns: statuses.map((entry) => ({ status: entry, count: 0, tasks: [] })),
    total: 0,
  };
  mockApi({
    '/api/me': meWith(['VIEW_PROJECT', 'CREATE_TASKS', 'MANAGE_STATUSES']),
    '/api/projects/p1/board': board,
    '/api/projects/p1/statuses': { items: statuses },
    '/api/projects/p1/labels': { items: [] },
    '/api/projects/p1/pipelines': { items: [pipeline] },
  });
  renderWorkPage(<TasksPage />, '/t/:team/p/:key/tasks', '/t/acme/p/WEB/tasks');
  return { create };
}

describe('the board', () => {
  it('offers + only on the columns new tasks can start in', async () => {
    const { create } = renderBoard([
      status('s-open', 'Open', 0, true),
      status('s-review', 'Review', 1, true),
      status('s-done', 'Done', 2, false),
    ]);
    const board = await screen.findByRole('region', { name: 'Board' });
    const done = within(board).getByRole('region', { name: 'Done' });
    expect(within(done).queryByRole('button', { name: /New task in/ })).not.toBeInTheDocument();
    await userEvent.click(within(board).getByRole('button', { name: 'New task in Review' }));
    expect(create).toHaveBeenCalledWith({ projectId: 'p1', statusId: 's-review' });
    expect(screen.queryByTestId('no-start-stage')).not.toBeInTheDocument();
  });

  it('warns and disables New task when no stage accepts new tasks', async () => {
    renderBoard([status('s-open', 'Open', 0, false), status('s-done', 'Done', 1, false)]);
    const notice = await screen.findByTestId('no-start-stage');
    expect(notice).toHaveTextContent('No status accepts new tasks');
    expect(within(notice).getByRole('link', { name: 'Edit statuses' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/settings/statuses?pipeline=pl-a',
    );
    expect(screen.getByRole('button', { name: /New task/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /New task in/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create a task/ })).not.toBeInTheDocument();
  });
});

describe('the status dialog', () => {
  const statuses = [
    status('s0', 'Open', 0, true),
    status('s1', 'Review', 1, false),
    status('s2', 'Done', 2, false),
  ];

  function renderDialog(onUpdate: (id: string, input: UpdateStatusInput) => Promise<unknown>) {
    const review = statuses[1];
    if (!review) throw new Error('status');
    mockApi({ '/api/config': testConfig, '/api/me': testMe() });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider>
          <StatusDialog
            state={{ mode: 'edit', status: review }}
            statuses={statuses}
            options={{ users: [], roles: [], projectRoles: [] }}
            teamId="t1"
            canManage
            onClose={() => undefined}
            onCreate={() => Promise.reject(new Error('unused'))}
            onUpdate={onUpdate}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('saves "New tasks can start here" with the basics', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn((_id: string, _input: UpdateStatusInput) => Promise.resolve());
    renderDialog(onUpdate);
    const allow = screen.getByRole('checkbox', { name: 'New tasks can start here' });
    expect(allow).not.toBeChecked();
    await user.click(allow);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ rules: { allowCreate: true } }),
      ),
    );
  });

  it('turns it on (and locks it) when the status becomes the default', async () => {
    const user = userEvent.setup();
    renderDialog(() => Promise.resolve());
    await user.click(screen.getByRole('checkbox', { name: 'Default for new tasks' }));
    const allow = screen.getByRole('checkbox', { name: 'New tasks can start here' });
    expect(allow).toBeChecked();
    expect(allow).toBeDisabled();
  });
});
