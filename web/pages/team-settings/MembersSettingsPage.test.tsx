import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Member, Role } from '@shared/schemas/teams';
import { createQueryClient } from '@web/lib/queryClient';
import { mockApi, testMe } from '@web/test/mockApi';
import type { TeamSettingsContext } from './context';
import MembersSettingsPage from './MembersSettingsPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

const me = testMe();
const team = me.teams[0]!;
const ada = { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null };
const mia = { id: 'u2', username: 'mia', name: 'Mia Chen', image: null };
const miaAi = {
  id: 'a2',
  username: 'mia-ai',
  name: 'Mia Chen AI',
  image: null,
  kind: 'agent' as const,
  agentOwner: mia,
};

function member(user: Member['user'], overrides: Partial<Member> = {}): Member {
  return {
    user,
    joinedAt: '2026-09-01T10:00:00.000Z',
    isOwner: false,
    roles: [],
    color: null,
    ...overrides,
  };
}

const everyone: Role = {
  id: 'r0',
  teamId: 't1',
  name: '@everyone',
  slug: 'everyone',
  color: null,
  position: 0,
  permissions: [],
  mentionable: false,
  hoist: false,
  isEveryone: true,
  memberCount: 3,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

function renderMembers() {
  const context: TeamSettingsContext = { team };
  const router = createMemoryRouter(
    [
      {
        path: '/t/:team/settings',
        element: <Outlet context={context} />,
        children: [{ path: 'members', element: <MembersSettingsPage /> }],
      },
    ],
    { initialEntries: ['/t/acme/settings/members'] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('MembersSettingsPage with agent members', () => {
  it('lists agents like members with the AI badge and their owner', async () => {
    mockApi({
      '/api/me': me,
      '/api/teams/t1/members': {
        items: [member(ada, { isOwner: true }), member(mia), member(miaAi)],
      },
      '/api/teams/t1/roles': { items: [everyone] },
    });
    renderMembers();
    const table = await screen.findByRole('table', { name: 'Members' }, { timeout: 5000 });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const agentRow = rows[2]!;
    expect(agentRow).toHaveTextContent('Mia Chen AI');
    expect(within(agentRow).getByText('AI', { selector: '[data-agent-badge]' })).toBeVisible();
    expect(agentRow).toHaveTextContent('@mia-ai · Mia Chen’s agent');
    expect(within(rows[1]!).queryByText('AI', { selector: '[data-agent-badge]' })).toBeNull();
  });

  it('warns that removing a person removes their agent too', async () => {
    mockApi({
      '/api/me': me,
      '/api/teams/t1/members': {
        items: [member(ada, { isOwner: true }), member(mia), member(miaAi)],
      },
      '/api/teams/t1/roles': { items: [everyone] },
    });
    const user = userEvent.setup();
    renderMembers();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Mia Chen' }, { timeout: 5000 }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from team' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Mia Chen and their agent lose access to Acme',
    );
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Actions for Mia Chen AI' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from team' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'It comes back only if Mia Chen rejoins the team.',
    );
  });
});
