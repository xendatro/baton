import {
  BotIcon,
  ChevronRightIcon,
  ListChecksIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { LIMITS } from '@shared/constants';
import type { Principal, PrincipalRule } from '@shared/principals';
import {
  DEFAULT_STAGE_RULES,
  PIPELINE_LIMITS,
  type ExitCriterion,
  type StageRules,
  type StageRulesPatch,
} from '@shared/schemas/pipelines';
import { statusNameSchema, type Status, type UpdateStatusInput } from '@shared/schemas/projects';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { STATUS_ICON_SHAPES } from '@web/components/common/statusIcons';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import { EMPTY_RULE, type PrincipalOptions } from '@web/components/pickers/principals';
import { StatusIconPicker } from '@web/components/pickers/StatusIconPicker';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@web/components/ui/collapsible';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@web/components/ui/sheet';
import { Switch } from '@web/components/ui/switch';
import { Textarea } from '@web/components/ui/textarea';
import { acceptsNewTasks } from '@web/lib/newTaskStages';
import { cn } from '@web/lib/utils';
import { useUpdateStatus } from '../projects/queries';
import {
  agentChoices,
  EVERY_PERSON_RULE,
  isAgentStage,
  nextCriterionId,
  samePrincipalExactly,
  stageAgents,
  whoChoice,
  whoSentence,
  type WhoChoice,
} from './simpleStage';
import { approvalsSentence, stageSummary } from './stageRules';

/**
 * The stage panel of the visual pipeline editor (2026-09-29): three plain questions, each saved as
 * soon as it changes (optimistically, with a toast), and everything else under Advanced.
 *
 *   - Who works here? The hand-off: keep, nobody, these people/roles/agents (together), or
 *     whoever claims it first from a list.
 *   - What's needed to move on? The exit criteria as a checklist, and an approval.
 *   - Should an agent do this stage? A hand-off to agents only (a claim pool, so the first agent
 *     to pick it up does it), and the stage's instructions, which go into the agent's job brief.
 */

export interface StagePanelProps {
  projectId: string;
  /** The stage whose panel is open (null: closed). */
  status: Status | null;
  /** Its pipeline's stages, in order. */
  stages: readonly Status[];
  options: PrincipalOptions;
  canManage: boolean;
  /** Focus the name (a stage just added). */
  focusName?: boolean;
  onClose: () => void;
  /** Advanced → All settings: the full stage dialog. */
  onOpenFull: (status: Status) => void;
  onDelete: (status: Status) => void;
}

export function StagePanel(props: StagePanelProps) {
  const { status, onClose } = props;
  return (
    <Sheet open={status !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto sm:max-w-md"
        data-testid="stage-panel"
      >
        {status ? <PanelBody key={status.id} {...props} status={status} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({
  projectId,
  status,
  stages,
  options,
  canManage,
  focusName = false,
  onOpenFull,
  onDelete,
}: StagePanelProps & { status: Status }) {
  const rules: StageRules = status.rules ?? DEFAULT_STAGE_RULES;
  const update = useUpdateStatus(projectId);
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(status.name);
  const [savedName, setSavedName] = useState(status.name);
  if (status.name !== savedName) {
    setSavedName(status.name);
    setName(status.name);
  }
  useEffect(() => {
    if (!focusName) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [focusName]);

  const save = (input: UpdateStatusInput, done?: () => void) =>
    update.mutate(
      { id: status.id, input },
      {
        onSuccess: () => {
          toast.success(`Saved ${input.name ?? status.name}`, { id: `stage-saved-${status.id}` });
          done?.();
        },
      },
    );
  const saveRules = (patch: StageRulesPatch) => save({ rules: patch });

  const commitName = () => {
    const parsed = statusNameSchema.safeParse(name);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Invalid name');
      setName(status.name);
      return;
    }
    if (parsed.data !== status.name) save({ name: parsed.data });
  };

  return (
    <>
      <SheetHeader className="gap-3 border-b pr-12">
        <SheetTitle className="sr-only">{status.name}</SheetTitle>
        <div className="flex items-center gap-2">
          <StatusIconPicker
            value={{ icon: status.icon, color: status.color }}
            onChange={(input) => save(input)}
            label={`${status.name} icon`}
            disabled={!canManage}
          >
            <button
              type="button"
              disabled={!canManage}
              aria-label={`${status.name} icon: ${STATUS_ICON_SHAPES[status.icon].label}, ${status.color}`}
              className="flex size-9 shrink-0 items-center justify-center rounded-md border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StatusIcon status={status} className="size-4" />
            </button>
          </StatusIconPicker>
          <Label htmlFor={nameId} className="sr-only">
            Stage name
          </Label>
          <Input
            id={nameId}
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape' && name !== status.name) {
                event.stopPropagation();
                setName(status.name);
              }
            }}
            disabled={!canManage}
            maxLength={LIMITS.statusName.max}
            className="h-9 text-base font-semibold"
          />
        </div>
        <SheetDescription>
          {canManage
            ? 'Answer the three questions; changes save as you go and apply to tasks the next time they move.'
            : 'You can see how this stage works, but not change it.'}
        </SheetDescription>
      </SheetHeader>
      <fieldset disabled={!canManage} className="grid min-w-0 gap-0 divide-y border-b">
        <legend className="sr-only">{status.name} settings</legend>
        <WhoWorksHere rules={rules} options={options} onSave={saveRules} />
        <NeededToMoveOn rules={rules} options={options} onSave={saveRules} />
        <AgentStage rules={rules} options={options} onSave={saveRules} />
      </fieldset>
      <Advanced
        status={status}
        rules={rules}
        isOnly={stages.length <= 1}
        canManage={canManage}
        onSave={save}
        onOpenFull={() => onOpenFull(status)}
        onDelete={() => onDelete(status)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The three questions
// ---------------------------------------------------------------------------------------------

type OnSave = (patch: StageRulesPatch) => void;

function Question({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof UsersIcon;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-3 px-4 py-4">
      <div className="grid gap-0.5">
        <h3 id={id} className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

const WHO_LABELS: Record<Exclude<WhoChoice, 'custom'>, { label: string; help: string }> = {
  keep: { label: 'Keep whoever had it', help: 'The people from the stage before carry on.' },
  nobody: {
    label: 'Nobody (anyone can pick it up)',
    help: 'It arrives unassigned.',
  },
  specific: {
    label: 'These people, roles or agents',
    help: 'Everyone on the list is assigned together.',
  },
  pool: {
    label: 'Whoever claims it first from…',
    help: 'It arrives unassigned; the first on the list to claim it gets it.',
  },
};

function WhoWorksHere({
  rules,
  options,
  onSave,
}: {
  rules: StageRules;
  options: PrincipalOptions;
  onSave: OnSave;
}) {
  const radioId = useId();
  const saved = whoChoice(rules);
  // A list mode picked but nobody named yet: kept here until someone is added.
  const [draft, setDraft] = useState<{ mode: 'specific' | 'pool'; rule: PrincipalRule } | null>(
    null,
  );
  if (isAgentStage(rules, options) && !draft) {
    return (
      <Question
        icon={UsersIcon}
        title="Who works here?"
        hint="Who has the task while it is in this stage."
      >
        <p className="rounded-md bg-violet-500/10 px-3 py-2 text-sm text-violet-800 dark:text-violet-200">
          <BotIcon className="mr-1.5 inline size-4" aria-hidden="true" />
          An agent does this stage. Turn off “Should an agent do this stage?” below to hand it to
          people instead.
        </p>
      </Question>
    );
  }
  const choice: WhoChoice = draft?.mode ?? saved;
  const listRule = draft?.rule ?? rules.handoff.rule ?? EMPTY_RULE;

  const choose = (value: string) => {
    const next = value as WhoChoice;
    if (next === 'keep' || next === 'nobody') {
      setDraft(null);
      onSave({ handoff: { mode: next } });
    } else if (next === 'specific' || next === 'pool') {
      const rule = rules.handoff.rule ?? EMPTY_RULE;
      if (rule.allow.length > 0) {
        setDraft(null);
        onSave({ handoff: { mode: next, rule } });
      } else {
        setDraft({ mode: next, rule });
      }
    }
  };
  const changeRule = (rule: PrincipalRule) => {
    const mode = choice === 'pool' ? 'pool' : 'specific';
    if (rule.allow.length === 0) {
      setDraft({ mode, rule });
      return;
    }
    setDraft(null);
    onSave({ handoff: { mode, rule } });
  };

  return (
    <Question
      icon={UsersIcon}
      title="Who works here?"
      hint="Who has the task while it is in this stage."
    >
      <RadioGroup
        value={choice}
        onValueChange={choose}
        aria-label="Who works here"
        className="gap-2"
      >
        {(Object.keys(WHO_LABELS) as Array<keyof typeof WHO_LABELS>).map((mode) => (
          <div key={mode} className="grid gap-2">
            <div className="flex items-start gap-2">
              <RadioGroupItem value={mode} id={`${radioId}-${mode}`} className="mt-0.5" />
              <Label htmlFor={`${radioId}-${mode}`} className="grid gap-0.5 font-normal">
                <span>{WHO_LABELS[mode].label}</span>
                <span className="text-xs text-muted-foreground">{WHO_LABELS[mode].help}</span>
              </Label>
            </div>
            {choice === mode && (mode === 'specific' || mode === 'pool') ? (
              <div className="ml-6 grid gap-1.5">
                <PrincipalRulePicker
                  label={mode === 'pool' ? 'Who can claim it' : 'Who works here'}
                  value={listRule}
                  onChange={changeRule}
                  options={options}
                  allowDeny={false}
                />
                {listRule.allow.length === 0 ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Add someone: nothing is saved until the list has a name.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {choice === 'custom' ? (
          <div className="flex items-start gap-2">
            <RadioGroupItem value="custom" id={`${radioId}-custom`} className="mt-0.5" />
            <Label htmlFor={`${radioId}-custom`} className="grid gap-0.5 font-normal">
              <span>{whoSentence(rules, options)}</span>
              <span className="text-xs text-muted-foreground">
                Set in All settings (under Advanced).
              </span>
            </Label>
          </div>
        ) : null}
      </RadioGroup>
    </Question>
  );
}

function NeededToMoveOn({
  rules,
  options,
  onSave,
}: {
  rules: StageRules;
  options: PrincipalOptions;
  onSave: OnSave;
}) {
  const approvalId = useId();
  const newId = useId();
  const criteria = rules.exitCriteria;
  const [adding, setAdding] = useState('');
  const [approversDraft, setApproversDraft] = useState<PrincipalRule | null>(null);
  const approvals = rules.approvals;
  const approvers = approversDraft ?? approvals?.rule ?? EMPTY_RULE;

  const saveCriteria = (next: ExitCriterion[]) => onSave({ exitCriteria: next });
  const add = () => {
    const text = adding.trim();
    if (!text) return;
    saveCriteria([...criteria, { id: nextCriterionId(criteria), text }]);
    setAdding('');
  };
  const onAddKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };

  return (
    <Question
      icon={ListChecksIcon}
      title="What’s needed to move on?"
      hint="Checks need evidence (a note or a link) before the task can move to the next stage."
    >
      <ul className="grid gap-1.5" aria-label="Checks to move on">
        {criteria.map((criterion, index) => (
          <CriterionRow
            key={criterion.id}
            criterion={criterion}
            index={index}
            onChange={(text) =>
              saveCriteria(
                criteria.map((item) => (item.id === criterion.id ? { ...item, text } : item)),
              )
            }
            onRemove={() => saveCriteria(criteria.filter((item) => item.id !== criterion.id))}
          />
        ))}
      </ul>
      {criteria.length < PIPELINE_LIMITS.criteria ? (
        <div className="flex items-center gap-2">
          <Label htmlFor={newId} className="sr-only">
            New check
          </Label>
          <Input
            id={newId}
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            onKeyDown={onAddKey}
            maxLength={PIPELINE_LIMITS.criterionText}
            placeholder={criteria.length ? 'Add another check' : 'e.g. Tests pass'}
            className="h-8"
          />
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={!adding.trim()}>
            <PlusIcon aria-hidden="true" />
            Add check
          </Button>
        </div>
      ) : null}
      <div className="grid gap-2 rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={approvalId} className="font-normal">
            Needs approval
          </Label>
          <Switch
            id={approvalId}
            checked={approvals !== null || approversDraft !== null}
            onCheckedChange={(on) => {
              setApproversDraft(null);
              onSave({
                approvals: on
                  ? { count: 1, rule: EVERY_PERSON_RULE, dismissOnChange: false }
                  : null,
              });
            }}
          />
        </div>
        {approvals || approversDraft ? (
          <>
            <PrincipalRulePicker
              label="Who approves"
              value={approvers}
              onChange={(rule) => {
                if (rule.allow.length === 0) {
                  setApproversDraft(rule);
                  return;
                }
                setApproversDraft(null);
                onSave({
                  approvals: {
                    count: approvals?.count ?? 1,
                    dismissOnChange: approvals?.dismissOnChange ?? false,
                    rule,
                  },
                });
              }}
              options={options}
              allowDeny={false}
            />
            <p
              className={cn(
                'text-xs',
                approvers.allow.length === 0
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-muted-foreground',
              )}
            >
              {approvers.allow.length === 0
                ? 'Add who approves: nothing is saved until the list has a name.'
                : approvalsSentence(approvals?.count ?? 1, approvers, options)}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Off: once the checks have evidence, it can move on.
          </p>
        )}
      </div>
    </Question>
  );
}

function CriterionRow({
  criterion,
  index,
  onChange,
  onRemove,
}: {
  criterion: ExitCriterion;
  index: number;
  onChange: (text: string) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(criterion.text);
  const [saved, setSaved] = useState(criterion.text);
  if (criterion.text !== saved) {
    setSaved(criterion.text);
    setText(criterion.text);
  }
  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) onRemove();
    else if (trimmed !== criterion.text) onChange(trimmed);
  };
  return (
    <li className="flex items-center gap-2">
      <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        maxLength={PIPELINE_LIMITS.criterionText}
        aria-label={`Check ${index + 1}`}
        className="h-8"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove check ${index + 1}`}
        onClick={onRemove}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
    </li>
  );
}

function AgentStage({
  rules,
  options,
  onSave,
}: {
  rules: StageRules;
  options: PrincipalOptions;
  onSave: OnSave;
}) {
  const switchId = useId();
  const instructionsId = useId();
  const savedAgents = stageAgents(rules, options);
  const isAgent = savedAgents.length > 0;
  // Turned on, no agent picked yet: nothing saved until one is.
  const [pending, setPending] = useState<Principal[] | null>(null);
  const on = isAgent || pending !== null;
  const picked = pending ?? savedAgents;
  const choices = agentChoices(options);
  const [instructions, setInstructions] = useState(rules.instructions);
  const [savedInstructions, setSavedInstructions] = useState(rules.instructions);
  if (rules.instructions !== savedInstructions) {
    setSavedInstructions(rules.instructions);
    setInstructions(rules.instructions);
  }

  const toggle = (next: boolean) => {
    if (next) {
      setPending(isAgent ? null : []);
      return;
    }
    setPending(null);
    if (isAgent) onSave({ handoff: { mode: 'keep' } });
  };
  const pick = (principal: Principal, checked: boolean) => {
    const allow = checked
      ? [...picked, principal]
      : picked.filter((item) => !samePrincipalExactly(item, principal));
    if (allow.length === 0) {
      setPending([]);
      return;
    }
    setPending(null);
    // A claim pool: each agent gets a job when a task arrives, the first to claim it does it.
    const mode = isAgent && rules.handoff.mode === 'specific' ? 'specific' : 'pool';
    onSave({ handoff: { mode, rule: { allow, deny: [] } } });
  };

  return (
    <Question
      icon={BotIcon}
      title="Should an agent do this stage?"
      hint="An agent gets a job when a task arrives here, with these instructions in its brief."
    >
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={switchId} className="font-normal">
          An agent does this stage
        </Label>
        <Switch id={switchId} checked={on} onCheckedChange={toggle} />
      </div>
      {on ? (
        <fieldset className="grid gap-1.5 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Which agents</legend>
          {choices.map((choice) => (
            <AgentCheck
              key={choice.key}
              label={choice.label}
              description={choice.description}
              checked={picked.some((item) => samePrincipalExactly(item, choice.principal))}
              onChange={(checked) => pick(choice.principal, checked)}
            />
          ))}
          <p
            className={cn(
              'text-xs',
              picked.length === 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
            )}
          >
            {picked.length === 0
              ? 'Pick at least one agent.'
              : picked.length === 1 && picked[0]?.type === 'user'
                ? 'It gets a job when a task arrives here.'
                : 'Each gets a job when a task arrives; the first to claim it does it.'}
          </p>
        </fieldset>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={instructionsId}>Instructions</Label>
        <Textarea
          id={instructionsId}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => {
            if (instructions !== rules.instructions) onSave({ instructions });
          }}
          maxLength={PIPELINE_LIMITS.instructions}
          rows={5}
          placeholder="What to do here, e.g. Review the change, run the tests, and note anything risky."
        />
        <p className="text-xs text-muted-foreground">
          Markdown. Shown on the task and sent to agents in their job brief.
        </p>
      </div>
    </Question>
  );
}

function AgentCheck({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="flex min-w-0 items-baseline gap-2 font-normal">
        <span className="truncate">{label}</span>
        <span className="truncate text-xs text-muted-foreground">{description}</span>
      </Label>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------------------------

function Advanced({
  status,
  rules,
  isOnly,
  canManage,
  onSave,
  onOpenFull,
  onDelete,
}: {
  status: Status;
  rules: StageRules;
  isOnly: boolean;
  canManage: boolean;
  onSave: (input: UpdateStatusInput) => void;
  onOpenFull: () => void;
  onDelete: () => void;
}) {
  const startId = useId();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-4 py-3">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            className={cn('size-4 transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          />
          Advanced
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-4 pt-3">
        <fieldset disabled={!canManage} className="grid gap-4">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={startId} className="font-normal">
              New tasks can start here
            </Label>
            <Switch
              id={startId}
              checked={acceptsNewTasks(status)}
              onCheckedChange={(allowCreate) => onSave({ rules: { allowCreate } })}
            />
          </div>
          <div className="flex items-center justify-between gap-3 text-sm">
            {status.isDefault ? (
              <span className="text-muted-foreground">
                The default stage: new tasks start here.
              </span>
            ) : (
              <>
                <span className="text-muted-foreground">Not the default stage.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onSave({ isDefault: true })}
                >
                  Make it the default
                </Button>
              </>
            )}
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Other rules: {stageSummary(rules)}. All settings holds where tasks go next or back to, who
          may move them on, notifications, claiming, the default difficulty and more.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* Works read-only too: the dialog shows every setting. */}
          <Button type="button" variant="outline" size="sm" onClick={onOpenFull}>
            <Settings2Icon aria-hidden="true" />
            All settings…
          </Button>
          {canManage ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={isOnly}
              title={isOnly ? 'A pipeline needs at least one stage' : undefined}
              className="text-destructive hover:text-destructive"
            >
              <Trash2Icon aria-hidden="true" />
              Delete stage
            </Button>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
