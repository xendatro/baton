import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@shared/schemas/core';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { CreateStatusInput, Pipeline, Project, Status } from '@shared/schemas/projects';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/** Project settings → Pipelines: "New stage" → Create, Create and edit…, Create from existing…. */

const LAZY = { timeout: 15_000 };
const NOW = '2026-09-27T10:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

function stage(
  id: string,
  name: string,
  position: number,
  extra: Partial<Status> = {},
  projectId = 'p1',
  pipelineId = 'pl1',
): Status {
  return {
    id,
    projectId,
    pipelineId,
    name,
    color: '#6b7280',
    icon: 'circle',
    position,
    isDefault: position === 0,
    taskCount: 0,
    rules: { ...DEFAULT_STAGE_RULES },
    ...extra,
  };
}

function pipeline(id: string, projectId: string, name: string, isDefault: boolean): Pipeline {
  return {
    id,
    projectId,
    name,
    slug: name.toLowerCase(),
    color: null,
    icon: null,
    position: isDefault ? 0 : 1,
    isDefault,
    viewRule: null,
    createRule: null,
    manageRule: null,
    statusCount: 2,
    taskCount: 0,
    openTaskCount: 0,
    canCreateTasks: true,
    canManage: true,
  };
}

const project: Project = {
  id: 'p1',
  teamId: 't1',
  teamSlug: 'acme',
  name: 'Web app',
  key: 'WEB',
  ref: 'acme/WEB',
  description: '',
  icon: null,
  color: '#0ea5e9',
  counts: {
    tasks: 0,
    assignedTasks: 0,
    completedTasks: 0,
    openTasks: 0,
    doneTasks: 0,
    openIssues: 0,
    resolvedIssues: 0,
  },
  path: '/t/acme/p/WEB',
  createdAt: NOW,
  updatedAt: NOW,
  readme: '',
  createdBy: null,
  keyAliases: [],
  statuses: [],
  labels: [],
};

function me(): MeResponse {
  const base = testMe();
  return {
    ...base,
    teams: [
      ...base.teams,
      {
        id: 't2',
        slug: 'globex',
        name: 'Globex',
        icon: null,
        color: '#22c55e',
        isOwner: true,
        permissions: ['ADMINISTRATOR'],
        projects: [{ id: 'p2', key: 'GAME', name: 'Game', icon: null, color: '#f59e0b' }],
      },
    ],
  };
}

function setup() {
  const statuses: Status[] = [
    stage('s-backlog', 'Backlog', 0, { rules: { ...DEFAULT_STAGE_RULES, allowCreate: true } }),
    stage('s-review', 'Review', 1, {
      rules: {
        ...DEFAULT_STAGE_RULES,
        exitCriteria: [{ id: 'tests', text: 'Tests pass' }],
        approvals: {
          count: 2,
          rule: { allow: [{ type: 'user', userId: 'u1' }], deny: [] },
          dismissOnChange: false,
        },
      },
    }),
  ];
  const gameStatuses: Status[] = [
    stage('g-todo', 'To do', 0, {}, 'p2', 'pl-game'),
    stage(
      'g-qa',
      'QA',
      1,
      { rules: { ...DEFAULT_STAGE_RULES, instructions: 'Play it.' } },
      'p2',
      'pl-game',
    ),
  ];
  const posts: CreateStatusInput[] = [];
  mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(),
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/p1/statuses': () => jsonResponse({ items: statuses }),
    '/api/projects/p1/pipelines': { items: [pipeline('pl1', 'p1', 'Main', true)] },
    '/api/projects/p2/pipelines': { items: [pipeline('pl-game', 'p2', 'Art', true)] },
    '/api/projects/p2/statuses': { items: gameStatuses },
    '/api/projects/p1/roles': { items: [] },
    '/api/teams/t1/roles': { items: [] },
    '/api/teams/t1/members': { items: [] },
    'POST /api/projects/p1/statuses': ({ init }: { init?: RequestInit }) => {
      const input = JSON.parse(init?.body as string) as CreateStatusInput;
      posts.push(input);
      const created = stage(`s-new-${posts.length}`, input.name, statuses.length);
      statuses.push(created);
      return jsonResponse(
        input.copyRulesFrom
          ? { ...created, copied: { from: 'Art / QA', dropped: ['@ann (approvers)'] } }
          : created,
        201,
      );
    },
  });
  const router = createMemoryRouter(routes, {
    initialEntries: ['/t/acme/p/WEB/settings/pipelines?view=list'],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { posts };
}

describe('New stage', { timeout: 30_000 }, () => {
  it('Create adds a plain stage at once and focuses its name for renaming', async () => {
    const user = userEvent.setup();
    const { posts } = setup();
    await screen.findByRole('textbox', { name: 'Name of status Review' }, LAZY);
    await user.click(screen.getByRole('button', { name: 'New stage' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ name: 'New stage', pipelineId: 'pl1' });
    expect(posts[0]).not.toHaveProperty('rules');
    const name = await screen.findByRole('textbox', { name: 'Name of status New stage' });
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // The menu's Create picks the next free name.
    await user.click(screen.getByRole('button', { name: 'More ways to create a stage' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Create A plain stage/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ name: 'New stage 2' });
  });

  it('Create and edit opens the step-by-step dialog', async () => {
    const user = userEvent.setup();
    const { posts } = setup();
    await screen.findByRole('textbox', { name: 'Name of status Review' }, LAZY);
    await user.click(screen.getByRole('button', { name: 'More ways to create a stage' }));
    await user.click(await screen.findByRole('menuitem', { name: /Create and edit/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New stage' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /Exit criteria/ })).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  it('Create from existing: basics, then the stage to copy, here or in another pipeline', async () => {
    const user = userEvent.setup();
    const { posts } = setup();
    await screen.findByRole('textbox', { name: 'Name of status Review' }, LAZY);
    await user.click(screen.getByRole('button', { name: 'More ways to create a stage' }));
    await user.click(await screen.findByRole('menuitem', { name: /Create from existing/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New stage from existing' })).toBeVisible();

    // The name must be new.
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'review');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('already a stage named “Review”');
    await user.clear(within(dialog).getByRole('textbox', { name: 'Name' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Security review');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    // Page 2: this pipeline's stages, each with a summary of its rules.
    expect(within(dialog).getByRole('heading', { name: 'Copy settings from' })).toBeVisible();
    const list = within(dialog).getByRole('radiogroup', { name: 'Stage to copy the settings of' });
    expect(within(list).getByText('New tasks can start here')).toBeVisible();
    expect(within(list).getByText('1 exit criterion · 2 approvals')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Create stage' })).toBeDisabled();
    await user.click(within(list).getByRole('radio', { name: /Review/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create stage' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const { color, ...copyInput } = posts[0] ?? { color: undefined };
    expect(color).toMatch(/^#/);
    expect(copyInput).toEqual({
      name: 'Security review',
      icon: 'circle',
      copyRulesFrom: 's-review',
      pipelineId: 'pl1',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Another team's project: browse to it and copy one of its stages.
    await user.click(screen.getByRole('button', { name: 'More ways to create a stage' }));
    await user.click(await screen.findByRole('menuitem', { name: /Create from existing/ }));
    const again = await screen.findByRole('dialog');
    await user.type(within(again).getByRole('textbox', { name: 'Name' }), 'Playtest');
    await user.click(within(again).getByRole('button', { name: 'Next' }));
    await user.click(within(again).getByRole('button', { name: 'Browse other pipelines…' }));
    const projectSelect = within(again).getByRole('combobox', { name: 'Project' });
    expect(within(projectSelect).getByRole('group', { name: 'Globex' })).toBeInTheDocument();
    await user.selectOptions(projectSelect, 'p2');
    const other = await within(again).findByRole('radio', { name: /QA/ });
    expect(within(again).getByRole('combobox', { name: 'Pipeline' })).toHaveValue('pl-game');
    expect(within(again).getByText('Instructions')).toBeVisible();
    await user.click(other);
    await user.click(within(again).getByRole('button', { name: 'Create stage' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ name: 'Playtest', copyRulesFrom: 'g-qa', pipelineId: 'pl1' });
    // What the copy left out is shown.
    expect(
      (await screen.findAllByText(/Left out \(no match here\): @ann \(approvers\)/)).length,
    ).toBeGreaterThan(0);
  });
});
