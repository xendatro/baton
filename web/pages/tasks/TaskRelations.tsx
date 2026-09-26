import { useQuery } from '@tanstack/react-query';
import { CircleDotIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ISSUE_LINK_KINDS, type IssueLinkKind } from '@shared/constants';
import { searchResponseSchema } from '@shared/schemas/core';
import type { LinkedIssue, RelatedTask, Task } from '@shared/schemas/tasks';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { Button } from '@web/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@web/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { api } from '@web/lib/api';
import { useTeamAccess } from '@web/lib/permissions';
import { queryKeys } from '@web/lib/queryKeys';
import { useDebouncedValue } from '@web/lib/useDebouncedValue';
import { cn } from '@web/lib/utils';
import { IssueStateIcon } from '@web/pages/issues/IssueState';
import { useTaskSearch } from './queries';

/**
 * The task page's links (SPEC §1.8): "Blocked by" and "Blocking" (tasks of the project; a task is
 * blocked while any blocker is open) and the issues it addresses (`fixes` resolves the issue when
 * the task is done, `relates` doesn't). A `fixes` link needs the right to resolve the issue (its
 * author or RESOLVE_ISSUES), so new links are `relates` for members without RESOLVE_ISSUES.
 */

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = `relation-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="grid grid-cols-1 gap-1">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 id={id} className="text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function RelatedTaskRow({
  task,
  onRemove,
  removeLabel,
}: {
  task: RelatedTask;
  onRemove?: () => void;
  removeLabel: string;
}) {
  return (
    <li className="group flex min-w-0 items-center gap-2 rounded-md py-0.5 text-sm">
      <StatusIcon status={task.status} />
      <Link to={task.path} className="flex min-w-0 items-center gap-1.5 hover:underline">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.ref}</span>
        <span
          className={cn('truncate', task.status.category === 'done' && 'text-muted-foreground')}
        >
          {task.title}
        </span>
      </Link>
      <span className="sr-only">({task.status.name})</span>
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 shrink-0 text-muted-foreground opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
          onClick={onRemove}
          aria-label={removeLabel}
        >
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}

/** Searchable list of the project's tasks, for adding a blocker. */
function TaskPicker({
  projectId,
  exclude,
  onPick,
  label,
}: {
  projectId: string;
  exclude: ReadonlySet<string>;
  onPick: (taskId: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q, 200);
  const results = useTaskSearch(projectId, debounced.trim(), open);
  const items = (results.data ?? []).filter((task) => !exclude.has(task.id));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQ('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={label}
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        align="end"
        collisionPadding={16}
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder="Search tasks by title or KEY-12…"
            aria-label="Search tasks"
          />
          <CommandList>
            <CommandEmpty>{results.isFetching ? 'Searching…' : 'No tasks found.'}</CommandEmpty>
            {items.length ? (
              <CommandGroup>
                {items.map((task) => (
                  <CommandItem
                    key={task.id}
                    value={task.id}
                    onSelect={() => {
                      onPick(task.id);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    <StatusIcon status={task.status} />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {task.ref}
                    </span>
                    <span className="truncate">{task.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Searchable issues of the project (full-text search), for linking. */
function IssuePicker({
  teamId,
  projectId,
  exclude,
  onPick,
}: {
  teamId: string;
  projectId: string;
  exclude: ReadonlySet<string>;
  onPick: (issueId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q.trim(), 200);
  const results = useQuery({
    queryKey: queryKeys.search({ q: debounced, projectId, types: 'issue' }),
    queryFn: ({ signal }) =>
      api.get('/api/search', {
        query: { q: debounced, teamId, projectId, types: 'issue', limit: 20 },
        schema: searchResponseSchema,
        signal,
      }),
    enabled: open && debounced.length > 0,
    select: (data) => data.results.filter((result) => !exclude.has(result.entityId)),
  });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQ('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Link an issue"
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        align="end"
        collisionPadding={16}
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder="Search issues…"
            aria-label="Search issues"
          />
          <CommandList>
            <CommandEmpty>
              {debounced.length === 0
                ? 'Type to search the project’s issues.'
                : results.isFetching
                  ? 'Searching…'
                  : 'No issues found.'}
            </CommandEmpty>
            {results.data?.length ? (
              <CommandGroup>
                {results.data.map((result) => (
                  <CommandItem
                    key={result.entityId}
                    value={result.entityId}
                    onSelect={() => {
                      onPick(result.entityId);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    <CircleDotIcon className="text-muted-foreground" aria-hidden="true" />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {result.ref}
                    </span>
                    <span className="truncate">{result.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const KIND_LABELS: Record<IssueLinkKind, string> = { fixes: 'Fixes', relates: 'Relates to' };

function IssueRow({
  issue,
  editable,
  onKind,
  onRemove,
}: {
  issue: LinkedIssue;
  editable: boolean;
  onKind: (kind: IssueLinkKind) => void;
  onRemove: () => void;
}) {
  return (
    <li className="group grid gap-1 py-1 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        {/* The issues module's markers: shape and label, not just color, tell the states apart. */}
        <IssueStateIcon resolved={issue.resolved} className="size-3.5" />
        <Link to={issue.path} className="flex min-w-0 items-center gap-1.5 hover:underline">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.ref}</span>
          <span className={cn('truncate', issue.resolved && 'text-muted-foreground')}>
            {issue.title}
          </span>
        </Link>
        {editable ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6 shrink-0 text-muted-foreground opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
            onClick={onRemove}
            aria-label={`Unlink ${issue.ref}`}
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="pl-5.5">
        {editable ? (
          <Select value={issue.kind} onValueChange={(value) => onKind(value as IssueLinkKind)}>
            <SelectTrigger
              size="sm"
              className="h-6 px-2 text-xs"
              aria-label={`Link kind of ${issue.ref}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ISSUE_LINK_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">{KIND_LABELS[issue.kind]}</span>
        )}
      </div>
    </li>
  );
}

export interface TaskRelationsProps {
  task: Task;
  editable: boolean;
  onChange: (input: {
    blockedBy?: { add?: string[]; remove?: string[] };
    issueLinks?: { add?: Array<{ issueId: string; kind: IssueLinkKind }>; remove?: string[] };
  }) => void;
}

export function TaskRelations({ task, editable, onChange }: TaskRelationsProps) {
  const blockerIds = new Set([task.id, ...task.blockedBy.map((item) => item.id)]);
  const issueIds = new Set(task.issues.map((issue) => issue.id));
  const newLinkKind: IssueLinkKind = useTeamAccess(task.teamId).has('RESOLVE_ISSUES')
    ? 'fixes'
    : 'relates';
  return (
    <div className="grid grid-cols-1 gap-4">
      <Section
        title="Blocked by"
        action={
          editable ? (
            <TaskPicker
              projectId={task.projectId}
              exclude={blockerIds}
              label="Add a blocker"
              onPick={(id) => onChange({ blockedBy: { add: [id] } })}
            />
          ) : undefined
        }
      >
        {task.blockedBy.length ? (
          <ul>
            {task.blockedBy.map((blocker) => (
              <RelatedTaskRow
                key={blocker.id}
                task={blocker}
                removeLabel={`Remove blocker ${blocker.ref}`}
                onRemove={
                  editable ? () => onChange({ blockedBy: { remove: [blocker.id] } }) : undefined
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Not blocked</p>
        )}
      </Section>
      {task.blocking.length ? (
        <Section title="Blocking">
          <ul>
            {task.blocking.map((blocked) => (
              <RelatedTaskRow key={blocked.id} task={blocked} removeLabel="" />
            ))}
          </ul>
        </Section>
      ) : null}
      <Section
        title="Linked issues"
        action={
          editable ? (
            <IssuePicker
              teamId={task.teamId}
              projectId={task.projectId}
              exclude={issueIds}
              onPick={(issueId) =>
                onChange({ issueLinks: { add: [{ issueId, kind: newLinkKind }] } })
              }
            />
          ) : undefined
        }
      >
        {task.issues.length ? (
          <ul>
            {task.issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                editable={editable}
                onKind={(kind) => onChange({ issueLinks: { add: [{ issueId: issue.id, kind }] } })}
                onRemove={() => onChange({ issueLinks: { remove: [issue.id] } })}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </Section>
    </div>
  );
}
