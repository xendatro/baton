import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@shared/schemas/core';
import type { DashboardResponse } from '@shared/schemas/work';
import { mockApi, testMe } from '@web/test/mockApi';
import { myTask, renderWorkPage, requestUrl } from '@web/pages/my-tasks/testing';
import DashboardPage from './DashboardPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mia = { id: 'u2', username: 'mia', name: 'Mia Chen', image: null };

const activity: ActivityEntry = {
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
};

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    today: '2026-03-10',
    counts: { assigned: 12, overdue: 1, dueSoon: 0, claimed: 1 },
    assigned: [myTask(), myTask({ id: 'task2', ref: 'WEB-2', number: 2, title: 'Add dark mode' })],
    overdue: [myTask({ id: 'task3', title: 'Write the report', dueDate: '2026-03-01' })],
    dueSoon: [],
    claimed: [
      myTask({
        id: 'task4',
        title: 'Refactor auth',
        claim: {
          user: mia,
          via: { keyId: 'k1', keyName: 'Codex desktop' },
          claimedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      }),
    ],
    activity: [activity],
    teams: [
      {
        id: 't1',
        slug: 'acme',
        name: 'Acme',
        icon: null,
        color: '#6366f1',
        memberCount: 4,
        url: '/t/acme',
        projects: [
          {
            id: 'p1',
            key: 'WEB',
            name: 'Web app',
            icon: null,
            color: '#0ea5e9',
            description: '',
            assignedTasks: 7,
            openTasks: 9,
            openIssues: 2,
            url: '/t/acme/p/WEB',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('DashboardPage', () => {
  it('greets the user and shows their work, activity and teams', async () => {
    mockApi({ '/api/me': testMe(), '/api/me/dashboard': dashboard() });
    renderWorkPage(<DashboardPage />, '/');

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByText(/Good (morning|afternoon|evening), Ada\./)).toBeInTheDocument();

    expect(await screen.findByRole('link', { name: /Assigned to you: 12/ })).toHaveAttribute(
      'href',
      '/my-tasks',
    );
    expect(screen.getByRole('link', { name: /Overdue: 1/ })).toHaveAttribute(
      'href',
      '/my-tasks?due=overdue',
    );

    const assigned = screen.getByRole('region', { name: 'Assigned to you' });
    expect(within(assigned).getByRole('link', { name: /Fix login/ })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/tasks/1',
    );
    expect(within(assigned).getByText('10 more tasks in My tasks')).toBeInTheDocument();

    const due = screen.getByRole('region', { name: 'Overdue and due soon' });
    expect(within(due).getByText('Write the report')).toBeInTheDocument();

    const claimed = screen.getByRole('region', { name: 'Claimed by you and your agents' });
    expect(within(claimed).getByText('Refactor auth')).toBeInTheDocument();
    expect(within(claimed).getAllByText(/Codex desktop/).length).toBeGreaterThan(0);

    const feed = screen.getByRole('list', { name: 'Recent activity' });
    expect(feed).toHaveTextContent('Mia Chen');
    expect(feed).toHaveTextContent('moved WEB-12 from Open to Done');
    expect(feed).toHaveTextContent('Acme · Web app');
    expect(within(feed).getByRole('link', { name: 'WEB-12' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/tasks/12',
    );

    const teams = screen.getByRole('region', { name: 'Teams and projects' });
    expect(within(teams).getByRole('link', { name: /Web app/ })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB',
    );
  });

  it('shows calm empty states when nothing needs attention', async () => {
    mockApi({
      '/api/me': testMe(),
      '/api/me/dashboard': dashboard({
        counts: { assigned: 0, overdue: 0, dueSoon: 0, claimed: 0 },
        assigned: [],
        overdue: [],
        claimed: [],
        activity: [],
      }),
    });
    renderWorkPage(<DashboardPage />, '/');
    expect(
      await screen.findByText('Nothing is assigned to you or your roles right now.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse Web app' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/tasks',
    );
    expect(
      screen.getByText('Nothing overdue, and nothing due in the next 7 days.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/No active claims/)).toBeInTheDocument();
  });

  it('welcomes a user without teams and joins with a pasted invite link', async () => {
    const fetchMock = mockApi({ '/api/me': { ...testMe(), teams: [] } });
    const user = userEvent.setup();
    const { router } = renderWorkPage(<DashboardPage />, '/');

    expect(
      await screen.findByRole('heading', { name: 'Welcome to Baton, Ada' }),
    ).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Invite link or code' });
    await user.type(input, 'not a link');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Paste an invite link/);

    await user.clear(input);
    await user.type(input, 'https://baton.example/join/AbCd123456');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(router.state.location.pathname).toBe('/join/AbCd123456');
    // No dashboard request without teams.
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/api/me/dashboard')),
    ).toBe(false);
  });

  it('offers a retry when the dashboard fails to load', async () => {
    mockApi({
      '/api/me': testMe(),
      '/api/me/dashboard': () =>
        // A client error, so the query client does not retry it.
        new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Nope' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    renderWorkPage(<DashboardPage />, '/');
    expect(await screen.findByText('Couldn’t load your dashboard')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
