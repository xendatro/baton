import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse, Notification, NotificationCountsResponse } from '@shared/schemas/core';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { renderWorkPage, requestUrl } from '@web/pages/my-tasks/testing';
import InboxPage from './InboxPage';

/** BAT-34: the inbox filtered by team and project, with counts, remembered per person. */

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const base = testMe();
const me: MeResponse = {
  ...base,
  teams: [
    {
      ...base.teams[0]!,
      projects: [
        { id: 'p1', key: 'WEB', name: 'Web app', icon: null, color: '#0ea5e9' },
        { id: 'p2', key: 'API', name: 'Api server', icon: null, color: '#22c55e' },
      ],
    },
    {
      id: 't2',
      slug: 'labs',
      name: 'Labs',
      icon: null,
      color: '#f59e0b',
      isOwner: false,
      permissions: [],
      projects: [{ id: 'p3', key: 'OPS', name: 'Ops', icon: null, color: '#ef4444' }],
    },
  ],
};

function notification(id: string, teamId: string, projectId: string, key: string): Notification {
  return {
    id,
    teamId,
    projectId,
    type: 'reply',
    entityType: 'task',
    entityId: `task-${id}`,
    actor: { id: 'u2', username: 'bo', name: 'Bo', image: null },
    viaKeyName: null,
    title: `${key}-1: Something in ${key}`,
    snippet: '',
    url: `/t/${teamId === 't1' ? 'acme' : 'labs'}/p/${key}/tasks/1`,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
}

const all = [
  notification('n1', 't1', 'p1', 'WEB'),
  notification('n2', 't1', 'p2', 'API'),
  notification('n3', 't2', 'p3', 'OPS'),
];

const counts: NotificationCountsResponse = {
  teams: [
    { teamId: 't1', total: 2, unread: 2 },
    { teamId: 't2', total: 1, unread: 1 },
  ],
  projects: [
    { teamId: 't1', projectId: 'p1', total: 1, unread: 1 },
    { teamId: 't1', projectId: 'p2', total: 1, unread: 1 },
    { teamId: 't2', projectId: 'p3', total: 1, unread: 1 },
  ],
};

function setup() {
  return mockApi({
    '/api/me': me,
    '/api/notifications/unread-count': { count: 3 },
    '/api/notifications/counts': counts,
    '/api/notifications': ({ url }: { url: URL }) => {
      const teamId = url.searchParams.get('teamId');
      const projectId = url.searchParams.get('projectId');
      return jsonResponse({
        items: all.filter(
          (item) =>
            (!teamId || item.teamId === teamId) && (!projectId || item.projectId === projectId),
        ),
        nextCursor: null,
      });
    },
    'POST /api/notifications/read': { updated: 1 },
  });
}

describe('Inbox filters', () => {
  it('filters by team and project with counts, and marks only the filtered ones read', async () => {
    const fetchMock = setup();
    const user = userEvent.setup();
    const { unmount } = renderWorkPage(<InboxPage />, '/inbox');
    expect(await screen.findAllByTestId('notification')).toHaveLength(3);

    const team = await screen.findByRole('combobox', { name: 'Team' });
    expect([...(team as HTMLSelectElement).options].map((option) => option.text)).toEqual([
      'All teams (3)',
      'Acme (2)',
      'Labs (1)',
    ]);
    await user.selectOptions(team, 't1');
    await waitFor(() => expect(screen.getAllByTestId('notification')).toHaveLength(2));
    const project = screen.getByRole('combobox', { name: 'Project' });
    expect([...(project as HTMLSelectElement).options].map((option) => option.text)).toEqual([
      'All projects (2)',
      'Web app (1)',
      'Api server (1)',
    ]);
    await user.selectOptions(project, 'p2');
    await waitFor(() => expect(screen.getAllByTestId('notification')).toHaveLength(1));
    expect(screen.getByTestId('notification')).toHaveTextContent('API-1: Something in API');
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('teamId=t1&projectId=p2')),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls
          .filter(([input, init]) => requestUrl(input) === '/api/notifications/read' && init)
          .map(([, init]) => JSON.parse(init?.body as string) as unknown),
      ).toEqual([{ all: true, teamId: 't1', projectId: 'p2' }]),
    );

    // Remembered for this person: the inbox opens filtered next time.
    unmount();
    renderWorkPage(<InboxPage />, '/inbox');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('p2'),
    );
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getAllByTestId('notification')).toHaveLength(3));
    expect(window.localStorage.getItem('baton.inbox.scope.u1')).toBeNull();
  });
});
