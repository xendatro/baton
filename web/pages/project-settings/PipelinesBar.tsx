import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, Settings2Icon, Trash2Icon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  DEFAULT_PIPELINE_TEMPLATE,
  PIPELINE_TEMPLATE_LIST,
  PIPELINE_TEMPLATES,
  type PipelineTemplateId,
} from '@shared/pipelineTemplates';
import type { PrincipalRule } from '@shared/principals';
import { pipelineNameSchema, type Pipeline, type Status } from '@shared/schemas/projects';
import { SoftWarning } from '@web/components/common/SoftWarning';
import { Spinner } from '@web/components/common/Spinner';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import type { PrincipalOptions } from '@web/components/pickers/principals';
import { Button } from '@web/components/ui/button';
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
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Switch } from '@web/components/ui/switch';
import { errorMessage } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import {
  useCreatePipeline,
  useDeletePipeline,
  useReorderPipelines,
  useUpdatePipeline,
} from '../projects/queries';

/**
 * Pipelines (BAT-25): a project's separate sets of stages, each with its own board. The bar picks
 * the pipeline whose statuses the page below edits; "New pipeline" adds one (starting with the
 * default stages) and the gear opens its settings: name, order, who may see it, create tasks in
 * it and edit its stages, and deleting it (its tasks move to a stage of another pipeline).
 */
export function PipelinesBar({
  projectId,
  pipelines,
  selectedId,
  onSelect,
  canAdd,
  statuses,
  options,
  startCreating = false,
  onCreatingChange,
}: {
  projectId: string;
  pipelines: readonly Pipeline[];
  selectedId: string | undefined;
  onSelect: (pipelineId: string) => void;
  /** MANAGE_STATUSES: may add, reorder, delete pipelines and change who may use them. */
  canAdd: boolean;
  statuses: readonly Status[];
  options: PrincipalOptions;
  /** Open "New pipeline" right away (the board's "New pipeline" link). */
  startCreating?: boolean;
  onCreatingChange?: (creating: boolean) => void;
}) {
  const [creating, setCreatingState] = useState(startCreating);
  const setCreating = (next: boolean) => {
    setCreatingState(next);
    onCreatingChange?.(next);
  };
  const [editing, setEditing] = useState<Pipeline | null>(null);
  const selected = pipelines.find((pipeline) => pipeline.id === selectedId);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div role="tablist" aria-label="Pipelines" className="flex flex-wrap gap-1">
        {pipelines.map((pipeline) => (
          <button
            key={pipeline.id}
            type="button"
            role="tab"
            aria-selected={pipeline.id === selectedId}
            onClick={() => onSelect(pipeline.id)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
              pipeline.id === selectedId
                ? 'border-primary bg-primary/5 font-medium text-foreground'
                : 'text-muted-foreground',
            )}
          >
            {pipeline.name}
            <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
              {pipeline.taskCount}
            </span>
          </button>
        ))}
      </div>
      {selected && (selected.canManage || canAdd) ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing(selected)}
          aria-label={`${selected.name} pipeline settings`}
        >
          <Settings2Icon aria-hidden="true" />
          Pipeline settings
        </Button>
      ) : null}
      {canAdd ? (
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <PlusIcon aria-hidden="true" />
          New pipeline
        </Button>
      ) : null}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {creating ? (
            <CreatePipelineForm
              projectId={projectId}
              onClose={() => setCreating(false)}
              onCreated={(pipeline) => onSelect(pipeline.id)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {editing ? (
            <PipelineSettingsForm
              key={editing.id}
              projectId={projectId}
              pipeline={editing}
              pipelines={pipelines}
              statuses={statuses}
              canManageAll={canAdd}
              options={options}
              onClose={() => setEditing(null)}
              onDeleted={() => {
                const fallback = pipelines.find((pipeline) => pipeline.isDefault);
                if (fallback) onSelect(fallback.id);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreatePipelineForm({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (pipeline: Pipeline) => void;
}) {
  const nameId = useId();
  const create = useCreatePipeline(projectId);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<PipelineTemplateId>(DEFAULT_PIPELINE_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = pipelineNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid name');
      return;
    }
    setError(null);
    create.mutate(
      { name: parsed.data, template },
      {
        onSuccess: (pipeline) => {
          const setup = PIPELINE_TEMPLATES[template].setup;
          toast.success(
            `Added the ${pipeline.name} pipeline`,
            setup ? { description: setup, duration: 10_000 } : undefined,
          );
          onCreated(pipeline);
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New pipeline</DialogTitle>
        <DialogDescription>
          A separate set of stages with its own board, e.g. Modeling next to Scripting. Start from a
          template; you can rename, add or change stages next.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={40}
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${nameId}-error` : undefined}
        />
        {error ? (
          <p id={`${nameId}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <TemplatePicker value={template} onChange={setTemplate} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? <Spinner /> : null}
          Add pipeline
        </Button>
      </DialogFooter>
    </form>
  );
}

type RuleField = 'viewRule' | 'createRule' | 'manageRule';

const RULES: ReadonlyArray<{
  field: RuleField;
  label: string;
  everyone: string;
  off: string;
}> = [
  {
    field: 'viewRule',
    label: 'Who can see it',
    everyone: 'Everyone in the project sees it and its tasks',
    off: 'Everyone',
  },
  {
    field: 'createRule',
    label: 'Who can create tasks in it',
    everyone: 'Everyone who can create tasks',
    off: 'Everyone',
  },
  {
    field: 'manageRule',
    label: 'Who else can edit its stages',
    everyone: 'Only people who can manage statuses',
    off: 'Nobody else',
  },
];

function PipelineSettingsForm({
  projectId,
  pipeline,
  pipelines,
  statuses,
  canManageAll,
  options,
  onClose,
  onDeleted,
}: {
  projectId: string;
  pipeline: Pipeline;
  pipelines: readonly Pipeline[];
  statuses: readonly Status[];
  canManageAll: boolean;
  options: PrincipalOptions;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const nameId = useId();
  const moveId = useId();
  const update = useUpdatePipeline(projectId);
  const reorder = useReorderPipelines(projectId);
  const remove = useDeletePipeline(projectId);
  const [name, setName] = useState(pipeline.name);
  const [rules, setRules] = useState<Record<RuleField, PrincipalRule | null>>({
    viewRule: pipeline.viewRule,
    createRule: pipeline.createRule,
    manageRule: pipeline.manageRule,
  });
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const elsewhere = statuses.filter((status) => status.pipelineId !== pipeline.id);
  const [moveTo, setMoveTo] = useState(elsewhere[0]?.id ?? '');
  const pipelineName = (id: string | undefined) =>
    pipelines.find((candidate) => candidate.id === id)?.name ?? '';
  const index = pipelines.findIndex((candidate) => candidate.id === pipeline.id);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = pipelineNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid name');
      return;
    }
    for (const { field, label } of RULES) {
      if (rules[field] && rules[field].allow.length === 0) {
        setError(`${label}: add someone, or switch it back to everyone`);
        return;
      }
    }
    setError(null);
    update.mutate(
      {
        id: pipeline.id,
        input: {
          ...(parsed.data !== pipeline.name ? { name: parsed.data } : {}),
          ...(canManageAll ? rules : {}),
        },
      },
      {
        onSuccess: () => {
          toast.success('Pipeline saved');
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  const move = (offset: number) => {
    const ids = pipelines.map((candidate) => candidate.id);
    const target = index + offset;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] ?? '', ids[index] ?? ''];
    reorder.mutate(ids, { onError: (cause) => toast.error(errorMessage(cause)) });
  };

  const destroy = () => {
    setError(null);
    remove.mutate(
      { id: pipeline.id, moveTo },
      {
        onSuccess: (result) => {
          toast.success(
            result.movedTasks > 0
              ? `Deleted ${pipeline.name} and moved ${pluralize(result.movedTasks, 'task')}`
              : `Deleted ${pipeline.name}`,
          );
          onDeleted();
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <form onSubmit={save} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{pipeline.name} pipeline</DialogTitle>
        <DialogDescription>
          {pipeline.isDefault
            ? 'The default pipeline: new tasks start here unless another is picked. It can be renamed but not deleted.'
            : `${pluralize(pipeline.statusCount, 'stage')}, ${pluralize(pipeline.taskCount, 'task')}.`}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={40}
        />
      </div>
      {canManageAll && pipelines.length > 1 ? (
        <div className="flex items-center gap-2">
          <span className="text-sm">Order</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index <= 0 || reorder.isPending}
            onClick={() => move(-1)}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Earlier
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index >= pipelines.length - 1 || reorder.isPending}
            onClick={() => move(1)}
          >
            Later
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      {canManageAll
        ? RULES.map(({ field, label, everyone, off }) => (
            <RuleSetting
              key={field}
              label={label}
              everyone={everyone}
              off={off}
              value={rules[field]}
              options={options}
              onChange={(rule) => setRules((current) => ({ ...current, [field]: rule }))}
            />
          ))
        : null}
      {rules.viewRule && rules.viewRule.allow.length === 0 ? (
        <SoftWarning size="sm" data-testid="nobody-sees-pipeline">
          Only people who can manage statuses will see this pipeline and its tasks: nobody is chosen
          under “Who can see it”.
        </SoftWarning>
      ) : rules.createRule && rules.createRule.allow.length === 0 ? (
        <SoftWarning size="sm">
          Only people who can manage statuses can create tasks in this pipeline: nobody is chosen
          under “Who can create tasks in it”.
        </SoftWarning>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="sm:justify-between">
        {canManageAll && !pipeline.isDefault ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete((open) => !open)}
            aria-expanded={confirmDelete}
          >
            <Trash2Icon aria-hidden="true" />
            Delete pipeline
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? <Spinner /> : null}
            Save
          </Button>
        </div>
      </DialogFooter>
      {confirmDelete ? (
        <div className="grid gap-2 rounded-md border border-destructive/40 p-3">
          <Label htmlFor={moveId}>Move its tasks to</Label>
          <select
            id={moveId}
            value={moveTo}
            onChange={(event) => setMoveTo(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {elsewhere.map((status) => (
              <option key={status.id} value={status.id}>
                {pipelineName(status.pipelineId)} / {status.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Its stages go; the tasks enter the stage you pick.
          </p>
          <Button
            type="button"
            variant="destructive"
            onClick={destroy}
            disabled={!moveTo || remove.isPending}
            className="justify-self-start"
          >
            {remove.isPending ? <Spinner /> : null}
            Delete {pipeline.name}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function RuleSetting({
  label,
  everyone,
  off,
  value,
  options,
  onChange,
}: {
  label: string;
  everyone: string;
  off: string;
  value: PrincipalRule | null;
  options: PrincipalOptions;
  onChange: (rule: PrincipalRule | null) => void;
}) {
  const switchId = useId();
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={switchId}>{label}</Label>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{value ? 'Only these' : off}</span>
          <Switch
            id={switchId}
            checked={value !== null}
            onCheckedChange={(on) => onChange(on ? { allow: [], deny: [] } : null)}
            aria-label={`${label}: only some people`}
          />
        </div>
      </div>
      {value ? (
        <PrincipalRulePicker label={label} value={value} onChange={onChange} options={options} />
      ) : (
        <p className="text-xs text-muted-foreground">{everyone}.</p>
      )}
    </div>
  );
}

/** The template a new pipeline starts from, each with a preview of its stages. */
export function TemplatePicker({
  value,
  onChange,
  label = 'Start from',
}: {
  value: PipelineTemplateId;
  onChange: (template: PipelineTemplateId) => void;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as PipelineTemplateId)}
        aria-labelledby={id}
        className="gap-2"
      >
        {PIPELINE_TEMPLATE_LIST.map((template) => (
          <label
            key={template.id}
            htmlFor={`${id}-${template.id}`}
            className={cn(
              'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 rounded-md border p-3 hover:bg-accent/50',
              value === template.id && 'border-primary bg-primary/5',
            )}
          >
            <RadioGroupItem value={template.id} id={`${id}-${template.id}`} className="mt-0.5" />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{template.name}</span>
              <span className="text-xs text-muted-foreground">{template.description}</span>
            </span>
            <ol
              aria-label={`${template.name} stages`}
              className="col-start-2 flex flex-wrap items-center gap-1 text-xs"
            >
              {template.stages.map((stage, index) => (
                <li key={stage.name} className="flex items-center gap-1">
                  {index > 0 ? (
                    <ArrowRightIcon className="size-3 text-muted-foreground" aria-hidden="true" />
                  ) : null}
                  <span className="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5">
                    <StatusIcon status={stage} className="size-3" />
                    {stage.name}
                  </span>
                </li>
              ))}
            </ol>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}
