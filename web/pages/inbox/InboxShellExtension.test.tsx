import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Outlet } from 'react-router';
import type { LiveEvent } from '@shared/events';
import type { Notification } from '@shared/schemas/core';
import { connectLiveEvents } from '@web/lib/live';
import { FakeEventSource, mockApi, testMe } from '@web/test/mockApi';
import { renderWorkPage, requestUrl } from '@web/pages/my-tasks/testing';
import InboxShellExtension from './InboxShellExtension';

let disconnect: (() => void) | undefined;

afterEach(() => {
  toast.dismiss();
  disconnect?.();
  vi.unstubAllGlobals();
});

const note: Notification = {
  id: 'n9',
  teamId: 't1',
  type: 'mention',
  entityType: 'task',
  entityId: 'task1',
  actor: { id: 'u2', username: 'ada', name: 'Ada Lovelace', image: null },
  viaKeyName: null,
  title: 'WEB-12: Fix login',
  snippet: 'hey @me',
  url: '/t/acme/p/WEB/tasks/12',
  readAt: null,
  createdAt: new Date().toISOString(),
};

const created: LiveEvent = {
  type: 'notification.created',
  teamId: 't1',
  entityType: 'notification',
  entityId: 'n9',
  actorId: 'u2',
  userId: 'u1',
  at: new Date().toISOString(),
};

function setup(path: string, id = note.id) {
  const fetchMock = mockApi({
    '/api/me': testMe(),
    '/api/notifications/unread-count': { count: 1 },
    '/api/notifications': { items: [{ ...note, id }], nextCursor: null },
    'POST /api/notifications/read': { updated: 1 },
  });
  // Mounted around every page, like the shell does.
  const view = renderWorkPage(
    <>
      <InboxShellExtension />
      <Outlet />
    </>,
    '/',
    path,
    [{ path: '*', element: <p>Page</p> }],
  );
  disconnect = connectLiveEvents({
    queryClient: view.queryClient,
    createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
  });
  const source = FakeEventSource.instances.at(-1);
  source?.open();
  return { ...view, fetchMock, source };
}

describe('InboxShellExtension', () => {
  it('toasts a new notification with an Open action that marks it read', async () => {
    const { source, router, fetchMock } = setup('/');
    // Wait for the viewer to be known before the event arrives.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === '/api/me')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    source?.emit(created);

    expect(await screen.findByText('Ada Lovelace mentioned you')).toBeInTheDocument();
    expect(screen.getByText('WEB-12: Fix login')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    expect(router.state.location.pathname).toBe('/t/acme/p/WEB/tasks/12');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            requestUrl(input) === '/api/notifications/read' &&
            init?.body === JSON.stringify({ ids: ['n9'] }),
        ),
      ).toBe(true),
    );
  });

  it('stays quiet on the inbox, which updates in place', async () => {
    const { source, fetchMock, router } = setup('/inbox', 'n10');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === '/api/me')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    source?.emit({ ...created, entityId: 'n10' });
    // BAT-2: it is looked up (for the chime), but the inbox shows it in place: no toast.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => requestUrl(input).startsWith('/api/notifications?')),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Ada Lovelace mentioned you')).not.toBeInTheDocument();

    // Elsewhere, the same listener toasts.
    await act(() => router.navigate('/my-tasks'));
    source?.emit({ ...created, entityId: 'n10', at: new Date().toISOString() });
    expect(await screen.findByText('Ada Lovelace mentioned you')).toBeInTheDocument();
  });
});
