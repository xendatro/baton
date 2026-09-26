import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@shared/schemas/core';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { renderWorkPage, requestUrl } from '@web/pages/my-tasks/testing';
import InboxPage from './InboxPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ada = { id: 'u2', username: 'ada', name: 'Ada Lovelace', image: null };

function notification(overrides: Partial<Notification>): Notification {
  return {
    id: 'n1',
    teamId: 't1',
    type: 'assigned',
    entityType: 'task',
    entityId: 'task1',
    actor: ada,
    viaKeyName: null,
    title: 'WEB-12: Fix login',
    snippet: '',
    url: '/t/acme/p/WEB/tasks/12',
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const items = [
  notification({}),
  notification({
    id: 'n2',
    type: 'reply',
    viaKeyName: 'Claude on laptop',
    title: 'WEB#3: Crash on save',
    snippet: 'Fixed in the latest build.',
    url: '/t/acme/p/WEB/issues/3#reply-r1',
    readAt: new Date().toISOString(),
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  }),
];

function readBody(calls: ReadonlyArray<[RequestInfo | URL, RequestInit?]>) {
  return calls
    .filter(
      ([input, init]) => requestUrl(input) === '/api/notifications/read' && init?.method === 'POST',
    )
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);
}

describe('InboxPage', () => {
  it('lists notifications with who, what, where and when, and marks one read on open', async () => {
    const fetchMock = mockApi({
      '/api/me': testMe(),
      '/api/notifications/unread-count': { count: 1 },
      '/api/notifications': { items, nextCursor: null },
      'POST /api/notifications/read': { updated: 1 },
    });
    const user = userEvent.setup();
    const { router } = renderWorkPage(<InboxPage />, '/inbox');

    const rows = await screen.findAllByTestId('notification');
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(first).toHaveAttribute('data-unread', 'true');
    expect(first).toHaveTextContent('Ada Lovelaceassigned you');
    expect(first).toHaveTextContent('WEB-12: Fix login');
    expect(first).toHaveTextContent('Acme');
    expect(first).toHaveTextContent('Web app');
    expect(second).not.toHaveAttribute('data-unread');
    expect(second).toHaveTextContent('via Claude on laptop');
    expect(second).toHaveTextContent('Fixed in the latest build.');
    expect(screen.getByText('Today')).toBeInTheDocument();

    await user.click(within(first).getByRole('link'));
    await waitFor(() => expect(readBody(fetchMock.mock.calls)).toEqual([{ ids: ['n1'] }]));
    expect(router.state.location.pathname).toBe('/t/acme/p/WEB/tasks/12');
  });

  it('marks everything read', async () => {
    const fetchMock = mockApi({
      '/api/me': testMe(),
      '/api/notifications/unread-count': { count: 1 },
      '/api/notifications': { items, nextCursor: null },
      'POST /api/notifications/read': { updated: 1 },
    });
    const user = userEvent.setup();
    renderWorkPage(<InboxPage />, '/inbox');
    const button = await screen.findByRole('button', { name: 'Mark all as read' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(readBody(fetchMock.mock.calls)).toEqual([{ all: true }]));
    expect(await screen.findByText('All caught up')).toBeInTheDocument();
  });

  it('asks the server for unread ones only on the Unread tab and says when there are none', async () => {
    const fetchMock = mockApi({
      '/api/me': testMe(),
      '/api/notifications/unread-count': { count: 0 },
      '/api/notifications': ({ url }: { url: URL }) =>
        jsonResponse({
          items: url.searchParams.get('unread') === '1' ? [] : items,
          nextCursor: null,
        }),
    });
    const user = userEvent.setup();
    renderWorkPage(<InboxPage />, '/inbox');
    await screen.findAllByTestId('notification');
    await user.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('unread=1'))).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'View all notifications' }));
    expect(await screen.findAllByTestId('notification')).toHaveLength(2);
  });

  it('loads older notifications page by page', async () => {
    const fetchMock = mockApi({
      '/api/me': testMe(),
      '/api/notifications/unread-count': { count: 0 },
      '/api/notifications': ({ url }: { url: URL }) =>
        jsonResponse(
          url.searchParams.get('cursor') === 'next'
            ? {
                items: [
                  notification({
                    id: 'old',
                    title: 'An old one',
                    readAt: new Date().toISOString(),
                  }),
                ],
                nextCursor: null,
              }
            : { items: items.slice(1), nextCursor: 'next' },
        ),
    });
    const user = userEvent.setup();
    renderWorkPage(<InboxPage />, '/inbox');
    await user.click(await screen.findByRole('button', { name: 'Load older notifications' }));
    expect(await screen.findByText('An old one')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('cursor=next'))).toBe(
      true,
    );
  });

  it('shows an empty state for a new account', async () => {
    mockApi({
      '/api/me': testMe(),
      '/api/notifications/unread-count': { count: 0 },
      '/api/notifications': { items: [], nextCursor: null },
    });
    renderWorkPage(<InboxPage />, '/inbox');
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });
});
