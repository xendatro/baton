import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeletedTeam } from '@shared/schemas/teams';
import { jsonResponse, mockApi, testConfig, testMe } from '@web/test/mockApi';
import AccountSettingsPage from './AccountSettingsPage';
import { jsonBody, renderSettingsPage, requestUrl } from './testing';

const LAZY = { timeout: 5000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

const deletedTeam: DeletedTeam = {
  id: 't9',
  name: 'Old crew',
  slug: 'old-crew',
  icon: null,
  color: '#6366f1',
  deletedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  purgeAt: new Date(Date.now() + 28 * 86_400_000).toISOString(),
};

/** `me` for a user who owns no team. */
function memberOnly() {
  const me = testMe();
  return { ...me, teams: me.teams.map((team) => ({ ...team, isOwner: false })) };
}

function routes(overrides: Record<string, unknown> = {}) {
  return {
    'GET /api/me': memberOnly(),
    'GET /api/config': testConfig,
    'GET /api/me/connections': { hasPassword: true, accounts: [] },
    'GET /api/me/deleted-teams': { items: [] },
    ...overrides,
  };
}

describe('account settings', () => {
  it('shows the email and changes the password', async () => {
    const fetchMock = mockApi(
      routes({ 'POST /api/me/password': { ok: true, revokedSessions: 2 } }),
    );
    const user = userEvent.setup();
    renderSettingsPage(<AccountSettingsPage />);
    expect(await screen.findByText('ada@example.com', {}, LAZY)).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();

    const passwordForm = screen.getByRole('form', { name: 'Change password' });
    await user.type(within(passwordForm).getByLabelText('Current password'), 'old password!');
    await user.type(within(passwordForm).getByLabelText('New password'), 'a new passphrase');
    await user.type(within(passwordForm).getByLabelText('Confirm new password'), 'mismatch!!');
    await user.click(within(passwordForm).getByRole('button', { name: 'Change password' }));
    expect(await within(passwordForm).findByText('The passwords don’t match')).toBeInTheDocument();

    const confirm = within(passwordForm).getByLabelText('Confirm new password');
    await user.clear(confirm);
    await user.type(confirm, 'a new passphrase');
    await user.click(within(passwordForm).getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Password changed. 2 other sessions signed out.'),
    ).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url]) => requestUrl(url) === '/api/me/password');
    expect(jsonBody(post?.[1])).toEqual({
      currentPassword: 'old password!',
      newPassword: 'a new passphrase',
      revokeOtherSessions: true,
    });
  });

  it('shows a wrong current password next to the field', async () => {
    mockApi(
      routes({
        'POST /api/me/password': () =>
          jsonResponse(
            {
              error: {
                code: 'validation_failed',
                message: 'That isn’t your current password',
                details: {
                  issues: [
                    { path: 'currentPassword', message: 'That isn’t your current password' },
                  ],
                },
              },
            },
            400,
          ),
      }),
    );
    const user = userEvent.setup();
    renderSettingsPage(<AccountSettingsPage />);
    const passwordForm = await screen.findByRole('form', { name: 'Change password' }, LAZY);
    await user.type(within(passwordForm).getByLabelText('Current password'), 'wrong one');
    await user.type(within(passwordForm).getByLabelText('New password'), 'a new passphrase');
    await user.type(
      within(passwordForm).getByLabelText('Confirm new password'),
      'a new passphrase',
    );
    await user.click(within(passwordForm).getByRole('button', { name: 'Change password' }));
    expect(
      await within(passwordForm).findByText('That isn’t your current password'),
    ).toBeInTheDocument();
  });

  it('offers to set a password to accounts without one', async () => {
    const fetchMock = mockApi(
      routes({
        'GET /api/me/connections': {
          hasPassword: false,
          accounts: [
            {
              id: 'acc1',
              provider: 'github',
              accountId: '1',
              label: '@ada',
              connectedAt: '2026-09-01T10:00:00.000Z',
            },
          ],
        },
        'POST /api/me/password/set': { ok: true, revokedSessions: 0 },
      }),
    );
    const user = userEvent.setup();
    renderSettingsPage(<AccountSettingsPage />);
    const passwordForm = await screen.findByRole('form', { name: 'Set a password' }, LAZY);
    expect(within(passwordForm).queryByLabelText('Current password')).not.toBeInTheDocument();
    await user.type(within(passwordForm).getByLabelText('New password'), 'a new passphrase');
    await user.type(
      within(passwordForm).getByLabelText('Confirm new password'),
      'a new passphrase',
    );
    await user.click(within(passwordForm).getByRole('checkbox'));
    await user.click(within(passwordForm).getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText(/Password set/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url]) => requestUrl(url) === '/api/me/password/set');
    expect(jsonBody(post?.[1])).toEqual({
      newPassword: 'a new passphrase',
      revokeOtherSessions: false,
    });
  });

  it('lists deleted teams and restores one', async () => {
    let items = [deletedTeam];
    const fetchMock = mockApi(
      routes({
        'GET /api/me/deleted-teams': () => jsonResponse({ items }),
        'POST /api/teams/t9/restore': () => {
          items = [];
          return jsonResponse({
            id: 't9',
            slug: 'old-crew',
            name: 'Old crew',
            description: '',
            icon: null,
            color: '#6366f1',
            ownerId: 'u1',
            owner: null,
            memberCount: 1,
            createdAt: deletedTeam.deletedAt,
            updatedAt: deletedTeam.deletedAt,
          });
        },
      }),
    );
    const user = userEvent.setup();
    renderSettingsPage(<AccountSettingsPage />);
    expect(await screen.findByText('Old crew', {}, LAZY)).toBeInTheDocument();
    expect(screen.getByText(/purged in 28 days/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore Old crew' }));
    expect(await screen.findByText('Old crew restored')).toBeInTheDocument();
    expect(await screen.findByText(/No deleted teams/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => requestUrl(url) === '/api/teams/t9/restore')).toBe(
      true,
    );
  });

  it('blocks deleting the account while the user owns teams', async () => {
    mockApi(
      routes({ 'GET /api/me': testMe(), 'GET /api/me/deleted-teams': { items: [deletedTeam] } }),
    );
    const user = userEvent.setup();
    renderSettingsPage(<AccountSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete account' }, LAZY));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('You own 2 teams');
    expect(within(dialog).getByText('Acme')).toBeInTheDocument();
    expect(within(dialog).getByText('in Trash')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Team settings/ })).toHaveAttribute(
      'href',
      '/t/acme/settings/general',
    );
    expect(within(dialog).queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('deletes the account with the password and goes to the login page', async () => {
    const fetchMock = mockApi(routes({ 'POST /api/me/delete': { ok: true } }));
    const user = userEvent.setup();
    const { router } = renderSettingsPage(<AccountSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete account' }, LAZY));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Delete my account' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Your password'), 'my password');
    await user.click(submit);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText(/Your account was deleted/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url]) => requestUrl(url) === '/api/me/delete');
    expect(jsonBody(post?.[1])).toEqual({ password: 'my password' });
  });

  it('asks accounts without a password to type their username', async () => {
    mockApi(
      routes({
        'GET /api/me/connections': { hasPassword: false, accounts: [] },
        'POST /api/me/delete': () =>
          jsonResponse(
            {
              error: {
                code: 'validation_failed',
                message: 'Type your username to confirm',
                details: {
                  issues: [{ path: 'confirmUsername', message: 'Type your username to confirm' }],
                },
              },
            },
            400,
          ),
      }),
    );
    const user = userEvent.setup();
    renderSettingsPage(<AccountSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete account' }, LAZY));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Type your username, ada, to confirm');
    const submit = within(dialog).getByRole('button', { name: 'Delete my account' });
    await user.type(input, 'ad');
    expect(submit).toBeDisabled();
    await user.type(input, 'a');
    await user.click(submit);
    expect(await within(dialog).findByText('Type your username to confirm')).toBeInTheDocument();
  });
});
