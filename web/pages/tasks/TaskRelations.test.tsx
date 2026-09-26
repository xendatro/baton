import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkedIssue, Task } from '@shared/schemas/tasks';
import { createQueryClient } from '@web/lib/queryClient';
import { mockApi, testMe } from '@web/test/mockApi';
import { TaskRelations } from './TaskRelations';

afterEach(() => {
  vi.unstubAllGlobals();
});

function issue(overrides: Partial<LinkedIssue>): LinkedIssue {
  return {
    id: 'i1',
    ref: 'WEB#7',
    number: 7,
    title: 'Board overflows',
    resolved: false,
    kind: 'fixes',
    projectId: 'p1',
    path: '/t/acme/p/WEB/issues/7',
    ...overrides,
  };
}

describe('TaskRelations', () => {
  it('marks linked issues like the issues module: shape and label, not color alone (UX-11)', () => {
    mockApi({ '/api/me': testMe() });
    // Only the fields the relations panel reads.
    const task = {
      id: 't1',
      teamId: 't1',
      projectId: 'p1',
      blockedBy: [],
      blocking: [],
      issues: [
        issue({}),
        issue({ id: 'i2', ref: 'WEB#8', number: 8, title: 'Fixed one', resolved: true }),
      ],
    } as unknown as Task;
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <TaskRelations task={task} editable={false} onChange={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const [open, resolved] = screen.getAllByRole('listitem');
    const openIcon = within(open as HTMLElement).getByRole('img', { name: 'Open' });
    const resolvedIcon = within(resolved as HTMLElement).getByRole('img', { name: 'Resolved' });
    // Open issues are the accent color's circle-dot; resolved ones a green check.
    expect(openIcon).toHaveClass('lucide-circle-dot', 'text-primary');
    expect(resolvedIcon).toHaveClass('text-emerald-600');
    expect(resolvedIcon.getAttribute('class')).toMatch(/lucide-circle-check/);
  });
});
