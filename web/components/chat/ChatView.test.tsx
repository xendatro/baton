import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConnection } from '@shared/schemas/agentRunner';
import type { CatchUpState, ChatPage } from '@shared/schemas/chat';
import type { Reply } from '@shared/schemas/core';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useLiveEvents } from '@web/lib/live';
import { createQueryClient } from '@web/lib/queryClient';
import { queryKeys } from '@web/lib/queryKeys';
import { writeReplyDraft } from '@web/lib/replyDrafts';
import { FakeEventSource, jsonResponse, mockApi, testMe, testSession } from '@web/test/mockApi';
import { chatMessages, continuesGroup, excerpt, typingText } from './chatLayout';
import { ChatView } from './ChatView';

/** The chat view of an issue: stream, reply-to, composer, typing, catch-up panel. */

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
    author: ada,
    via: null,
    attachments: [],
    reactions: [],
    createdAt: at,
    updatedAt: at,
    editedAt: null,
    ...overrides,
  };
}

function page(items: Reply[], overrides: Partial<ChatPage> = {}): ChatPage {
  return {
    items,
    olderCursor: null,
    total: items.length,
    unread: { count: 0, firstReplyId: null },
    workingAgents: [],
    ...overrides,
  };
}

function connection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    agent: { id: 'a1', username: 'ada-ai', name: 'Ada AI' },
    project: { id: 'p1', ref: 'acme/WEB', name: 'Web app', repoUrl: null },
    paused: false,
    pausedReason: null,
    pausedBy: null,
    agentCanView: true,
    covered: true,
    runners: [],
    listening: true,
    pendingJobs: 0,
    ...overrides,
  };
}

const noCatchUp: CatchUpState = { summaries: [], job: null, hasAgent: true };

/** Ada, who may reply in acme/WEB. */
function me() {
  const value = testMe();
  return {
    ...value,
    teams: value.teams.map((team) => ({ ...team, permissions: ['REPLY', 'VIEW_PROJECT'] })),
  };
}

interface Setup {
  chat: ChatPage;
  catchUp?: CatchUpState;
  agentConnection?: AgentConnection;
  onPost?: (body: unknown) => void;
}

function serve({ chat, catchUp = noCatchUp, agentConnection = connection(), onPost }: Setup) {
  return mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(),
    '/api/config': { version: 'test', signupsEnabled: true, providers: {}, maxUploadMb: 25 },
    '/api/teams/t1/members': {
      items: [ada, grace].map((user) => ({
        user,
        joinedAt: '2026-01-01T00:00:00.000Z',
        isOwner: false,
        roles: [],
        color: null,
      })),
    },
    '/api/teams/t1/mentionables': { users: [], roles: [] },
    '/api/items/issue/i1/chat': chat,
    '/api/items/issue/i1/catch-up': catchUp,
    'POST /api/items/issue/i1/typing': { ok: true },
    '/api/projects/p1/agent-connection': agentConnection,
    'POST /api/replies': ({ init }: { init?: RequestInit }) => {
      const body: unknown = JSON.parse(init?.body as string);
      onPost?.(body);
      return jsonResponse(message('new', 30, { body: 'Hello team' }), 201);
    },
  });
}

function Live({ children }: { children: ReactNode }) {
  useLiveEvents(true);
  return children;
}

function renderChat() {
  const client = createQueryClient();
  client.setQueryData(queryKeys.session(), testSession);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <Live>
            <ChatView
              parentType="issue"
              parentId="i1"
              teamId="t1"
              projectId="p1"
              item={{ author: ada, ref: 'WEB#1', path: '/t/acme/p/WEB/issues/1' }}
            />
          </Live>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  FakeEventSource.instances = [];
});

describe('chat layout helpers', () => {
  it('orders pages oldest first and groups consecutive messages of one author', () => {
    const older = page([message('m1', 0)]);
    const newer = page([message('m2', 1), message('m3', 2, { author: grace })]);
    const list = chatMessages([newer, older]);
    expect(list.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
    expect(continuesGroup(list[0], list[1] as Reply, false)).toBe(true);
    expect(continuesGroup(list[0], list[1] as Reply, true)).toBe(false);
    expect(continuesGroup(list[1], list[2] as Reply, false)).toBe(false);
    expect(continuesGroup(list[0], message('late', 30), false)).toBe(false);
    expect(excerpt('**Look** at ![shot](/a.png) and [this](http://x)')).toBe(
      'Look at [image: shot] and this',
    );
    expect(typingText(['Ada'])).toBe('Ada is typing…');
    expect(typingText(['Ada', 'Grace'])).toBe('Ada and Grace are typing…');
    expect(typingText(['A', 'B', 'C'])).toBe('Several people are typing…');
  });
});

describe('ChatView', () => {
  it('shows a flat stream: grouped rows, the new-messages divider and quoted answers', async () => {
    serve({
      chat: page(
        [
          message('m1', 0, { body: 'Deploy is broken' }),
          message('m2', 1, { body: 'Since this morning' }),
          message('m3', 2, { author: grace, parentReplyId: 'm1', body: 'Looking now' }),
        ],
        { unread: { count: 1, firstReplyId: 'm3' } },
      ),
    });
    renderChat();
    const rows = await screen.findAllByTestId('chat-message');
    expect(rows).toHaveLength(3);
    // The second message continues Ada's group: no name of its own.
    expect(within(rows[0] as HTMLElement).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText('Ada Lovelace')).toBeNull();
    expect(screen.getByRole('separator', { name: 'New messages' })).toBeInTheDocument();
    // The answer quotes the message it answers, inline (not nested).
    const quote = within(rows[2] as HTMLElement).getByTestId('chat-quote');
    expect(quote).toHaveTextContent('Ada Lovelace');
    expect(quote).toHaveTextContent('Deploy is broken');
    expect(screen.getByText('This is the start of the chat of WEB#1.')).toBeInTheDocument();
  });

  it('replies to a message: the chip shows it, Enter sends with parentReplyId', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    writeReplyDraft('u1', 'issue', 'i1', { body: 'Hello team', attachments: [] });
    serve({
      chat: page([message('m1', 0, { author: grace, body: 'Anyone around?' })]),
      onPost: (body) => posts.push(body),
    });
    renderChat();
    const [row] = await screen.findAllByTestId('chat-message');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Reply' }));
    const chip = await screen.findByTestId('reply-to-chip');
    expect(chip).toHaveTextContent('Replying to');
    expect(chip).toHaveTextContent('Grace Hopper');
    expect(chip).toHaveTextContent('Anyone around?');
    const box = screen.getByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(box).toHaveTextContent('Hello team'));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      parentType: 'issue',
      parentId: 'i1',
      body: 'Hello team',
      parentReplyId: 'm1',
    });
    await waitFor(() => expect(screen.queryByTestId('reply-to-chip')).toBeNull());
  });

  it('shows who is typing from live typing events, and agents at work', async () => {
    serve({
      chat: page([message('m1', 0)], {
        workingAgents: [
          {
            id: 'a9',
            username: 'ada-ai',
            name: 'Ada AI',
            image: null,
            kind: 'agent',
          },
        ],
      }),
    });
    renderChat();
    await screen.findAllByTestId('chat-message');
    expect(screen.getByTestId('chat-activity')).toHaveTextContent('Ada AI is working…');
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    act(() => {
      source?.open();
      source?.emit({
        type: 'typing',
        teamId: 't1',
        projectId: 'p1',
        entityType: 'issue',
        entityId: 'i1',
        actorId: 'u2',
        at: new Date().toISOString(),
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('chat-activity')).toHaveTextContent('Grace Hopper is typing…'),
    );
    // The viewer's own pings and other items' are ignored.
    act(() => {
      source?.emit({
        type: 'typing',
        teamId: 't1',
        projectId: 'p1',
        entityType: 'issue',
        entityId: 'other',
        actorId: 'u3',
        at: new Date().toISOString(),
      });
    });
    expect(screen.getByTestId('chat-activity')).not.toHaveTextContent('Someone');
  });

  it('offers Catch up with many unread messages; the panel shows summaries and the button', async () => {
    const user = userEvent.setup();
    serve({
      chat: page([message('m1', 0), message('m2', 1)], {
        unread: { count: 12, firstReplyId: 'm1' },
      }),
      catchUp: {
        hasAgent: true,
        job: null,
        summaries: [
          {
            id: 'c1',
            itemType: 'issue',
            itemId: 'i1',
            range: { kind: 'unread', count: 12, fromReplyId: 'm1', toReplyId: 'm2' },
            summary: 'Grace fixed **the deploy**.',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    renderChat();
    const strip = await screen.findByTestId('catch-up-strip');
    expect(strip).toHaveTextContent('You have 12 unread messages');
    await user.click(within(strip).getByRole('button', { name: 'Catch up' }));
    const panel = await screen.findByTestId('catch-up-panel');
    expect(await within(panel).findByTestId('catch-up-summary')).toHaveTextContent(
      'Grace fixed the deploy.',
    );
    expect(within(panel).getByText(/Unread · 12 messages/)).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: 'Unread (12 messages)' })).toBeChecked();
    expect(
      await within(panel).findByRole('button', { name: 'Summarize with my agent' }),
    ).toBeEnabled();
  });

  it('shows Connect now instead of queuing when the viewer’s agent isn’t connected', async () => {
    const user = userEvent.setup();
    serve({
      chat: page([message('m1', 0)]),
      agentConnection: connection({ covered: false, listening: false }),
    });
    renderChat();
    await screen.findAllByTestId('chat-message');
    expect(screen.queryByTestId('catch-up-strip')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Catch up' }));
    const panel = await screen.findByTestId('catch-up-panel');
    expect(await within(panel).findByRole('button', { name: 'Connect now' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Summarize with my agent' })).toBeNull();
  });

  it('says so while the agent works on a summary, and when there is no agent', async () => {
    const user = userEvent.setup();
    serve({
      chat: page([message('m1', 0)]),
      catchUp: {
        hasAgent: true,
        summaries: [],
        job: {
          id: 'j1',
          status: 'claimed',
          range: { kind: 'last', count: 20, fromReplyId: 'm1', toReplyId: 'm1' },
          createdAt: new Date().toISOString(),
        },
      },
    });
    const { unmount } = renderChat();
    await user.click(await screen.findByRole('button', { name: 'Catch up' }));
    expect(await screen.findByTestId('catch-up-working')).toHaveTextContent(
      'Your agent is reading 20 messages…',
    );
    unmount();
    vi.unstubAllGlobals();
    serve({ chat: page([message('m1', 0)]), catchUp: { ...noCatchUp, hasAgent: false } });
    renderChat();
    await user.click(await screen.findByRole('button', { name: 'Catch up' }));
    expect(await screen.findByText('You don’t have an agent yet')).toBeInTheDocument();
  });
});

describe('the chat composer’s keys', () => {
  function Editor({ onSubmit }: { onSubmit: () => void }) {
    const [value, setValue] = useState('Hi');
    return (
      <RichTextEditor
        value={value}
        onChange={setValue}
        submitOnEnter
        onSubmit={onSubmit}
        label="Message"
      />
    );
  }

  it('sends on Enter, not on Shift+Enter', async () => {
    const onSubmit = vi.fn();
    const client = createQueryClient();
    mockApi({
      '/api/config': { version: 'test', signupsEnabled: true, providers: {}, maxUploadMb: 25 },
    });
    render(
      <QueryClientProvider client={client}>
        <Editor onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    const box = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
