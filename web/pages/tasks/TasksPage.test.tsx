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
  window.localStorage.clear();
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

describe('TasksPage with several pipelines (BAT-25)', () => {
  function pipeline(id: string, name: string, position: number) {
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
      statusCount: 2,
      taskCount: position + 1,
      canCreateTasks: true,
      canManage: true,
    };
  }

  function mockPipelines(
    items: ReturnType<typeof pipeline>[],
    permissions: Permission[] = ['VIEW_PROJECT', 'CREATE_TASKS'],
  ) {
    const boardUrls: string[] = [];
    mockApi({
      '/api/me': meWith(permissions),
      '/api/projects/p1/board': ({ url }: { url: URL }) => {
        boardUrls.push(url.search);
        return new Response(JSON.stringify(emptyBoard), {
          headers: { 'content-type': 'application/json' },
        });
      },
      '/api/projects/p1/statuses': { items: statuses },
      '/api/projects/p1/labels': { items: [] },
      '/api/projects/p1/pipelines': { items },
    });
    return boardUrls;
  }

  it('shows one tab per pipeline then All, opening on the default pipeline', async () => {
    const create = vi.fn();
    unregister = registerShellAction('task.create', create);
    const boardUrls = mockPipelines([
      pipeline('pl-a', 'Scripting', 0),
      pipeline('pl-b', 'Modeling', 1),
    ]);
    renderWorkPage(<TasksPage />, '/t/:team/p/:key/tasks', '/t/acme/p/WEB/tasks');
    const tabs = await screen.findByRole('tablist', { name: 'Pipelines' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Scripting1', 'Modeling2', 'All3']);
    expect(within(tabs).getByRole('tab', { name: /Scripting/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await vi.waitFor(() => expect(boardUrls).not.toHaveLength(0));
    // Never all pipelines' tasks first: the board asks for the default pipeline's straight away.
    expect(boardUrls.every((search) => search.includes('pipeline=pl-a'))).toBe(true);

    await userEvent.click(within(tabs).getByRole('tab', { name: /Modeling/ }));
    await vi.waitFor(() =>
      expect(boardUrls.some((search) => search.includes('pipeline=pl-b'))).toBe(true),
    );
    await userEvent.click(await screen.findByRole('button', { name: /Create a task/ }));
    expect(create).toHaveBeenCalledWith({
      projectId: 'p1',
      statusId: undefined,
      pipelineId: 'pl-b',
    });
    // The tab is remembered for the next visit.
    expect(window.localStorage.getItem('baton.pipelineTab.p1')).toBe('pl-b');

    await userEvent.click(within(tabs).getByRole('tab', { name: /All/ }));
    await vi.waitFor(() => expect(boardUrls.at(-1)?.includes('pipeline')).toBe(false));
  });

  it('shows the tab of a project with one pipeline, and New pipeline to status managers', async () => {
    mockPipelines(
      [pipeline('pl-a', 'Development', 0)],
      ['VIEW_PROJECT', 'CREATE_TASKS', 'MANAGE_STATUSES'],
    );
    renderWorkPage(<TasksPage />, '/t/:team/p/:key/tasks', '/t/acme/p/WEB/tasks');
    const tabs = await screen.findByRole('tablist', { name: 'Pipelines' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Development1']);
    expect(within(tabs).getByRole('tab')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('link', { name: 'New pipeline' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/settings/pipelines?new=pipeline',
    );
  });

  it('opens on the tab last picked in this browser', async () => {
    window.localStorage.setItem('baton.pipelineTab.p1', 'pl-b');
    mockPipelines([pipeline('pl-a', 'Scripting', 0), pipeline('pl-b', 'Modeling', 1)]);
    renderWorkPage(<TasksPage />, '/t/:team/p/:key/tasks', '/t/acme/p/WEB/tasks');
    const tabs = await screen.findByRole('tablist', { name: 'Pipelines' });
    expect(within(tabs).getByRole('tab', { name: /Modeling/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('link', { name: 'New pipeline' })).not.toBeInTheDocument();
  });

  it('flags a pipeline with no stages, and New task can’t target it', async () => {
    mockApi({
      '/api/me': meWith(['VIEW_PROJECT', 'CREATE_TASKS', 'MANAGE_STATUSES']),
      '/api/projects/p1/board': { columns: [], total: 0 },
      // Every stage belongs to Scripting: Modeling has none left.
      '/api/projects/p1/statuses': {
        items: statuses.map((entry) => ({ ...entry, pipelineId: 'pl-a' })),
      },
      '/api/projects/p1/labels': { items: [] },
      '/api/projects/p1/pipelines': {
        items: [pipeline('pl-a', 'Scripting', 0), pipeline('pl-b', 'Modeling', 1)],
      },
    });
    renderWorkPage(<TasksPage />, '/t/:team/p/:key/tasks', '/t/acme/p/WEB/tasks?pipeline=pl-b');
    const notice = await screen.findByTestId('no-stages');
    expect(notice).toHaveTextContent('Modeling has no stages — add one to put tasks in it.');
    expect(within(notice).getByRole('link', { name: 'Add stage' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/settings/pipelines?pipeline=pl-b',
    );
    expect(screen.queryByRole('button', { name: /Create a task/ })).not.toBeInTheDocument();
  });
});
