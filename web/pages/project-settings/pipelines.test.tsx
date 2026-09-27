import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PrincipalRule } from '@shared/principals';
import { DEFAULT_STAGE_RULES, type StageRules } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import { StatusIconPicker, type StatusIconValue } from '@web/components/pickers/StatusIconPicker';
import { describeRule, type PrincipalOptions } from '@web/components/pickers/principals';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { StageRulesDialog } from './StageRulesDialog';
import { countRules } from './stageRules';

/** The "who" picker and the per-status rules editor (design §2, §5). */

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
  it('adds people, agents and roles, sets scopes and exceptions', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ allow: [], deny: [] }} onChange={onChange} />);
    const allowed = screen.getByRole('list', { name: 'Who can approve: allowed' });
    expect(within(allowed).getByText('Nobody yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add to Who can approve: allowed' }));
    // People and agents are listed apart.
    expect(screen.getByRole('group', { name: 'Agents' })).toHaveTextContent('Ann AI');
    await user.click(screen.getByRole('option', { name: /Reviewer/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [{ type: 'role', roleId: 'r1', scope: 'both' }],
      deny: [],
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Scope of Reviewer' }), 'people');
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [{ type: 'role', roleId: 'r1', scope: 'people' }],
      deny: [],
    });

    await user.click(screen.getByRole('button', { name: 'Add to Who can approve: excepted' }));
    await user.click(screen.getByRole('option', { name: /Ann AI/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [{ type: 'role', roleId: 'r1', scope: 'people' }],
      deny: [{ type: 'user', userId: 'u2' }],
    });

    await user.click(screen.getByRole('button', { name: 'Remove Reviewer' }));
    expect(onChange).toHaveBeenLastCalledWith({
      allow: [],
      deny: [{ type: 'user', userId: 'u2' }],
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

function renderDialog(onSave: (rules: StageRules) => Promise<unknown>, canManage = true) {
  const review = statuses[1];
  if (!review) throw new Error('status');
  render(
    <TooltipProvider>
      <StageRulesDialog
        status={review}
        statuses={statuses}
        options={options}
        canManage={canManage}
        onClose={() => undefined}
        onSave={onSave}
      />
    </TooltipProvider>,
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

describe('StageRulesDialog', () => {
  it('edits criteria, approvals, auto-advance and the next stage', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn((_rules: StageRules) => Promise.resolve());
    renderDialog(onSave);
    expect(screen.getByRole('heading', { name: 'Rules of In Review' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add criterion' }));
    await user.type(screen.getByRole('textbox', { name: 'Criterion 1' }), 'Tests pass');
    await user.click(screen.getByRole('checkbox', { name: 'Require approvals' }));
    await user.clear(screen.getByRole('spinbutton', { name: 'Approvals needed' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Approvals needed' }), '2');
    await user.click(screen.getByRole('button', { name: 'Add to Who can approve: allowed' }));
    await user.click(screen.getByRole('option', { name: /Reviewer/ }));
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Move on by itself once the criteria and approvals are met',
      }),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Next stage' }), 's2');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      exitCriteria: [{ id: 'c1', text: 'Tests pass' }],
      approvals: {
        count: 2,
        rule: { allow: [{ type: 'role', roleId: 'r1', scope: 'both' }], deny: [] },
        dismissOnChange: false,
      },
      autoAdvance: true,
      nextStatusId: 's2',
      handoff: { mode: 'keep' },
    });
    expect(countRules(saved)).toBe(4);
  });

  it('asks who gets the task for rule-based hand-offs and explains invalid rules', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    renderDialog(onSave);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Hand-off' }), 'pool');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose who gets the task');
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add to Who gets the task: allowed' }));
    await user.click(screen.getByRole('option', { name: /Everyone in the team/ }));
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          handoff: {
            mode: 'pool',
            rule: { allow: [{ type: 'everyone', scope: 'both' }], deny: [] },
          },
        }),
      ),
    );
  });

  it('edits the stage’s own behaviour: assign nobody, on-enter effects, blocking, claiming', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn((_rules: StageRules) => Promise.resolve());
    renderDialog(onSave);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Hand-off' }), 'nobody');
    await user.click(screen.getByRole('checkbox', { name: 'Resolve the issues it fixes' }));
    await user.click(screen.getByRole('checkbox', { name: 'Release its claim' }));
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Tell the author (and whoever had it) that it got here',
      }),
    );
    const blocks = screen.getByRole('checkbox', {
      name: 'It still blocks the tasks waiting on it',
    });
    expect(blocks).toBeChecked();
    await user.click(blocks);
    await user.click(screen.getByRole('checkbox', { name: 'It can be claimed' }));
    await user.click(screen.getByRole('button', { name: 'Save rules' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      handoff: { mode: 'nobody' },
      onEnter: { resolveIssues: true, releaseClaim: true, notifyAuthor: true },
      blocksDependents: false,
      claimable: false,
    });
    expect(countRules(saved)).toBe(6);
  });

  it('is read-only without Manage statuses', () => {
    renderDialog(() => Promise.resolve(), false);
    expect(screen.queryByRole('button', { name: 'Save rules' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add criterion' })).toBeDisabled();
  });
});
