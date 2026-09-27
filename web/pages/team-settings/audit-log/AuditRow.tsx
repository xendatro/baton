import { format } from 'date-fns';
import { BotIcon, ChevronRightIcon } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { Link } from 'react-router';
import type { ActivityEntry } from '@shared/schemas/core';
import { ActorAvatar } from '@web/components/common/AgentAvatar';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { UserName } from '@web/components/common/UserName';
import { LogoMark } from '@web/components/layout/Logo';
import { Badge } from '@web/components/ui/badge';
import {
  describeActivity,
  diffRows,
  hugsPrevious,
  type ActivityPart,
  type DiffRow,
} from '@web/lib/activityText';
import { isAgentUser } from '@web/lib/agentMembers';
import { formatDateTime } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { useIsFresh } from './freshRows';

const SOURCE_LABELS = { web: 'Web', mcp: 'MCP', api: 'API', system: 'System' } as const;

function Part({ part, url }: { part: ActivityPart; url: string | null }) {
  const className = cn(
    part.emphasis && 'font-medium text-foreground',
    part.code && 'font-mono text-[0.8125rem] whitespace-nowrap text-foreground',
    part.tone === 'added' && 'text-emerald-700 dark:text-emerald-400',
    part.tone === 'removed' && 'text-red-700 dark:text-red-400',
  );
  if (part.entity && url) {
    return (
      <Link
        to={url}
        className={cn(
          className,
          'font-medium text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        )}
      >
        {part.text}
      </Link>
    );
  }
  return className ? <span className={className}>{part.text}</span> : <>{part.text}</>;
}

function DiffValue({ value, kind }: { value: string; kind: 'value' | 'text' }) {
  if (value === 'none') return <span className="text-muted-foreground italic">none</span>;
  return (
    <span
      className={cn(
        'break-words text-foreground',
        kind === 'text' &&
          'block max-h-40 overflow-auto rounded bg-muted/60 p-2 text-xs whitespace-pre-wrap',
      )}
    >
      {value}
    </span>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  return (
    <div className="grid gap-1 py-1.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{row.label}</dt>
      <dd className="min-w-0 text-sm">
        {row.kind === 'list' ? (
          <span className="flex flex-wrap gap-1.5">
            {row.added.map((item) => (
              <Badge
                key={`+${item}`}
                variant="outline"
                className="border-emerald-600/30 bg-emerald-600/10 font-normal text-emerald-800 dark:text-emerald-300"
              >
                <span aria-hidden="true">+</span>
                <span className="sr-only">added </span>
                {item}
              </Badge>
            ))}
            {row.removed.map((item) => (
              <Badge
                key={`-${item}`}
                variant="outline"
                className="border-red-600/30 bg-red-600/10 font-normal text-red-800 line-through decoration-red-600/50 dark:text-red-300"
              >
                <span aria-hidden="true">−</span>
                <span className="sr-only">removed </span>
                {item}
              </Badge>
            ))}
            {row.added.length === 0 && row.removed.length === 0 ? (
              <span className="text-muted-foreground italic">no change</span>
            ) : null}
          </span>
        ) : (
          <span
            className={cn(
              'flex min-w-0 gap-2',
              row.kind === 'text' ? 'flex-col' : 'flex-wrap items-baseline',
            )}
          >
            <span
              className={cn(row.kind === 'value' && 'line-through decoration-muted-foreground/60')}
            >
              <DiffValue value={row.from} kind={row.kind} />
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              {row.kind === 'text' ? '↓' : '→'}
            </span>
            <span className="sr-only">changed to</span>
            <DiffValue value={row.to} kind={row.kind} />
          </span>
        )}
      </dd>
    </div>
  );
}

export interface AuditRowProps {
  entry: ActivityEntry;
  /** Name of the entry's project, shown for rows about something inside a project. */
  projectName?: string | null;
}

/**
 * One audit entry: time, actor ("Claude via Ethan's <key>", or "ethan" + "via <key>"), the sentence with a link to the entity, and an
 * expandable panel with the field diff and the raw action, source and time.
 */
export function AuditRow({ entry, projectName }: AuditRowProps) {
  const fresh = useIsFresh(entry.id);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const parts = describeActivity(entry, { subject: 'entity' });
  const diff = diffRows(entry);
  const { user, via, source } = entry.actor;

  return (
    <li
      className={cn(
        'group/row transition-colors',
        fresh && 'animate-in bg-primary/5 duration-500 fade-in slide-in-from-top-1',
      )}
      data-testid="audit-row"
    >
      <div className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <time
          dateTime={entry.createdAt}
          title={formatDateTime(entry.createdAt)}
          className="hidden w-16 shrink-0 text-xs leading-6 text-muted-foreground tabular-nums sm:block"
        >
          {format(new Date(entry.createdAt), 'p')}
        </time>
        <span className="pt-px">
          {user ? (
            <ActorAvatar user={user} agentName={via?.agentName} keyName={via?.keyName} size="md" />
          ) : source === 'system' ? (
            <LogoMark className="size-6 rounded-full" />
          ) : (
            <UserAvatar user={null} size="md" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-6 text-muted-foreground">
            {/* An agent's action reads "Claude via Ethan's MSI" (BAT-10). */}
            <UserName
              user={user}
              via={via?.agentName || isAgentUser(user) ? via : null}
              source={source}
              className="mr-1 align-bottom"
            />
            {via && !via.agentName && !isAgentUser(user) ? (
              <Badge
                variant="outline"
                className="mr-1 max-w-48 align-[1px] font-normal text-muted-foreground"
                title={`Done by an agent using the API key “${via.keyName}”`}
              >
                <BotIcon aria-hidden="true" />
                <span className="truncate">via {via.keyName}</span>
              </Badge>
            ) : null}
            {parts.map((part, index) => (
              <Fragment key={index}>
                {index === 0 || hugsPrevious(part) ? '' : ' '}
                <Part part={part} url={entry.url} />
              </Fragment>
            ))}
            {projectName && entry.entityType !== 'project' ? (
              <span className="ml-1.5 text-xs whitespace-nowrap text-muted-foreground">
                · in {projectName}
              </span>
            ) : null}
          </p>
          <time
            dateTime={entry.createdAt}
            className="text-xs text-muted-foreground tabular-nums sm:hidden"
          >
            {format(new Date(entry.createdAt), 'p')}
          </time>
          {open ? (
            <div id={panelId} className="mt-2 rounded-md border bg-muted/30 px-3 py-2">
              {diff.length > 0 ? (
                <dl className="divide-y">
                  {diff.map((row) => (
                    <DiffLine key={row.field} row={row} />
                  ))}
                </dl>
              ) : null}
              <p
                className={cn(
                  'flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground',
                  diff.length > 0 && 'mt-2 border-t pt-2',
                )}
              >
                <code className="font-mono text-foreground">{entry.action}</code>
                <span>{SOURCE_LABELS[source]}</span>
                <span>{formatDateTime(entry.createdAt)}</span>
                <span className="font-mono">
                  {entry.entityType} {entry.entityId}
                </span>
              </p>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={
            open ? 'Hide details' : diff.length ? `Show changes (${diff.length})` : 'Show details'
          }
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {diff.length > 0 ? <span className="tabular-nums">{diff.length}</span> : null}
          <ChevronRightIcon
            aria-hidden="true"
            className={cn('size-4 transition-transform', open && 'rotate-90')}
          />
        </button>
      </div>
    </li>
  );
}
