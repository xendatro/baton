import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@shared/permissions';
import type { MeResponse, ReplyListResponse, ReplyNode } from '@shared/schemas/core';
import { createQueryClient } from '@web/lib/queryClient';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';
import { Timeline } from './Timeline';
import { buildReplyForest, focusForDeepLink, loadedDescendants } from './threadForest';

const ada = { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null };
const grace = { id: 'u2', username: 'grace', name: 'Grace Hopper', image: null };

/** `/api/me` lists effective permissions: an administrator has them all. */
function me(): MeResponse {
  const base = testMe();
  return { ...base, teams: base.teams.map((team) => ({ ...team, permissions: [...PERMISSIONS] })) };
}

let clock = 0;
function node(
  id: string,
  parentReplyId: string | null,
  depth: number,
  overrides: Partial<ReplyNode> = {},
): ReplyNode {
  clock += 1;
  const at = new Date(Date.UTC(2026, 8, 20, 10, 0, clock)).toISOString();
  return {
    id,
    teamId: 't1',
    projectId: 'p1',
    parentType: 'task',
    parentId: 'task1',
    parentReplyId,
    body: `Body of ${id}`,
    author: depth % 2 === 0 ? ada : grace,
    via: null,
    attachments: [],
    createdAt: at,
    updatedAt: at,
    editedAt: null,
    deleted: false,
    replyCount: 0,
    depth,
    ...overrides,
  };
}

function tree(items: ReplyNode[], extra: Partial<ReplyListResponse> = {}): ReplyListResponse {
  return {
    items,
    total: items.length,
    topLevelCount: items.filter((item) => item.depth === 0).length,
    ancestors: [],
    ...extra,
  };
}

/** Serves `/api/replies` from `answer`, recording each request's query string. */
function serve(answer: (params: URLSearchParams) => ReplyListResponse) {
  const requests: URLSearchParams[] = [];
  mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(),
    '/api/config': testConfig,
    '/api/notifications/unread-count': { count: 0 },
    '/api/activity': { items: [] },
    '/api/teams/t1/mentionables': { users: [], roles: [] },
    '/api/replies': ({ url }: { url: URL }) => {
      requests.push(url.searchParams);
      return jsonResponse(answer(url.searchParams));
    },
  });
  return requests;
}

function renderTimeline(path = '/task') {
  const router = createMemoryRouter(
    [{ path: '/task', element: <Timeline parentType="task" parentId="task1" /> }],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('threaded replies', { timeout: 20_000 }, () => {
  it('nests answers and collapses a thread with its line', async () => {
    const a = node('a', null, 0, { replyCount: 1 });
    const a1 = node('a1', 'a', 1, { replyCount: 1 });
    const a1x = node('a1x', 'a1', 2);
    const b = node('b', null, 0);
    serve(() => tree([a, a1, a1x, b]));
    const user = userEvent.setup();
    renderTimeline();

    expect(await screen.findByText('Body of a1x')).toBeInTheDocument();
    const answers = screen.getByRole('list', { name: 'Answers to reply by Ada Lovelace' });
    expect(within(answers).getByText('Body of a1')).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: 'Collapse thread: reply by Ada Lovelace' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await user.click(collapse);
    expect(screen.queryByText('Body of a')).not.toBeInTheDocument();
    expect(screen.queryByText('Body of a1x')).not.toBeInTheDocument();
    expect(screen.getByText('Body of b')).toBeInTheDocument();
    const expand = screen.getByRole('button', { name: /Expand thread: Ada Lovelace/ });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveTextContent('2 replies hidden');

    // Keyboard: the collapsed row is a button, and the focus stays on the toggle.
    expect(expand).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Body of a1x')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Collapse thread: reply by Ada Lovelace' }),
    ).toHaveFocus();
  });

  it('shows 10 levels, then "Continue this thread" opens the sub-thread', async () => {
    const chain = Array.from({ length: 10 }, (_, depth) =>
      node(`d${depth}`, depth === 0 ? null : `d${depth - 1}`, depth, { replyCount: 1 }),
    );
    const deeper = node('d10', 'd9', 1);
    const requests = serve((params) =>
      params.get('root') === 'd9'
        ? tree([{ ...chain[9]!, depth: 0 }, deeper], {
            topLevelCount: 1,
            ancestors: chain.slice(0, 9).map((item) => item.id),
          })
        : tree(chain, { total: 11 }),
    );
    const user = userEvent.setup();
    const router = renderTimeline();

    expect(await screen.findByText('Body of d9')).toBeInTheDocument();
    expect(screen.queryByText('Body of d10')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Continue this thread/ }));

    expect(await screen.findByText('Body of d10')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?thread=d9');
    expect(requests.at(-1)?.get('root')).toBe('d9');
    expect(screen.getByText('You’re viewing a single comment thread.')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Show parent comment' }));
    expect(router.state.location.search).toBe('?thread=d8');
    await user.click(await screen.findByRole('link', { name: 'View all comments' }));
    expect(router.state.location.search).toBe('');
  });

  it('loads hidden answers with "N more replies" and shows deleted placeholders', async () => {
    const a = node('a', null, 0, { replyCount: 3, deleted: true, body: '', author: null });
    const a1 = node('a1', 'a', 1);
    const more = [node('a2', 'a', 1), node('a3', 'a', 1)];
    const requests = serve((params) =>
      params.get('expand') === 'a' ? tree([a, a1, ...more]) : tree([a, a1]),
    );
    const user = userEvent.setup();
    renderTimeline();

    expect(await screen.findByText('[deleted]')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Deleted reply' })).toHaveAttribute('id', 'reply-a');
    await user.click(screen.getByRole('button', { name: /2 more replies/ }));
    expect(await screen.findByText('Body of a3')).toBeInTheDocument();
    expect(requests.at(-1)?.get('expand')).toBe('a');
    expect(screen.queryByRole('button', { name: /more replies/ })).not.toBeInTheDocument();
  });

  it('asks for a linked reply and opens its collapsed ancestors', async () => {
    const a = node('a', null, 0, { replyCount: 1 });
    const a1 = node('a1', 'a', 1);
    sessionStorage.setItem('baton:reply-collapsed:task:task1', JSON.stringify(['a']));
    const requests = serve(() => tree([a, a1]));
    renderTimeline('/task#reply-a1');

    expect(await screen.findByText('Body of a1')).toBeInTheDocument();
    expect(requests[0]?.get('include')).toBe('a1');
    // The viewer can still collapse that thread while the link is in the URL.
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Collapse thread: reply by Ada Lovelace' }),
    );
    expect(screen.queryByText('Body of a1')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(sessionStorage.getItem('baton:reply-collapsed:task:task1')).toBe('["a"]'),
    );
  });

  it('opens a Reply box under a reply', async () => {
    const a = node('a', null, 0);
    serve(() => tree([a]));
    const user = userEvent.setup();
    renderTimeline();

    const reply = await screen.findByRole('button', { name: 'Reply to Ada Lovelace' });
    expect(reply).toHaveAttribute('aria-expanded', 'false');
    await user.click(reply);
    expect(reply).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});

describe('threadForest', () => {
  it('builds the tree and finds where a deep link opens', () => {
    const chain = Array.from({ length: 13 }, (_, depth) =>
      node(`c${depth}`, depth === 0 ? null : `c${depth - 1}`, depth, { replyCount: 1 }),
    );
    const forest = buildReplyForest(chain);
    expect(forest.roots.map((root) => root.reply.id)).toEqual(['c0']);
    expect(loadedDescendants(forest.roots[0]!)).toBe(12);
    expect(forest.byId.get('c12')?.hidden).toBe(1);
    // Reddit's context=3: three levels above the linked reply.
    expect(focusForDeepLink(forest, 'c12')).toBe('c9');
    expect(focusForDeepLink(forest, 'c9')).toBeNull();
  });
});
