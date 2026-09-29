import {
  CircleStopIcon,
  ExternalLinkIcon,
  HandIcon,
  MonitorIcon,
  RotateCwIcon,
  SettingsIcon,
} from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { HARNESS_LABELS } from '@shared/schemas/agentRunner';
import type { DesktopJob, DesktopState } from '@shared/desktopBridge';
import { desktopVersionText } from '@shared/desktopVersion';
import { usePendingRequestCount } from '@web/components/agentRequests/queries';
import { AgentConnectionNotice } from '@web/components/common/AgentConnectionNotice';
import { EmptyState } from '@web/components/common/EmptyState';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { useNow } from '@web/components/common/useNow';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { Skeleton } from '@web/components/ui/skeleton';
import { Switch } from '@web/components/ui/switch';
import { errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { desktopBridge, elapsed, useDesktopState } from '@web/lib/desktop';
import { useDocumentTitle } from '@web/lib/title';
import { useDecideWaitingJob, useWaitingJobs } from '../settings/automaticAgentsQueries';
import { useAgentSettings, useUpdateAgentSettings } from '../settings/queries';
import { WaitingJobGroups } from '../settings/WaitingJobs';
import { DesktopOnly, UsageLimit } from './common';

/**
 * `/desktop`: your agents running on this computer right now (BAT-26): each job with its harness,
 * model, elapsed time and live output, and Kill. Pausing works here for this computer and
 * everywhere (your agent's pause, the same switch as Settings → Agent).
 */
export default function DesktopAgentsPage() {
  useDocumentTitle(['Running agents']);
  return (
    <DesktopOnly>
      <Agents />
    </DesktopOnly>
  );
}

const STATUS_TEXT: Record<string, string> = {
  online: 'Online',
  paused: 'Paused',
  offline: 'Offline',
  connecting: 'Connecting',
  stopped: 'Not running',
};

function Agents() {
  const { state, loading } = useDesktopState();
  if (loading || !state) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-40 rounded-lg" />
      </PageContainer>
    );
  }
  const runner = state.runner;
  return (
    <PageContainer>
      <AppVersion state={state} />
      <PageHeader
        title="Running agents"
        description={
          runner?.statusText ??
          'Your agent’s jobs run here in your own harness. Nothing is spent while nothing runs.'
        }
        actions={
          <>
            <Badge variant={runner?.status === 'online' ? 'default' : 'secondary'}>
              {STATUS_TEXT[runner?.status ?? 'stopped']}
            </Badge>
            <Button asChild variant="outline" size="sm">
              <Link to="/desktop/setup">
                <SettingsIcon aria-hidden="true" />
                Set up this computer
              </Link>
            </Button>
          </>
        }
      />
      {!state.connected ? (
        <EmptyState
          icon={MonitorIcon}
          title="This computer isn’t running your agent yet"
          description="Set it up once: pick folders for your projects and how each harness asks for permission."
          action={
            <Button asChild>
              <Link to="/desktop/setup">Set up this computer</Link>
            </Button>
          }
          className="py-12"
        />
      ) : (
        <div className="grid gap-4">
          <PauseSwitches state={state} />
          <UncoveredProjects state={state} />
          <RequestsHere />
          <WaitingHere state={state} />
          {runner?.jobs.length ? (
            <ul className="grid gap-4" aria-label="Running jobs">
              {runner.jobs.map((job) => (
                <JobCard key={job.jobId} job={job} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={MonitorIcon}
              title="Nothing is running"
              description="Jobs show up here as soon as someone mentions or assigns your agent in a project with a folder on this computer."
              className="py-12"
            />
          )}
        </div>
      )}
    </PageContainer>
  );
}

/**
 * Projects with jobs waiting for your agent that no folder here covers (and no other computer or
 * listener takes): each with Connect now, which picks a folder for it on this computer.
 */
function UncoveredProjects({ state }: { state: DesktopState }) {
  const me = useMe();
  const projectIds = (me.data?.teams ?? [])
    .flatMap((team) => team.projects.map((project) => project.id))
    .filter((projectId) => !state.folders[projectId]);
  if (projectIds.length === 0) return null;
  return (
    <div className="grid gap-2 empty:hidden" aria-label="Projects your agent isn’t connected to">
      {projectIds.map((projectId) => (
        <AgentConnectionNotice
          key={projectId}
          projectId={projectId}
          when={(connection) => connection.pendingJobs > 0 && !connection.paused}
        />
      ))}
    </div>
  );
}

const UPDATE_TEXT: Record<string, string> = {
  checking: 'Checking for updates…',
  available: 'A new version is available',
  downloading: 'Downloading an update…',
  ready: 'An update is ready: restart to install',
};

/** The app's version and "Check for updates" (apps from 0.3.0 on can update themselves). */
function AppVersion({ state }: { state: DesktopState }) {
  const bridge = desktopBridge();
  const update = state.update;
  const canCheck = bridge !== null && 'checkForUpdates' in bridge;
  const { installed, latest } = desktopVersionText(state);
  const statusText =
    update?.status === 'error'
      ? `Couldn’t check for updates: ${update.error ?? ''}`
      : update && update.status !== 'latest'
        ? (UPDATE_TEXT[update.status] ?? '')
        : '';
  return (
    <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{installed}</span>
      {update ? (
        <span aria-live="polite">
          {latest ? `· ${latest}` : null}
          {statusText ? ` · ${statusText}` : null}
        </span>
      ) : null}
      {canCheck ? (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          disabled={update?.status === 'checking' || update?.status === 'downloading'}
          onClick={() =>
            void bridge
              ?.checkForUpdates?.()
              .catch((cause: unknown) => toast.error(errorMessage(cause)))
          }
        >
          Check for updates
        </Button>
      ) : (
        <span>· Reinstall from the Download page to get automatic updates.</span>
      )}
    </p>
  );
}

function PauseSwitches({ state }: { state: DesktopState }) {
  const hereId = useId();
  const everywhereId = useId();
  const settings = useAgentSettings();
  const update = useUpdateAgentSettings();
  const pausedEverywhere = Boolean(settings.data?.pausedAt);
  return (
    <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={hereId}>Pause on this computer</Label>
        <Switch
          id={hereId}
          checked={state.pausedHere}
          onCheckedChange={(paused) =>
            void desktopBridge()
              ?.pauseHere(paused)
              .then(() => toast.success(paused ? 'Paused on this computer' : 'Resumed'))
          }
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={everywhereId}>Pause your agent everywhere</Label>
        <Switch
          id={everywhereId}
          checked={pausedEverywhere}
          disabled={settings.isPending || update.isPending}
          onCheckedChange={(paused) =>
            update.mutate(
              { paused },
              {
                onSuccess: () =>
                  toast.success(paused ? 'Your agent is paused' : 'Your agent is back'),
              },
            )
          }
        />
      </div>
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  blocked: 'Waiting for your OK',
  'waiting-usage': 'Waiting on usage',
  finishing: 'Finishing',
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Jobs waiting on you, right here (BAT#22): others' jobs that need your OK (Approve / Decline),
 * your stopped runs with why they stopped (Retry / Trash), and those cleared because their task
 * finished (BAT#29). A run stopped on this computer that Baton has no error for says why from the
 * app's own note; Retry ignores the usage limits stored here for that attempt (BAT#30).
 */
/** Requests to start your agent wait on their own page: a pointer when some do. */
function RequestsHere() {
  const count = usePendingRequestCount();
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-3">
      <HandIcon className="size-4 text-amber-600" aria-hidden="true" />
      <p className="text-sm">
        {count === 1 ? '1 request waits' : `${count} requests wait`} for your OK before your agent
        runs {count === 1 ? 'it' : 'them'}.
      </p>
      <Button asChild size="sm" variant="outline" className="ml-auto">
        <Link to="/agent/requests">Open requests</Link>
      </Button>
    </div>
  );
}

function WaitingHere({ state }: { state: DesktopState }) {
  const waiting = useWaitingJobs();
  if (!waiting.data?.length) return null;
  const bridge = desktopBridge();
  const notes = Object.fromEntries(
    (state.runner?.finished ?? []).flatMap((item) =>
      item.note ? [[item.jobId, `Stopped here: ${item.note}`] as const] : [],
    ),
  );
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <WaitingJobGroups
        jobs={waiting.data}
        notes={notes}
        {...(bridge?.retryNow ? { beforeRetry: (jobId: string) => bridge.retryNow?.(jobId) } : {})}
      />
    </div>
  );
}

function JobCard({ job }: { job: DesktopJob }) {
  const now = useNow();
  const decide = useDecideWaitingJob();
  // After Kill the job waits under Stopped runs; the toast offers to trash it straight away.
  const kill = () =>
    desktopBridge()
      ?.kill(job.jobId)
      .then(() =>
        toast.success('Stopped. It waits under Stopped runs until you retry it.', {
          action: {
            label: 'Trash it',
            onClick: () =>
              decide.mutate(
                { jobId: job.jobId, decision: 'dismiss' },
                {
                  onSuccess: () => toast.success('Trashed'),
                  onError: (cause) => toast.error(errorMessage(cause)),
                },
              ),
          },
        }),
      )
      .catch((cause: unknown) => toast.error(errorMessage(cause)));
  const retry = () =>
    void desktopBridge()
      ?.retryNow?.(job.jobId)
      .then(() => toast.success('Trying again now'))
      .catch((cause: unknown) => toast.error(errorMessage(cause)));
  return (
    <li
      className="rounded-lg border bg-card p-4"
      aria-label={`${job.ref ?? 'Job'} ${job.title ?? ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {job.url ? (
              <a href={job.url} className="hover:underline">
                {job.ref} {job.title}
              </a>
            ) : (
              `${job.ref ?? ''} ${job.title ?? ''}`
            )}
          </p>
          <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
            <span>{job.kind.replace('_', ' ')}</span>
            <span>
              {job.harness
                ? [HARNESS_LABELS[job.harness], job.model, job.effort].filter(Boolean).join(' · ')
                : 'Starting…'}
            </span>
            <span>{elapsed(job.startedAt, now)}</span>
            <Badge variant={job.state === 'blocked' ? 'destructive' : 'secondary'}>
              {STATE_TEXT[job.state] ?? job.state}
            </Badge>
            {job.delivered ? (
              <Badge variant="outline">{plural(job.delivered, 'message')} delivered</Badge>
            ) : null}
            {job.queued ? (
              <Badge variant="outline">{plural(job.queued, 'message')} queued for next turn</Badge>
            ) : null}
          </p>
        </div>
        <div className="flex gap-2">
          {job.url ? (
            <Button asChild variant="outline" size="sm">
              <a href={job.url}>
                <ExternalLinkIcon aria-hidden="true" />
                Open
              </a>
            </Button>
          ) : null}
          <Button variant="destructive" size="sm" onClick={() => void kill()}>
            <CircleStopIcon aria-hidden="true" />
            Kill
          </Button>
        </div>
      </div>
      {job.state === 'waiting-usage' && job.waitingOn?.length ? (
        <div
          className="mt-3 grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
          aria-label="Waiting on usage"
        >
          {job.waitingOn.map((item) => (
            <UsageLimit key={item.harness} harness={item.harness} until={item.until} />
          ))}
          {desktopBridge()?.retryNow ? (
            <div>
              <Button size="sm" onClick={retry}>
                <RotateCwIcon aria-hidden="true" />
                Retry now
              </Button>
            </div>
          ) : null}
        </div>
      ) : job.note ? (
        <p className="mt-2 text-sm text-muted-foreground">{job.note}</p>
      ) : null}
      <pre
        className="mt-3 max-h-64 overflow-auto rounded-md bg-zinc-950 p-3 text-xs whitespace-pre-wrap text-zinc-100"
        aria-label="Live output"
      >
        {job.output.slice(-120).join('\n') || 'Waiting for output…'}
      </pre>
    </li>
  );
}
