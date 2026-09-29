import {
  CheckIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  HARNESS_LABELS,
  type ClearedReason,
  type HarnessId,
  type JobRun,
} from '@shared/schemas/agentRunner';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';
import { useDecideWaitingJob, useJobOutput, type WaitingJob } from './automaticAgentsQueries';

/**
 * The jobs that wait on their owner (BAT#22), in three groups, in Settings → Automatic agents and
 * on the desktop app's Running agents page:
 * - **Needs your OK**: from people outside "Whose jobs run". Approve runs it; Decline drops it.
 * - **Stopped runs**: your agent's own runs that failed or that you killed, with why (the error,
 *   killed by you, out of usage) and the output's tail. Retry runs it again; Trash drops it.
 * - **Cleared — task finished** (BAT#29): either kind whose task or issue finished meanwhile,
 *   muted with only Open, for a day.
 *
 * On the desktop app, `notes` carries why a job stopped on this computer (shown when Baton has
 * no error for it, e.g. from an older server) and `beforeRetry` the app's Retry now, which makes
 * the next attempt ignore the usage limits stored there (BAT#30).
 */
export function WaitingJobGroups({
  jobs,
  ...options
}: { jobs: readonly WaitingJob[] } & RowOptions) {
  const needsOk = jobs.filter((job) => job.group === 'needs_ok');
  const stopped = jobs.filter((job) => job.group === 'stopped');
  const cleared = jobs.filter((job) => job.group === 'cleared');
  return (
    <div className="grid gap-4">
      {needsOk.length > 0 ? (
        <Group
          title="Needs your OK"
          description="From people outside “Whose jobs run”. They only run when you approve them."
          jobs={needsOk}
          options={options}
        />
      ) : null}
      {stopped.length > 0 ? (
        <Group
          title="Stopped runs"
          description="Your agent’s runs that failed or that you stopped. They wait until you retry them."
          jobs={stopped}
          options={options}
        />
      ) : null}
      {cleared.length > 0 ? (
        <Group
          title="Cleared — task finished"
          description="Their task or issue was finished meanwhile, so nothing is left to do. They go away after a day."
          jobs={cleared}
          options={options}
          muted
        />
      ) : null}
    </div>
  );
}

interface RowOptions {
  /** Job id → why it stopped, as the desktop app that ran it knows. */
  notes?: Readonly<Record<string, string>>;
  /** Runs before Retry approves the job (the desktop app's Retry now). */
  beforeRetry?: (jobId: string) => Promise<void> | void;
}

function Group({
  title,
  description,
  jobs,
  options,
  muted = false,
}: {
  title: string;
  description: string;
  jobs: readonly WaitingJob[];
  options: RowOptions;
  muted?: boolean;
}) {
  return (
    <section aria-label={title} className={cn(muted && 'text-muted-foreground')}>
      <h3 className="text-sm font-medium">
        {title} ({jobs.length})
      </h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      <ul className="divide-y">
        {jobs.map((job) => (
          <JobRow key={job.jobId} job={job} options={options} />
        ))}
      </ul>
    </section>
  );
}

const CLEARED_TEXT: Record<ClearedReason, string> = {
  finished: 'Cleared: the task was finished',
  deleted: 'Cleared: it was deleted',
  resolved: 'Cleared: the issue was resolved',
  moved: 'Cleared: the task moved on from that stage',
  unassigned: 'Cleared: your agent isn’t assigned any more',
};

/** Why a stopped run stopped, in words. */
function runReason(run: JobRun | null): string {
  if (!run) return 'Stopped before it ran';
  switch (run.outcome) {
    case 'failed':
      return run.error ? `Failed: ${run.error}` : 'Failed (the harness gave no error)';
    case 'killed':
      return 'Killed by you';
    case 'out_of_usage':
      return run.error ? `Out of usage: ${run.error}` : 'Out of usage';
    case 'permission_denied':
      return 'Stopped: a permission was denied';
    case 'no_harness':
      return run.error ?? 'None of its harnesses is installed on that computer';
    case 'no_folder':
      return run.error ?? 'Its project has no folder on that computer';
    case 'error':
      return run.error ? `The desktop app failed: ${run.error}` : 'The desktop app failed';
    default:
      return run.error ?? 'Stopped';
  }
}

function harnessText(run: JobRun): string | null {
  if (!run.harness) return null;
  const label = HARNESS_LABELS[run.harness as HarnessId] ?? run.harness;
  return run.model ? `${label} · ${run.model}` : label;
}

function JobRow({ job, options }: { job: WaitingJob; options: RowOptions }) {
  const decide = useDecideWaitingJob();
  const [showOutput, setShowOutput] = useState(false);
  const ref = job.target.ref ?? 'job';
  const act = async (decision: 'approve' | 'dismiss', done: string) => {
    if (decision === 'approve' && job.group === 'stopped' && options.beforeRetry) {
      await Promise.resolve(options.beforeRetry(job.jobId)).catch(() => undefined);
    }
    decide.mutate(
      { jobId: job.jobId, decision },
      {
        onSuccess: () => toast.success(done),
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  };
  // Baton's record of the run, else what the desktop app that ran it noted (one reason, not two).
  const localNote = options.notes?.[job.jobId];
  const reason =
    localNote && (!job.run || (!job.run.error && job.run.outcome !== 'killed'))
      ? localNote
      : runReason(job.run);
  const failed = job.group === 'stopped' && job.run?.outcome !== 'killed';
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {job.target.url ? (
            <a href={job.target.url} className="hover:underline">
              {job.target.ref} {job.target.title}
            </a>
          ) : (
            `${job.target.ref ?? ''} ${job.target.title ?? ''}`
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {job.kind.replace('_', ' ')} by @{job.triggeredBy ?? 'someone'} ·{' '}
          <RelativeTime value={job.createdAt} />
          {job.run && harnessText(job.run) ? ` · ${harnessText(job.run)}` : ''}
          {job.group === 'needs_ok' && job.trigger ? ` · “${job.trigger.body.slice(0, 80)}”` : ''}
        </p>
        {job.group === 'stopped' ? (
          <p
            className={cn(
              'text-xs break-words',
              failed ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {reason}
            {job.run ? (
              <>
                {' · '}
                <RelativeTime value={job.run.endedAt} />
              </>
            ) : null}
          </p>
        ) : null}
        {job.group === 'cleared' && job.clearedReason ? (
          <p className="text-xs">
            {CLEARED_TEXT[job.clearedReason]}
            {job.clearedAt ? (
              <>
                {' · '}
                <RelativeTime value={job.clearedAt} />
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      {job.group === 'needs_ok' ? (
        <>
          <Button
            size="sm"
            onClick={() => void act('approve', 'Approved: your agent will run it')}
            disabled={decide.isPending}
            aria-label={`Approve ${ref}`}
          >
            <CheckIcon aria-hidden="true" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act('dismiss', 'Declined')}
            disabled={decide.isPending}
            aria-label={`Decline ${ref}`}
          >
            <XIcon aria-hidden="true" />
            Decline
          </Button>
        </>
      ) : null}
      {job.group === 'stopped' ? (
        <>
          {job.run?.hasOutput ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowOutput(true)}
              aria-label={`Show output of ${ref}`}
            >
              <ScrollTextIcon aria-hidden="true" />
              Show output
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => void act('approve', 'Your agent will run it again')}
            disabled={decide.isPending}
            aria-label={`Retry ${ref}`}
          >
            <RotateCcwIcon aria-hidden="true" />
            Retry
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act('dismiss', 'Trashed')}
            disabled={decide.isPending}
            aria-label={`Trash ${ref}`}
          >
            <Trash2Icon aria-hidden="true" />
            Trash
          </Button>
        </>
      ) : null}
      {job.group === 'cleared' && job.target.url ? (
        <Button asChild size="sm" variant="ghost">
          <a href={job.target.url} aria-label={`Open ${ref}`}>
            <ExternalLinkIcon aria-hidden="true" />
            Open
          </a>
        </Button>
      ) : null}
      {showOutput ? (
        <OutputDialog job={job} open={showOutput} onOpenChange={setShowOutput} />
      ) : null}
    </li>
  );
}

/** The output tail Baton keeps of the job's last run (BAT#23); the full log is on the computer. */
function OutputDialog({
  job,
  open,
  onOpenChange,
}: {
  job: WaitingJob;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const output = useJobOutput(job.jobId, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Output of {job.target.ref ?? 'the job'} {job.target.title ?? ''}
          </DialogTitle>
          <DialogDescription>
            The last lines of its last run. The full log stays on the computer that ran it.
          </DialogDescription>
        </DialogHeader>
        {job.run ? <p className="text-sm text-destructive">{runReason(job.run)}</p> : null}
        {output.isPending ? (
          <Skeleton className="h-64" />
        ) : output.isError ? (
          <p className="text-sm text-destructive">{errorMessage(output.error)}</p>
        ) : (
          <pre
            className="max-h-[60vh] overflow-auto rounded-md bg-zinc-950 p-3 text-xs whitespace-pre-wrap text-zinc-100"
            aria-label="Output"
          >
            {output.data.output || 'No output was kept for this run.'}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
