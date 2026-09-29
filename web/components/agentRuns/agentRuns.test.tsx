import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ItemAgentRun } from '@shared/schemas/agentRunner';
import { SuggestModelChip } from '@web/components/replies/SuggestModelChip';
import { mentionsAgent } from '@web/lib/agentModels';
import { createQueryClient } from '@web/lib/queryClient';
import { MODEL_OPTIONS } from '@web/test/agentRequests';
import { mockApi } from '@web/test/mockApi';
import { ItemAgentRuns } from './ItemAgentRuns';

/** Direct model choice: suggesting a model in a reply, and the model each run used. */

afterEach(() => vi.unstubAllGlobals());

function renderWithQuery(element: ReactElement) {
  return render(<QueryClientProvider client={createQueryClient()}>{element}</QueryClientProvider>);
}

function run(overrides: Partial<ItemAgentRun>): ItemAgentRun {
  return {
    jobId: 'job-1',
    kind: 'mention',
    status: 'done',
    agent: { id: 'a1', username: 'ethan-ai', name: 'Ethan AI' },
    triggeredBy: { id: 'caden', username: 'caden', name: 'Caden' },
    stage: null,
    ranWith: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' },
    outcome: 'done',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Agent runs on a task', () => {
  it('shows which model each run ran with', async () => {
    mockApi({
      '/api/agent-runs': {
        runs: [
          run({}),
          run({ jobId: 'job-2', kind: 'pool', stage: 'Build', status: 'claimed', ranWith: null }),
        ],
      },
    });
    renderWithQuery(<ItemAgentRuns item={{ type: 'task', id: 't1' }} />);
    const list = await screen.findByTestId('agent-runs');
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Ran with Codex · gpt-6-sol · high');
    expect(second).toHaveTextContent('stage pool in Build · running');
    expect(second).toHaveTextContent('Running (model not reported yet)');
  });

  it('renders nothing before any agent ran', async () => {
    mockApi({ '/api/agent-runs': { runs: [] } });
    const { container } = renderWithQuery(<ItemAgentRuns item={{ type: 'task', id: 't1' }} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });
});

function Chip({ onChange }: { onChange: (value: ChainEntry | null) => void }) {
  const [value, setValue] = useState<ChainEntry | null>(null);
  return (
    <SuggestModelChip
      projectId="p1"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('Suggest model in a reply', () => {
  it('shows only when the text mentions an agent', () => {
    expect(mentionsAgent('@ethan-ai can you look?')).toBe(true);
    expect(mentionsAgent('@ethan can you look?')).toBe(false);
  });

  it('picks a model from what the team’s computers report, and clears it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockApi({ '/api/projects/p1/suggestable-models': MODEL_OPTIONS });
    renderWithQuery(<Chip onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Suggest model/ }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Suggested model: harness' }),
      'codex',
    );
    await user.type(screen.getByRole('combobox', { name: 'Suggested model: model' }), 'gpt-5');
    expect(onChange).toHaveBeenLastCalledWith({ harness: 'codex', model: 'gpt-5', effort: '' });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /with Codex · gpt-5/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the suggested model' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: /Suggest model/ })).toBeInTheDocument();
  });
});
