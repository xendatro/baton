import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { IssueSummary } from '@shared/schemas/issues';
import { createQueryClient } from '@web/lib/queryClient';
import { IssueRow } from '@web/pages/issues/IssueRow';
import { WorkingDot } from './WorkingDot';
import { workingLabel } from './workingLabel';

describe('WorkingDot (BAT#42)', () => {
  it('names the working agents in its label and tooltip', () => {
    render(<WorkingDot working={{ agentIds: ['a'], names: ['Ethan AI'] }} />);
    const dot = screen.getByRole('img', { name: 'Ethan AI is working' });
    expect(dot).toHaveAttribute('title', 'Ethan AI is working');
  });

  it('renders nothing when no agent works on the item', () => {
    const { container, rerender } = render(<WorkingDot working={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<WorkingDot working={{ agentIds: [], names: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pulses slowly, and holds still with reduced motion', () => {
    render(<WorkingDot working={{ agentIds: ['a'], names: ['Ethan AI'] }} />);
    const pulse = screen.getByTestId('working-dot').firstElementChild;
    expect(pulse).toHaveClass('animate-working-pulse', 'motion-reduce:animate-none');
  });

  it('words several agents', () => {
    expect(workingLabel(['Ethan AI', 'Caden AI'])).toBe('Ethan AI and Caden AI are working');
    expect(workingLabel(['Ethan AI', 'Caden AI', 'Mia AI'])).toBe(
      'Ethan AI and 2 others are working',
    );
  });

  it('marks issue rows an agent works on', () => {
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
      agentWorking: { agentIds: ['a'], names: ['Ethan AI'] },
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
    expect(screen.getByRole('img', { name: 'Ethan AI is working' })).toBeInTheDocument();
  });
});
