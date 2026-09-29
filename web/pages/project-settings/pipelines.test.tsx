import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalRule } from '@shared/principals';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { CreateStatusInput, Status, UpdateStatusInput } from '@shared/schemas/projects';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import { StatusIconPicker, type StatusIconValue } from '@web/components/pickers/StatusIconPicker';
import { describeRule, type PrincipalOptions } from '@web/components/pickers/principals';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { mockApi, testConfig, testMe } from '@web/test/mockApi';
import { StatusDialog, type StatusDialogProps } from './StatusDialog';
import { countRules } from './stageRules';

/** The "who" picker and the per-status rules editor (design §2, §5). */

afterEach(() => vi.unstubAllGlobals());

const options: PrincipalOptions = {
  users: [
    { id: 'u1', username: 'ann', name: 'Ann', image: null },
    { id: 'u2', username: 'ann-ai', name: 'Ann AI', image: null },
  ],
  roles: [
    { id: 'r-everyone', name: '@everyone', color: null, isEveryone: true },
    { id: 'r1', name: 'Reviewer', color: '#22c55e' },
  ],
  projectRoles: [{ id: 'pr1', name: 'QA', color: null }],
};

function Harness({
  initial,
  onChange,
}: {
  initial: PrincipalRule;
  onChange: (r: PrincipalRule) => void;
}) {
  const [rule, setRule] = useState(initial);
  return (
    <PrincipalRulePicker
      label="Who can approve"
      value={rule}
      options={options}
      onChange={(next) => {
        setRule(next);
        onChange(next);
      }}
    />
  );
}

describe('PrincipalRulePicker', () => {
  it('adds people, agents and roles by @name, and exclusions behind a link', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ allow: [], deny: [] }} onChange={onChange} />);
    const include = screen.getByRole('combobox', { name: 'Add to Who can approve: include' });

    // A name shared by a person and her agent: both are offered, told apart by their tags.
    await user.type(include, '@ann');
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByRole('option', { name: /@ann Ann Person/ })).toBeInTheDocument();
    expect(
      within(listbox).getByRole('option', { name: /@ann-ai Ann AI Agent/ }),
    ).toBeInTheDocument();
    await user.click(within(listbox).getByRole('option', { name: /@ann-ai/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [{ type: 'user', userId: 'u2' }],
      deny: [],
    });

    // @reviewer is the role's people, @reviewer-ai their agents.
    await user.type(include, 'reviewer-');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [
        { type: 'user', userId: 'u2' },
        { type: 'role', roleId: 'r1', scope: 'agents' },
      ],
      deny: [],
    });
    expect(
      within(screen.getByRole('list', { name: 'Who can approve: include' })).getByText(
        '@reviewer-ai',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Exclude someone' }));
    await user.type(
      screen.getByRole('combobox', { name: 'Add to Who can approve: exclude' }),
      '@ann',
    );
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [
        { type: 'user', userId: 'u2' },
        { type: 'role', roleId: 'r1', scope: 'agents' },
      ],
      deny: [{ type: 'user', userId: 'u1' }],
    });

    await user.click(screen.getByRole('button', { name: 'Remove @ann-ai' }));
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [{ type: 'role', roleId: 'r1', scope: 'agents' }],
      deny: [{ type: 'user', userId: 'u1' }],
    });
  });

  it('reads rules in words like the server', () => {
    expect(
      describeRule(
        {
          allow: [
            { type: 'role', roleId: 'r1', scope: 'people' },
            { type: 'project_role', roleId: 'pr1', scope: 'agents' },
            { type: 'user', userId: 'u1' },
          ],
          deny: [{ type: 'everyone', scope: 'agents' }],
        },
        options,
      ),
    ).toBe('Reviewer (people), QA (project role, agents) or @ann, except every agent');
    expect(describeRule(null, options)).toBe('nobody');
  });
});

const statuses: Status[] = ['Open', 'In Review', 'Done'].map((name, position) => ({
  id: `s${position}`,
  projectId: 'p1',
  name,
  color: '#6b7280',
  icon: name === 'Done' ? 'check-circle' : 'circle',
  position,
  isDefault: position === 0,
  taskCount: 0,
  rules: DEFAULT_STAGE_RULES,
}));

function renderDialog(
  props: Partial<StatusDialogProps> & { onUpdate?: StatusDialogProps['onUpdate'] },
) {
  const review = statuses[1];
  if (!review) throw new Error('status');
  mockApi({ '/api/config': testConfig, '/api/me': testMe() });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipProvider>
        <StatusDialog
          state={{ mode: 'edit', status: review }}
          statuses={statuses}
          options={options}
          teamId="t1"
          canManage
          onClose={() => undefined}
          onCreate={() => Promise.reject(new Error('unused'))}
          onUpdate={() => Promise.resolve()}
          {...props}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('StatusIconPicker', () => {
  function IconHarness({ onChange }: { onChange: (change: Partial<StatusIconValue>) => void }) {
    const [value, setValue] = useState<StatusIconValue>({ icon: 'circle', color: '#6b7280' });
    return (
      <StatusIconPicker
        value={value}
        label="Review icon"
        onChange={(change) => {
          setValue((current) => ({ ...current, ...change }));
          onChange(change);
        }}
      />
    );
  }

  it('mixes any shape with any color, and draws the status with both', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<IconHarness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Review icon: Circle, #6b7280' }));
    const shapes = screen.getByRole('radiogroup', { name: 'Shape' });
    expect(within(shapes).getAllByRole('radio')).toHaveLength(12);
    expect(within(shapes).getByRole('radio', { name: 'Circle' })).toBeChecked();
    await user.click(within(shapes).getByRole('radio', { name: 'Star' }));
    expect(onChange).toHaveBeenLastCalledWith({ icon: 'star' });
    // The popover stays open, so the color can be picked too.
    await user.click(screen.getByRole('radio', { name: 'Green' }));
    expect(onChange).toHaveBeenLastCalledWith({ color: '#22c55e' });
    expect(within(shapes).getByRole('radio', { name: 'Star' })).toBeChecked();
    const star = within(shapes).getByRole('radio', { name: 'Star' }).querySelector('svg');
    expect(star).toHaveAttribute('data-icon', 'star');
    expect(star).toHaveStyle({ color: '#22c55e' });
  });

  it('renders every status with its own shape and color', () => {
    render(<StatusIcon status={{ name: 'Blocked', icon: 'x-circle', color: '#ef4444' }} />);
    const icon = document.querySelector('svg');
    expect(icon).toHaveAttribute('data-icon', 'x-circle');
    expect(icon).toHaveStyle({ color: '#ef4444' });
  });
});

describe('StatusDialog', () => {
  it('creates a status step by step and saves everything at once', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn((input: CreateStatusInput) =>
      Promise.resolve({ ...statuses[0], id: 'new', name: input.name } as Status),
    );
    renderDialog({ state: { mode: 'create' }, onCreate });
    expect(screen.getByRole('heading', { name: 'New stage' })).toBeInTheDocument();
    // Later steps are locked until reached.
    expect(screen.getByRole('button', { name: /Exit criteria/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Name');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'QA');
    await user.click(screen.getByRole('button', { name: 'Next' })); // → Instructions
    await user.click(screen.getByRole('button', { name: 'Next' })); // → When a task arrives
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'custom');
    await user.type(screen.getByRole('combobox', { name: 'Add to Who: include' }), '@reviewer');
    await user.keyboard('{Enter}');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Who gets it' }), 'pool');
    await user.click(screen.getByRole('checkbox', { name: 'The author' }));
    await user.click(screen.getByRole('button', { name: 'Next' })); // → While it’s here
    await user.click(screen.getByRole('checkbox', { name: 'Counts as finished' }));
    await user.click(screen.getByRole('button', { name: 'Next' })); // → Exit criteria
    await user.click(screen.getByRole('button', { name: 'Add criterion' }));
    await user.type(screen.getByRole('textbox', { name: 'Criterion 1' }), 'Tests pass');
    await user.click(screen.getByRole('button', { name: 'Next' })); // → Moving on
    const count = screen.getByRole('spinbutton', { name: 'Approvals needed' });
    await user.clear(count);
    await user.type(count, '2');
    await user.type(
      screen.getByRole('combobox', { name: 'Add to Who can approve: include' }),
      '@ann',
    );
    await user.keyboard('{Enter}');
    expect(screen.getByText(/2 different people must approve/)).toBeInTheDocument();
    // New statuses start plain (anyone may move tasks on); limit it to assignees and the claimer.
    expect(screen.getByRole('checkbox', { name: 'Assignees' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Assignees' }));
    await user.click(screen.getByRole('checkbox', { name: 'Whoever claimed it' }));
    await user.click(screen.getByRole('button', { name: 'Create stage' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    const input = onCreate.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      name: 'QA',
      rules: {
        handoff: {
          mode: 'pool',
          rule: { allow: [{ type: 'role', roleId: 'r1', scope: 'people' }], deny: [] },
        },
        onEnter: { notifyAuthor: true, notifyAssignees: true, releaseClaim: false },
        blocksDependents: false,
        exitCriteria: [{ id: 'c1', text: 'Tests pass' }],
        approvals: { count: 2, rule: { allow: [{ type: 'user', userId: 'u1' }], deny: [] } },
        autoAdvance: false,
        moveBy: { assignees: true, claimer: true },
        moveRule: null,
        nextStatusId: null,
      },
    });
  });

  it('saves one category of an existing status on its own', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn((_id: string, _input: UpdateStatusInput) => Promise.resolve());
    renderDialog({ onUpdate });
    expect(screen.getByRole('heading', { name: 'Edit In Review' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /While it’s here/ }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Can be claimed' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith('s1', {
        rules: { blocksDependents: true, claimable: false },
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('offers "Next stage" without naming it, since columns can be rearranged', () => {
    renderDialog({ state: { mode: 'edit', status: statuses[1] as Status, section: 'moving' } });
    const forward = screen.getByRole('combobox', { name: 'Forward' });
    expect(
      within(forward)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Next stage', 'Open', 'Done']);
  });

  it('keeps the claim only for the last stage’s assignees, and checks custom lists', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn((_id: string, _input: UpdateStatusInput) => Promise.resolve());
    renderDialog({
      onUpdate,
      state: { mode: 'edit', status: statuses[1] as Status, section: 'arrival' },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Keep their claim' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0]?.[1].rules?.onEnter).toMatchObject({ releaseClaim: true });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Assign to' }), 'custom');
    expect(screen.queryByRole('checkbox', { name: 'Keep their claim' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose who gets the task');
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('makes an existing status final in one click', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn((_id: string, _input: UpdateStatusInput) => Promise.resolve());
    renderDialog({ onUpdate });
    await user.click(screen.getByRole('button', { name: 'Make this a final status' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0]?.[1].rules).toMatchObject({
      handoff: { mode: 'nobody' },
      onEnter: { resolveIssues: true, notifyAuthor: true, notifyPreviousHolder: true },
      blocksDependents: false,
      claimable: false,
    });
    expect(await screen.findByText('This is a final status')).toBeInTheDocument();
  });

  it('is read-only without Manage statuses', async () => {
    const user = userEvent.setup();
    renderDialog({ canManage: false });
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Exit criteria/ }));
    expect(screen.getByRole('button', { name: 'Add criterion' })).toBeDisabled();
  });

  it('counts the rules a status has', () => {
    expect(countRules(DEFAULT_STAGE_RULES)).toBe(0);
    expect(
      countRules({
        ...DEFAULT_STAGE_RULES,
        handoff: { mode: 'nobody' },
        onEnter: { ...DEFAULT_STAGE_RULES.onEnter, notifyAssignees: false },
      }),
    ).toBe(2);
  });
});
