import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Member, MemberRole } from '@shared/schemas/teams';
import { createQueryClient } from '@web/lib/queryClient';
import { invalidateForEvent } from '@web/lib/live';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { memberSections } from './memberSections';
import TeamMembersPage from './TeamMembersPage';

afterEach(() => {
  vi.unstubAllGlobals();
});

const LAZY = { timeout: 5000 };
const base = testMe();
const me = {
  ...base,
  teams: base.teams.map((team) => ({
    ...team,
    permissions: ['CREATE_INVITES' as const, 'MANAGE_MEMBERS' as const],
  })),
};
const ada = { id: 'u1', username: 'ada', name: 'Ada Lovelace', image: null };
const mia = { id: 'u2', username: 'mia', name: 'Mia Chen', image: null };
const zoe = { id: 'u3', username: 'zoe', name: 'Zoe Park', image: null };
const adaAi = {
  id: 'a1',
  username: 'ada-ai',
  name: 'Ada Lovelace AI',
  image: null,
  kind: 'agent' as const,
  agentOwner: ada,
};
const miaAi = { ...adaAi, id: 'a2', username: 'mia-ai', name: 'Mia Chen AI', agentOwner: mia };

const lead: MemberRole = {
  id: 'r2',
  slug: 'lead',
  name: 'Leads',
  color: '#ef4444',
  position: 3,
  hoist: true,
};
const dev: MemberRole = {
  id: 'r1',
  slug: 'dev',
  name: 'Developers',
  color: '#3b82f6',
  position: 2,
  hoist: true,
};
const quiet: MemberRole = { id: 'r3', slug: 'quiet', name: 'Quiet', color: null, position: 1 };

function member(user: Member['user'], roles: MemberRole[] = [], isOwner = false): Member {
  return { user, joinedAt: '2026-09-01T10:00:00.000Z', isOwner, roles, color: null };
}

const members = [
  member(ada, [lead], true),
  member(mia, [dev, quiet]),
  member(zoe, [quiet]),
  member(adaAi, [dev]),
  member(miaAi),
];

function renderPage() {
  const queryClient = createQueryClient();
  const router = createMemoryRouter([{ path: '/t/:team/members', element: <TeamMembersPage /> }], {
    initialEntries: ['/t/acme/members'],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('memberSections', () => {
  it('groups by highest hoisted role, then Members and Agents, online before offline', () => {
    const sections = memberSections(members, new Set(['u2', 'a1', 'a2']));
    expect(
      sections.map((section) => [
        section.title,
        section.online.map((m) => m.user.username),
        section.offline.map((m) => m.user.username),
      ]),
    ).toEqual([
      ['Leads', [], ['ada']],
      ['Developers', ['ada-ai', 'mia'], []],
      ['Members', [], ['zoe']],
      ['Agents', ['mia-ai'], []],
    ]);
  });
});

describe('TeamMembersPage', () => {
  it('lists members by role, split online and offline, with presence not by color alone', async () => {
    mockApi({
      '/api/me': me,
      '/api/teams/t1/members': { items: members },
      '/api/teams/t1/presence': { online: ['u2', 'a1'] },
    });
    renderPage();
    const leads = await screen.findByRole('region', { name: /Leads/ }, LAZY);
    expect(within(leads).getByRole('heading', { level: 3 })).toHaveTextContent('Offline — 1');
    expect(within(leads).getByRole('listitem')).toHaveTextContent('Ada Lovelace');
    expect(within(leads).getByText('Owner')).toBeInTheDocument();

    const developers = screen.getByRole('region', { name: /Developers/ });
    const onlineList = within(developers).getByRole('list', { name: 'Online — 2' });
    const rows = within(onlineList).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-presence'))).toEqual(['online', 'online']);
    expect(rows[0]).toHaveTextContent('Ada Lovelace AI');
    expect(rows[0]).toHaveTextContent('Ada Lovelace’s agent');
    expect(within(rows[0]!).getByText('AI', { selector: '[data-agent-badge]' })).toBeVisible();
    expect(rows[1]).toHaveTextContent(', online');

    const agents = screen.getByRole('region', { name: /Agents/ });
    expect(within(agents).getByRole('list', { name: 'Offline — 1' })).toHaveTextContent(
      'Mia Chen AI',
    );
    expect(screen.getByText('5 members · 2 online')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
  });

  it('follows presence.changed events', async () => {
    let online = ['u2'];
    mockApi({
      '/api/me': me,
      '/api/teams/t1/members': { items: members },
      '/api/teams/t1/presence': () => jsonResponse({ online }),
    });
    const queryClient = renderPage();
    const agents = await screen.findByRole('region', { name: /Agents/ }, LAZY);
    expect(within(agents).getByRole('list', { name: 'Offline — 1' })).toBeInTheDocument();
    online = ['u2', 'a2'];
    await act(() =>
      invalidateForEvent(queryClient, {
        type: 'presence.changed',
        teamId: 't1',
        entityType: 'team',
        entityId: 't1',
        actorId: null,
        at: new Date().toISOString(),
      }),
    );
    expect(await within(agents).findByRole('list', { name: 'Online — 1' })).toHaveTextContent(
      'Mia Chen AI',
    );
  });

  it('offers an invite when you are alone, and shows errors', async () => {
    mockApi({
      '/api/me': me,
      '/api/teams/t1/members': { items: [member(ada, [], true)] },
      '/api/teams/t1/presence': { online: ['u1'] },
    });
    renderPage();
    expect(await screen.findByText('Just you so far', {}, LAZY)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Invite people' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Manage' })).toHaveAttribute(
      'href',
      '/t/acme/settings/members',
    );
  });

  it('shows an error state when members fail to load', async () => {
    mockApi({
      '/api/me': me,
      '/api/teams/t1/members': () =>
        jsonResponse({ error: { code: 'internal', message: 'Boom' } }, 500),
      '/api/teams/t1/presence': { online: [] },
    });
    renderPage();
    expect(
      await screen.findByText('Couldn’t load members', {}, { timeout: 8000 }),
    ).toBeInTheDocument();
  });
});
