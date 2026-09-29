import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAGE_RULES, type StageRules } from '@shared/schemas/pipelines';
import type {
  CreatePipelineInput,
  Pipeline,
  Project,
  Status,
  UpdateStatusInput,
} from '@shared/schemas/projects';
import type { MeResponse } from '@shared/schemas/core';
import type { Member } from '@shared/schemas/teams';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/** Project settings → Pipelines: the visual editor, its stage panel and pipeline templates. */

const LAZY = { timeout: 15_000 };
const NOW = '2026-09-29T10:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

function stage(id: string, name: string, position: number, rules: Partial<StageRules> = {}) {
  return {
    id,
    projectId: 'p1',
    pipelineId: 'pl1',
    name,
    color: '#6b7280',
    icon: 'circle',
    position,
    isDefault: position === 0,
    taskCount: 0,
    rules: { ...DEFAULT_STAGE_RULES, ...rules },
  } satisfies Status;
}

const pipeline: Pipeline = {
  id: 'pl1',
  projectId: 'p1',
  name: 'Main',
  slug: 'main',
  color: null,
  icon: null,
  position: 0,
  isDefault: true,
  viewRule: null,
  createRule: null,
  manageRule: null,
  statusCount: 3,
  taskCount: 0,
  openTaskCount: 0,
  canCreateTasks: true,
  canManage: true,
};

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

function member(id: string, username: string, name: string): Member {
  return {
    user: { id, username, name, image: null },
    joinedAt: NOW,
    isOwner: false,
    roles: [],
    color: null,
  };
}

function me(): MeResponse {
  const base = testMe();
  return {
    ...base,
    teams: base.teams.map((team) => ({
      ...team,
      permissions: ['ADMINISTRATOR', 'MANAGE_STATUSES'],
    })),
  };
}

function setup() {
  const statuses: Status[] = [
    stage('s-plan', 'Plan', 0, { allowCreate: true }),
    stage('s-build', 'Build', 1, { sendBackTo: ['s-plan'] }),
    stage('s-done', 'Done', 2, { blocksDependents: false, claimable: false }),
  ];
  const patches: Array<{ id: string; input: UpdateStatusInput }> = [];
  const created: CreatePipelineInput[] = [];
  const patch = (id: string) => (request: { init?: RequestInit }) => {
    const input = JSON.parse(request.init?.body as string) as UpdateStatusInput;
    patches.push({ id, input });
    const index = statuses.findIndex((status) => status.id === id);
    const current = statuses[index]!;
    const next: Status = {
      ...current,
      ...(input.name ? { name: input.name } : {}),
      rules: { ...current.rules!, ...(input.rules as Partial<StageRules>) },
    };
    statuses[index] = next;
    return jsonResponse(next);
  };
  mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me(),
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/p1/statuses': () => jsonResponse({ items: statuses }),
    '/api/projects/p1/pipelines': { items: [pipeline] },
    '/api/projects/p1/suggestable-models': {
      harnesses: [
        {
          id: 'claude',
          online: true,
          machines: [],
          reported: true,
          models: [{ id: 'opus', label: null, efforts: ['high'], online: true }],
          efforts: ['high'],
        },
      ],
    },
    '/api/projects/p1/roles': { items: [] },
    '/api/teams/t1/roles': { items: [] },
    '/api/teams/t1/members': {
      items: [member('u1', 'ann', 'Ann'), member('u2', 'ann-ai', 'Ann AI')],
    },
    'PATCH /api/statuses/s-plan': patch('s-plan'),
    'PATCH /api/statuses/s-build': patch('s-build'),
    'POST /api/projects/p1/pipelines': ({ init }: { init?: RequestInit }) => {
      const input = JSON.parse(init?.body as string) as CreatePipelineInput;
      created.push(input);
      return jsonResponse({ ...pipeline, id: 'pl2', name: input.name, isDefault: false }, 201);
    },
  });
  const router = createMemoryRouter(routes, {
    initialEntries: ['/t/acme/p/WEB/settings/pipelines'],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { patches, created, router };
}

const node = (name: RegExp) => screen.getByRole('button', { name });

describe('Visual pipeline editor', { timeout: 30_000 }, () => {
  it('shows the stages as a flow with badges, reachable with the arrow keys', async () => {
    const user = userEvent.setup();
    setup();
    const editor = await screen.findByTestId('pipeline-editor', {}, LAZY);
    const nodes = within(editor).getAllByTestId('stage-node');
    expect(nodes.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Plan'),
      expect.stringContaining('Build'),
      expect.stringContaining('Done'),
    ]);
    // Who works here, the send-back and the finish, in words for screen readers.
    expect(node(/^Stage 1: Plan; Whoever had it keeps it; new tasks can start here/)).toBeVisible();
    expect(node(/^Stage 2: Build;.*can send back to Plan/)).toBeVisible();
    expect(node(/^Stage 3: Done;.*counts as finished/)).toBeVisible();
    expect(
      within(editor).getByRole('button', { name: 'Add a stage between Plan and Build' }),
    ).toBeVisible();
    expect(within(editor).getByRole('button', { name: 'Add a stage after Done' })).toBeVisible();

    node(/^Stage 1: Plan/).focus();
    await user.keyboard('{ArrowRight}');
    expect(node(/^Stage 2: Build/)).toHaveFocus();
    await user.keyboard('{End}');
    expect(node(/^Stage 3: Done/)).toHaveFocus();

    // Difficulty is gone (2026-09-29): no Difficulty section in Project settings.
    expect(screen.queryByRole('link', { name: 'Difficulty' })).not.toBeInTheDocument();

    // The list view is still there.
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findAllByTestId('status-row')).toHaveLength(3);
  });

  it('edits a stage in its panel: checks, an approval, an agent and instructions', async () => {
    const user = userEvent.setup();
    const { patches } = setup();
    await screen.findByTestId('pipeline-editor', {}, LAZY);
    await user.click(node(/^Stage 2: Build/));
    const panel = await screen.findByTestId('stage-panel');
    expect(within(panel).getByRole('textbox', { name: 'Stage name' })).toHaveValue('Build');

    // What's needed to move on: a check…
    await user.type(within(panel).getByRole('textbox', { name: 'New check' }), 'Tests pass{Enter}');
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      id: 's-build',
      input: { rules: { exitCriteria: [{ id: 'c1', text: 'Tests pass' }] } },
    });
    expect(await within(panel).findByRole('textbox', { name: 'Check 1' })).toHaveValue(
      'Tests pass',
    );
    expect(
      within(screen.getByTestId('pipeline-editor')).getByTestId('badge-criteria'),
    ).toHaveTextContent('1');

    // …and an approval, by every person to start with.
    await user.click(within(panel).getByRole('switch', { name: 'Needs approval' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]?.input).toEqual({
      rules: {
        approvals: {
          count: 1,
          rule: { allow: [{ type: 'everyone', scope: 'people' }], deny: [] },
          dismissOnChange: false,
        },
      },
    });
    expect(
      await within(panel).findByText('1 person must approve before it moves on.'),
    ).toBeVisible();

    // Should an agent do this stage? Nothing is saved until an agent is picked.
    await user.click(within(panel).getByRole('switch', { name: 'An agent does this stage' }));
    expect(within(panel).getByText('Pick at least one agent.')).toBeVisible();
    expect(patches).toHaveLength(2);
    // Only agents are offered.
    expect(within(panel).queryByRole('checkbox', { name: /^Ann @ann$/ })).toBeNull();
    await user.click(within(panel).getByRole('checkbox', { name: /Ann AI/ }));
    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches[2]?.input).toEqual({
      rules: {
        handoff: { mode: 'pool', rule: { allow: [{ type: 'user', userId: 'u2' }], deny: [] } },
      },
    });
    // Who works here now says an agent does it; the node shows the agent.
    expect(within(panel).getByText(/An agent does this stage\. Turn off/)).toBeVisible();
    expect(
      within(screen.getByTestId('pipeline-editor')).getByTestId('badge-agent'),
    ).toHaveTextContent('@ann-ai');

    // Instructions save when the field is left.
    await user.type(within(panel).getByRole('textbox', { name: 'Instructions' }), 'Build it.');
    await user.tab();
    await waitFor(() => expect(patches).toHaveLength(4));
    expect(patches[3]?.input).toEqual({ rules: { instructions: 'Build it.' } });

    // Turning the agent off hands the stage back to whoever had the task.
    await user.click(within(panel).getByRole('switch', { name: 'An agent does this stage' }));
    await waitFor(() => expect(patches).toHaveLength(5));
    expect(patches[4]?.input).toEqual({ rules: { handoff: { mode: 'keep' } } });

    // Everything else is under Advanced, with the full dialog.
    await user.click(within(panel).getByRole('button', { name: 'Advanced' }));
    await user.click(within(panel).getByRole('button', { name: 'All settings…' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Build/ });
    expect(within(dialog).getByRole('heading', { name: 'Basics' })).toBeVisible();
  });

  it('suggests a model for the stage’s agents, saved as rules.suggestedModel', async () => {
    const user = userEvent.setup();
    const { patches } = setup();
    await screen.findByTestId('pipeline-editor', {}, LAZY);
    await user.click(node(/^Stage 1: Plan/));
    const panel = await screen.findByTestId('stage-panel');
    const field = within(panel).getByTestId('stage-suggested-model');
    await user.selectOptions(
      within(field).getByRole('combobox', { name: 'Suggested model: harness' }),
      'claude',
    );
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      id: 's-plan',
      input: { rules: { suggestedModel: { harness: 'claude', model: '', effort: '' } } },
    });
    await user.type(
      within(field).getByRole('combobox', { name: 'Suggested model: model' }),
      'opus',
    );
    await user.type(
      within(field).getByRole('combobox', { name: 'Suggested model: effort' }),
      'high',
    );
    await user.click(within(panel).getByRole('textbox', { name: 'Instructions' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]?.input).toEqual({
      rules: { suggestedModel: { harness: 'claude', model: 'opus', effort: 'high' } },
    });
    // Cleared: no suggestion.
    await user.selectOptions(
      within(field).getByRole('combobox', { name: 'Suggested model: harness' }),
      '',
    );
    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches[2]?.input).toEqual({ rules: { suggestedModel: null } });
  });

  it('hands a stage to a list of people, saved once someone is named', async () => {
    const user = userEvent.setup();
    const { patches } = setup();
    await screen.findByTestId('pipeline-editor', {}, LAZY);
    await user.click(node(/^Stage 1: Plan/));
    const panel = await screen.findByTestId('stage-panel');
    await user.click(within(panel).getByRole('radio', { name: /These people, roles or agents/ }));
    expect(patches).toHaveLength(0);
    await user.type(
      within(panel).getByRole('combobox', { name: 'Add to Who works here: include' }),
      '@ann',
    );
    await user.click(await within(panel).findByRole('option', { name: /@ann Ann Person/ }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      id: 's-plan',
      input: {
        rules: {
          handoff: {
            mode: 'specific',
            rule: { allow: [{ type: 'user', userId: 'u1' }], deny: [] },
          },
        },
      },
    });
    await user.click(within(panel).getByRole('radio', { name: /Nobody/ }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]?.input).toEqual({ rules: { handoff: { mode: 'nobody' } } });
  });

  it('creates a pipeline from a template', async () => {
    const user = userEvent.setup();
    const { created } = setup();
    await screen.findByTestId('pipeline-editor', {}, LAZY);
    await user.click(await screen.findByRole('button', { name: 'New pipeline' }));
    const dialog = await screen.findByRole('dialog', { name: 'New pipeline' });
    // Each template previews its stages.
    expect(
      within(within(dialog).getByRole('list', { name: 'AI loop stages' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Plan', 'Build', 'Review', 'Done']);
    expect(within(dialog).getByRole('radio', { name: /Simple board/ })).toBeChecked();
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Agents');
    await user.click(within(dialog).getByRole('radio', { name: /AI loop/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add pipeline' }));
    await waitFor(() => expect(created).toEqual([{ name: 'Agents', template: 'ai_loop' }]));
  });
});
