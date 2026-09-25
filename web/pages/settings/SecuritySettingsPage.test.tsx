import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@shared/schemas/account';
import type { ActivityEntry } from '@shared/schemas/core';
import { jsonResponse, mockApi } from '@web/test/mockApi';
import SecuritySettingsPage from './SecuritySettingsPage';
import { renderSettingsPage } from './testing';

const LAZY = { timeout: 5000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function session(overrides: Partial<AccountSession>): AccountSession {
  const now = new Date().toISOString();
  return {
    id: 's1',
    current: false,
    browser: 'Chrome',
    os: 'macOS',
    device: 'desktop',
    ipAddress: '198.51.100.4',
    userAgent: null,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function logEntry(id: string, action: string, meta: Record<string, unknown> = {}): ActivityEntry {
  return {
    id,
    teamId: null,
    projectId: null,
    actor: { user: null, via: null, source: 'web' },
    entityType: 'user',
    entityId: 'u1',
    action,
    changes: {},
    meta,
    url: '/settings/security',
    createdAt: new Date().toISOString(),
  };
}

describe('security settings', () => {
  it('lists sessions and signs out another one', async () => {
    let sessions = [
      session({ id: 's1', current: true }),
      session({ id: 's2', browser: 'Safari', os: 'iOS', device: 'mobile' }),
    ];
    const fetchMock = mockApi({
      'GET /api/me/sessions': () => jsonResponse({ items: sessions }),
      'DELETE /api/me/sessions/s2': () => {
        sessions = sessions.filter((item) => item.id !== 's2');
        return jsonResponse({ ok: true });
      },
      'GET /api/me/security-log': { items: [], nextCursor: null },
    });
    const user = userEvent.setup();
    renderSettingsPage(<SecuritySettingsPage />);
    const list = await screen.findByRole('list', { name: 'Active sessions' }, LAZY);
    const [current, phone] = within(list).getAllByRole('listitem');
    expect(current).toHaveTextContent('Chrome on macOS');
    expect(current).toHaveTextContent('This device');
    expect(current).toHaveTextContent('Active now');
    expect(within(current as HTMLElement).queryByRole('button')).toBeNull();
    expect(phone).toHaveTextContent('Safari on iOS');

    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));
    expect(await screen.findByText('Signed out Safari on iOS')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
  });

  it('signs out every other session after confirmation', async () => {
    mockApi({
      'GET /api/me/sessions': {
        items: [session({ id: 's1', current: true }), session({ id: 's2' })],
      },
      'POST /api/me/sessions/revoke-others': { revoked: 1 },
      'GET /api/me/security-log': { items: [], nextCursor: null },
    });
    const user = userEvent.setup();
    renderSettingsPage(<SecuritySettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Sign out other sessions' }, LAZY));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('1 other session will be signed out');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out others' }));
    expect(await screen.findByText('Signed out 1 other session')).toBeInTheDocument();
  });

  it('shows the security log in plain words and loads older events', async () => {
    mockApi({
      'GET /api/me/sessions': { items: [session({ current: true })] },
      'GET /api/me/security-log': ({ url }: { url: URL }) =>
        jsonResponse(
          url.searchParams.get('cursor')
            ? { items: [logEntry('a2', 'user.signed_up', { method: 'email' })], nextCursor: null }
            : {
                items: [logEntry('a1', 'api_key.created', { name: 'Claude on laptop' })],
                nextCursor: 'next',
              },
        ),
    });
    const user = userEvent.setup();
    renderSettingsPage(<SecuritySettingsPage />);
    const log = await screen.findByRole('list', { name: 'Security log' }, LAZY);
    expect(log).toHaveTextContent('Created API key “Claude on laptop”');
    await user.click(screen.getByRole('button', { name: 'Show older events' }));
    expect(await within(log).findByText('Created your account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older events' })).toBeNull();
  });
});
