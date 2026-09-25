import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkedAccount } from '@shared/schemas/account';
import { jsonResponse, mockApi, testConfig } from '@web/test/mockApi';
import ConnectionsSettingsPage from './ConnectionsSettingsPage';
import { renderSettingsPage } from './testing';

const LAZY = { timeout: 5000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

const github: LinkedAccount = {
  id: 'acc1',
  provider: 'github',
  accountId: '42',
  label: '@adalovelace',
  connectedAt: '2026-09-01T10:00:00.000Z',
};

function row(name: string): HTMLElement {
  const item = screen.getByText(name, { selector: 'p > *:first-child, p' }).closest('li');
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

describe('connections settings', () => {
  it('shows connected accounts and providers the server doesn’t offer', async () => {
    mockApi({
      'GET /api/config': testConfig, // GitHub on, Google off
      'GET /api/me/connections': { hasPassword: true, accounts: [github] },
    });
    renderSettingsPage(<ConnectionsSettingsPage />);
    expect(await screen.findByText('@adalovelace', {}, LAZY)).toBeInTheDocument();
    expect(
      screen.getByText('Google sign-in is not configured on this server.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Google' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disconnect GitHub' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Change password' })).toHaveAttribute(
      'href',
      '/settings/account',
    );
  });

  it('won’t disconnect the last way to sign in', async () => {
    mockApi({
      'GET /api/config': testConfig,
      'GET /api/me/connections': { hasPassword: false, accounts: [github] },
    });
    renderSettingsPage(<ConnectionsSettingsPage />);
    expect(await screen.findByRole('button', { name: 'Disconnect GitHub' }, LAZY)).toBeDisabled();
    expect(within(row('GitHub')).getByText(/only way to sign in/)).toBeInTheDocument();
    expect(within(row('GitHub')).getByRole('link', { name: 'Set a password' })).toBeInTheDocument();
  });

  it('disconnects after confirmation', async () => {
    let accounts = [github];
    const fetchMock = mockApi({
      'GET /api/config': { ...testConfig, providers: { google: true, github: true } },
      'GET /api/me/connections': () => jsonResponse({ hasPassword: true, accounts }),
      'DELETE /api/me/connections/github': () => {
        accounts = [];
        return jsonResponse({ ok: true });
      },
    });
    const user = userEvent.setup();
    renderSettingsPage(<ConnectionsSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }, LAZY));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('GitHub disconnected')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  it('reports the result of connecting at the provider, once', async () => {
    mockApi({
      'GET /api/config': testConfig,
      'GET /api/me/connections': { hasPassword: true, accounts: [] },
    });
    const { router } = renderSettingsPage(<ConnectionsSettingsPage />, {
      initialEntry: '/settings/page?error=account_already_linked_to_different_user',
    });
    expect(
      await screen.findByText('That account is already connected to another Baton user.', {}, LAZY),
    ).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});
