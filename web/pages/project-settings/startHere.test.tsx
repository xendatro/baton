import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@shared/schemas/core';
import { DEFAULT_STAGE_RULES, type StageRules } from '@shared/schemas/pipelines';
import type { Pipeline, Project, Status, UpdateStatusInput } from '@shared/schemas/projects';
import { createQueryClient } from '@web/lib/queryClient';
import { routes } from '@web/router';
import { jsonResponse, mockApi, testConfig, testMe, testSession } from '@web/test/mockApi';

/** BAT#20: Project settings → Pipelines: each stage row's "Start here" switch. */

const LAZY = { timeout: 15_000 };
const NOW = '2026-09-29T10:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

function stage(id: string, name: string, position: number, rules: Partial<StageRules>): Status {
  return {
    id,
    projectId: 'p1',
    pipelineId: 'pl1',
    name,
    color: '#6b7280',
    icon: 'circle',
    position,
    isDefault: position === 0,
    taskCount: position,
    rules: { ...DEFAULT_STAGE_RULES, ...rules },
  };
}

function pipeline(canManage: boolean): Pipeline {
  return {
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
    canManage,
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

function setup({ canManage = true, fail = false } = {}) {
  const statuses: Status[] = [
    stage('s-open', 'Open', 0, { allowCreate: true }),
    stage('s-review', 'Review', 1, {}),
    stage('s-done', 'Done', 2, { blocksDependents: false }),
  ];
  const patches: Array<{ id: string; input: UpdateStatusInput }> = [];
  const base = testMe();
  const me: MeResponse = canManage
    ? base
    : { ...base, teams: base.teams.map((team) => ({ ...team, isOwner: false, permissions: [] })) };
  const patch =
    (id: string) =>
    ({ init }: { init?: RequestInit }) => {
      const input = JSON.parse(init?.body as string) as UpdateStatusInput;
      patches.push({ id, input });
      if (fail) return jsonResponse({ error: { code: 'forbidden', message: 'Not allowed' } }, 403);
      const index = statuses.findIndex((status) => status.id === id);
      const current = statuses[index] as Status;
      const updated = { ...current, rules: { ...(current.rules as StageRules), ...input.rules } };
      statuses[index] = updated as Status;
      return jsonResponse(updated);
    };
  mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': me,
    '/api/notifications/unread-count': { count: 0 },
    '/api/config': testConfig,
    '/api/projects/p1': project,
    '/api/projects/p1/statuses': () => jsonResponse({ items: statuses }),
    '/api/projects/p1/pipelines': { items: [pipeline(canManage)] },
    '/api/projects/p1/roles': { items: [] },
    '/api/teams/t1/roles': { items: [] },
    '/api/teams/t1/members': { items: [] },
    'PATCH /api/statuses/s-open': patch('s-open'),
    'PATCH /api/statuses/s-review': patch('s-review'),
    'PATCH /api/statuses/s-done': patch('s-done'),
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
  return { patches };
}

const startSwitch = (name: string) =>
  screen.getByRole('switch', { name: `New tasks can start in ${name}` });

describe('Start here', { timeout: 30_000 }, () => {
  it('shows a labelled switch per stage, apart from the task count', async () => {
    setup();
    await screen.findByRole('textbox', { name: 'Name of status Review' }, LAZY);
    expect(startSwitch('Open')).toBeChecked();
    expect(startSwitch('Review')).not.toBeChecked();
    expect(startSwitch('Done')).not.toBeChecked();
    // The Tasks cell holds only the count and the finished ✓.
    const rows = screen.getAllByTestId('status-row');
    expect(within(rows[2] as HTMLElement).getByLabelText('Counts as finished')).toBeVisible();
    expect(within(rows[0] as HTMLElement).queryByLabelText('Counts as finished')).toBeNull();
    expect(screen.queryByTestId('no-start-stage')).not.toBeInTheDocument();
  });

  it('turns several stages on and off from the list, by mouse or keyboard', async () => {
    const user = userEvent.setup();
    const { patches } = setup();
    await screen.findByRole('textbox', { name: 'Name of status Review' }, LAZY);

    await user.click(startSwitch('Review'));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ id: 's-review', input: { rules: { allowCreate: true } } });
    // Several stages may accept new tasks.
    await waitFor(() => expect(startSwitch('Review')).toBeChecked());
    expect(startSwitch('Open')).toBeChecked();

    startSwitch('Done').focus();
    await user.keyboard(' ');
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ id: 's-done', input: { rules: { allowCreate: true } } });

    // Turning them all off warns that no task can be created.
    await user.click(startSwitch('Open'));
    await user.click(startSwitch('Review'));
    await user.click(startSwitch('Done'));
    await waitFor(() => expect(patches).toHaveLength(5));
    expect(patches[4]).toEqual({ id: 's-done', input: { rules: { allowCreate: false } } });
    expect(await screen.findByTestId('no-start-stage')).toHaveTextContent(
      'No stage accepts new tasks',
    );
  });

  it('rolls back and toasts when the change fails', async () => {
    const user = userEvent.setup();
    setup({ fail: true });
    await screen.findByRole('textbox', { name: 'Name of status Review' }, LAZY);
    await user.click(startSwitch('Review'));
    expect(await screen.findByText('Not allowed')).toBeVisible();
    await waitFor(() => expect(startSwitch('Review')).not.toBeChecked());
  });

  it('is read-only for people who cannot manage the stages', async () => {
    setup({ canManage: false });
    await screen.findByRole('textbox', { name: 'Name of status Review' }, LAZY);
    expect(startSwitch('Open')).toBeChecked();
    expect(startSwitch('Open')).toBeDisabled();
    expect(startSwitch('Review')).toBeDisabled();
  });
});
