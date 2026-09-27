import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { PrincipalRule } from '@shared/principals';
import {
  DEFAULT_STAGE_RULES,
  HANDOFF_MODES,
  PIPELINE_LIMITS,
  RULE_HANDOFF_MODES,
  stageRulesSchema,
  type HandoffMode,
  type StageRules,
} from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import { Spinner } from '@web/components/common/Spinner';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import { EMPTY_RULE, type PrincipalOptions } from '@web/components/pickers/principals';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';
import { HANDOFF_LABELS } from './stageRules';

/**
 * The rules of one stage (design §5), edited in a dialog from Project settings → Statuses: what to
 * do here, who gets the task, who hears about it and what else happens when it enters (resolve
 * fixed issues, release the claim, tell the author), how tasks behave while here (block their
 * dependents, can be claimed), and what it needs to move on (exit criteria, who may move it,
 * approvals), plus auto-advance, the next stage and send-back.
 */

export interface StageRulesDialogProps {
  status: Status | null;
  statuses: readonly Status[];
  options: PrincipalOptions;
  canManage: boolean;
  onClose: () => void;
  onSave: (rules: StageRules) => Promise<unknown>;
}

export function StageRulesDialog({
  status,
  statuses,
  options,
  canManage,
  onClose,
  onSave,
}: StageRulesDialogProps) {
  return (
    <Dialog open={status !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {status ? (
          <RulesForm
            key={status.id}
            status={status}
            statuses={statuses}
            options={options}
            canManage={canManage}
            onClose={onClose}
            onSave={onSave}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function nextCriterionId(existing: ReadonlyArray<{ id: string }>): string {
  for (let n = existing.length + 1; ; n += 1) {
    const id = `c${n}`;
    if (!existing.some((criterion) => criterion.id === id)) return id;
  }
}

function RulesForm({
  status,
  statuses,
  options,
  canManage,
  onClose,
  onSave,
}: Omit<StageRulesDialogProps, 'status'> & { status: Status }) {
  const [rules, setRules] = useState<StageRules>(status.rules ?? DEFAULT_STAGE_RULES);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof StageRules>(key: K, value: StageRules[K]) =>
    setRules((current) => ({ ...current, [key]: value }));
  const others = statuses.filter((candidate) => candidate.id !== status.id);
  const ids = {
    instructions: useId(),
    handoff: useId(),
    holder: useId(),
    count: useId(),
    next: useId(),
  };

  const save = () => {
    const cleaned: StageRules = {
      ...rules,
      handoff: RULE_HANDOFF_MODES.has(rules.handoff.mode)
        ? { mode: rules.handoff.mode, rule: rules.handoff.rule ?? EMPTY_RULE }
        : rules.handoff.mode === 'stage_holder'
          ? {
              mode: 'stage_holder',
              ...(rules.handoff.statusId ? { statusId: rules.handoff.statusId } : {}),
            }
          : { mode: rules.handoff.mode },
      exitCriteria: rules.exitCriteria.map((criterion) => ({
        ...criterion,
        text: criterion.text.trim(),
      })),
    };
    const parsed = stageRulesSchema.safeParse(cleaned);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? `${issue.path.join(' › ') || 'Rules'}: ${issue.message}` : 'Invalid rules');
      return;
    }
    setError(null);
    setPending(true);
    onSave(parsed.data).then(
      () => {
        setPending(false);
        toast.success(`Saved the rules of ${status.name}`);
        onClose();
      },
      (cause: unknown) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    );
  };

  const ruleMode = RULE_HANDOFF_MODES.has(rules.handoff.mode);

  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>Rules of {status.name}</DialogTitle>
        <DialogDescription>
          Everything is optional. Rule changes apply to tasks the next time they move.
        </DialogDescription>
      </DialogHeader>
      <fieldset disabled={!canManage || pending} className="grid gap-5">
        <Group title="What to do here">
          <Label htmlFor={ids.instructions} className="sr-only">
            Instructions
          </Label>
          <Textarea
            id={ids.instructions}
            value={rules.instructions}
            onChange={(event) => set('instructions', event.target.value)}
            maxLength={PIPELINE_LIMITS.instructions}
            placeholder="Instructions (markdown), shown on the task and to agents"
            rows={3}
          />
        </Group>

        <Group title="When a task enters">
          <div className="grid gap-1.5">
            <Label htmlFor={ids.handoff}>Hand-off</Label>
            <NativeSelect
              id={ids.handoff}
              value={rules.handoff.mode}
              onChange={(value) => {
                const mode = value as HandoffMode;
                set('handoff', {
                  mode,
                  ...(RULE_HANDOFF_MODES.has(mode)
                    ? { rule: rules.handoff.rule ?? EMPTY_RULE }
                    : {}),
                  ...(mode === 'stage_holder'
                    ? { statusId: rules.handoff.statusId ?? others[0]?.id }
                    : {}),
                });
              }}
            >
              {HANDOFF_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {HANDOFF_LABELS[mode]}
                </option>
              ))}
            </NativeSelect>
          </div>
          {ruleMode ? (
            <PrincipalRulePicker
              label="Who gets the task"
              value={rules.handoff.rule ?? EMPTY_RULE}
              onChange={(rule) => set('handoff', { ...rules.handoff, rule })}
              options={options}
              disabled={!canManage}
            />
          ) : null}
          {rules.handoff.mode === 'stage_holder' ? (
            <div className="grid gap-1.5">
              <Label htmlFor={ids.holder}>Stage</Label>
              <NativeSelect
                id={ids.holder}
                value={rules.handoff.statusId ?? ''}
                onChange={(statusId) => set('handoff', { mode: 'stage_holder', statusId })}
              >
                {others.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <OptionalRule
            label="Notify people"
            description="They get an inbox notification; they aren’t assigned."
            value={rules.notify}
            onChange={(rule) => set('notify', rule)}
            options={options}
            disabled={!canManage}
          />
          <CheckRow
            label="Resolve the issues it fixes"
            checked={rules.onEnter.resolveIssues}
            onChange={(resolveIssues) => set('onEnter', { ...rules.onEnter, resolveIssues })}
          />
          <CheckRow
            label="Release its claim"
            checked={rules.onEnter.releaseClaim}
            onChange={(releaseClaim) => set('onEnter', { ...rules.onEnter, releaseClaim })}
          />
          <CheckRow
            label="Tell the author (and whoever had it) that it got here"
            checked={rules.onEnter.notifyAuthor}
            onChange={(notifyAuthor) => set('onEnter', { ...rules.onEnter, notifyAuthor })}
          />
        </Group>

        <Group title="While a task is here">
          <CheckRow
            label="It still blocks the tasks waiting on it"
            description="Off: tasks here count as completed and no longer block anything."
            checked={rules.blocksDependents}
            onChange={(checked) => set('blocksDependents', checked)}
          />
          <CheckRow
            label="It can be claimed"
            description="Off: Claim and claim_next_task skip tasks here."
            checked={rules.claimable}
            onChange={(checked) => set('claimable', checked)}
          />
        </Group>

        <Group title="To move on">
          <div className="grid gap-2">
            <p className="text-sm font-medium">Exit criteria</p>
            <p className="text-xs text-muted-foreground">
              Each needs evidence (a summary or a link) before the task moves on; agents pass it by
              the id shown.
            </p>
            <ul className="grid gap-2" aria-label="Exit criteria">
              {rules.exitCriteria.map((criterion, index) => (
                <li key={criterion.id} className="flex items-center gap-2">
                  <code className="w-10 shrink-0 text-xs text-muted-foreground">
                    {criterion.id}
                  </code>
                  <Input
                    value={criterion.text}
                    onChange={(event) =>
                      set(
                        'exitCriteria',
                        rules.exitCriteria.map((item, at) =>
                          at === index ? { ...item, text: event.target.value } : item,
                        ),
                      )
                    }
                    maxLength={PIPELINE_LIMITS.criterionText}
                    aria-label={`Criterion ${index + 1}`}
                    placeholder="e.g. Tests pass"
                    className="h-8"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove criterion ${index + 1}`}
                    onClick={() =>
                      set(
                        'exitCriteria',
                        rules.exitCriteria.filter((_, at) => at !== index),
                      )
                    }
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              disabled={rules.exitCriteria.length >= PIPELINE_LIMITS.criteria}
              onClick={() =>
                set('exitCriteria', [
                  ...rules.exitCriteria,
                  { id: nextCriterionId(rules.exitCriteria), text: '' },
                ])
              }
            >
              <PlusIcon aria-hidden="true" />
              Add criterion
            </Button>
          </div>
          <OptionalRule
            label="Only some people can move it on"
            description="Without this, whoever may move tasks can."
            value={rules.moveRule}
            onChange={(rule) => set('moveRule', rule)}
            options={options}
            disabled={!canManage}
          />
          <div className="grid gap-2">
            <CheckRow
              label="Require approvals"
              checked={rules.approvals !== null}
              onChange={(checked) =>
                set(
                  'approvals',
                  checked ? { count: 1, rule: EMPTY_RULE, dismissOnChange: false } : null,
                )
              }
            />
            {rules.approvals ? (
              <div className="grid gap-2 pl-6">
                <div className="flex items-center gap-2">
                  <Label htmlFor={ids.count}>Approvals needed</Label>
                  <Input
                    id={ids.count}
                    type="number"
                    min={1}
                    max={PIPELINE_LIMITS.maxApprovals}
                    value={rules.approvals.count || ''}
                    onChange={(event) =>
                      rules.approvals &&
                      set('approvals', {
                        ...rules.approvals,
                        // Checked on save (1 to the maximum), so typing "12" isn't fought.
                        count: Math.trunc(Number(event.target.value) || 0),
                      })
                    }
                    className="h-8 w-20"
                  />
                </div>
                <PrincipalRulePicker
                  label="Who can approve"
                  value={rules.approvals.rule}
                  onChange={(rule) =>
                    rules.approvals && set('approvals', { ...rules.approvals, rule })
                  }
                  options={options}
                  disabled={!canManage}
                />
                <CheckRow
                  label="Dismiss approvals when the task or its evidence is edited"
                  checked={rules.approvals.dismissOnChange}
                  onChange={(dismissOnChange) =>
                    rules.approvals && set('approvals', { ...rules.approvals, dismissOnChange })
                  }
                />
              </div>
            ) : null}
          </div>
          <CheckRow
            label="Move on by itself once the criteria and approvals are met"
            checked={rules.autoAdvance}
            onChange={(checked) => set('autoAdvance', checked)}
          />
          <div className="grid gap-1.5">
            <Label htmlFor={ids.next}>Next stage</Label>
            <NativeSelect
              id={ids.next}
              value={rules.nextStatusId ?? ''}
              onChange={(value) => set('nextStatusId', value || null)}
            >
              <option value="">The next column</option>
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <CheckRow
            label="Allow sending tasks back to the previous stage"
            checked={rules.allowSendBack}
            onChange={(checked) => set('allowSendBack', checked)}
          />
        </Group>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          {canManage ? 'Cancel' : 'Close'}
        </Button>
        {canManage ? (
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? <Spinner /> : null}
            Save rules
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function CheckRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-0.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(value) => onChange(value === true)}
          aria-describedby={description ? `${id}-description` : undefined}
        />
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
      </div>
      {description ? (
        <p id={`${id}-description`} className="pl-6 text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function OptionalRule({
  label,
  description,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  description: string;
  value: PrincipalRule | null;
  onChange: (rule: PrincipalRule | null) => void;
  options: PrincipalOptions;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <CheckRow
        label={label}
        checked={value !== null}
        onChange={(checked) => onChange(checked ? EMPTY_RULE : null)}
      />
      {value ? (
        <div className="grid gap-1 pl-6">
          <p className="text-xs text-muted-foreground">{description}</p>
          <PrincipalRulePicker
            label={label}
            value={value}
            onChange={onChange}
            options={options}
            disabled={disabled}
          />
        </div>
      ) : null}
    </div>
  );
}

function NativeSelect({
  id,
  value,
  onChange,
  children,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30',
        className,
      )}
    >
      {children}
    </select>
  );
}
