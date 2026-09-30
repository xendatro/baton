import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@shared/permissions';
import type { IssueListResponse, IssueSummary } from '@shared/schemas/issues';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import type { TaskCard, TaskListResponse } from '@shared/schemas/tasks';
import { queryKeys } from '@web/lib/queryKeys';
import { IssueRail } from '@web/pages/issues/IssueRail';
import { renderWorkPage } from '@web/pages/my-tasks/testing';
import { finishingStage } from '@web/pages/tasks/railQuery';
import { TaskRail } from '@web/pages/tasks/TaskRail';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { sortByActivity } from './railState';

/** BAT-44: the issue and task rails (sorting, hidden finished items, right-click, highlight). */

afterEach(() => {
  vi.unstubAllGlobals();
});

const admin = {
  ...testMe(),
  teams: testMe().teams.map((team) => ({ ...team, permissions: [...PERMISSIONS] })),
};
const meTeam = admin.teams[0]!;
const meProject = meTeam.projects[0]!;

function issue(number: number, title: string, overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id: `i${number}`,
    teamId: 't1',
    projectId: 'p1',
    number,
    ref: `WEB#${number}`,
    title,
    resolved: false,
    resolvedAt: null,
    labels: [],
    author: { id: 'u2', username: 'caden', name: 'Caden', image: null },
    via: null,
    replyCount: 0,
    lastActivityAt: '2026-09-20T10:00:00.000Z',
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    editedAt: null,
    path: `/t/acme/p/WEB/issues/${number}`,
    unreadCount: 0,
    latestReply: null,
    ...overrides,
  };
}

type Sent = Array<{ method: string; path: string; search: string; body: unknown }>;

function recorder(sent: Sent) {
  return (answer: unknown, status = 200) =>
    ({ url, init }: { url: URL; init?: RequestInit }) => {
      sent.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        search: url.search,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return jsonResponse(answer, status);
    };
}

function rowTitles() {
  return screen
    .getAllByTestId('item-rail-row')
    .map((row) => row.querySelector('.truncate')?.textContent);
}

describe('Issue rail', () => {
  function renderIssueRail(items: IssueSummary[]) {
    const sent: Sent = [];
    const record = recorder(sent);
    const list: IssueListResponse = {
      items,
      nextCursor: null,
      counts: { open: items.length, resolved: 0, all: items.length },
    };
    mockApi({
      '/api/me': admin,
      '/api/projects/p1/issues': record(list),
      'POST /api/issues/i12/resolve': record({
        ...items.find((item) => item.id === 'i12'),
        resolved: true,
        body: '',
        attachments: [],
        resolvedBy: null,
        linkedTasks: [],
        reactions: [],
        subscribed: false,
      }),
    });
    const view = renderWorkPage(
      <IssueRail team={meTeam} project={meProject} currentNumber={12} />,
      '/t/acme/p/WEB/issues/:number',
      '/t/acme/p/WEB/issues/12',
    );
    const ready = () =>
      waitFor(() => expect(view.queryClient.getQueryData(queryKeys.me())).toBeDefined());
    return { ...view, sent, ready };
  }

  it('lists open issues by latest activity, hides resolved ones and highlights the open one', async () => {
    const { sent } = renderIssueRail([
      issue(3, 'Old question', { lastActivityAt: '2026-09-10T10:00:00.000Z' }),
      issue(12, 'Export fails', {
        lastActivityAt: '2026-09-21T10:00:00.000Z',
        latestReply: {
          id: 'r1',
          author: { id: 'u2', username: 'caden', name: 'Caden', image: null },
          excerpt: 'sounds good',
          createdAt: '2026-09-21T10:00:00.000Z',
        },
      }),
      issue(7, 'Done already', { resolved: true, lastActivityAt: '2026-09-22T10:00:00.000Z' }),
      issue(9, 'Slow search', {
        lastActivityAt: '2026-09-15T10:00:00.000Z',
        unreadCount: 2,
        agentWorking: { agentIds: ['a1'], names: ['Ethan AI'] },
      }),
    ]);
    await screen.findByRole('list', { name: 'Open issues' });
    expect(rowTitles()).toEqual(['Export fails', 'Slow search', 'Old question']);
    const current = screen.getByRole('link', { current: 'page' });
    expect(current).toHaveTextContent('Export fails');
    expect(current).toHaveTextContent('Caden: sounds good');
    expect(screen.getByRole('img', { name: '2 unread notifications' })).toBeInTheDocument();
    // BAT#42: the working dot on the row an agent works on, and only there.
    expect(screen.getByRole('link', { name: /Slow search/ })).toContainElement(
      screen.getByRole('img', { name: 'Ethan AI is working' }),
    );
    expect(screen.getAllByTestId('working-dot')).toHaveLength(1);
    expect(screen.queryByText('Done already')).not.toBeInTheDocument();
    const request = sent.find((call) => call.path === '/api/projects/p1/issues');
    expect(request?.search).toContain('state=open');
    expect(request?.search).toContain('sort=latest-activity');
    expect(request?.search).toContain('latestReply=true');
  });

  it('marks an issue resolved from its right-click menu, which drops it from the list', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderIssueRail([issue(12, 'Export fails'), issue(9, 'Slow search')]);
    await ready();
    const row = await screen.findByRole('link', { name: /Export fails/ });
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu', { name: 'WEB#12 actions' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Mark resolved' }));
    await waitFor(() =>
      expect(
        sent.some((call) => call.method === 'POST' && call.path === '/api/issues/i12/resolve'),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Export fails')).not.toBeInTheDocument());
    expect(screen.getByText('Slow search')).toBeInTheDocument();
  });
});

function stage(id: string, name: string, position: number, finishes = false): Status {
  return {
    id,
    projectId: 'p1',
    pipelineId: 'pl1',
    name,
    color: '#6b7280',
    icon: 'circle',
    position,
    isDefault: position === 0,
    taskCount: 0,
    rules: { ...DEFAULT_STAGE_RULES, blocksDependents: !finishes },
  };
}

const todo = stage('s-todo', 'Todo', 0);
const doing = stage('s-doing', 'Doing', 1);
const done = stage('s-done', 'Done', 2, true);
const archive = stage('s-archive', 'Archived', 3, true);

function task(number: number, title: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: `task${number}`,
    ref: `WEB-${number}`,
    number,
    title,
    projectId: 'p1',
    teamId: 't1',
    status: { id: doing.id, name: doing.name, color: doing.color, icon: doing.icon },
    priority: 0,
    dueDate: null,
    labels: [],
    assignees: { users: [{ id: 'u2', username: 'caden', name: 'Caden', image: null }], roles: [] },
    claim: null,
    blocked: false,
    replyCount: 0,
    updatedAt: '2026-09-20T10:00:00.000Z',
    lastActivityAt: '2026-09-20T10:00:00.000Z',
    position: 'a0',
    blockers: [],
    createdAt: '2026-09-18T10:00:00.000Z',
    completedAt: null,
    path: `/t/acme/p/WEB/tasks/${number}`,
    unreadCount: 0,
    latestReply: null,
    ...overrides,
  };
}

describe('Task rail', () => {
  function renderTaskRail(items: TaskCard[], move: { status?: number; body?: unknown } = {}) {
    const sent: Sent = [];
    const record = recorder(sent);
    const list: TaskListResponse = { items, total: items.length, nextCursor: null };
    mockApi({
      '/api/me': admin,
      '/api/projects/p1/tasks': record(list),
      '/api/projects/p1/statuses': { items: [todo, doing, done, archive] },
      'POST /api/tasks/task4/move': record(
        move.body ?? {
          ...items[0],
          status: { id: archive.id, name: archive.name, color: archive.color, icon: archive.icon },
          completedAt: '2026-09-22T10:00:00.000Z',
          description: '',
          teamSlug: 'acme',
          projectKey: 'WEB',
          author: null,
          via: null,
          editedAt: null,
          blockedBy: [],
          blocking: [],
          issues: [],
          attachments: [],
          reactions: [],
          subscribed: false,
        },
        move.status,
      ),
    });
    const view = renderWorkPage(
      <TaskRail team={meTeam} project={meProject} currentNumber={5} />,
      '/t/acme/p/WEB/tasks/:number',
      '/t/acme/p/WEB/tasks/5',
    );
    const ready = () =>
      waitFor(() => expect(view.queryClient.getQueryData(queryKeys.me())).toBeDefined());
    return { ...view, sent, ready };
  }

  it('lists unfinished tasks by latest activity with stage and assignee, open one highlighted', async () => {
    const { sent } = renderTaskRail([
      task(4, 'Write docs', { lastActivityAt: '2026-09-19T10:00:00.000Z' }),
      task(5, 'Fix login', { lastActivityAt: '2026-09-21T10:00:00.000Z' }),
      task(6, 'Shipped', {
        completedAt: '2026-09-22T10:00:00.000Z',
        lastActivityAt: '2026-09-22T10:00:00.000Z',
      }),
    ]);
    await screen.findByRole('list', { name: 'Open tasks' });
    expect(rowTitles()).toEqual(['Fix login', 'Write docs']);
    const current = screen.getByRole('link', { current: 'page' });
    expect(current).toHaveTextContent('WEB-5');
    expect(current).toHaveTextContent('Doing');
    expect(current).toHaveTextContent('Caden');
    const request = sent.find((call) => call.path === '/api/projects/p1/tasks');
    expect(request?.search).toContain('sort=lastActivityAt');
    expect(request?.search).toContain('completed=no');
  });

  it('marks a task done: moves it to the pipeline’s finishing stage and drops it', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderTaskRail([task(4, 'Write docs'), task(5, 'Fix login')]);
    await ready();
    await screen.findByRole('list', { name: 'Open tasks' });
    fireEvent.contextMenu(screen.getByRole('link', { name: /Write docs/ }));
    const menu = await screen.findByRole('menu', { name: 'WEB-4 actions' });
    await user.click(await within(menu).findByRole('menuitem', { name: 'Mark done' }));
    await waitFor(() =>
      expect(sent.find((call) => call.path === '/api/tasks/task4/move')?.body).toEqual({
        statusId: 's-archive',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Write docs')).not.toBeInTheDocument());
  });

  it('keeps the task and says why when the pipeline refuses the move', async () => {
    const user = userEvent.setup();
    renderTaskRail([task(4, 'Write docs')], {
      status: 409,
      body: { error: { code: 'conflict', message: 'Tasks move one stage at a time.' } },
    });
    await screen.findByRole('list', { name: 'Open tasks' });
    fireEvent.contextMenu(screen.getByRole('link', { name: /Write docs/ }));
    const menu = await screen.findByRole('menu', { name: 'WEB-4 actions' });
    await user.click(await within(menu).findByRole('menuitem', { name: 'Mark done' }));
    expect(
      await screen.findByText('Can’t mark WEB-4 done: Tasks move one stage at a time.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Write docs')).toBeInTheDocument();
  });

  it('picks the last finishing stage of the task’s own pipeline', () => {
    const other = { ...stage('s-x', 'Other done', 9, true), pipelineId: 'pl2' };
    expect(finishingStage([todo, doing, done, archive, other], task(1, 'x'))?.id).toBe('s-archive');
    const noFinish = [todo, doing].map((status) => ({ ...status }));
    expect(finishingStage(noFinish, task(1, 'x'))?.id).toBe('s-doing');
  });
});

describe('sortByActivity', () => {
  it('orders newest activity first and keeps ties in order', () => {
    const items = [
      { id: 'a', activityAt: '2026-09-01T00:00:00.000Z' },
      { id: 'b', activityAt: '2026-09-03T00:00:00.000Z' },
      { id: 'c', activityAt: '2026-09-01T00:00:00.000Z' },
    ];
    expect(sortByActivity(items).map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });
});
