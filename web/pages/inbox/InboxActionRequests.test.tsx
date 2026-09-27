import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionRequest } from '@shared/schemas/agentActions';
import type { Notification } from '@shared/schemas/core';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { renderWorkPage, requestUrl } from '@web/pages/my-tasks/testing';
import InboxPage from './InboxPage';

/** Sign-off requests in the inbox (design §6): Approve / Deny on the row, then the outcome. */

afterEach(() => {
  vi.unstubAllGlobals();
});

const agent = {
  id: 'a1',
  username: 'ethan-ai',
  name: 'Ethan AI',
  image: null,
  kind: 'agent' as const,
  agentOwner: { id: 'u1', username: 'ethan', name: 'Ethan', image: null },
};

const notification: Notification = {
  id: 'n1',
  teamId: 't1',
  type: 'agent_action_request',
  entityType: 'agent_action_request',
  entityId: 'ar1',
  actor: agent,
  viaKeyName: 'MSI',
  title: 'Ethan AI wants to delete WEB-12 “Fix login”',
  snippet: '',
  url: '/t/acme/p/WEB/tasks/12',
  readAt: null,
  createdAt: new Date().toISOString(),
};

function actionRequest(overrides: Partial<AgentActionRequest> = {}): AgentActionRequest {
  const now = new Date();
  return {
    id: 'ar1',
    team: { id: 't1', name: 'Acme', slug: 'acme' },
    projectId: 'p1',
    action: 'delete_task',
    status: 'pending',
    summary: 'delete WEB-12 “Fix login”',
    url: '/t/acme/p/WEB/tasks/12',
    agent,
    owner: agent.agentOwner,
    via: { keyId: 'k1', keyName: 'MSI', agentName: 'Claude' },
    runsAsOwner: false,
    result: null,
    error: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

function setup(decided: AgentActionRequest) {
  let current = actionRequest();
  const fetchMock = mockApi({
    '/api/me': testMe(),
    '/api/notifications/unread-count': { count: 1 },
    // Deciding marks the notification read on the server.
    '/api/notifications': () =>
      jsonResponse({
        items: [
          {
            ...notification,
            readAt: current.status === 'pending' ? null : new Date().toISOString(),
          },
        ],
        nextCursor: null,
      }),
    '/api/agent-actions': () => jsonResponse({ items: [current] }),
    'POST /api/agent-actions/ar1/approve': () => {
      current = decided;
      return jsonResponse(decided);
    },
    'POST /api/agent-actions/ar1/deny': () => {
      current = decided;
      return jsonResponse(decided);
    },
  });
  return fetchMock;
}

function posted(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls
    .filter(([input, init]) => init?.method === 'POST' && requestUrl(input).includes('agent-'))
    .map(([input]) => requestUrl(input));
}

describe('InboxPage: agent sign-off requests', () => {
  it('approves from the row and shows what happened', async () => {
    const fetchMock = setup(
      actionRequest({
        status: 'approved',
        result: { ok: true },
        decidedAt: new Date().toISOString(),
      }),
    );
    const user = userEvent.setup();
    renderWorkPage(<InboxPage />, '/inbox');

    const row = await screen.findByTestId('notification');
    expect(row).toHaveTextContent('Ethan AI');
    expect(row).toHaveTextContent('needs your sign-off');
    expect(row).toHaveTextContent('Ethan AI wants to delete WEB-12 “Fix login”');
    const approve = await within(row).findByRole('button', {
      name: 'Approve: Ethan AI wants to delete WEB-12 “Fix login”',
    });
    expect(
      within(row).getByRole('button', {
        name: 'Deny: Ethan AI wants to delete WEB-12 “Fix login”',
      }),
    ).toBeEnabled();

    await user.click(approve);
    await waitFor(() => expect(posted(fetchMock)).toEqual(['/api/agent-actions/ar1/approve']));
    expect(await screen.findByText('Approved: delete WEB-12 “Fix login”')).toBeInTheDocument();
    expect(await within(row).findByTestId('agent-action-outcome')).toHaveTextContent('Approved');
    expect(within(row).queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });

  it('denies from the row', async () => {
    const fetchMock = setup(
      actionRequest({ status: 'denied', decidedAt: new Date().toISOString() }),
    );
    const user = userEvent.setup();
    renderWorkPage(<InboxPage />, '/inbox');

    const row = await screen.findByTestId('notification');
    await user.click(await within(row).findByRole('button', { name: /^Deny/ }));
    await waitFor(() => expect(posted(fetchMock)).toEqual(['/api/agent-actions/ar1/deny']));
    expect(await screen.findByText('Denied: delete WEB-12 “Fix login”')).toBeInTheDocument();
    expect(await within(row).findByTestId('agent-action-outcome')).toHaveTextContent('Denied');
  });

  it('says why an approved action failed', async () => {
    setup(
      actionRequest({
        status: 'failed',
        error: { code: 'forbidden', message: 'You can only delete your own tasks' },
      }),
    );
    const user = userEvent.setup();
    renderWorkPage(<InboxPage />, '/inbox');

    const row = await screen.findByTestId('notification');
    await user.click(await within(row).findByRole('button', { name: /^Approve/ }));
    expect(await screen.findByText('Couldn’t delete WEB-12 “Fix login”')).toBeInTheDocument();
    expect(await within(row).findByTestId('agent-action-outcome')).toHaveTextContent(
      'Failed: You can only delete your own tasks',
    );
  });
});
