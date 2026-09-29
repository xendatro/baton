import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRequest, ItemAgentRequests } from '@shared/schemas/agentAccess';
import type { ChatPage } from '@shared/schemas/chat';
import type { MeResponse, Reply } from '@shared/schemas/core';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { queryKeys } from '@web/lib/queryKeys';
import { registerShellAction } from '@web/lib/shellActions';
import type { TaskPrefill } from '@web/lib/taskPrefill';
import { mockApi, testMe, testSession } from '@web/test/mockApi';
import { Conversation } from './Conversation';

/**
 * Tasks from chat messages (Make task from this, Select messages) and agent requests under the
 * message that asked: the owner's inline card, everyone else's status line.
 */

const ada = { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null };
const grace = { id: 'u2', username: 'grace', name: 'Grace Hopper', image: null };

function message(id: string, minute: number, overrides: Partial<Reply> = {}): Reply {
  const at = new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString();
  return {
    id,
    teamId: 't1',
    projectId: 'p1',
    parentType: 'issue',
    parentId: 'i1',
    parentReplyId: null,
    body: `Body of ${id}`,
    author: grace,
    via: null,
    attachments: [],
    reactions: [],
    createdAt: at,
    updatedAt: at,
    editedAt: null,
    ...overrides,
  };
}

function page(items: Reply[]): ChatPage {
  return {
    items,
    olderCursor: null,
    total: items.length,
    unread: { count: 0, firstReplyId: null },
    workingAgents: [],
  };
}

function me(permissions: string[]): MeResponse {
  const value = testMe();
  return {
    ...value,
    teams: value.teams.map((team) => ({
      ...team,
      isOwner: false,
      permissions: permissions as MeResponse['teams'][number]['permissions'],
    })),
  };
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    jobId: 'job1',
    kind: 'mention',
    status: 'pending',
    agent: { id: 'a1', username: 'ada-ai', name: 'Ada AI' },
    owner: { id: 'u1', username: 'ada', name: 'Ada' },
    requester: grace,
    question: 'Can I reply to Grace’s message here?',
    summary: 'Reply to Grace’s message on WEB#1',
    project: { id: 'p1', ref: 'acme/WEB', name: 'Web app' },
    target: {
      type: 'issue',
      id: 'i1',
      ref: 'WEB#1',
      title: 'Chat',
      path: '/t/acme/p/WEB/issues/1',
    },
    message: { replyId: 'm2', body: 'Can you check @ada-ai?', path: null },
    stage: null,
    suggestedChain: [{ harness: 'claude', model: 'opus', effort: 'high' }],
    suggestedSource: 'your mapping',
    createdAt: '2026-09-20T10:05:00.000Z',
    decidedAt: null,
    reason: null,
    modelOverride: null,
    ...overrides,
  };
}

function serve(options: {
  permissions?: string[];
  messages?: Reply[];
  requests?: ItemAgentRequests;
}) {
  return mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(options.permissions ?? ['VIEW_PROJECT', 'REPLY', 'CREATE_TASKS']),
    '/api/config': { version: 'test', signupsEnabled: true, providers: {}, maxUploadMb: 25 },
    '/api/teams/t1/members': { items: [] },
    '/api/teams/t1/mentionables': { users: [], roles: [] },
    '/api/items/issue/i1/chat': page(
      options.messages ?? [
        message('m1', 0, { body: '**Export** is slow\nIt takes a minute' }),
        message('m2', 1, { body: 'Can you check @ada-ai?' }),
        message('m3', 2, { author: ada, body: 'Same for imports' }),
      ],
    ),
    '/api/agent-requests': options.requests ?? { mine: [], waiting: [] },
  });
}

let unregister: (() => void) | null = null;

function renderChat() {
  const create = vi.fn<(payload: { projectId?: string; prefill?: TaskPrefill }) => void>();
  unregister = registerShellAction('task.create', create);
  const client = createQueryClient();
  client.setQueryData(queryKeys.session(), testSession);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <Conversation
            parentType="issue"
            parentId="i1"
            teamId="t1"
            projectId="p1"
            mode="chat"
            item={{ author: ada, ref: 'WEB#1', path: '/t/acme/p/WEB/issues/1' }}
          />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { create };
}

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Make task from this', () => {
  it('opens New task prefilled from one message, linked to the issue as fixes', async () => {
    const user = userEvent.setup();
    serve({});
    const { create } = renderChat();
    const rows = await screen.findAllByTestId('chat-message');
    await user.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: 'Make task from this' }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0]?.[0];
    expect(payload?.projectId).toBe('p1');
    expect(payload?.prefill).toMatchObject({
      title: 'Export is slow',
      // Ada wrote the issue, so she may resolve it.
      issue: { id: 'i1', ref: 'WEB#1', kind: 'fixes' },
      source: { itemType: 'issue', itemId: 'i1', ref: 'WEB#1', replyIds: ['m1'] },
    });
    expect(payload?.prefill?.description).toContain(
      '**Grace Hopper** ([message](/t/acme/p/WEB/issues/1#reply-m1)):\n> **Export** is slow',
    );
    // Named, not @mentioned: creating the task pings nobody.
    expect(payload?.prefill?.description).not.toContain('@grace');
  });

  it('makes one task from the selected messages', async () => {
    const user = userEvent.setup();
    serve({});
    const { create } = renderChat();
    await screen.findAllByTestId('chat-message');
    await user.click(screen.getByRole('button', { name: 'Select messages' }));
    const boxes = screen.getAllByTestId('chat-select');
    expect(boxes).toHaveLength(3);
    // Picked out of order: the task quotes them in conversation order.
    await user.click(boxes[2] as HTMLElement);
    await user.click(boxes[0] as HTMLElement);
    expect(screen.getByTestId('chat-selection')).toHaveTextContent('2 messages selected');
    await user.click(screen.getByRole('button', { name: 'Make task from 2 messages' }));
    const prefill = create.mock.calls[0]?.[0].prefill;
    expect(prefill?.source.replyIds).toEqual(['m1', 'm3']);
    expect(prefill?.title).toBe('Export is slow');
    expect(prefill?.description).toMatch(/^From 2 messages in \[WEB#1\]/);
    expect(prefill?.description.indexOf('Export')).toBeLessThan(
      prefill?.description.indexOf('Same for imports') ?? 0,
    );
    // Selecting ends with it.
    expect(screen.queryByTestId('chat-selection')).toBeNull();
  });

  it('is not offered without CREATE_TASKS', async () => {
    serve({ permissions: ['VIEW_PROJECT', 'REPLY'] });
    renderChat();
    await screen.findAllByTestId('chat-message');
    expect(screen.queryByRole('button', { name: 'Make task from this' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select messages' })).toBeNull();
  });
});

describe('agent requests under the message that asked', () => {
  it('give the owner the card with Approve and Decline', async () => {
    serve({
      requests: {
        mine: [request()],
        waiting: [
          {
            jobId: 'job1',
            status: 'pending',
            replyId: 'm2',
            model: null,
            agent: { id: 'a1', username: 'ada-ai', name: 'Ada AI' },
            owner: { id: 'u1', username: 'ada', name: 'Ada' },
            requester: { id: 'u2', username: 'grace', name: 'Grace Hopper' },
            summary: 'Reply to Grace’s message on WEB#1',
            createdAt: '2026-09-20T10:05:00.000Z',
            decidedAt: null,
            reason: null,
          },
        ],
      },
    });
    renderChat();
    const rows = await screen.findAllByTestId('chat-message');
    const asked = rows[1] as HTMLElement;
    expect(
      await within(asked).findByRole('button', { name: /^Approve: Reply to Grace/ }),
    ).toBeInTheDocument();
    expect(within(asked).getByRole('button', { name: /^Decline: / })).toBeInTheDocument();
    // Only under that message, and no status line for the owner.
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByTestId('agent-request-line')).toBeNull();
  });

  it('show everyone else a line: waiting, then approved with the model', async () => {
    const waiting = {
      jobId: 'job1',
      status: 'pending' as const,
      replyId: 'm2',
      model: null,
      agent: { id: 'a9', username: 'ethan-ai', name: 'Ethan AI' },
      owner: { id: 'u9', username: 'ethan', name: 'Ethan' },
      requester: { id: 'u2', username: 'grace', name: 'Grace Hopper' },
      summary: 'Reply to Grace’s message on WEB#1',
      createdAt: '2026-09-20T10:05:00.000Z',
      decidedAt: null,
      reason: null,
    };
    serve({ requests: { mine: [], waiting: [waiting] } });
    renderChat();
    const rows = await screen.findAllByTestId('chat-message');
    const line = await within(rows[1] as HTMLElement).findByTestId('agent-request-line');
    expect(line).toHaveTextContent('Ethan AI is waiting for Ethan’s OK');
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    vi.unstubAllGlobals();
    unregister?.();
    document.body.innerHTML = '';

    serve({
      requests: {
        mine: [],
        waiting: [
          {
            ...waiting,
            status: 'approved',
            decidedAt: '2026-09-20T10:06:00.000Z',
            model: { harness: 'claude', model: 'opus', effort: 'high' },
          },
        ],
      },
    });
    renderChat();
    const again = await screen.findAllByTestId('chat-message');
    expect(
      await within(again[1] as HTMLElement).findByTestId('agent-request-line'),
    ).toHaveTextContent('Ethan approved (Claude Code · opus · high)');
  });
});
