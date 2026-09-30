import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@shared/permissions';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import type { BoardResponse, TaskCard } from '@shared/schemas/tasks';
import { queryKeys } from '@web/lib/queryKeys';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { renderWorkPage } from '../my-tasks/testing';
import { Board } from './Board';

/** Right-click a board card: Move to (strict moves), Assign to me, Claim, Copy, Delete. */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stage(id: string, name: string, position: number, sendBackTo: string[] = []): Status {
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
    rules: { ...DEFAULT_STAGE_RULES, sendBackTo, allowCreate: position === 0 },
  };
}

const todo = stage('s-todo', 'Todo', 0);
const doing = stage('s-doing', 'Doing', 1, ['s-todo']);
const review = stage('s-review', 'Review', 2, ['s-todo', 's-doing']);

const card: TaskCard = {
  id: 'task1',
  ref: 'WEB-7',
  number: 7,
  title: 'Fix the login redirect',
  projectId: 'p1',
  teamId: 't1',
  status: { id: doing.id, name: doing.name, color: doing.color, icon: doing.icon },
  priority: 0,
  dueDate: null,
  labels: [],
  assignees: { users: [], roles: [] },
  claim: null,
  blocked: false,
  replyCount: 0,
  updatedAt: new Date().toISOString(),
  position: 'a0',
  blockers: [],
  createdAt: new Date().toISOString(),
  completedAt: null,
  path: '/t/acme/p/WEB/tasks/7',
};

const board: BoardResponse = {
  columns: [
    { status: todo, count: 0, tasks: [] },
    { status: doing, count: 1, tasks: [card] },
    { status: review, count: 0, tasks: [] },
  ],
  total: 1,
};

function renderBoard() {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const record =
    (answer: unknown) =>
    ({ url, init }: { url: URL; init?: RequestInit }) => {
      sent.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return jsonResponse(answer);
    };
  const moved = { ...card, status: { ...card.status, id: review.id, name: 'Review' } };
  mockApi({
    // Like the server: an administrator's list is every permission.
    '/api/me': {
      ...testMe(),
      teams: testMe().teams.map((team) => ({ ...team, permissions: [...PERMISSIONS] })),
    },
    'POST /api/tasks/task1/move': record(moved),
    'PATCH /api/tasks/task1': record(card),
    'POST /api/tasks/task1/claim': record(card),
    '/api/teams/t1/members': {
      items: [
        {
          user: { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null },
          joinedAt: '2026-09-01T10:00:00.000Z',
          isOwner: true,
          roles: [],
          color: null,
        },
        {
          user: { id: 'u2', username: 'mia', name: 'Mia Chen', image: null },
          joinedAt: '2026-09-01T10:00:00.000Z',
          isOwner: false,
          roles: [],
          color: null,
        },
      ],
    },
    '/api/teams/t1/roles': {
      items: [
        {
          id: 'r1',
          teamId: 't1',
          name: 'Backend',
          slug: 'backend',
          color: null,
          position: 1,
          permissions: [],
          mentionable: true,
          hoist: false,
          isEveryone: false,
          memberCount: 1,
          createdAt: '2026-09-01T10:00:00.000Z',
          updatedAt: '2026-09-01T10:00:00.000Z',
        },
      ],
    },
    '/api/projects/p1/labels': {
      items: [
        {
          id: 'l1',
          projectId: 'p1',
          name: 'bug',
          color: '#ef4444',
          description: '',
          issueCount: 0,
          taskCount: 0,
        },
      ],
    },
  });
  const onMove = vi.fn();
  const { queryClient, router } = renderWorkPage(
    <Board
      board={board}
      canMove
      canCreate
      onMove={onMove}
      onQuickAdd={vi.fn()}
      filtered={false}
      editStatusHref={(id) => `/t/acme/p/WEB/settings/pipelines?status=${id}`}
    />,
    '/t/acme/p/WEB/tasks',
  );
  // The menus follow the viewer's permissions, from `me`.
  const ready = () => waitFor(() => expect(queryClient.getQueryData(queryKeys.me())).toBeDefined());
  return { sent, ready, router };
}

describe('Task card right-click menu', () => {
  it('moves the task to its next stage', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderBoard();
    await ready();
    fireEvent.contextMenu(await screen.findByRole('link', { name: /WEB-7/ }));
    const menu = await screen.findByRole('menu', { name: 'WEB-7 actions' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Move to' }));
    const next = await screen.findByRole('menuitem', { name: /Review/ });
    expect(next).toHaveTextContent('Next');
    // Only the earlier stages Doing may send back to.
    expect(screen.getByRole('menuitem', { name: /Todo/ })).toHaveTextContent('Back…');
    // Radix submenus take the keyboard reliably in happy-dom.
    next.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        path: '/api/tasks/task1/move',
        body: { statusId: 's-review' },
      }),
    );
  });

  it('asks for the reason before a move back', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderBoard();
    await ready();
    fireEvent.contextMenu(await screen.findByRole('link', { name: /WEB-7/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to' }));
    const todoItem = await screen.findByRole('menuitem', { name: /Todo/ });
    todoItem.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(sent).toEqual([]);
    await user.type(within(dialog).getByRole('textbox'), 'Needs a test');
    await user.click(within(dialog).getByRole('button', { name: /Send back/ }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'POST',
        path: '/api/tasks/task1/move',
        body: { statusId: 's-todo', reason: 'Needs a test' },
      }),
    );
  });

  it('assigns the task to you and claims it', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderBoard();
    await ready();
    fireEvent.contextMenu(await screen.findByRole('link', { name: /WEB-7/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Assign to me' }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/api/tasks/task1',
        body: { assigneeUsers: { add: ['u1'] } },
      }),
    );
    fireEvent.contextMenu(screen.getByRole('link', { name: /WEB-7/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Claim' }));
    await waitFor(() =>
      expect(sent).toContainEqual({ method: 'POST', path: '/api/tasks/task1/claim', body: {} }),
    );
  });

  it('gives a column header New task here and Edit stage', async () => {
    const { ready } = renderBoard();
    await ready();
    fireEvent.contextMenu(await screen.findByRole('heading', { name: 'Todo' }));
    const menu = await screen.findByRole('menu', { name: 'Todo column actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['New task here…', 'Edit stage']);
  });

  it('adds a label from the Labels submenu', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderBoard();
    await ready();
    const cardLink = await screen.findByRole('link', { name: /WEB-7/ });
    fireEvent.contextMenu(cardLink);
    await user.click(await screen.findByRole('menuitem', { name: 'Labels' }));
    const bug = await screen.findByRole('menuitemcheckbox', { name: 'bug' });
    expect(bug).toHaveAttribute('aria-checked', 'false');
    // The viewer manages labels: New label… is offered too.
    expect(screen.getByRole('menuitem', { name: 'New label…' })).toBeInTheDocument();
    bug.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/api/tasks/task1',
        body: { labels: { add: ['l1'] } },
      }),
    );
    // The submenu stays open for the next label.
    expect(screen.getByRole('menuitemcheckbox', { name: 'bug' })).toBeInTheDocument();
  });
});

/** BAT#33: the "⋯" button in a card's corner opens the same actions, plus Rename, Priority, Assign. */
describe('Task card ⋯ menu', () => {
  it('opens the actions without opening the task', async () => {
    const user = userEvent.setup();
    const { ready, router } = renderBoard();
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Actions for WEB-7' }));
    // Radix names a dropdown after its trigger.
    const menu = await screen.findByRole('menu', { name: 'Actions for WEB-7' });
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    for (const name of ['Open', 'Copy link', 'Rename…', 'Move to', 'Priority', 'Assign', 'Labels'])
      expect(names.some((text) => text?.startsWith(name))).toBe(true);
    expect(router.state.location.pathname).toBe('/t/acme/p/WEB/tasks');
  });

  it('renames the task, checking the title inline first', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderBoard();
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Actions for WEB-7' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename WEB-7' });
    const input = within(dialog).getByRole('textbox', { name: 'Title' });
    expect(input).toHaveValue('Fix the login redirect');
    await user.clear(input);
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(sent).toEqual([]);
    await user.type(input, 'Fix the logout redirect');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/api/tasks/task1',
        body: { title: 'Fix the logout redirect' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('adds a person from the Assign submenu', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderBoard();
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Actions for WEB-7' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Assign' }));
    const mia = await screen.findByRole('menuitemcheckbox', { name: /Mia Chen/ });
    expect(mia).toHaveAttribute('aria-checked', 'false');
    // You first, then the others, then roles.
    expect(screen.getByRole('menuitemcheckbox', { name: /Ada Lovelace \(you\)/ })).toBeVisible();
    expect(screen.getByRole('menuitemcheckbox', { name: /Backend/ })).toBeVisible();
    mia.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/api/tasks/task1',
        body: { assigneeUsers: { add: ['u2'] } },
      }),
    );
  });

  it('sets the priority from the right-click menu too', async () => {
    const user = userEvent.setup();
    const { sent, ready } = renderBoard();
    await ready();
    fireEvent.contextMenu(await screen.findByRole('link', { name: /WEB-7/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Priority' }));
    expect(await screen.findByRole('menuitemradio', { name: 'No priority' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    high.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/api/tasks/task1',
        body: { priority: 3 },
      }),
    );
  });
});
