import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@shared/permissions';
import type { ReactionSummary, Reactor } from '@shared/schemas/core';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { queryKeys } from '@web/lib/queryKeys';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { ReactionBar } from './ReactionBar';
import { applyReaction, reactorName, reactorsLabel } from './reactions';

const ada: Reactor = { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null, via: null };
const grace: Reactor = { id: 'u2', username: 'grace', name: 'Grace', image: null, via: null };
const claude: Reactor = {
  id: 'u3',
  username: 'ethan',
  name: 'Ethan',
  image: null,
  via: { keyId: 'k1', keyName: 'MSI', agentName: 'Claude' },
};

const reactions: ReactionSummary[] = [
  { emoji: '🔥', count: 3, reactedByMe: true, users: [grace, ada, claude] },
  { emoji: '👍', count: 1, reactedByMe: false, users: [grace] },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reaction helpers', () => {
  it('names agents as "Claude via Ethan’s MSI" and the viewer as "You"', () => {
    expect(reactorName(claude)).toBe('Claude via Ethan’s MSI');
    expect(reactorName({ ...grace, via: { keyId: 'k2', keyName: 'CI' } })).toBe('Grace via CI');
    expect(
      reactorName({
        id: 'u4',
        username: 'ethan-ai',
        name: 'Ethan AI',
        image: null,
        kind: 'agent',
        agentOwner: { id: 'u3', username: 'ethan', name: 'Ethan', image: null },
        via: { keyId: 'k1', keyName: 'MSI', agentName: 'Claude' },
      }),
    ).toBe('Ethan AI');
    expect(reactorsLabel(reactions[0]!, 'u1')).toBe(
      'Grace, You, Claude via Ethan’s MSI reacted with 🔥',
    );
  });

  it('adds and removes the viewer’s reaction the way the server will', () => {
    const added = applyReaction(reactions, '👍', ada, true);
    expect(added[1]).toMatchObject({ emoji: '👍', count: 2, reactedByMe: true });
    expect(applyReaction(reactions, '🎉', ada, true).at(-1)).toEqual({
      emoji: '🎉',
      count: 1,
      reactedByMe: true,
      users: [ada],
    });
    const removed = applyReaction(reactions, '🔥', ada, false);
    expect(removed[0]).toMatchObject({ count: 2, reactedByMe: false, users: [grace, claude] });
    expect(
      applyReaction([{ ...reactions[1]!, users: [ada], reactedByMe: true }], '👍', ada, false),
    ).toEqual([]);
  });
});

function renderBar(permissions: Permission[], list: ReactionSummary[] = reactions) {
  const queryClient = createQueryClient();
  const me = testMe();
  queryClient.setQueryData(queryKeys.me(), {
    ...me,
    teams: me.teams.map((team) => ({ ...team, permissions })),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ReactionBar
          targetType="reply"
          targetId="r1"
          teamId="t1"
          reactions={list}
          queryKey={queryKeys.replies.list('task', 'x1')}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ReactionBar', () => {
  it('shows each reaction as a toggle with its count, and who reacted on hover', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderBar(['REPLY']);
    const fire = screen.getByRole('button', { name: 'React with 🔥 (3)' });
    expect(fire).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'React with 👍 (1)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.hover(fire);
    expect(
      (await screen.findAllByText('Grace, You, Claude via Ethan’s MSI reacted with 🔥'))[0],
    ).toBeInTheDocument();
    // Quick reactions skip the emoji already shown as chips.
    expect(screen.getByRole('button', { name: 'React with 🎉' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'React with 👍' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
  });

  it('removes your reaction on click and adds one with a quick emoji, updating at once', async () => {
    const calls: Array<{ method: string; url: URL; body: unknown }> = [];
    const respond = ({ url, init }: { url: URL; init?: RequestInit }) => {
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return jsonResponse({ targetType: 'reply', targetId: 'r1', reactions: [] });
    };
    mockApi({ 'PUT /api/reactions': respond, 'DELETE /api/reactions': respond });
    const user = userEvent.setup();
    renderBar(['REPLY']);

    await user.click(screen.getByRole('button', { name: 'React with 🔥 (3)' }));
    expect(screen.getByRole('button', { name: 'React with 🔥 (2)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe('DELETE');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      targetType: 'reply',
      targetId: 'r1',
      emoji: '🔥',
    });

    await user.click(screen.getByRole('button', { name: 'React with 🎉' }));
    expect(screen.getByRole('button', { name: 'React with 🎉 (1)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      body: { targetType: 'reply', targetId: 'r1', emoji: '🎉' },
    });
  });

  it('shows reactions read-only without REPLY, and nothing when there are none', () => {
    const fetchMock = mockApi({});
    renderBar([]);
    expect(screen.getByRole('button', { name: 'React with 🔥 (3)' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'React with 🎉' })).toBeNull();
    screen.getByRole('button', { name: 'React with 🔥 (3)' }).click();
    const urls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    expect(urls.some((url) => url.includes('/api/reactions'))).toBe(false);
    expect(screen.getByRole('button', { name: 'React with 🔥 (3)' })).toBeInTheDocument();
  });

  it('renders nothing for viewers who cannot react to an item without reactions', () => {
    mockApi({});
    renderBar([], []);
    expect(screen.queryByRole('group', { name: 'Reactions' })).toBeNull();
  });
});
