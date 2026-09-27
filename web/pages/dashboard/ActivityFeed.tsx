import { BotIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import type { ActivityEntry, MeTeam } from '@shared/schemas/core';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { ActorAvatar } from '@web/components/common/AgentAvatar';
import { UserName } from '@web/components/common/UserName';
import { LogoMark } from '@web/components/layout/Logo';
import { describeActivity, hugsPrevious, type ActivityPart } from '@web/lib/activityText';
import { cn } from '@web/lib/utils';

function Part({ part, url }: { part: ActivityPart; url: string | null }) {
  const className = cn(
    part.emphasis && 'font-medium text-foreground',
    part.code && 'font-mono text-[0.8125rem] text-foreground',
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

/** Where an entry happened: "Acme · Web app". */
function contextOf(entry: ActivityEntry, teams: readonly MeTeam[]): string | null {
  const team = teams.find((candidate) => candidate.id === entry.teamId);
  if (!team) return null;
  const project = entry.projectId
    ? team.projects.find((candidate) => candidate.id === entry.projectId)
    : undefined;
  return project && entry.entityType !== 'project' ? `${team.name} · ${project.name}` : team.name;
}

/** Entries shown before "Show more". */
const COLLAPSED_COUNT = 10;

export interface ActivityFeedProps {
  entries: readonly ActivityEntry[];
  teams: readonly MeTeam[];
}

/**
 * Recent activity across the viewer's teams, worded like the audit log ("moved WEB-12 from Open
 * to Done") with a link to each entity and its team and project.
 */
export function ActivityFeed({ entries, teams }: ActivityFeedProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);
  const hidden = entries.length - shown.length;
  return (
    <>
      <ol className="divide-y" aria-label="Recent activity">
        {shown.map((entry) => {
          const { user, via, source } = entry.actor;
          const parts = describeActivity(entry, { subject: 'entity' });
          const context = contextOf(entry, teams);
          return (
            <li key={entry.id} className="flex gap-2.5 px-3 py-2.5 sm:px-4">
              <span className="pt-0.5">
                {user || source !== 'system' ? (
                  <ActorAvatar user={user} agentName={via?.agentName} size="md" />
                ) : (
                  <LogoMark className="size-6 rounded-full" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-5 break-words text-muted-foreground">
                  {/* An agent's action reads "Claude via Ethan's MSI" (BAT-10). */}
                  <UserName
                    user={user}
                    via={via?.agentName ? via : null}
                    source={source}
                    hovercard={false}
                    className="align-bottom"
                  />
                  {via && !via.agentName ? (
                    <span className="ml-1 inline-flex items-center gap-0.5 align-bottom text-xs">
                      <BotIcon className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">via </span>
                      {via.keyName}
                    </span>
                  ) : null}
                  {parts.map((part, index) => (
                    <Fragment key={index}>
                      {hugsPrevious(part) ? '' : ' '}
                      <Part part={part} url={entry.url} />
                    </Fragment>
                  ))}
                </p>
                <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  {context ? <span className="truncate">{context}</span> : null}
                  {context ? <span aria-hidden="true">·</span> : null}
                  <RelativeTime value={entry.createdAt} className="shrink-0" />
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full border-t px-4 py-2 text-center text-xs text-muted-foreground outline-none hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40 focus-visible:text-foreground"
        >
          Show {hidden} more
        </button>
      ) : null}
    </>
  );
}
