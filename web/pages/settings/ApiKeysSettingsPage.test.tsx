import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiKey } from '@shared/schemas/core';
import { jsonResponse, mockApi } from '@web/test/mockApi';
import ApiKeysSettingsPage from './ApiKeysSettingsPage';
import { jsonBody, renderSettingsPage } from './testing';

const LAZY = { timeout: 5000 };

function key(overrides: Partial<ApiKey>): ApiKey {
  return {
    id: 'k1',
    name: 'Claude on laptop',
    prefix: 'AbCd1234',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API keys settings', () => {
  it('lists keys with their state, prefix and usage', async () => {
    mockApi({
      'GET /api/me/api-keys': {
        apiKeys: [
          key({ id: 'k2', name: 'Old script', revokedAt: '2026-09-10T10:00:00.000Z' }),
          key({ id: 'k1', lastUsedAt: new Date().toISOString() }),
          key({ id: 'k3', name: 'CI', expiresAt: '2026-01-01T00:00:00.000Z' }),
        ],
      },
    });
    renderSettingsPage(<ApiKeysSettingsPage />);
    const list = await screen.findByRole('list', { name: 'API keys' }, LAZY);
    const rows = within(list).getAllByRole('listitem');
    // Active keys first.
    expect(rows[0]).toHaveTextContent('Claude on laptop');
    expect(rows[0]).toHaveTextContent('Active');
    expect(rows[0]).toHaveTextContent('bat_AbCd1234…');
    expect(rows[0]).toHaveTextContent('Last used just now');
    expect(screen.getByText('Revoked', { selector: '[data-slot=badge]' })).toBeInTheDocument();
    expect(screen.getByText('Expired', { selector: '[data-slot=badge]' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke Old script' })).not.toBeInTheDocument();
    expect(screen.getByText(/1 active of at most 50/)).toBeInTheDocument();
  });

  it('shows an empty state with a call to action', async () => {
    mockApi({ 'GET /api/me/api-keys': { apiKeys: [] } });
    renderSettingsPage(<ApiKeysSettingsPage />);
    expect(await screen.findByText('No API keys yet', {}, LAZY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create API key' })).toBeInTheDocument();
  });

  it('creates a key and shows it once with setup for Claude Code and Codex', async () => {
    const created = key({ id: 'k9', name: 'Codex desktop' });
    const secret = `bat_${'x'.repeat(40)}`;
    let keys: ApiKey[] = [];
    const fetchMock = mockApi({
      'GET /api/me/api-keys': () => jsonResponse({ apiKeys: keys }),
      'POST /api/me/api-keys': () => {
        keys = [created];
        return jsonResponse({ key: secret, apiKey: created }, 201);
      },
    });
    const user = userEvent.setup();
    renderSettingsPage(<ApiKeysSettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'New API key' }, LAZY));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Codex desktop');
    await user.click(within(dialog).getByRole('combobox', { name: 'Expires' }));
    await user.click(await screen.findByRole('option', { name: '90 days' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));

    expect(await screen.findByText(secret)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(jsonBody(post?.[1])).toEqual({ name: 'Codex desktop', expiresInDays: 90 });
    expect(screen.getByText(/won’t be shown again/)).toBeInTheDocument();

    const origin = window.location.origin;
    expect(
      screen.getByText(
        `claude mcp add --transport http baton ${origin}/mcp --header "Authorization: Bearer ${secret}"`,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(await screen.findByText(`export BATON_API_KEY="${secret}"`)).toBeInTheDocument();
    expect(screen.getByText(/bearer_token_env_var = "BATON_API_KEY"/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText(secret)).not.toBeInTheDocument());
    // The list shows the new key without its secret.
    expect(await screen.findByText('Codex desktop')).toBeInTheDocument();
  });

  it('validates the name before creating', async () => {
    const fetchMock = mockApi({ 'GET /api/me/api-keys': { apiKeys: [] } });
    const user = userEvent.setup();
    renderSettingsPage(<ApiKeysSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'New API key' }, LAZY));
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('revokes a key after confirmation', async () => {
    let revoked = false;
    mockApi({
      'GET /api/me/api-keys': () =>
        jsonResponse({
          apiKeys: [key({ revokedAt: revoked ? new Date().toISOString() : null })],
        }),
      'DELETE /api/me/api-keys/k1': () => {
        revoked = true;
        return jsonResponse({ ok: true });
      },
    });
    const user = userEvent.setup();
    renderSettingsPage(<ApiKeysSettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Revoke Claude on laptop' }, LAZY));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('lose access immediately');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('“Claude on laptop” revoked')).toBeInTheDocument();
    expect(
      await screen.findByText('Revoked', { selector: '[data-slot=badge]' }),
    ).toBeInTheDocument();
  });

  it('opens the create dialog from ?new=1 (the palette command)', async () => {
    mockApi({ 'GET /api/me/api-keys': { apiKeys: [] } });
    renderSettingsPage(<ApiKeysSettingsPage />, { initialEntry: '/settings/page?new=1' });
    expect(await screen.findByRole('dialog', {}, LAZY)).toHaveTextContent('New API key');
  });
});
