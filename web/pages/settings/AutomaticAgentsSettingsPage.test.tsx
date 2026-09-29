import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentStats, AgentUsageTotals, OwnerJob } from '@shared/schemas/agentRunner';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { mockApi, testMe } from '@web/test/mockApi';
import AutomaticAgentsSettingsPage from './AutomaticAgentsSettingsPage';
import { renderSettingsPage } from './testing';

/** Settings → Automatic agents: jobs waiting on you (BAT#22, BAT#29), stats (BAT#25), chains (BAT#23). */

const LAZY = { timeout: 5000 };

function totals(overrides: Partial<AgentUsageTotals> = {}): AgentUsageTotals {
  return {
    jobs: 1,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    costUsd: 0,
    costEstimatedUsd: 0,
    unpricedRuns: 0,
    durationMs: 60_000,
    ...overrides,
  };
}

function job(overrides: Partial<OwnerJob>): OwnerJob {
  return {
    jobId: 'job-1',
    kind: 'mention',
    status: 'pending',
    createdAt: new Date().toISOString(),
    triggeredBy: 'ada',
    needsOk: true,
    project: { id: 'p1', ref: 'acme/WEB', name: 'Web' },
    target: { ref: 'acme/WEB-1', title: 'Login', url: 'http://localhost/t/acme/p/WEB/tasks/1' },
    trigger: null,
    group: 'stopped',
    run: null,
    clearedAt: null,
    clearedReason: null,
    ...overrides,
  };
}

const gpt = totals({
  tokensIn: 20_000_000,
  tokensCacheRead: 15_000_000,
  tokensOut: 400_000,
  tokensReasoning: 100_000,
  costEstimatedUsd: 12.4,
});
const sol = totals({ tokensIn: 5_000_000, unpricedRuns: 2 });
const stats: AgentStats = {
  days: 30,
  totals: totals({ jobs: 3, tokensIn: 25_000_000, costEstimatedUsd: 12.4, unpricedRuns: 2 }),
  byDay: [],
  byHarness: [],
  byModel: [
    { harness: 'codex', model: 'gpt-5', ...gpt },
    { harness: 'codex', model: 'gpt-6-sol', ...sol },
  ],
  byDifficulty: [],
  byOutcome: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  return renderSettingsPage(
    <TooltipProvider>
      <AutomaticAgentsSettingsPage />
    </TooltipProvider>,
  );
}

describe('Automatic agents settings', () => {
  it('breaks the stats down by token kind, with estimated costs and — for unknown prices', async () => {
    mockApi({ '/api/me': testMe(), '/api/me/agent/stats': stats });
    renderPage();
    const table = await screen.findByRole('table', { name: 'By model' }, LAZY);
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      'Name',
      'Jobs',
      'Input',
      'Cache read',
      'Cache write',
      'Output',
      'Reasoning',
      'Cost (est.)',
      'Time',
    ]);
    const [, gptRow, solRow] = within(table).getAllByRole('row');
    expect(gptRow).toHaveTextContent('Codex gpt-5');
    expect(gptRow).toHaveTextContent('5M'); // uncached input
    expect(gptRow).toHaveTextContent('15M'); // cache read
    expect(gptRow).toHaveTextContent('≈ $12.40 est.');
    expect(solRow).toHaveTextContent('—');
    expect(solRow).not.toHaveTextContent('$0.00');
  });

  it('groups jobs waiting on you, with cleared ones muted and only Open (BAT#22, BAT#29)', async () => {
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent/waiting': {
        jobs: [
          job({ jobId: 'j1', group: 'needs_ok', triggeredBy: 'caden' }),
          job({
            jobId: 'j2',
            target: { ref: 'acme/WEB-2', title: 'Signup', url: null },
            run: {
              outcome: 'killed',
              error: null,
              harness: 'claude',
              model: 'opus',
              endedAt: new Date().toISOString(),
              hasOutput: false,
            },
          }),
          job({
            jobId: 'j3',
            status: 'cancelled',
            group: 'cleared',
            target: { ref: 'acme/WEB-3', title: 'Done already', url: 'http://localhost/x' },
            clearedAt: new Date().toISOString(),
            clearedReason: 'finished',
          }),
        ],
      },
    });
    renderPage();
    const needsOk = await screen.findByRole('region', { name: 'Needs your OK' }, LAZY);
    expect(within(needsOk).getByRole('button', { name: 'Approve acme/WEB-1' })).toBeInTheDocument();
    expect(within(needsOk).getByRole('button', { name: 'Decline acme/WEB-1' })).toBeInTheDocument();
    const stopped = screen.getByRole('region', { name: 'Stopped runs' });
    expect(within(stopped).getByText(/Killed by you/)).toBeInTheDocument();
    expect(within(stopped).getByRole('button', { name: 'Retry acme/WEB-2' })).toBeInTheDocument();
    const cleared = screen.getByRole('region', { name: 'Cleared — task finished' });
    expect(within(cleared).getByText(/Cleared: the task was finished/)).toBeInTheDocument();
    expect(within(cleared).getAllByRole('link', { name: /Open acme\/WEB-3/ })).toHaveLength(1);
    expect(within(cleared).queryByRole('button')).toBeNull();
  });

  it('shows the last failed run next to its chain entry (BAT#23)', async () => {
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent/models': {
        default: { chain: [{ harness: 'codex', model: 'Luna', effort: '' }], levels: {} },
        projects: {},
      },
      '/api/me/agent/model-failures': {
        failures: [
          {
            harness: 'codex',
            model: 'luna',
            error: "The 'luna' model is not supported when using Codex with a ChatGPT account",
            at: new Date().toISOString(),
          },
        ],
      },
    });
    renderPage();
    expect(
      await screen.findByText(/Last run failed: The 'luna' model is not supported/, {}, LAZY),
    ).toBeInTheDocument();
  });
});
