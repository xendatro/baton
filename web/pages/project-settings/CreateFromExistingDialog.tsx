import { ArrowLeftIcon, FolderSearchIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { StatusIconShape } from '@shared/constants';
import { LIMITS } from '@shared/constants';
import type { MeTeam } from '@shared/schemas/core';
import {
  statusNameSchema,
  type CreatedStatus,
  type CreateStatusInput,
  type Status,
} from '@shared/schemas/projects';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { STATUS_ICON_SHAPES } from '@web/components/common/statusIcons';
import { StatusIconPicker } from '@web/components/pickers/StatusIconPicker';
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
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { usePipelines } from '../projects/queries';
import { useSourceStages } from './pipelineQueries';
import { stageSummary, suggestColor } from './stageRules';

/**
 * "New stage → Create from existing" (2026-09-27): the basics (name, icon, default), then the stage
 * whose settings the new one copies: one of this pipeline's, or, after "Browse other pipelines…",
 * a stage of another pipeline of this project or of any project of the viewer's teams. The server
 * copies the rules (`copyRulesFrom`): stages they name map to this pipeline's by name, people and
 * roles to this team's, and what has no match is dropped; the toast lists what was.
 */

const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

export interface CreateFromExistingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The pipeline the stage joins, and its stages (the first sources offered). */
  pipelineId?: string | undefined;
  pipelineName?: string | undefined;
  statuses: readonly Status[];
  teams: readonly MeTeam[];
  onCreate: (input: CreateStatusInput) => Promise<CreatedStatus>;
}

export function CreateFromExistingDialog(props: CreateFromExistingDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {open ? <CreateFromExistingForm {...props} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

interface Basics {
  name: string;
  icon: StatusIconShape;
  color: string;
  isDefault: boolean;
}

function CreateFromExistingForm({
  projectId,
  pipelineId,
  pipelineName,
  statuses,
  teams,
  onCreate,
  onClose,
}: CreateFromExistingDialogProps & { onClose: () => void }) {
  const [page, setPage] = useState<'basics' | 'source'>('basics');
  const [basics, setBasics] = useState<Basics>(() => ({
    name: '',
    icon: 'circle',
    color: suggestColor(statuses),
    isDefault: false,
  }));
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const next = (event: FormEvent) => {
    event.preventDefault();
    const parsed = statusNameSchema.safeParse(basics.name);
    if (!parsed.success) {
      setError(`Name: ${parsed.error.issues[0]?.message ?? 'Invalid name'}`);
      return;
    }
    const clash = statuses.find(
      (status) => status.name.toLowerCase() === parsed.data.toLowerCase(),
    );
    if (clash) {
      setError(`There is already a stage named “${clash.name}”`);
      return;
    }
    setError(null);
    setPage('source');
  };

  const create = () => {
    if (!sourceId) {
      setError('Choose the stage to copy');
      return;
    }
    setError(null);
    setPending(true);
    onCreate({
      name: statusNameSchema.parse(basics.name),
      icon: basics.icon,
      color: basics.color,
      ...(basics.isDefault ? { isDefault: true } : {}),
      copyRulesFrom: sourceId,
    }).then(
      (created) => {
        setPending(false);
        const dropped = created.copied?.dropped ?? [];
        const title = `Added ${created.name} with the settings of ${created.copied?.from ?? 'the stage'}`;
        if (dropped.length > 0) {
          toast.warning(title, {
            description: `Left out (no match here): ${dropped.join('; ')}. Edit the stage to set them.`,
            duration: 15_000,
          });
        } else {
          toast.success(title);
        }
        onClose();
      },
      (cause: unknown) => {
        setPending(false);
        setError(errorMessage(cause));
      },
    );
  };

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {page === 'basics' ? 'New stage from existing' : 'Copy settings from'}
        </DialogTitle>
        <DialogDescription>
          {page === 'basics'
            ? 'Step 1 of 2: name the stage. Next, pick the stage whose settings it copies.'
            : `Step 2 of 2: ${basics.name.trim()} gets that stage’s rules (hand-off, criteria, approvals, moving on…); its name and icon stay yours.`}
        </DialogDescription>
      </DialogHeader>
      {page === 'basics' ? (
        <BasicsPage basics={basics} setBasics={setBasics} onSubmit={next} />
      ) : (
        <SourcePage
          projectId={projectId}
          pipelineId={pipelineId}
          pipelineName={pipelineName}
          statuses={statuses}
          teams={teams}
          sourceId={sourceId}
          onSourceChange={(id) => {
            setSourceId(id);
            setError(null);
          }}
        />
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="gap-2 sm:justify-between">
        {page === 'source' ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setError(null);
              setPage('basics');
            }}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Back
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        )}
        {page === 'basics' ? (
          <Button type="submit" form="create-from-existing-basics">
            Next
          </Button>
        ) : (
          <Button type="button" onClick={create} disabled={pending || !sourceId}>
            {pending ? <Spinner /> : null}
            Create stage
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

function BasicsPage({
  basics,
  setBasics,
  onSubmit,
}: {
  basics: Basics;
  setBasics: (update: (current: Basics) => Basics) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const nameId = useId();
  const defaultId = useId();
  return (
    <form id="create-from-existing-basics" onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          value={basics.name}
          onChange={(event) => setBasics((current) => ({ ...current, name: event.target.value }))}
          maxLength={LIMITS.statusName.max}
          placeholder="e.g. Security review"
          autoFocus
          autoComplete="off"
        />
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Icon</span>
        <StatusIconPicker
          value={{ icon: basics.icon, color: basics.color }}
          onChange={(change) => setBasics((current) => ({ ...current, ...change }))}
          label="Status icon"
        >
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            aria-label={`Icon: ${STATUS_ICON_SHAPES[basics.icon].label}, ${basics.color}`}
          >
            <StatusIcon status={{ name: basics.name, icon: basics.icon, color: basics.color }} />
            Change icon
          </Button>
        </StatusIconPicker>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={defaultId}
          checked={basics.isDefault}
          onCheckedChange={(checked) =>
            setBasics((current) => ({ ...current, isDefault: checked === true }))
          }
          className="mt-0.5"
        />
        <div className="grid gap-0.5">
          <Label htmlFor={defaultId}>Make it the default stage</Label>
          <p className="text-xs text-muted-foreground">
            New tasks of this pipeline start here (it then accepts new tasks).
          </p>
        </div>
      </div>
    </form>
  );
}

/** Which pipeline the stages to copy come from. */
interface Source {
  projectId: string;
  pipelineId: string | undefined;
}

function SourcePage({
  projectId,
  pipelineId,
  pipelineName,
  statuses,
  teams,
  sourceId,
  onSourceChange,
}: {
  projectId: string;
  pipelineId: string | undefined;
  pipelineName: string | undefined;
  statuses: readonly Status[];
  teams: readonly MeTeam[];
  sourceId: string | null;
  onSourceChange: (id: string | null) => void;
}) {
  const projectSelectId = useId();
  const pipelineSelectId = useId();
  const [browsing, setBrowsing] = useState(false);
  const [source, setSource] = useState<Source>({ projectId, pipelineId });
  const home = source.projectId === projectId && source.pipelineId === pipelineId;
  const pipelines = usePipelines(browsing ? source.projectId : undefined);
  const stages = useSourceStages(home ? null : source.projectId);
  const sourcePipelineId =
    source.pipelineId ?? pipelines.data?.find((pipeline) => pipeline.isDefault)?.id;
  const shown: readonly Status[] = home
    ? statuses
    : (stages.data ?? []).filter(
        (status) => !sourcePipelineId || status.pipelineId === sourcePipelineId,
      );
  const groups = teams.filter((team) => team.projects.length > 0);
  const choose = (next: Source) => {
    setSource(next);
    onSourceChange(null);
  };

  return (
    <div className="grid gap-3">
      {browsing ? (
        <div className="grid gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={projectSelectId}>Project</Label>
            <select
              id={projectSelectId}
              className={selectClass}
              value={source.projectId}
              onChange={(event) => choose({ projectId: event.target.value, pipelineId: undefined })}
            >
              {groups.map((team) => (
                <optgroup key={team.id} label={team.name}>
                  {team.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.key} · {project.name}
                      {project.id === projectId ? ' (this project)' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={pipelineSelectId}>Pipeline</Label>
            <select
              id={pipelineSelectId}
              className={selectClass}
              value={sourcePipelineId ?? ''}
              disabled={!pipelines.data}
              onChange={(event) =>
                choose({ projectId: source.projectId, pipelineId: event.target.value || undefined })
              }
            >
              {(pipelines.data ?? []).map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                  {pipeline.id === pipelineId ? ' (this pipeline)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Stages of {pipelineName ? <strong>{pipelineName}</strong> : 'this pipeline'}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setBrowsing(true)}>
            <FolderSearchIcon aria-hidden="true" />
            Browse other pipelines…
          </Button>
        </div>
      )}
      {!home && stages.isError ? (
        <ErrorState
          title="Couldn’t load those stages"
          error={stages.error}
          onRetry={() => void stages.refetch()}
        />
      ) : !home && (stages.isPending || (browsing && pipelines.isPending)) ? (
        <div role="status" aria-label="Loading stages" className="grid gap-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          This pipeline has no stages yet. Browse another one.
        </p>
      ) : (
        <RadioGroup
          value={sourceId ?? ''}
          onValueChange={(id) => onSourceChange(id)}
          aria-label="Stage to copy the settings of"
          className="gap-0 overflow-hidden rounded-md border"
        >
          {shown.map((status) => {
            const id = `copy-source-${status.id}`;
            return (
              <label
                key={status.id}
                htmlFor={id}
                className="flex cursor-pointer items-start gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-accent/50 has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem id={id} value={status.id} className="mt-1" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <StatusIcon status={status} />
                    {status.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {stageSummary(status.rules)}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      )}
      <p className="text-xs text-muted-foreground">
        Stages the rules name (next stage, send back to, hand-off) are matched to this pipeline’s by
        name, and people and roles to this team’s. Anything without a match is left out, and you’ll
        see what was.
      </p>
    </div>
  );
}
