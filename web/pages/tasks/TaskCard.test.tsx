import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TaskCard } from '@shared/schemas/tasks';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { TaskCardBody } from './TaskCard';

const base: TaskCard = {
  id: 't1',
  ref: 'API-7',
  number: 7,
  title: 'Fix the login redirect',
  projectId: 'p',
  teamId: 't',
  status: { id: 's', name: 'Todo', color: '#0ea5e9', icon: 'circle' },
  priority: 4,
  dueDate: '2020-01-01',
  labels: [{ id: 'l', name: 'Bug', color: '#ef4444' }],
  assignees: {
    users: [{ id: 'u', username: 'mia', name: 'Mia', image: null }],
    roles: [{ id: 'r', slug: 'backend', name: 'Backend', color: null }],
  },
  claim: {
    user: { id: 'u', username: 'mia', name: 'Mia', image: null },
    via: { keyId: 'k', keyName: 'Claude on laptop' },
    claimedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
  },
  blocked: true,
  replyCount: 3,
  updatedAt: new Date().toISOString(),
  position: 'a0',
  blockers: ['API-3'],
  createdAt: new Date().toISOString(),
  completedAt: null,
  path: '/t/acme/p/API/tasks/7',
};

describe('TaskCardBody', () => {
  it('shows everything a card needs, with text for every visual signal', () => {
    render(
      <TooltipProvider>
        <TaskCardBody task={base} />
      </TooltipProvider>,
    );
    expect(screen.getByText('API-7')).toBeInTheDocument();
    expect(screen.getByText('Fix the login redirect')).toBeInTheDocument();
    expect(screen.getByText('Blocked by API-3')).toBeInTheDocument();
    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(screen.getByText('Bug')).toBeInTheDocument();
    expect(screen.getByText('(overdue)')).toBeInTheDocument();
    expect(screen.getByText('replies')).toBeInTheDocument();
    expect(screen.getByText('Assigned to Mia')).toBeInTheDocument();
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText(/Mia via Claude on laptop claimed this/)).toBeInTheDocument();
  });

  it('shows the viewer’s unread notifications as a counted badge (BAT-16)', () => {
    const { rerender } = render(
      <TooltipProvider>
        <TaskCardBody task={{ ...base, unreadCount: 2 }} />
      </TooltipProvider>,
    );
    const badge = screen.getByRole('img', { name: '2 unread notifications' });
    expect(badge).toHaveTextContent('2');
    rerender(
      <TooltipProvider>
        <TaskCardBody task={{ ...base, unreadCount: 0 }} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('img', { name: /unread/ })).not.toBeInTheDocument();
  });

  it('never shows finished tasks as overdue, and leaves out empty parts', () => {
    render(
      <TooltipProvider>
        <TaskCardBody
          task={{
            ...base,
            status: { id: 'd', name: 'Done', color: '#22c55e', icon: 'check-circle' },
            completedAt: '2030-01-02T00:00:00.000Z',
            blocked: false,
            blockers: [],
            claim: null,
            labels: [],
            replyCount: 0,
            assignees: { users: [], roles: [] },
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByText('(overdue)')).not.toBeInTheDocument();
    expect(screen.queryByText(/Blocked/)).not.toBeInTheDocument();
    expect(screen.queryByText(/claimed this/)).not.toBeInTheDocument();
  });
});
