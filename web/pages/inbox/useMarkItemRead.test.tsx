import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { connectLiveEvents } from '@web/lib/live';
import { queryKeys } from '@web/lib/queryKeys';
import { FakeEventSource, jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { renderWorkPage, requestUrl } from '@web/pages/my-tasks/testing';
import InboxShellExtension from './InboxShellExtension';
import { isAboutItemOnScreen, useMarkItemRead } from './useMarkItemRead';

/** BAT-15: a task or issue page marks its notifications read while it is on screen. */

let visibility: DocumentVisibilityState = 'visible';
let disconnect: (() => void) | undefined;

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  disconnect?.();
  vi.unstubAllGlobals();
});

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function created(parentId: string, id = 'n1'): LiveEvent {
  return {
    type: 'notification.created',
    teamId: 't1',
    projectId: 'p1',
    entityType: 'notification',
    entityId: id,
    parentType: 'task',
    parentId,
    actorId: 'u2',
    userId: 'u1',
    at: new Date().toISOString(),
  };
}

function TaskProbe() {
  useMarkItemRead('task', { id: 'task1', projectId: 'p1' });
  return <p>Task page</p>;
}

function setup(withShell = false) {
  // Like the server: 3 unread until the item is marked read, which reads 2 of them.
  let marked = false;
  const fetchMock = mockApi({
    '/api/me': testMe(),
    '/api/notifications/unread-count': () => jsonResponse({ count: marked ? 1 : 3 }),
    '/api/notifications': { items: [], nextCursor: null },
    'POST /api/notifications/read': () => {
      marked = true;
      return jsonResponse({ updated: 2 });
    },
  });
  const view = renderWorkPage(
    <>
      {withShell ? <InboxShellExtension /> : null}
      <TaskProbe />
    </>,
    '/',
  );
  disconnect = connectLiveEvents({
    queryClient: view.queryClient,
    createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
  });
  const source = FakeEventSource.instances.at(-1);
  source?.open();
  const markCalls = () =>
    fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input) === '/api/notifications/read' &&
        init?.method === 'POST' &&
        init.body === JSON.stringify({ item: { type: 'task', id: 'task1' } }),
    ).length;
  const showThread = () =>
    act(() => {
      view.queryClient.setQueryData(queryKeys.replies.list('task', 'task1'), { items: [] });
    });
  return { ...view, fetchMock, source, markCalls, showThread };
}

describe('useMarkItemRead', () => {
  it('marks the item read once its thread is shown, and lowers the inbox count', async () => {
    const { markCalls, showThread, queryClient } = setup();
    queryClient.setQueryData(queryKeys.notifications.unreadCount(), { count: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(markCalls()).toBe(0);

    showThread();
    await waitFor(() => expect(markCalls()).toBe(1));
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.notifications.unreadCount())).toEqual({
        count: 1,
      }),
    );
  });

  it('marks notifications arriving while visible, and waits for a hidden tab to be shown', async () => {
    const { markCalls, showThread, source } = setup();
    showThread();
    await waitFor(() => expect(markCalls()).toBe(1));

    // About the item on screen: marked at once. About another item: left alone.
    act(() => source?.emit(created('task1')));
    await waitFor(() => expect(markCalls()).toBe(2));
    act(() => source?.emit(created('task2', 'n2')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(markCalls()).toBe(2);

    // A background tab leaves it unread until it is visible again.
    setVisibility('hidden');
    act(() => source?.emit(created('task1', 'n3')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(markCalls()).toBe(2);
    setVisibility('visible');
    await waitFor(() => expect(markCalls()).toBe(3));

    // Becoming visible again with nothing new doesn't call the server.
    setVisibility('hidden');
    setVisibility('visible');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(markCalls()).toBe(3);
  });

  it('tells the inbox which notifications are about the item on screen', () => {
    const { showThread } = setup();
    expect(isAboutItemOnScreen({ parentType: 'task', parentId: 'task1' })).toBe(false);
    showThread();
    expect(isAboutItemOnScreen({ parentType: 'task', parentId: 'task1' })).toBe(true);
    expect(isAboutItemOnScreen({ parentType: 'issue', parentId: 'task1' })).toBe(false);
    expect(isAboutItemOnScreen({ parentType: 'task', parentId: 'task2' })).toBe(false);
    visibility = 'hidden';
    expect(isAboutItemOnScreen({ parentType: 'task', parentId: 'task1' })).toBe(false);
  });

  it('keeps the inbox quiet about the item on screen', async () => {
    const { showThread, source, fetchMock } = setup(true);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === '/api/me')).toBe(true),
    );
    showThread();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lookups = () =>
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).startsWith('/api/notifications?'))
        .length;
    act(() => source?.emit(created('task1')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No lookup: no toast, chime or desktop notification for it.
    expect(lookups()).toBe(0);
    act(() => source?.emit(created('task2', 'n2')));
    await waitFor(() => expect(lookups()).toBe(1));
  });
});
