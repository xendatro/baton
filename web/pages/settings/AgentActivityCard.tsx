import { RadioIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { AgentJobKind, AgentJobStatus } from '@shared/constants';
import type { AgentJobSummary, AgentSession } from '@shared/schemas/agentJobs';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Badge } from '@web/components/ui/badge';
import { Skeleton } from '@web/components/ui/skeleton';
import { cn } from '@web/lib/utils';
import { useAgentActivity } from './queries';
import { SettingsCard } from './SettingsCard';

const KIND_LABELS: Record<AgentJobKind, string> = {
  mention: 'Mention',
  assigned: 'Assigned',
  thread_reply: 'Reply in thread',
  pool: 'Pool hand-off',
  approval: 'Approval',
  action_result: 'Action result',
};

const STATUS_LABELS: Record<AgentJobStatus, string> = {
  pending: 'Waiting',
  claimed: 'Working',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_VARIANTS: Record<AgentJobStatus, 'default' | 'secondary' | 'outline'> = {
  pending: 'default',
  claimed: 'secondary',
  done: 'outline',
  cancelled: 'outline',
};

/**
 * Settings → Agent: what your agent is doing (docs/design/agents-and-pipelines.md §4) — its
 * listener sessions (online while seen in the last 90 s, the projects each listens to) and its
 * latest jobs. Live `agent_job.changed` events keep it current.
 */
export function AgentActivityCard() {
  const activity = useAgentActivity();
  return (
    <SettingsCard
      title="Agent activity"
      description="Your agent works while a listener runs (start_listener through one of your API keys): mentions, assignments and replies in its threads become jobs."
      action={
        activity.data ? (
          <Badge variant={activity.data.online ? 'default' : 'outline'}>
            <span
              aria-hidden="true"
              className={cn(
                'size-2 rounded-full',
                activity.data.online ? 'bg-emerald-400' : 'border border-current',
              )}
            />
            {activity.data.online ? 'Online' : 'Offline'}
          </Badge>
        ) : null
      }
    >
      {activity.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading agent activity">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : activity.isError ? (
        <ErrorState
          title="Couldn’t load your agent’s activity"
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-2">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Listeners
            </h4>
            {activity.data.sessions.length === 0 ? (
              <p className="flex items-start gap-2 rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
                <RadioIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  No listener has run yet. Connect an agent with one of your{' '}
                  <Link
                    to="/settings/api-keys"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    API keys
                  </Link>{' '}
                  and ask it to start a listener for your projects.
                </span>
              </p>
            ) : (
              <ul className="divide-y rounded-md border" aria-label="Listener sessions">
                {activity.data.sessions.map((session) => (
                  <SessionRow key={session.id} session={session} />
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-2">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Recent jobs
              {activity.data.pendingCount > 0 ? ` · ${activity.data.pendingCount} waiting` : ''}
            </h4>
            {activity.data.jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No jobs yet. Mention your agent (@{'<you>'}-ai) or assign it a task to give it one.
              </p>
            ) : (
              <ul className="divide-y rounded-md border" aria-label="Recent jobs">
                {activity.data.jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

function SessionRow({ session }: { session: AgentSession }) {
  const via = [session.agentName, session.keyName ? `${session.keyName} key` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 rounded-full',
            session.online ? 'bg-emerald-500' : 'border border-muted-foreground',
          )}
        />
        {session.online ? 'Online' : 'Offline'}
      </span>
      <span className="text-muted-foreground">{via || 'Deleted key'}</span>
      <span className="min-w-0 flex-1 truncate">
        {session.projects.length > 0
          ? session.projects.map((project) => project.key).join(', ')
          : 'No projects'}
      </span>
      <span className="text-xs text-muted-foreground">
        Last seen <RelativeTime value={session.lastSeenAt} />
      </span>
    </li>
  );
}

function JobRow({ job }: { job: AgentJobSummary }) {
  const label = job.target.ref ? `${job.target.ref} ${job.target.title ?? ''}`.trim() : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <Badge variant={STATUS_VARIANTS[job.status]}>{STATUS_LABELS[job.status]}</Badge>
      <span className="text-muted-foreground">{KIND_LABELS[job.kind]}</span>
      {job.closing ? <span className="text-xs text-muted-foreground">(closing)</span> : null}
      <span className="min-w-0 flex-1 truncate">
        {job.target.url && job.project ? (
          <Link to={job.target.url} className="font-medium underline-offset-4 hover:underline">
            {label}
          </Link>
        ) : (
          (label ?? <span className="text-muted-foreground italic">Deleted item</span>)
        )}
      </span>
      <RelativeTime value={job.createdAt} className="text-xs" />
    </li>
  );
}
