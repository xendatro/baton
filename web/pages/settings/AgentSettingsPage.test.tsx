import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSettings, UpdateAgentSettingsInput } from '@shared/schemas/account';
import { jsonResponse, mockApi } from '@web/test/mockApi';
import AgentSettingsPage from './AgentSettingsPage';
import { jsonBody, renderSettingsPage } from './testing';

const LAZY = { timeout: 5000 };

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    agent: {
      id: 'a1',
      username: 'ada-ai',
      name: 'Ada Lovelace AI',
      image: null,
      kind: 'agent',
      agentOwner: { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null },
    },
    pausedAt: null,
    notifications: 'needs_me',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Agent settings', () => {
  it('shows your agent, its pause switch and notification level', async () => {
    mockApi({ 'GET /api/me/agent': settings() });
    renderSettingsPage(<AgentSettingsPage />);
    expect(await screen.findByText('Ada Lovelace AI', {}, LAZY)).toBeInTheDocument();
    expect(screen.getByText('@ada-ai')).toBeInTheDocument();
    expect(screen.getByText('AI', { selector: '[data-agent-badge]' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pause your agent' })).not.toBeChecked();
    expect(screen.getByText(/its API keys can read but not write/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Only what needs you' })).toBeChecked();
    expect(
      screen.getByText('Only when your agent mentions, assigns or answers you'),
    ).toBeInTheDocument();
  });

  it('pauses the agent', async () => {
    let current = settings();
    const fetchMock = mockApi({
      'GET /api/me/agent': () => jsonResponse(current),
      'PATCH /api/me/agent': ({ init }: { init?: RequestInit }) => {
        const input = jsonBody(init) as UpdateAgentSettingsInput;
        current = { ...current, pausedAt: input.paused ? new Date().toISOString() : null };
        return jsonResponse(current);
      },
    });
    const user = userEvent.setup();
    renderSettingsPage(<AgentSettingsPage />);
    await user.click(await screen.findByRole('switch', { name: 'Pause your agent' }, LAZY));
    expect(await screen.findByText('Paused Ada Lovelace AI')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pause your agent' })).toBeChecked();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(jsonBody(patch?.[1])).toEqual({ paused: true });
  });

  it('changes the notification level', async () => {
    let current = settings();
    const fetchMock = mockApi({
      'GET /api/me/agent': () => jsonResponse(current),
      'PATCH /api/me/agent': ({ init }: { init?: RequestInit }) => {
        const input = jsonBody(init) as UpdateAgentSettingsInput;
        current = { ...current, notifications: input.notifications ?? current.notifications };
        return jsonResponse(current);
      },
    });
    const user = userEvent.setup();
    renderSettingsPage(<AgentSettingsPage />);
    await user.click(await screen.findByRole('radio', { name: 'Everything' }, LAZY));
    expect(await screen.findByText('Agent notifications saved')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Everything' })).toBeChecked();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(jsonBody(patch?.[1])).toEqual({ notifications: 'all' });
  });

  it('puts the switch back and shows the error when saving fails', async () => {
    mockApi({
      'GET /api/me/agent': settings(),
      'PATCH /api/me/agent': () =>
        jsonResponse({ error: { code: 'internal', message: 'Something broke.' } }, 500),
    });
    const user = userEvent.setup();
    renderSettingsPage(<AgentSettingsPage />);
    await user.click(await screen.findByRole('switch', { name: 'Pause your agent' }, LAZY));
    expect(await screen.findByText('Something broke.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Pause your agent' })).not.toBeChecked(),
    );
  });

  it('shows an error state when the agent can’t load', async () => {
    mockApi({
      'GET /api/me/agent': () =>
        jsonResponse({ error: { code: 'internal', message: 'Down.' } }, 500),
    });
    renderSettingsPage(<AgentSettingsPage />);
    expect(
      await screen.findByText('Couldn’t load your agent', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });
});

describe('Agent activity', () => {
  it('shows listener sessions and recent jobs', async () => {
    const now = new Date().toISOString();
    mockApi({
      'GET /api/me/agent': settings(),
      'GET /api/me/agent/activity': {
        online: true,
        pendingCount: 1,
        sessions: [
          {
            id: 's1',
            keyName: 'MSI',
            agentName: 'Claude',
            projects: [{ id: 'p1', key: 'WEB', name: 'Web app', teamSlug: 'acme' }],
            startedAt: now,
            lastSeenAt: now,
            online: true,
          },
        ],
        jobs: [
          {
            id: 'j1',
            kind: 'mention',
            status: 'claimed',
            closing: false,
            project: { id: 'p1', key: 'WEB', name: 'Web app', teamSlug: 'acme' },
            target: {
              type: 'task',
              id: 't1',
              ref: 'WEB-12',
              title: 'Fix login',
              url: '/t/acme/p/WEB/tasks/12',
            },
            createdAt: now,
            claimedAt: now,
            completedAt: null,
          },
          {
            id: 'j2',
            kind: 'thread_reply',
            status: 'pending',
            closing: true,
            project: null,
            target: { type: 'task', id: 't2', ref: null, title: null, url: null },
            createdAt: now,
            claimedAt: null,
            completedAt: null,
          },
        ],
      },
    });
    renderSettingsPage(<AgentSettingsPage />);
    const sessions = await screen.findByRole('list', { name: 'Listener sessions' }, LAZY);
    expect(sessions).toHaveTextContent('Online');
    expect(sessions).toHaveTextContent('Claude · MSI key');
    expect(sessions).toHaveTextContent('WEB');
    const jobs = screen.getByRole('list', { name: 'Recent jobs' });
    expect(within(jobs).getByRole('link', { name: 'WEB-12 Fix login' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/tasks/12',
    );
    expect(jobs).toHaveTextContent('Working');
    expect(jobs).toHaveTextContent('Reply in thread');
    expect(jobs).toHaveTextContent('(closing)');
    expect(jobs).toHaveTextContent('Deleted item');
    expect(screen.getByText(/1 waiting/)).toBeInTheDocument();
  });

  it('explains how to start when no listener has run', async () => {
    mockApi({
      'GET /api/me/agent': settings(),
      'GET /api/me/agent/activity': { online: false, pendingCount: 0, sessions: [], jobs: [] },
    });
    renderSettingsPage(<AgentSettingsPage />);
    expect(await screen.findByText(/No listener has run yet/, {}, LAZY)).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });
});
