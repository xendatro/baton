import { CopyIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { Principal } from '@shared/principals';
import type { MeTeam } from '@shared/schemas/core';
import type { UnresolvedPrincipal } from '@shared/schemas/pipelines';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { isAgentUser, type PrincipalOptions } from '@web/components/pickers/principals';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Label } from '@web/components/ui/label';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { usePipelines } from '../projects/queries';
import { useCopyPipeline, useCopyPipelinePreview } from './pipelineQueries';

/**
 * "Copy pipeline from…" (design §5): pick another project whose statuses you manage (any of your
 * teams), see which statuses are created or updated, and re-pick (or drop) every person or role
 * the target team doesn't have before copying. Nothing is dropped silently.
 */

const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

export function CopyPipelineDialog({
  open,
  onOpenChange,
  projectId,
  pipelineId,
  teams,
  options,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The pipeline copied into (BAT-25). */
  pipelineId?: string | undefined;
  teams: readonly MeTeam[];
  options: PrincipalOptions;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {open ? (
          <CopyForm
            projectId={projectId}
            pipelineId={pipelineId}
            teams={teams}
            options={options}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Projects of the viewer's teams whose statuses they may manage (this one too: another of its
 * pipelines can be the source, BAT-25).
 */
function sourceProjects(teams: readonly MeTeam[]) {
  return teams
    .map((team) => ({
      team,
      projects: team.projects.filter((project) =>
        (project.permissions ?? team.permissions).includes('MANAGE_STATUSES'),
      ),
    }))
    .filter((group) => group.projects.length > 0);
}

function CopyForm({
  projectId,
  pipelineId,
  teams,
  options,
  onClose,
}: {
  projectId: string;
  pipelineId?: string | undefined;
  teams: readonly MeTeam[];
  options: PrincipalOptions;
  onClose: () => void;
}) {
  const selectId = useId();
  const pipelineSelectId = useId();
  const groups = sourceProjects(teams);
  const [from, setFrom] = useState<string | null>(null);
  const [fromPipeline, setFromPipeline] = useState<string | undefined>(undefined);
  const sourcePipelines = usePipelines(from ?? undefined);
  // The pipelines to copy from: in this project, only the others.
  const choices = (sourcePipelines.data ?? []).filter((pipeline) => pipeline.id !== pipelineId);
  const fromPipelineId =
    fromPipeline ?? (from === projectId ? choices[0]?.id : undefined) ?? undefined;
  const [answers, setAnswers] = useState<Record<string, Principal | null>>({});
  const [error, setError] = useState<string | null>(null);
  const ready = Boolean(from) && (from !== projectId || fromPipelineId !== undefined);
  const preview = useCopyPipelinePreview(projectId, ready ? from : null, {
    fromPipelineId,
    pipelineId,
  });
  const copy = useCopyPipeline(projectId);
  const unresolved = preview.data?.unresolved ?? [];
  const unanswered = unresolved.filter((entry) => !(entry.key in answers));

  const submit = () => {
    if (!from) return;
    setError(null);
    copy.mutate(
      {
        fromProjectId: from,
        replacements: answers,
        ...(fromPipelineId ? { fromPipelineId } : {}),
        ...(pipelineId ? { pipelineId } : {}),
      },
      {
        onSuccess: () => {
          toast.success(`Copied the pipeline of ${preview.data?.source.key ?? 'the project'}`);
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Copy pipeline from…</DialogTitle>
        <DialogDescription>
          Copies another project’s statuses and their rules. Statuses with the same name get its
          rules; the others are added. This project’s other statuses stay after them.
        </DialogDescription>
      </DialogHeader>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You don’t manage the statuses of any other project.
        </p>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={selectId}>Project</Label>
          <select
            id={selectId}
            className={selectClass}
            value={from ?? ''}
            onChange={(event) => {
              setFrom(event.target.value || null);
              setFromPipeline(undefined);
              setAnswers({});
            }}
          >
            <option value="">Choose a project</option>
            {groups.map((group) => (
              <optgroup key={group.team.id} label={group.team.name}>
                {group.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.key} · {project.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}
      {from && (choices.length > 1 || from === projectId) ? (
        <div className="grid gap-1.5">
          <Label htmlFor={pipelineSelectId}>Pipeline</Label>
          {choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">This project has no other pipeline.</p>
          ) : (
            <select
              id={pipelineSelectId}
              className={selectClass}
              value={fromPipelineId ?? ''}
              onChange={(event) => {
                setFromPipeline(event.target.value || undefined);
                setAnswers({});
              }}
            >
              {from === projectId ? null : <option value="">Its default pipeline</option>}
              {choices.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      {ready && preview.isPending ? (
        <div role="status" aria-label="Loading the pipeline" className="grid gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-56" />
        </div>
      ) : null}
      {ready && preview.isError ? (
        <ErrorState
          title="Couldn’t read that pipeline"
          error={preview.error}
          onRetry={() => void preview.refetch()}
        />
      ) : null}
      {preview.data ? (
        <div className="grid gap-3">
          <div>
            <p className="text-sm font-medium">Statuses</p>
            <ul className="mt-1 grid gap-0.5 text-sm">
              {preview.data.statuses.map((status) => (
                <li key={status.name} className="flex items-center gap-2">
                  <span>{status.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {status.action === 'create' ? 'added' : 'rules replaced'}
                    {status.hasRules ? '' : ' (no rules)'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {unresolved.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Not in this team: re-pick or drop</p>
              <ul className="grid gap-3">
                {unresolved.map((entry) => (
                  <Replacement
                    key={entry.key}
                    entry={entry}
                    options={options}
                    value={entry.key in answers ? (answers[entry.key] ?? null) : undefined}
                    onChange={(principal) =>
                      setAnswers((current) => {
                        const next = { ...current };
                        if (principal === undefined) delete next[entry.key];
                        else next[entry.key] = principal;
                        return next;
                      })
                    }
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={copy.isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={!preview.data || unanswered.length > 0 || copy.isPending}
        >
          {copy.isPending ? <Spinner /> : <CopyIcon aria-hidden="true" />}
          Copy pipeline
        </Button>
      </DialogFooter>
    </div>
  );
}

function encode(principal: Principal | null | undefined): string {
  if (principal === undefined) return '';
  if (principal === null) return 'drop';
  switch (principal.type) {
    case 'everyone':
      return 'everyone';
    case 'user':
      return `user:${principal.userId}`;
    case 'role':
      return `role:${principal.roleId}`;
    case 'project_role':
      return `project_role:${principal.roleId}`;
  }
}

function decode(value: string, original: Principal): Principal | null | undefined {
  if (value === '') return undefined;
  if (value === 'drop') return null;
  const scope = 'scope' in original ? original.scope : 'both';
  if (value === 'everyone') return { type: 'everyone', scope };
  const [type, id = ''] = value.split(':');
  if (type === 'user') return { type: 'user', userId: id };
  if (type === 'role') return { type: 'role', roleId: id, scope };
  return { type: 'project_role', roleId: id, scope };
}

function Replacement({
  entry,
  options,
  value,
  onChange,
}: {
  entry: UnresolvedPrincipal;
  options: PrincipalOptions;
  value: Principal | null | undefined;
  onChange: (principal: Principal | null | undefined) => void;
}) {
  const id = useId();
  const people = options.users.filter((user) => !isAgentUser(user));
  const agents = options.users.filter((user) => isAgentUser(user));
  return (
    <li className="grid gap-1">
      <Label htmlFor={id}>
        {entry.label}
        <span className="font-normal text-muted-foreground"> · {entry.usedIn.join('; ')}</span>
      </Label>
      <select
        id={id}
        className={selectClass}
        value={encode(value)}
        onChange={(event) => onChange(decode(event.target.value, entry.principal))}
      >
        <option value="">Choose a replacement</option>
        <option value="drop">Drop it</option>
        <option value="everyone">Everyone in the team</option>
        {options.roles.length ? (
          <optgroup label="Team roles">
            {options.roles.map((role) => (
              <option key={role.id} value={`role:${role.id}`}>
                {role.isEveryone ? '@everyone' : role.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {options.projectRoles.length ? (
          <optgroup label="Project roles">
            {options.projectRoles.map((role) => (
              <option key={role.id} value={`project_role:${role.id}`}>
                {role.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {[
          { label: 'People', users: people },
          { label: 'Agents', users: agents },
        ].map((group) =>
          group.users.length ? (
            <optgroup key={group.label} label={group.label}>
              {group.users.map((user) => (
                <option key={user.id} value={`user:${user.id}`}>
                  {user.name} (@{user.username})
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
    </li>
  );
}
