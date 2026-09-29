import { CheckIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { StatusIconShape } from '@shared/constants';
import {
  DEFAULT_STAGE_RULES,
  PIPELINE_LIMITS,
  stageRulesSchema,
  type StageRules,
  type StageRulesPatch,
} from '@shared/schemas/pipelines';
import {
  statusNameSchema,
  type CreateStatusInput,
  type Status,
  type UpdateStatusInput,
} from '@shared/schemas/projects';
import { HelpTip } from '@web/components/common/HelpTip';
import { Spinner } from '@web/components/common/Spinner';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { STATUS_ICON_SHAPES } from '@web/components/common/statusIcons';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import { EMPTY_RULE, type PrincipalOptions } from '@web/components/pickers/principals';
import { StatusIconPicker } from '@web/components/pickers/StatusIconPicker';
import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { errorMessage } from '@web/lib/api';
import { FINISHED_STAGE_RULES, LIMITS } from '@shared/constants';
import { cn } from '@web/lib/utils';
import { DifficultySelect, type DifficultyLevel } from '../tasks/DifficultySelect';
import {
  approvalsSentence,
  CUSTOM_HANDOFF_LABELS,
  CUSTOM_HANDOFF_MODES,
  isCustomHandoff,
  suggestColor,
  type CustomHandoffMode,
} from './stageRules';

/**
 * A status in one dialog (Project settings → Statuses): its basics, instructions, what happens
 * when a task arrives, how tasks behave while here, its exit criteria and how tasks move on.
 * Creating walks the categories in order (Next checks each, Create stage saves them all at once);
 * editing opens any category and saves it on its own.
 */

export type StatusDialogState =
  { mode: 'create' } | { mode: 'edit'; status: Status; section?: SectionId } | null;

export interface StatusDialogProps {
  state: StatusDialogState;
  statuses: readonly Status[];
  options: PrincipalOptions;
  teamId: string;
  canManage: boolean;
  onClose: () => void;
  onCreate: (input: CreateStatusInput) => Promise<Status>;
  onUpdate: (id: string, input: UpdateStatusInput) => Promise<unknown>;
  /** BAT-28: the project's difficulty levels, easiest first (for the default difficulty). */
  difficulties?: readonly DifficultyLevel[] | undefined;
}

const SECTIONS = [
  { id: 'basics', title: 'Basics' },
  { id: 'instructions', title: 'Instructions' },
  { id: 'arrival', title: 'When a task arrives' },
  { id: 'while', title: 'While it’s here' },
  { id: 'criteria', title: 'Exit criteria' },
  { id: 'moving', title: 'Moving on' },
] as const;
export type SectionId = (typeof SECTIONS)[number]['id'];

interface Draft {
  name: string;
  icon: StatusIconShape;
  color: string;
  isDefault: boolean;
  /** BAT-28: the difficulty of a task's first visit. */
  defaultDifficultyId: string | null;
  rules: StageRules;
}

/** The rules each category saves. */
const SECTION_RULES: Record<Exclude<SectionId, 'basics'>, ReadonlyArray<keyof StageRules>> = {
  instructions: ['instructions'],
  arrival: ['handoff', 'onEnter', 'notify'],
  while: ['blocksDependents', 'claimable'],
  criteria: ['exitCriteria'],
  moving: ['approvals', 'autoAdvance', 'moveBy', 'moveRule', 'sendBackTo', 'nextStatusId'],
};

/** The rules as they are saved: what the dialog hides or implies filled in. */
function cleanRules(rules: StageRules): StageRules {
  const { handoff } = rules;
  const exitCriteria = rules.exitCriteria.map((criterion) => ({
    ...criterion,
    text: criterion.text.trim(),
  }));
  return {
    ...rules,
    handoff: isCustomHandoff(handoff.mode)
      ? { mode: handoff.mode, rule: handoff.rule ?? EMPTY_RULE }
      : handoff.mode === 'stage_holder'
        ? { mode: 'stage_holder', ...(handoff.statusId ? { statusId: handoff.statusId } : {}) }
        : { mode: handoff.mode },
    // "Keep their claim" only exists for the assignees from the last stage; any other hand-off
    // moves the claim with the task (and `nobody` drops it).
    onEnter: {
      ...rules.onEnter,
      releaseClaim: handoff.mode === 'keep' ? rules.onEnter.releaseClaim : false,
    },
    // Retired from the dialog: the notify checkboxes replace it.
    notify: null,
    exitCriteria,
    // Always moved on by someone: the dialog no longer offers auto-advance.
    autoAdvance: false,
  };
}

function sectionOf(path: ReadonlyArray<PropertyKey>): SectionId {
  const field = path[0];
  for (const [section, fields] of Object.entries(SECTION_RULES)) {
    if ((fields as readonly PropertyKey[]).includes(field ?? '')) return section as SectionId;
  }
  return 'basics';
}

/** The first problem of a category, or null. */
function problemIn(section: SectionId, draft: Draft): string | null {
  if (section === 'basics') {
    const name = statusNameSchema.safeParse(draft.name);
    return name.success ? null : `Name: ${name.error.issues[0]?.message ?? 'Invalid name'}`;
  }
  const parsed = stageRulesSchema.safeParse(cleanRules(draft.rules));
  if (parsed.success) return null;
  const issue = parsed.error.issues.find((candidate) => sectionOf(candidate.path) === section);
  if (!issue) return null;
  if (issue.path[0] === 'approvals' && issue.path.includes('rule')) {
    return 'Choose who can approve';
  }
  return issue.message;
}

function pickRules(section: Exclude<SectionId, 'basics'>, rules: StageRules): StageRulesPatch {
  return Object.fromEntries(SECTION_RULES[section].map((field) => [field, rules[field]]));
}

function sameSection(section: SectionId, a: Draft, b: Draft): boolean {
  if (section === 'basics') {
    return (
      a.name === b.name &&
      a.icon === b.icon &&
      a.color === b.color &&
      a.isDefault === b.isDefault &&
      a.defaultDifficultyId === b.defaultDifficultyId &&
      a.rules.allowCreate === b.rules.allowCreate
    );
  }
  return (
    JSON.stringify(pickRules(section, a.rules)) === JSON.stringify(pickRules(section, b.rules))
  );
}

function withSection(section: SectionId, base: Draft, from: Draft): Draft {
  if (section === 'basics') {
    return {
      ...base,
      name: from.name,
      icon: from.icon,
      color: from.color,
      isDefault: from.isDefault,
      defaultDifficultyId: from.defaultDifficultyId,
      // BAT-34: "New tasks can start here" sits with the basics.
      rules: { ...base.rules, allowCreate: from.rules.allowCreate },
    };
  }
  return { ...base, rules: { ...base.rules, ...pickRules(section, from.rules) } as StageRules };
}

export function StatusDialog(props: StatusDialogProps) {
  const { state } = props;
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [dirty, setDirty] = useState(false);
  const close = () => {
    setConfirmingClose(false);
    setDirty(false);
    props.onClose();
  };
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (open) return;
        if (dirty) setConfirmingClose(true);
        else close();
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {state ? (
          <StatusForm
            key={state.mode === 'edit' ? state.status.id : 'new'}
            {...props}
            state={state}
            onDirtyChange={setDirty}
            confirmingClose={confirmingClose}
            onKeepEditing={() => setConfirmingClose(false)}
            onClose={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StatusForm({
  state,
  statuses,
  options,
  teamId,
  canManage,
  onClose,
  onCreate,
  onUpdate,
  onDirtyChange,
  confirmingClose,
  onKeepEditing,
  difficulties,
}: Omit<StatusDialogProps, 'state'> & {
  state: NonNullable<StatusDialogState>;
  onDirtyChange: (dirty: boolean) => void;
  confirmingClose: boolean;
  onKeepEditing: () => void;
}) {
  const creating = state.mode === 'create';
  const status = state.mode === 'edit' ? state.status : null;
  const [saved, setSaved] = useState<Draft>(() => {
    if (!status) {
      return {
        name: '',
        icon: 'circle',
        color: suggestColor(statuses),
        isDefault: false,
        defaultDifficultyId: null,
        // A new stage starts plain (nothing assigned or gated) and goes last: by default it can
        // send tasks back to every stage before it.
        rules: { ...DEFAULT_STAGE_RULES, sendBackTo: statuses.map((other) => other.id) },
      };
    }
    const rules = status.rules ?? DEFAULT_STAGE_RULES;
    // Stages reordered or deleted since are no longer earlier ones.
    const earlier = new Set(earlierStages(statuses, status.id).map((other) => other.id));
    return {
      name: status.name,
      icon: status.icon,
      color: status.color,
      isDefault: status.isDefault,
      defaultDifficultyId: status.defaultDifficultyId ?? null,
      rules: { ...rules, sendBackTo: rules.sendBackTo.filter((id) => earlier.has(id)) },
    };
  });
  const [draft, setDraft] = useState<Draft>(saved);
  const [section, setSection] = useState<SectionId>(
    state.mode === 'edit' ? (state.section ?? 'basics') : 'basics',
  );
  const [reached, setReached] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const index = SECTIONS.findIndex((candidate) => candidate.id === section);
  const dirtySections = SECTIONS.filter((candidate) => !sameSection(candidate.id, draft, saved));
  const isDirty = creating
    ? draft.name.trim() !== '' || dirtySections.length > 0
    : dirtySections.length > 0;
  const [reportedDirty, setReportedDirty] = useState(false);
  if (isDirty !== reportedDirty) {
    setReportedDirty(isDirty);
    onDirtyChange(isDirty);
  }

  const setRules = <K extends keyof StageRules>(key: K, value: StageRules[K]) =>
    setDraft((current) => ({ ...current, rules: { ...current.rules, [key]: value } }));

  const go = (next: SectionId) => {
    setError(null);
    setSection(next);
  };

  const next = () => {
    const problem = problemIn(section, draft);
    if (problem) {
      setError(problem);
      return;
    }
    const following = SECTIONS[index + 1];
    if (!following) return;
    setReached((current) => Math.max(current, index + 1));
    go(following.id);
  };

  const create = () => {
    for (const candidate of SECTIONS) {
      const problem = problemIn(candidate.id, draft);
      if (problem) {
        setSection(candidate.id);
        setError(problem);
        return;
      }
    }
    setError(null);
    setPending(true);
    const name = statusNameSchema.parse(draft.name);
    onCreate({
      name,
      icon: draft.icon,
      color: draft.color,
      ...(draft.isDefault ? { isDefault: true } : {}),
      ...(draft.defaultDifficultyId ? { defaultDifficultyId: draft.defaultDifficultyId } : {}),
      rules: cleanRules(draft.rules),
    }).then(
      (created) => {
        setPending(false);
        toast.success(`Added ${created.name}`);
        onDirtyChange(false);
        onClose();
      },
      (cause: unknown) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    );
  };

  const save = () => {
    if (!status) return;
    const problem = problemIn(section, draft);
    if (problem) {
      setError(problem);
      return;
    }
    let input: UpdateStatusInput;
    if (section === 'basics') {
      input = {
        name: statusNameSchema.parse(draft.name),
        icon: draft.icon,
        color: draft.color,
        ...(draft.isDefault && !saved.isDefault ? { isDefault: true as const } : {}),
        ...(draft.defaultDifficultyId !== saved.defaultDifficultyId
          ? { defaultDifficultyId: draft.defaultDifficultyId }
          : {}),
        ...(draft.rules.allowCreate !== saved.rules.allowCreate
          ? { rules: { allowCreate: draft.rules.allowCreate } }
          : {}),
      };
    } else {
      input = { rules: pickRules(section, cleanRules(draft.rules)) };
    }
    setError(null);
    setPending(true);
    onUpdate(status.id, input).then(
      () => {
        setPending(false);
        const cleaned = { ...draft, rules: cleanRules(draft.rules) };
        setSaved((current) => withSection(section, current, cleaned));
        setDraft((current) => withSection(section, current, cleaned));
        toast.success(`Saved ${SECTIONS[index]?.title.toLowerCase()} of ${draft.name.trim()}`);
      },
      (cause: unknown) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    );
  };

  /** "Make this a final status": in a new status it fills the draft; an existing one saves. */
  const makeFinal = () => {
    const rules = finalRules(draft.rules);
    setDraft((current) => ({ ...current, rules }));
    if (!status) return;
    const patch: StageRulesPatch = {
      handoff: rules.handoff,
      onEnter: rules.onEnter,
      blocksDependents: rules.blocksDependents,
      claimable: rules.claimable,
    };
    setError(null);
    setPending(true);
    onUpdate(status.id, { rules: patch }).then(
      () => {
        setPending(false);
        setSaved((current) => ({
          ...current,
          rules: { ...current.rules, ...patch } as StageRules,
        }));
        toast.success(`${draft.name.trim()} is now a final status`);
      },
      (cause: unknown) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    );
  };

  const title = creating ? 'New stage' : `Edit ${status?.name ?? ''}`;
  const sectionDirty = dirtySections.some((candidate) => candidate.id === section);

  return (
    <>
      <div className="border-b px-5 py-4 pr-12">
        <DialogTitle className="flex items-center gap-2">
          {!creating ? (
            <StatusIcon status={{ name: draft.name, icon: draft.icon, color: draft.color }} />
          ) : null}
          {title}
        </DialogTitle>
        <DialogDescription className="mt-1">
          {creating
            ? 'Go through each step; only the name is required. Nothing is saved until you create it.'
            : 'Pick a category and save it on its own. Changes apply to tasks the next time they move.'}
        </DialogDescription>
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label={creating ? 'Steps' : 'Categories'}
          className="shrink-0 overflow-x-auto border-b sm:w-52 sm:overflow-visible sm:border-r sm:border-b-0"
        >
          <ol className="flex gap-1 p-2 sm:flex-col">
            {SECTIONS.map((candidate, at) => {
              const locked = creating && at > reached;
              const done = creating && at < reached && at !== index;
              const unsaved = !creating && dirtySections.some((item) => item.id === candidate.id);
              const current = candidate.id === section;
              return (
                <li key={candidate.id}>
                  <button
                    type="button"
                    disabled={locked || pending}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => go(candidate.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                      current
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'hover:bg-accent/60',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.7rem] tabular-nums',
                        current && 'border-primary bg-primary text-primary-foreground',
                        done && 'border-primary text-primary',
                      )}
                    >
                      {done ? <CheckIcon className="size-3" /> : at + 1}
                    </span>
                    <span className="flex-1">{candidate.title}</span>
                    {unsaved ? (
                      <span className="size-1.5 rounded-full bg-primary" aria-label="unsaved" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <fieldset
          disabled={!canManage || pending}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4"
        >
          <legend className="sr-only">{SECTIONS[index]?.title}</legend>
          <h3 className="mb-4 text-base font-semibold">{SECTIONS[index]?.title}</h3>
          {section === 'basics' ? (
            <BasicsSection
              draft={draft}
              setDraft={setDraft}
              creating={creating}
              wasDefault={saved.isDefault && !creating}
              canManage={canManage}
              isFinal={isFinal(draft.rules)}
              onMakeFinal={makeFinal}
              difficulties={difficulties}
            />
          ) : section === 'instructions' ? (
            <InstructionsSection
              value={draft.rules.instructions}
              onChange={(value) => setRules('instructions', value)}
              teamId={teamId}
              editable={canManage}
            />
          ) : section === 'arrival' ? (
            <ArrivalSection
              rules={draft.rules}
              setRules={setRules}
              statuses={statuses}
              statusId={status?.id ?? null}
              options={options}
              disabled={!canManage}
            />
          ) : section === 'while' ? (
            <WhileSection rules={draft.rules} setRules={setRules} />
          ) : section === 'criteria' ? (
            <CriteriaSection rules={draft.rules} setRules={setRules} />
          ) : (
            <MovingSection
              rules={draft.rules}
              setRules={setRules}
              statuses={statuses}
              statusId={status?.id ?? null}
              options={options}
              disabled={!canManage}
            />
          )}
        </fieldset>
      </div>
      <div className="grid gap-2 border-t px-5 py-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {confirmingClose ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-sm"
          >
            <span>You have unsaved changes.</span>
            <span className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onKeepEditing}>
                Keep editing
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  onDirtyChange(false);
                  onClose();
                }}
              >
                Discard
              </Button>
            </span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {creating ? (
            <>
              {index > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mr-auto"
                  disabled={pending}
                  onClick={() => go(SECTIONS[index - 1]?.id ?? 'basics')}
                >
                  Back
                </Button>
              ) : null}
              {index < SECTIONS.length - 1 ? (
                <Button type="button" onClick={next} disabled={pending}>
                  Next
                </Button>
              ) : (
                <Button type="button" onClick={create} disabled={pending}>
                  {pending ? <Spinner /> : null}
                  Create stage
                </Button>
              )}
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                Done
              </Button>
              {canManage ? (
                <Button type="button" onClick={save} disabled={pending || !sectionDirty}>
                  {pending ? <Spinner /> : null}
                  Save
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

type SetRules = <K extends keyof StageRules>(key: K, value: StageRules[K]) => void;

/** The seeded Done's rules: assign nobody, tell the author and last holder, resolve issues, finished. */
function finalRules(rules: StageRules): StageRules {
  return {
    ...rules,
    handoff: FINISHED_STAGE_RULES.handoff,
    onEnter: { ...rules.onEnter, ...FINISHED_STAGE_RULES.onEnter },
    blocksDependents: FINISHED_STAGE_RULES.blocksDependents,
    claimable: FINISHED_STAGE_RULES.claimable,
  };
}

function isFinal(rules: StageRules): boolean {
  return JSON.stringify(finalRules(rules)) === JSON.stringify(rules);
}

function BasicsSection({
  draft,
  setDraft,
  creating,
  wasDefault,
  canManage,
  isFinal: final,
  onMakeFinal,
  difficulties,
}: {
  draft: Draft;
  setDraft: (update: (current: Draft) => Draft) => void;
  creating: boolean;
  wasDefault: boolean;
  canManage: boolean;
  isFinal: boolean;
  onMakeFinal: () => void;
  difficulties?: readonly DifficultyLevel[] | undefined;
}) {
  const nameId = useId();
  const difficultyId = useId();
  return (
    <div className="grid max-w-md gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          maxLength={LIMITS.statusName.max}
          placeholder="e.g. In review"
          autoFocus={creating}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Icon</span>
        <StatusIconPicker
          value={{ icon: draft.icon, color: draft.color }}
          onChange={(change) => setDraft((current) => ({ ...current, ...change }))}
          label="Status icon"
          disabled={!canManage}
        >
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            aria-label={`Icon: ${STATUS_ICON_SHAPES[draft.icon].label}, ${draft.color}`}
          >
            <StatusIcon status={{ name: draft.name, icon: draft.icon, color: draft.color }} />
            Change icon
          </Button>
        </StatusIconPicker>
      </div>
      {difficulties && difficulties.length > 0 ? (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={difficultyId}>Default difficulty</Label>
            <HelpTip topic="Default difficulty">
              The difficulty a task gets the first time it enters this stage (it picks the models
              agents run). Coming back, it keeps the difficulty it had here last time. No
              difficulty: it keeps the one it came with.
            </HelpTip>
          </div>
          <DifficultySelect
            id={difficultyId}
            levels={difficulties}
            value={draft.defaultDifficultyId}
            onChange={(value) =>
              setDraft((current) => ({ ...current, defaultDifficultyId: value }))
            }
            className="max-w-sm"
          />
        </div>
      ) : null}
      <CheckRow
        label="New tasks can start here"
        help={
          draft.isDefault && !wasDefault
            ? 'The default stage always accepts new tasks when you make it the default.'
            : 'People and agents can create tasks straight in this status (the + on its column, the status picker of New task). Off: tasks only get here by moving.'
        }
        checked={draft.rules.allowCreate}
        disabled={!canManage || (draft.isDefault && !wasDefault)}
        onChange={(allowCreate) =>
          setDraft((current) => ({ ...current, rules: { ...current.rules, allowCreate } }))
        }
      />
      <CheckRow
        label="Default for new tasks"
        help={
          wasDefault
            ? 'New tasks start here when it accepts them, else in the first status that does. To change that, make another status the default.'
            : 'New tasks start in this status. Making it the default lets new tasks start here.'
        }
        checked={draft.isDefault}
        disabled={wasDefault}
        onChange={(isDefault) =>
          setDraft((current) => ({
            ...current,
            isDefault,
            // BAT-34: the server turns it on for a new default too.
            rules: isDefault ? { ...current.rules, allowCreate: true } : current.rules,
          }))
        }
      />
      <div className="grid gap-1.5 rounded-lg border border-dashed p-3">
        <div className="flex items-center gap-1.5">
          {final ? (
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <CheckIcon className="size-4 text-primary" aria-hidden="true" />
              This is a final status
            </p>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onMakeFinal}
              disabled={!canManage}
            >
              Make this a final status
            </Button>
          )}
          <HelpTip topic="Final status">
            For statuses like Done, Canceled or Shipped. Sets: assign to nobody, notify the author
            and whoever had it, resolve the issues it fixes, counts as finished, can’t be claimed.
            You can still change each one afterwards.
          </HelpTip>
        </div>
      </div>
    </div>
  );
}

function InstructionsSection({
  value,
  onChange,
  teamId,
  editable,
}: {
  value: string;
  onChange: (value: string) => void;
  teamId: string;
  editable: boolean;
}) {
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">
        What should whoever has the task do here? Shown on the task and to agents. Markdown works;
        type / for blocks.
      </p>
      <RichTextEditor
        value={value}
        onChange={onChange}
        teamId={teamId}
        editable={editable}
        label="Instructions"
        placeholder="e.g. Review the change, run the tests, and note anything risky."
        className="min-h-[45vh]"
      />
      {value.length > PIPELINE_LIMITS.instructions * 0.9 ? (
        <p className="text-xs text-muted-foreground">
          {value.length} / {PIPELINE_LIMITS.instructions} characters
        </p>
      ) : null}
    </div>
  );
}

type AssignChoice = 'custom' | 'keep' | 'nobody' | 'mover' | 'author' | 'stage_holder';

function ArrivalSection({
  rules,
  setRules,
  statuses,
  statusId,
  options,
  disabled,
}: {
  rules: StageRules;
  setRules: SetRules;
  statuses: readonly Status[];
  statusId: string | null;
  options: PrincipalOptions;
  disabled: boolean;
}) {
  const assignId = useId();
  const getsId = useId();
  const { handoff } = rules;
  const choice: AssignChoice = isCustomHandoff(handoff.mode) ? 'custom' : handoff.mode;
  const holderStage = statuses.find((candidate) => candidate.id === handoff.statusId);
  const setOnEnter = (change: Partial<StageRules['onEnter']>) =>
    setRules('onEnter', { ...rules.onEnter, ...change });

  const choose = (value: AssignChoice) => {
    if (value === 'custom') {
      setRules('handoff', { mode: 'specific', rule: handoff.rule ?? EMPTY_RULE });
    } else if (value === 'stage_holder') {
      setRules('handoff', {
        mode: 'stage_holder',
        statusId: handoff.statusId ?? statuses.find((other) => other.id !== statusId)?.id,
      });
    } else {
      setRules('handoff', { mode: value });
    }
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={assignId}>Assign to</Label>
          <HelpTip topic="Assign to">
            Who the task is assigned to when it arrives. “Assignees from last stage” keeps whoever
            had it; “Custom” lets you pick people, agents and roles.
          </HelpTip>
        </div>
        <NativeSelect
          id={assignId}
          value={choice}
          onChange={(value) => choose(value as AssignChoice)}
        >
          <option value="custom">Custom…</option>
          <option value="keep">Assignees from last stage</option>
          <option value="nobody">Nobody</option>
          <option value="mover">Whoever moved it here</option>
          <option value="author">Task’s author</option>
          {choice === 'stage_holder' ? (
            <option value="stage_holder">
              Whoever had it in {holderStage?.name ?? 'another status'}
            </option>
          ) : null}
        </NativeSelect>

        {choice === 'custom' ? (
          <div className="grid gap-3 rounded-lg border p-3">
            <PrincipalRulePicker
              label="Who"
              value={handoff.rule ?? EMPTY_RULE}
              onChange={(rule) => setRules('handoff', { ...handoff, rule })}
              options={options}
              disabled={disabled}
            />
            <div className="grid gap-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor={getsId}>Who gets it</Label>
                <HelpTip topic="Who gets it">
                  “Together” assigns everyone on the list. “Claims it first” assigns nobody: anyone
                  on the list can claim it, and it’s theirs. The last two assign one person from the
                  list.
                </HelpTip>
              </div>
              <NativeSelect
                id={getsId}
                value={handoff.mode}
                onChange={(mode) =>
                  setRules('handoff', {
                    mode: mode as CustomHandoffMode,
                    rule: handoff.rule ?? EMPTY_RULE,
                  })
                }
              >
                {CUSTOM_HANDOFF_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {CUSTOM_HANDOFF_LABELS[mode]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        ) : null}

        {choice === 'keep' ? (
          <CheckRow
            label="Keep their claim"
            help="Whoever had claimed the task keeps working on it here. Off: the claim is released, so it’s free to be claimed again."
            checked={!rules.onEnter.releaseClaim}
            onChange={(keep) => setOnEnter({ releaseClaim: !keep })}
          />
        ) : null}
      </section>

      <section className="grid gap-2">
        <h4 className="text-sm font-medium">Notify</h4>
        <CheckRow
          label="Assignees"
          help="The people and agents it’s assigned to get an inbox notification."
          checked={rules.onEnter.notifyAssignees}
          onChange={(notifyAssignees) => setOnEnter({ notifyAssignees })}
        />
        <CheckRow
          label="The author"
          help="Whoever created the task gets an inbox notification that it reached this status."
          checked={rules.onEnter.notifyAuthor}
          onChange={(notifyAuthor) => setOnEnter({ notifyAuthor })}
        />
        <CheckRow
          label="Whoever had it before"
          help="Whoever it was assigned to in the previous status gets an inbox notification that it moved on."
          checked={rules.onEnter.notifyPreviousHolder}
          onChange={(notifyPreviousHolder) => setOnEnter({ notifyPreviousHolder })}
        />
      </section>

      <section className="grid gap-2">
        <h4 className="text-sm font-medium">Issues</h4>
        <CheckRow
          label="Resolve the issues it fixes"
          help="Issues linked to the task as “fixes” are marked resolved when it arrives here. Turn this on for your final status."
          checked={rules.onEnter.resolveIssues}
          onChange={(resolveIssues) => setOnEnter({ resolveIssues })}
        />
      </section>
    </div>
  );
}

function WhileSection({ rules, setRules }: { rules: StageRules; setRules: SetRules }) {
  return (
    <div className="grid gap-3">
      <CheckRow
        label="Counts as finished"
        help="Tasks here are complete: they get a completed date and stop blocking tasks that wait on them."
        checked={!rules.blocksDependents}
        onChange={(finished) => setRules('blocksDependents', !finished)}
      />
      <CheckRow
        label="Can be claimed"
        help="People can press Claim and agents can pick it up with claim_next_task. Turn off for statuses like Done or Waiting."
        checked={rules.claimable}
        onChange={(claimable) => setRules('claimable', claimable)}
      />
    </div>
  );
}

function nextCriterionId(existing: ReadonlyArray<{ id: string }>): string {
  for (let n = existing.length + 1; ; n += 1) {
    const id = `c${n}`;
    if (!existing.some((criterion) => criterion.id === id)) return id;
  }
}

function CriteriaSection({ rules, setRules }: { rules: StageRules; setRules: SetRules }) {
  const criteria = rules.exitCriteria;
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1.5">
        <p className="text-sm">Before it moves on, someone must show:</p>
        <HelpTip topic="Exit criteria">
          Each needs evidence (a summary or a link) before the task can move on. Agents pass it by
          the id shown next to each one.
        </HelpTip>
      </div>
      {criteria.length === 0 ? (
        <p className="text-sm text-muted-foreground">No criteria: it can move on any time.</p>
      ) : null}
      <ul className="grid gap-2" aria-label="Exit criteria">
        {criteria.map((criterion, index) => (
          <li key={criterion.id} className="flex items-center gap-2">
            <code className="w-8 shrink-0 text-xs text-muted-foreground">{criterion.id}</code>
            <Input
              value={criterion.text}
              onChange={(event) =>
                setRules(
                  'exitCriteria',
                  criteria.map((item, at) =>
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
                setRules(
                  'exitCriteria',
                  criteria.filter((_, at) => at !== index),
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
        disabled={criteria.length >= PIPELINE_LIMITS.criteria}
        onClick={() =>
          setRules('exitCriteria', [...criteria, { id: nextCriterionId(criteria), text: '' }])
        }
      >
        <PlusIcon aria-hidden="true" />
        Add criterion
      </Button>
    </div>
  );
}

/** The stages before `statusId` in column order (every stage for a new one). */
function earlierStages(statuses: readonly Status[], statusId: string | null): Status[] {
  const index = statusId ? statuses.findIndex((other) => other.id === statusId) : -1;
  return index === -1 ? (statusId ? [] : [...statuses]) : statuses.slice(0, index);
}

/**
 * "Can move to" (BAT-27): forward only to the next stage (the next column, or the stage picked
 * here), back only to the earlier stages checked here, always with a reason.
 */
function CanMoveTo({
  rules,
  setRules,
  statuses,
  statusId,
}: {
  rules: StageRules;
  setRules: SetRules;
  statuses: readonly Status[];
  statusId: string | null;
}) {
  const nextId = useId();
  const others = statuses.filter((other) => other.id !== statusId);
  const earlier = earlierStages(statuses, statusId);
  const checked = new Set(rules.sendBackTo);
  return (
    <section className="grid gap-3" aria-labelledby={`${nextId}-heading`}>
      <div className="flex items-center gap-1.5">
        <h4 id={`${nextId}-heading`} className="text-sm font-medium">
          Can move to
        </h4>
        <HelpTip topic="Can move to">
          Tasks move on only to the next stage, once the rules below are met, and back only to the
          earlier stages checked here, always with a reason. To skip a stage, pick a later one as
          the next stage.
        </HelpTip>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={nextId} className="font-normal text-muted-foreground">
          Forward
        </Label>
        <NativeSelect
          id={nextId}
          value={rules.nextStatusId ?? ''}
          onChange={(value) => setRules('nextStatusId', value || null)}
        >
          {/* Not named (BAT-35): the next column changes when stages are rearranged. */}
          <option value="">Next stage</option>
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              {other.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-sm font-normal text-muted-foreground">
          Back (with a reason)
        </legend>
        {earlier.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No earlier stages: tasks can’t be sent back from here.
          </p>
        ) : (
          earlier.map((other) => (
            <CheckRow
              key={other.id}
              label={other.name}
              checked={checked.has(other.id)}
              onChange={(on) =>
                setRules(
                  'sendBackTo',
                  earlier
                    .filter((candidate) =>
                      candidate.id === other.id ? on : checked.has(candidate.id),
                    )
                    .map((candidate) => candidate.id),
                )
              }
            />
          ))
        )}
        {earlier.length > 0 && checked.size === 0 ? (
          <p className="text-sm text-muted-foreground">
            None checked: tasks can’t be sent back from here, and Request changes only blocks it.
          </p>
        ) : null}
      </fieldset>
    </section>
  );
}

function MovingSection({
  rules,
  setRules,
  statuses,
  statusId,
  options,
  disabled,
}: {
  rules: StageRules;
  setRules: SetRules;
  statuses: readonly Status[];
  statusId: string | null;
  options: PrincipalOptions;
  disabled: boolean;
}) {
  const countId = useId();
  const { approvals } = rules;
  const count = approvals?.count ?? 0;

  const setCount = (value: number) => {
    const n = Math.max(0, Math.min(PIPELINE_LIMITS.maxApprovals, Math.trunc(value) || 0));
    setRules(
      'approvals',
      n === 0
        ? null
        : {
            count: n,
            rule: approvals?.rule ?? EMPTY_RULE,
            dismissOnChange: approvals?.dismissOnChange ?? false,
          },
    );
  };

  return (
    <div className="grid gap-6">
      <CanMoveTo rules={rules} setRules={setRules} statuses={statuses} statusId={statusId} />

      <section className="grid gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor={countId}>Approvals needed</Label>
          <Input
            id={countId}
            type="number"
            min={0}
            max={PIPELINE_LIMITS.maxApprovals}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
            className="h-8 w-20"
          />
          <HelpTip topic="Approvals needed">
            How many different approvers must press Approve before it can move on. Each person or
            agent counts once. 0: no approval step.
          </HelpTip>
        </div>
        {approvals ? (
          <div className="grid gap-3 rounded-lg border p-3">
            <PrincipalRulePicker
              label="Who can approve"
              value={approvals.rule}
              onChange={(rule) => setRules('approvals', { ...approvals, rule })}
              options={options}
              disabled={disabled}
            />
            <p className="text-sm text-muted-foreground">
              {approvalsSentence(approvals.count, approvals.rule, options)} Add{' '}
              <code className="text-xs">-ai</code> names to let agents approve.
            </p>
            <CheckRow
              label="Re-approve after edits"
              help="If the task or its evidence changes after someone approved, their approval is cleared and they must approve again."
              checked={approvals.dismissOnChange}
              onChange={(dismissOnChange) =>
                setRules('approvals', { ...approvals, dismissOnChange })
              }
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No approvals: once the criteria have evidence, whoever may move it on can, including an
            agent that decides the work is done.
          </p>
        )}
      </section>

      <section className="grid gap-2">
        <div className="flex items-center gap-1.5">
          <h4 className="text-sm font-medium">Who can move it on</h4>
          <HelpTip topic="Who can move it on">
            Who may move the task to the next status once it’s ready (criteria have evidence,
            approvals are in). Leave everything unticked to let anyone who can move tasks do it. A
            task with no assignees and no claim can be moved by anyone.
          </HelpTip>
        </div>
        <CheckRow
          label="Assignees"
          checked={rules.moveBy.assignees}
          onChange={(assignees) => setRules('moveBy', { ...rules.moveBy, assignees })}
        />
        <CheckRow
          label="Whoever claimed it"
          checked={rules.moveBy.claimer}
          onChange={(claimer) => setRules('moveBy', { ...rules.moveBy, claimer })}
        />
        <CheckRow
          label="Others"
          checked={rules.moveRule !== null}
          onChange={(others) => setRules('moveRule', others ? EMPTY_RULE : null)}
        />
        {rules.moveRule ? (
          <PrincipalRulePicker
            label="Who else can move it on"
            value={rules.moveRule}
            onChange={(rule) => setRules('moveRule', rule)}
            options={options}
            disabled={disabled}
            className="ml-6 rounded-lg border p-3"
          />
        ) : null}
        {!rules.moveBy.assignees && !rules.moveBy.claimer && !rules.moveRule ? (
          <p className="text-sm text-muted-foreground">Anyone who can move tasks can move it on.</p>
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

function CheckRow({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      {help ? <HelpTip topic={label}>{help}</HelpTip> : null}
    </div>
  );
}

function NativeSelect({
  id,
  value,
  onChange,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
    >
      {children}
    </select>
  );
}
