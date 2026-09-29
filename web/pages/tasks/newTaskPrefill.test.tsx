import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConnection } from '@shared/schemas/agentRunner';
import type { TaskDraftState } from '@shared/schemas/chat';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import { Dialog, DialogContent } from '@web/components/ui/dialog';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { queryKeys } from '@web/lib/queryKeys';
import { prefillFromIssue, titleFromText } from '@web/lib/taskPrefill';
import { jsonResponse, mockApi, testMe, testSession } from '@web/test/mockApi';
import NewTaskForm from './NewTaskForm';

/** The New task form started from an issue: prefilled, linked as fixes, drafted by your agent. */

function status(id: string, name: string, position: number, allowCreate: boolean): Status {
  return {
    id,
    projectId: 'p1',
    pipelineId: 'pl-a',
    name,
    color: '#6b7280',
    icon: 'circle',
    position,
    isDefault: position === 0,
    taskCount: 0,
    rules: { ...DEFAULT_STAGE_RULES, allowCreate },
  };
}

const pipeline = {
  id: 'pl-a',
  projectId: 'p1',
  name: 'Default',
  slug: 'default',
  color: null,
  icon: null,
  position: 0,
  isDefault: true,
  viewRule: null,
  createRule: null,
  manageRule: null,
  statusCount: 3,
  taskCount: 0,
  canCreateTasks: true,
  canManage: true,
};

const connection: AgentConnection = {
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
};

const prefill = prefillFromIssue({
  id: 'i1',
  ref: 'WEB#7',
  title: 'Crash on start',
  body: 'Open the app and it crashes.',
  path: '/t/acme/p/WEB/issues/7',
  kind: 'fixes',
});

const task = {
  id: 'k1',
  ref: 'WEB-3',
  title: 'Crash on start',
  path: '/t/acme/p/WEB/tasks/3',
};

function serve(posts: Array<{ path: string; body: unknown }>, draft?: TaskDraftState) {
  const record =
    (path: string, answer: unknown) =>
    ({ init }: { init?: RequestInit }) => {
      posts.push({ path, body: JSON.parse((init?.body as string | undefined) ?? '{}') });
      return jsonResponse(answer, 201);
    };
  return mockApi({
    '/api/auth/get-session': testSession,
    '/api/me': testMe(),
    '/api/projects/p1/statuses': {
      items: [
        status('s-open', 'Open', 0, true),
        status('s-triage', 'Triage', 1, true),
        status('s-done', 'Done', 2, false),
      ],
    },
    '/api/projects/p1/pipelines': { items: [pipeline] },
    '/api/projects/p1/labels': { items: [] },
    '/api/projects/p1/agent-connection': connection,
    // Not a full task: these tests only check what the form sends.
    'POST /api/projects/p1/tasks/from-issue': record('from-issue', task),
    'POST /api/projects/p1/tasks': record('tasks', task),
    'POST /api/items/issue/i1/task-draft': record('task-draft', {
      ...(draft ?? {}),
      status: 'pending',
      draft: null,
    }),
    ...(draft ? { [`/api/task-drafts/${draft.jobId}`]: draft } : {}),
  });
}

function renderForm() {
  const client = createQueryClient();
  client.setQueryData(queryKeys.session(), testSession);
  const me = testMe();
  const team = me.teams[0];
  const project = team?.projects[0];
  if (!team || !project) throw new Error('fixture');
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <Dialog open>
            <DialogContent>
              <NewTaskForm
                choices={[{ team, project }]}
                initialProjectId="p1"
                initialStatusId={undefined}
                prefill={prefill}
                onDone={() => undefined}
              />
            </DialogContent>
          </Dialog>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('task prefill', () => {
  it('builds the title and description the server would, and a title from a message', () => {
    expect(prefill).toMatchObject({
      title: 'Crash on start',
      description:
        'From issue [WEB#7](/t/acme/p/WEB/issues/7): Crash on start\n\nOpen the app and it crashes.',
      issue: { id: 'i1', kind: 'fixes' },
      source: { itemType: 'issue', itemId: 'i1', replyIds: [] },
    });
    expect(titleFromText('\n## **Fix** [login](http://x) flow\nmore', 'x')).toBe('Fix login flow');
    expect(titleFromText('', 'Follow up on WEB-1')).toBe('Follow up on WEB-1');
    const long = titleFromText('word '.repeat(40), 'x');
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('New task from an issue', () => {
  it('is prefilled, linked as fixes, and created in the chosen stage through from-issue', async () => {
    const user = userEvent.setup();
    const posts: Array<{ path: string; body: unknown }> = [];
    serve(posts);
    renderForm();
    expect(await screen.findByPlaceholderText('Task title')).toHaveValue('Crash on start');
    expect(screen.getByTestId('task-source')).toHaveTextContent('From WEB#7');
    expect(screen.getByTestId('linked-issue')).toHaveTextContent('Fixes WEB#7');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      path: 'from-issue',
      body: {
        issueId: 'i1',
        title: 'Crash on start',
        statusId: 's-open',
        description: expect.stringContaining('From issue [WEB#7]') as unknown,
      },
    });
  });

  it('creates a plain task once the issue is unlinked', async () => {
    const user = userEvent.setup();
    const posts: Array<{ path: string; body: unknown }> = [];
    serve(posts);
    renderForm();
    await user.click(await screen.findByRole('button', { name: 'Don’t link WEB#7' }));
    expect(screen.queryByTestId('linked-issue')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.path).toBe('tasks');
    expect(posts[0]?.body).not.toHaveProperty('issueId');
  });

  it('asks your agent for a draft and fills the form with it when you use it', async () => {
    const user = userEvent.setup();
    const posts: Array<{ path: string; body: unknown }> = [];
    serve(posts, {
      jobId: 'job1',
      status: 'done',
      itemType: 'issue',
      itemId: 'i1',
      replyIds: [],
      draft: { title: 'Stop the crash on start', description: '- [ ] No crash' },
      createdAt: '2026-09-29T10:00:00.000Z',
    });
    renderForm();
    await user.click(await screen.findByRole('button', { name: 'Have my agent draft it' }));
    await waitFor(() => expect(posts.map((post) => post.path)).toEqual(['task-draft']));
    expect(posts[0]?.body).toEqual({});
    const draft = await screen.findByTestId('task-draft');
    expect(draft).toHaveTextContent('Stop the crash on start');
    // Nothing is created until you submit.
    expect(posts).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Use this draft' }));
    expect(screen.getByPlaceholderText('Task title')).toHaveValue('Stop the crash on start');
    expect(screen.queryByTestId('task-draft')).toBeNull();
  });
});
