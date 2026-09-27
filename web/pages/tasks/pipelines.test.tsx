import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskStage } from '@shared/schemas/pipelines';
import type { Task } from '@shared/schemas/tasks';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { jsonResponse, mockApi } from '@web/test/mockApi';
import { StagePanel } from './StagePanel';
import { PipelineBadges } from './TaskCard';

/** The task page's Stage panel and the board card's pipeline badges (design §5). */

const NOW = '2026-09-27T10:00:00.000Z';
const ann = { id: 'u2', username: 'ann', name: 'Ann', image: null };

const stage: TaskStage = {
  status: { id: 's-review', name: 'In Review' },
  instructions: 'Check the **PR**.',
  criteria: [
    { id: 'tests', text: 'Tests pass', evidence: null },
    {
      id: 'pr',
      text: 'PR link',
      evidence: { text: 'https://git/1', user: ann, via: null, updatedAt: NOW },
    },
  ],
  approvals: {
    required: 2,
    approved: 1,
    rule: 'Reviewer (people)',
    dismissOnChange: true,
    given: [
      {
        id: 'a1',
        user: ann,
        via: null,
        decision: 'approve',
        comment: 'Looks good',
        createdAt: NOW,
      },
    ],
    canApprove: true,
  },
  moveRule: null,
  next: { id: 's-done', name: 'Done' },
  sendBackTo: { id: 's-doing', name: 'In Progress' },
  autoAdvance: false,
  pool: null,
  canEditEvidence: true,
  canMove: false,
  canForce: false,
  missing: ['evidence for “Tests pass” (criterion tests)', '1 more approval from Reviewer'],
  blockedMoves: {},
  previousEvidence: [],
};

const task: Task & { stage: TaskStage } = {
  id: 't1',
  ref: 'API-7',
  number: 7,
  title: 'Ship it',
  projectId: 'p1',
  teamId: 'team1',
  status: { id: 's-review', name: 'In Review', color: '#8b5cf6', category: 'open' },
  priority: 0,
  dueDate: null,
  labels: [],
  assignees: { users: [], roles: [] },
  claim: null,
  blocked: false,
  replyCount: 0,
  updatedAt: NOW,
  position: 'a0',
  blockers: [],
  createdAt: NOW,
  completedAt: null,
  path: '/t/acme/p/API/tasks/7',
  description: '',
  teamSlug: 'acme',
  projectKey: 'API',
  author: null,
  via: null,
  editedAt: null,
  lastActivityAt: NOW,
  blockedBy: [],
  blocking: [],
  issues: [],
  attachments: [],
  reactions: [],
  subscribed: false,
  stage,
};

function renderWith(ui: ReactNode) {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StagePanel', () => {
  it('shows the instructions, criteria, approvals and what is missing', () => {
    mockApi({});
    renderWith(<StagePanel task={task} teamId="team1" />);
    const panel = screen.getByTestId('stage-panel');
    expect(within(panel).getByRole('heading', { name: 'Stage: In Review' })).toBeInTheDocument();
    expect(within(panel).getByText('Next: Done')).toBeInTheDocument();
    expect(within(panel).getByText('PR')).toBeInTheDocument();
    expect(within(panel).getByText('Exit criteria (1/2)')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Missing')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Done')).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: 'Evidence for PR link' })).toHaveValue(
      'https://git/1',
    );
    expect(within(panel).getByText(/Approvals 1\/2/)).toBeInTheDocument();
    expect(within(panel).getByText('Looks good')).toBeInTheDocument();
    expect(within(panel).getByText('To move on to Done, it still needs:')).toBeInTheDocument();
    expect(within(panel).getByText('1 more approval from Reviewer')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument();
  });

  it('saves only the evidence that changed', async () => {
    const fetchMock = mockApi({
      'PUT /api/tasks/t1/evidence': () => jsonResponse(task),
    });
    const user = userEvent.setup();
    renderWith(<StagePanel task={task} teamId="team1" />);
    const save = screen.getByRole('button', { name: 'Save evidence' });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Evidence for Tests pass' }), 'CI green');
    await user.click(save);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/tasks/t1/evidence'),
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1]?.body as string)).toEqual({ evidence: { tests: 'CI green' } });
  });

  it('approves or requests changes with a comment', async () => {
    const fetchMock = mockApi({
      'POST /api/tasks/t1/approvals': () => jsonResponse(task, 201),
    });
    const user = userEvent.setup();
    renderWith(<StagePanel task={task} teamId="team1" />);
    await user.type(screen.getByRole('textbox', { name: 'Approval comment (optional)' }), 'Tests?');
    await user.click(screen.getByRole('button', { name: /Request changes/ }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({
        decision: 'request_changes',
        comment: 'Tests?',
      });
    });
    expect(
      screen.getByRole('button', { name: 'Request changes (sends it back to In Progress)' }),
    ).toBeInTheDocument();
  });

  it('is read-only for people who may not give evidence or approve', () => {
    mockApi({});
    renderWith(
      <StagePanel
        task={{
          ...task,
          stage: {
            ...stage,
            canEditEvidence: false,
            approvals: stage.approvals ? { ...stage.approvals, canApprove: false } : null,
          },
        }}
        teamId="team1"
      />,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText('https://git/1')).toBeInTheDocument();
    expect(screen.getByText('No evidence yet.')).toBeInTheDocument();
  });

  it('offers Claim for a pool task and Move on when nothing is missing', async () => {
    const fetchMock = mockApi({ 'POST /api/tasks/t1/claim': () => jsonResponse(task) });
    const onMoveOn = vi.fn();
    const user = userEvent.setup();
    renderWith(
      <StagePanel
        task={{
          ...task,
          stage: {
            ...stage,
            criteria: [],
            approvals: null,
            missing: [],
            canMove: true,
            pool: { rule: 'Reviewer', canClaim: true },
          },
        }}
        teamId="team1"
        onMoveOn={onMoveOn}
      />,
    );
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/tasks/t1/claim'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Move to Done' }));
    expect(onMoveOn).toHaveBeenCalled();
  });
});

describe('PipelineBadges', () => {
  it('say what blocks a card in words', () => {
    render(
      <PipelineBadges
        pipeline={{
          approvals: { approved: 1, required: 2 },
          criteria: { done: 2, total: 3 },
          claimable: true,
        }}
      />,
    );
    expect(screen.getByText('Approvals 1/2')).toBeInTheDocument();
    expect(screen.getByText('Criteria 2/3')).toBeInTheDocument();
    expect(screen.getByText('Claimable')).toBeInTheDocument();
  });

  it('hide what is already met', () => {
    const { container } = render(
      <PipelineBadges
        pipeline={{
          approvals: { approved: 2, required: 2 },
          criteria: { done: 3, total: 3 },
          claimable: false,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
