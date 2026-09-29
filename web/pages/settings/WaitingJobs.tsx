import { PlayIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { useDecideWaitingJob, type WaitingJob } from './automaticAgentsQueries';

/**
 * Jobs waiting for the owner's OK: ones they stopped (Kill, a failed run) and ones from people
 * outside "Whose jobs run". "Run again" queues it for the agent; "Trash" drops it for good.
 * Shown in Settings → Automatic agents and on the desktop app's Running agents page.
 */
export function WaitingJobsList({
  jobs,
  notes = {},
  beforeRunAgain,
  runLabel = 'Run again',
}: {
  jobs: readonly WaitingJob[];
  /** Job id → why it stopped (the desktop app knows for jobs it ran). */
  notes?: Readonly<Record<string, string>>;
  /** Runs before "Run again" approves the job (the desktop app's Retry now, BAT#30). */
  beforeRunAgain?: (jobId: string) => Promise<void> | void;
  runLabel?: string;
}) {
  const decide = useDecideWaitingJob();
  const act = async (jobId: string, decision: 'approve' | 'dismiss') => {
    if (decision === 'approve')
      await Promise.resolve(beforeRunAgain?.(jobId)).catch(() => undefined);
    decide.mutate(
      { jobId, decision },
      {
        onSuccess: () =>
          toast.success(decision === 'approve' ? 'Your agent will run it again' : 'Trashed'),
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  };
  return (
    <ul className="divide-y" aria-label="Jobs waiting for your OK">
      {jobs.map((job) => (
        <li key={job.jobId} className="flex flex-wrap items-center gap-2 py-2">
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
              {job.trigger ? ` · “${job.trigger.body.slice(0, 80)}”` : ''}
            </p>
            {notes[job.jobId] ? (
              <p className="text-xs break-words text-muted-foreground">{notes[job.jobId]}</p>
            ) : null}
          </div>
          <Button
            size="sm"
            onClick={() => void act(job.jobId, 'approve')}
            disabled={decide.isPending}
          >
            <PlayIcon aria-hidden="true" />
            {runLabel}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act(job.jobId, 'dismiss')}
            disabled={decide.isPending}
            aria-label={`Trash ${job.target.ref ?? 'job'}`}
          >
            <Trash2Icon aria-hidden="true" />
            Trash
          </Button>
        </li>
      ))}
    </ul>
  );
}
