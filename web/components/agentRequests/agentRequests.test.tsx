import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_ACCESS, type AgentAccessRules } from '@shared/schemas/agentAccess';
import type { PrincipalOptions } from '@web/components/pickers/principals';
import { createQueryClient } from '@web/lib/queryClient';
import { MODEL_OPTIONS, requestFixture } from '@web/test/agentRequests';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import RequestsPage from '@web/pages/agent/RequestsPage';
import { AgentAccessEditor } from './AgentAccessEditor';

/**
 * Agent access on the web: the two lists of who can start your agent (one list per person or
 * role), and request cards on the Requests page (Approve with "Run with", Decline with a reason,
 * a model none of your computers has in red).
 */

afterEach(() => vi.unstubAllGlobals());

const options: PrincipalOptions = {
  users: [
    { id: 'caden', username: 'caden', name: 'Caden', image: null },
    { id: 'dana', username: 'dana', name: 'Dana', image: null },
  ],
  roles: [{ id: 'r-everyone', name: '@everyone', color: null, isEveryone: true }],
  projectRoles: [],
};

function Editor({ onChange }: { onChange: (rules: AgentAccessRules) => void }) {
  const [rules, setRules] = useState<AgentAccessRules>({
    auto: { allow: [{ type: 'user', userId: 'caden' }], deny: [] },
    ask: DEFAULT_AGENT_ACCESS.ask,
  });
  return (
    <AgentAccessEditor
      value={rules}
      options={options}
      onChange={(next) => {
        setRules(next);
        onChange(next);
      }}
    />
  );
}

function renderWithApp(element: ReactElement) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AgentAccessEditor', () => {
  it('keeps each person in one list: asking takes them out of starting automatically', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    const auto = screen.getByRole('list', {
      name: 'Who can start your agent: start automatically: include',
    });
    expect(within(auto).getByText('@caden')).toBeInTheDocument();
    const ask = screen.getByRole('combobox', {
      name: 'Add to Who can start your agent: can ask you: include',
    });
    await user.type(ask, '@caden');
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /@caden/ }));
    const last = onChange.mock.lastCall?.[0] as AgentAccessRules;
    expect(last.auto.allow).toEqual([]);
    expect(last.ask.allow).toContainEqual({ type: 'user', userId: 'caden' });
    expect(screen.getByText(/Anyone in neither list can’t start your agent/)).toBeInTheDocument();
  });
});

describe('Requests page', () => {
  it('approves with the model you pick, and declines with a reason', async () => {
    const user = userEvent.setup();
    const calls: Array<{ path: string; body: unknown }> = [];
    const record = ({ url, init }: { url: URL; init?: RequestInit }) => {
      calls.push({
        path: url.pathname,
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
      });
      return jsonResponse(requestFixture({ status: 'approved' }));
    };
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent/model-options': MODEL_OPTIONS,
      '/api/me/agent/requests': {
        requests: [
          requestFixture(),
          requestFixture({
            jobId: 'job-2',
            kind: 'assigned',
            question: 'Can I start BAT-41? Caden assigned it to me.',
            summary: 'Start BAT-41 as Caden asked',
            message: null,
          }),
        ],
      },
      'POST /api/me/agent/requests/job-1/approve': record,
      'POST /api/me/agent/requests/job-2/decline': record,
    });
    renderWithApp(<RequestsPage />);
    const card = await screen.findByRole('article', {
      name: 'Request: Reply to Caden’s message on BAT-40',
    });
    expect(within(card).getByText('“Can I reply to Caden’s message here?”')).toBeInTheDocument();
    expect(within(card).getByText(/profile the CSV writer/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open message' })).toHaveAttribute(
      'href',
      '/t/baton/p/BAT/tasks/40#reply-r1',
    );
    // Run with: Codex · gpt-5 · high, from what the computers report.
    const harness = await within(card).findByRole('combobox', {
      name: 'Run with (BAT-40): harness',
    });
    await waitFor(() =>
      expect(within(harness).getByRole('option', { name: 'Codex' })).toBeEnabled(),
    );
    await user.selectOptions(harness, 'codex');
    await user.selectOptions(
      within(card).getByRole('combobox', { name: 'Run with (BAT-40): model' }),
      'gpt-5',
    );
    const effort = within(card).getByRole('combobox', { name: 'Run with (BAT-40): effort' });
    expect(within(effort).getByRole('option', { name: 'minimal' })).toBeInTheDocument();
    await user.selectOptions(effort, 'high');
    await user.click(
      within(card).getByRole('button', { name: 'Approve: Reply to Caden’s message on BAT-40' }),
    );

    const second = screen.getByRole('article', { name: 'Request: Start BAT-41 as Caden asked' });
    await user.click(
      within(second).getByRole('button', { name: 'Decline: Start BAT-41 as Caden asked' }),
    );
    await user.type(within(second).getByLabelText(/Why not\?/), 'Not this week');
    await user.click(
      within(second).getByRole('button', { name: 'Confirm decline: Start BAT-41 as Caden asked' }),
    );
    await waitFor(() =>
      expect(calls).toEqual([
        {
          path: '/api/me/agent/requests/job-1/approve',
          body: { model: { harness: 'codex', model: 'gpt-5', effort: 'high' } },
        },
        { path: '/api/me/agent/requests/job-2/decline', body: { reason: 'Not this week' } },
      ]),
    );
  });

  it('shows a suggested model none of your computers has in red, and won’t approve it', async () => {
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent/model-options': MODEL_OPTIONS,
      '/api/me/agent/requests': {
        requests: [
          requestFixture({
            suggestedChain: [{ harness: 'codex', model: 'gpt-6-sol', effort: '' }],
          }),
        ],
      },
    });
    renderWithApp(<RequestsPage />);
    expect(
      await screen.findByText('You don’t have gpt-6-sol set up in Codex on any of your computers'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve: Reply to Caden’s message on BAT-40' }),
    ).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Run with (BAT-40): model' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('shows who suggested which model, and which model a decided request ran with', async () => {
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent/model-options': MODEL_OPTIONS,
      '/api/me/agent/requests': {
        requests: [
          requestFixture({
            // Caden's suggestion isn't on Ethan's computers: Run with starts from his default.
            suggestedModel: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' },
            suggestedModelFrom: 'requester',
            suggestedSource: 'your default for Baton',
          }),
          requestFixture({
            jobId: 'job-2',
            status: 'approved',
            summary: 'Start BAT-41 as Caden asked',
            decidedAt: new Date().toISOString(),
            suggestedModel: { harness: 'claude', model: 'sonnet', effort: '' },
            suggestedModelFrom: 'stage',
            stage: 'Planning',
            ranWith: { harness: 'claude', model: 'claude-sonnet-5', effort: 'high' },
          }),
        ],
      },
    });
    renderWithApp(<RequestsPage />);
    const card = await screen.findByRole('article', {
      name: 'Request: Reply to Caden’s message on BAT-40',
    });
    const suggestion = within(card).getByTestId('request-suggestion');
    expect(suggestion).toHaveTextContent('Caden suggests Codex · gpt-6-sol · high');
    expect(suggestion).toHaveTextContent('so it starts from your default');
    expect(within(card).getByRole('combobox', { name: 'Run with (BAT-40): model' })).toHaveValue(
      'opus',
    );
    expect(within(card).getByText('Starts from your default for Baton.')).toBeInTheDocument();
    expect(await screen.findByText('The stage Planning suggests')).toBeInTheDocument();
    expect(
      screen.getByText(/ran with Claude Code · claude-sonnet-5 · high/, { exact: false }),
    ).toBeInTheDocument();
  });

  it('says so when nothing waits, with a way to who can start your agent', async () => {
    mockApi({ '/api/me': testMe(), '/api/me/agent/requests': { requests: [] } });
    renderWithApp(<RequestsPage />);
    expect(await screen.findByRole('heading', { name: 'No requests' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Who can start your agent' })[0]).toHaveAttribute(
      'href',
      '/settings/automatic-agents#who-can-start',
    );
  });
});
