import { QueryClientProvider, useQuery, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/schemas/tasks';
import { AssigneePicker } from '@web/components/pickers/AssigneePicker';
import { createQueryClient } from '@web/lib/queryClient';
import { queryKeys } from '@web/lib/queryKeys';
import { jsonResponse } from '@web/test/mockApi';
import { useToggleAssignee } from './queries';

/** The task page's Assignees picker: each toggle is its own add/remove, applied at once. */

const NOW = '2026-09-27T10:00:00.000Z';
const ann = { id: 'u2', username: 'ann', name: 'Ann', image: null };
const bob = { id: 'u3', username: 'bob', name: 'Bob', image: null };
const cal = { id: 'u4', username: 'cal', name: 'Cal', image: null };
const backend = { id: 'r1', slug: 'backend', name: 'Backend', color: null };

const base: Task = {
  id: 't1',
  ref: 'API-7',
  number: 7,
  title: 'Ship it',
  projectId: 'p1',
  teamId: 'team1',
  status: { id: 's-review', name: 'In Review', color: '#8b5cf6', icon: 'circle' },
  priority: 0,
  dueDate: null,
  labels: [],
  assignees: { users: [cal], roles: [] },
  claim: null,
  blocked: false,
  replyCount: 0,
  updatedAt: NOW,
  position: 'a0',
  blockers: [],
  createdAt: NOW,
  completedAt: null,
  path: '/t/acme/p/API/tasks/7',
  description: '',
  teamSlug: 'acme',
  projectKey: 'API',
  author: null,
  via: null,
  editedAt: null,
  lastActivityAt: NOW,
  blockedBy: [],
  blocking: [],
  issues: [],
  attachments: [],
  reactions: [],
  subscribed: false,
};
const key = queryKeys.tasks.detail(base.projectId, base.number);

function Harness() {
  const task = useQuery<Task>({ queryKey: key, enabled: false }).data ?? base;
  const toggle = useToggleAssignee(task);
  return (
    <AssigneePicker
      users={[ann, bob, cal]}
      roles={[backend]}
      value={{
        userIds: task.assignees.users.map((user) => user.id),
        roleIds: task.assignees.roles.map((role) => role.id),
      }}
      open
      note={`Assigned in ${task.status.name}`}
      onToggle={(change) => void toggle.mutateAsync(change).catch(() => undefined)}
    />
  );
}

/** Each PATCH waits until the test answers it. */
function deferredFetch() {
  const pending: Array<{ body: unknown; answer: (response: Response) => void }> = [];
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve) => {
      pending.push({
        body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
        answer: resolve,
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, pending };
}

function setup(): QueryClient {
  const client = createQueryClient();
  client.setQueryData(key, base);
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return client;
}

const selected = (name: string) =>
  screen.getByRole('option', { name: new RegExp(name) }).textContent?.includes('(selected)');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assigning from the task page', () => {
  it('applies each toggle at once as its own add/remove request', async () => {
    const user = userEvent.setup();
    const { fetchMock, pending } = deferredFetch();
    const client = setup();
    expect(screen.getByText('Assigned in In Review')).toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /Ann/ }));
    await user.click(screen.getByRole('option', { name: /Backend/ }));
    await user.click(screen.getByRole('option', { name: /Cal/ }));

    // Shown right away, before any response, and the picker stays open for more.
    expect(selected('Ann')).toBe(true);
    expect(selected('Backend')).toBe(true);
    expect(selected('Cal')).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(pending.map((request) => request.body)).toEqual([
      { assigneeUsers: { add: ['u2'] } },
      { assigneeRoles: { add: ['r1'] } },
      { assigneeUsers: { remove: ['u4'] } },
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'PATCH')).toBe(true);

    // An earlier response (it only knows the first toggle) doesn't hide the later ones.
    pending[0]?.answer(jsonResponse({ ...base, assignees: { users: [cal, ann], roles: [] } }));
    await waitFor(() => expect(client.isMutating()).toBe(2));
    expect(selected('Backend')).toBe(true);
    expect(selected('Cal')).toBe(false);

    pending[1]?.answer(
      jsonResponse({ ...base, assignees: { users: [cal, ann], roles: [backend] } }),
    );
    pending[2]?.answer(jsonResponse({ ...base, assignees: { users: [ann], roles: [backend] } }));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(client.getQueryData<Task>(key)?.assignees).toEqual({ users: [ann], roles: [backend] });
  });

  it('rolls back only the toggle that failed', async () => {
    const user = userEvent.setup();
    const { pending } = deferredFetch();
    const client = setup();

    await user.click(screen.getByRole('option', { name: /Ann/ }));
    await user.click(screen.getByRole('option', { name: /Bob/ }));
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]?.answer(
      jsonResponse({ error: { code: 'forbidden', message: 'You can’t assign Bob' } }, 403),
    );
    await waitFor(() => expect(selected('Bob')).toBe(false));
    expect(selected('Ann')).toBe(true);

    pending[0]?.answer(jsonResponse({ ...base, assignees: { users: [cal, ann], roles: [] } }));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(selected('Ann')).toBe(true);
    expect(selected('Cal')).toBe(true);
  });
});
