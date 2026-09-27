import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, ReplyNode } from '@shared/schemas/core';
import { createQueryClient } from '@web/lib/queryClient';
import { mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';
import { ActivitySheet } from './ActivitySheet';
import { Timeline } from './Timeline';

const ada = { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null };

function entry(id: string, action: string, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    teamId: 't1',
    projectId: 'p1',
    actor: { user: ada, via: null, source: 'web' },
    entityType: 'task',
    entityId: 'task1',
    action,
    changes: {},
    meta: {},
    url: null,
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

const reply: ReplyNode = {
  id: 'r1',
  teamId: 't1',
  projectId: 'p1',
  parentType: 'task',
  parentId: 'task1',
  parentReplyId: null,
  body: 'Looks good to me',
  author: ada,
  via: null,
  reactions: [],
  attachments: [],
  createdAt: '2026-09-24T10:05:00.000Z',
  updatedAt: '2026-09-24T10:05:00.000Z',
  editedAt: null,
  deleted: false,
  replyCount: 0,
  depth: 0,
};

function renderPage() {
  mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': testMe(),
    '/api/config': testConfig,
    '/api/notifications/unread-count': { count: 0 },
    '/api/teams/t1/mentionables': { users: [], roles: [] },
    '/api/replies': { items: [reply], total: 1, topLevelCount: 1, ancestors: [] },
    '/api/activity': {
      items: [
        entry('created', 'task.created'),
        entry('replied', 'reply.created', { createdAt: '2026-09-24T10:05:00.000Z' }),
        entry('moved', 'task.updated', {
          changes: { status: { from: 'Open', to: 'Done' } },
          createdAt: '2026-09-24T10:10:00.000Z',
        }),
      ],
    },
  });
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <>
          <ActivitySheet parentType="task" parentId="task1" itemRef="API-1" group="Task" />
          <Timeline parentType="task" parentId="task1" />
        </>
      ),
    },
  ]);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ActivitySheet', { timeout: 20_000 }, () => {
  it('keeps the history out of the conversation and shows it in a drawer', async () => {
    const user = userEvent.setup();
    renderPage();

    const conversation = await screen.findByRole('list', { name: 'Conversation' });
    expect(within(conversation).getByText('Looks good to me')).toBeInTheDocument();
    expect(screen.queryByText(/Open/)).not.toBeInTheDocument();

    const button = await screen.findByRole('button', { name: 'Activity: 2 entries' });
    await user.click(button);
    const history = await screen.findByRole('list', { name: 'History' });
    const rows = within(history).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Done');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('list', { name: 'History' })).not.toBeInTheDocument();

    // `h` opens it from the keyboard.
    await user.keyboard('h');
    expect(await screen.findByRole('list', { name: 'History' })).toBeInTheDocument();
  });
});
