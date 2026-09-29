import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { IssueSummary } from '@shared/schemas/issues';
import { createQueryClient } from '@web/lib/queryClient';
import { IssueRow } from '@web/pages/issues/IssueRow';
import { UnreadBadge } from './UnreadBadge';

describe('UnreadBadge (BAT-16)', () => {
  it('shows the count with a label, and nothing at zero', () => {
    const { rerender } = render(<UnreadBadge count={1} />);
    expect(screen.getByRole('img', { name: '1 unread notification' })).toHaveTextContent('1');
    rerender(<UnreadBadge count={120} />);
    expect(screen.getByRole('img', { name: '120 unread notifications' })).toHaveTextContent('99+');
    rerender(<UnreadBadge count={0} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    rerender(<UnreadBadge />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('marks issue rows with unread notifications', () => {
    const issue: IssueSummary = {
      id: 'i1',
      teamId: 't1',
      projectId: 'p1',
      number: 12,
      ref: 'WEB#12',
      title: 'Export fails',
      resolved: false,
      resolvedAt: null,
      labels: [],
      author: null,
      via: null,
      replyCount: 3,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      editedAt: null,
      path: '/t/acme/p/WEB/issues/12',
      unreadCount: 2,
    };
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ul>
            <IssueRow issue={issue} selected={false} onFocus={() => undefined} />
          </ul>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('img', { name: '2 unread notifications' })).toBeInTheDocument();
  });
});
