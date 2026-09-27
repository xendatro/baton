import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@shared/permissions';
import type { MeResponse } from '@shared/schemas/core';
import type { Status } from '@shared/schemas/projects';
import type { BoardResponse } from '@shared/schemas/tasks';
import { registerShellAction } from '@web/lib/shellActions';
import { mockApi, testMe } from '@web/test/mockApi';
import { renderWorkPage } from '../my-tasks/testing';
import TasksPage from './TasksPage';

/** The Tasks page of a project without tasks: its columns stay, with a small prompt (not a page). */

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
});

function status(id: string, name: string, position: number): Status {
  return {
    id,
    projectId: 'p1',
    name,
    color: '#6b7280',
    icon: position === 0 ? ('circle' as const) : ('check-circle' as const),
    position,
    isDefault: position === 0,
    taskCount: 0,
  };
}

const statuses = [status('s-open', 'Open', 0), status('s-done', 'Done', 1)];
const emptyBoard: BoardResponse = {
  columns: statuses.map((entry) => ({ status: entry, count: 0, tasks: [] })),
  total: 0,
};

/** Ada in Acme, with only `permissions` in the WEB project. */
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

function renderTasks(permissions: Permission[], search = '') {
  const create = vi.fn();
  unregister = registerShellAction('task.create', create);
  mockApi({
    '/api/me': meWith(permissions),
    '/api/projects/p1/board': emptyBoard,
    '/api/projects/p1/statuses': { items: statuses },
    '/api/projects/p1/labels': { items: [] },
  });
  renderWorkPage(<TasksPage />, '/t/:team/p/:key/tasks', `/t/acme/p/WEB/tasks${search}`);
  return { create };
}

describe('TasksPage without tasks', () => {
  it('shows every column, with a prompt to create the first task in the first one', async () => {
    const { create } = renderTasks(['VIEW_PROJECT', 'CREATE_TASKS']);
    const board = await screen.findByRole('region', { name: 'Board' });
    const open = within(board).getByRole('region', { name: 'Open' });
    const done = within(board).getByRole('region', { name: 'Done' });

    const hint = within(open).getByRole('status');
    expect(hint).toHaveTextContent('No tasks yet');
    // Not a page-wide empty state: the other columns keep their own placeholder.
    expect(within(done).getByText('No tasks')).toBeInTheDocument();
    expect(screen.getAllByText('No tasks yet')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'No tasks yet' })).not.toBeInTheDocument();

    await userEvent.click(within(hint).getByRole('button', { name: /Create a task/ }));
    expect(create).toHaveBeenCalledWith({ projectId: 'p1', statusId: undefined });
  });

  it('shows no prompt when filters match nothing', async () => {
    renderTasks(['VIEW_PROJECT', 'CREATE_TASKS'], '?priority=4');
    const board = await screen.findByRole('region', { name: 'Board' });
    expect(within(board).getAllByText('No matching tasks')).toHaveLength(2);
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create a task/ })).not.toBeInTheDocument();
  });

  it('shows just the empty columns to viewers who can’t create tasks', async () => {
    renderTasks(['VIEW_PROJECT']);
    const board = await screen.findByRole('region', { name: 'Board' });
    expect(within(board).getByRole('region', { name: 'Open' })).toBeInTheDocument();
    expect(within(board).getByRole('region', { name: 'Done' })).toBeInTheDocument();
    expect(within(board).getAllByText('No tasks')).toHaveLength(2);
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create a task/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New task/ })).not.toBeInTheDocument();
  });
});
