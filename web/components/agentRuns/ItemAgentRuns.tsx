import { BotIcon } from 'lucide-react';
import type { ItemAgentRun } from '@shared/schemas/agentRunner';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { ranWithText, useItemAgentRuns } from '@web/lib/agentModels';
import { cn } from '@web/lib/utils';

/**
 * "Agent runs" on a task: the agent jobs about it that ran or are running, newest first, each with
 * the model it actually ran with (harness · model · effort, as the desktop app reported it).
 * Renders nothing when no agent has run on it.
 */

const KIND_TEXT: Record<string, string> = {
  mention: 'mention',
  thread_reply: 'reply',
  assigned: 'assignment',
  pool: 'stage pool',
  approval: 'review',
  action_result: 'follow-up',
  catch_up: 'catch-up',
};

function statusText(run: ItemAgentRun): string {
  if (run.status === 'claimed') return 'running';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.outcome && run.outcome !== 'done') return run.outcome.replace(/_/g, ' ');
  return run.status === 'released' ? 'released' : 'done';
}

export function ItemAgentRuns({
  item,
  className,
}: {
  item: { type: 'task' | 'issue'; id: string };
  className?: string;
}) {
  const runs = useItemAgentRuns(item);
  if (!runs.data || runs.data.length === 0) return null;
  return (
    <section className={cn('grid gap-2', className)} aria-labelledby={`agent-runs-${item.id}`}>
      <h3 id={`agent-runs-${item.id}`} className="text-sm font-medium">
        Agent runs
      </h3>
      <ul className="grid gap-2" data-testid="agent-runs">
        {runs.data.map((run) => (
          <li key={run.jobId} className="grid gap-0.5 text-xs">
            <p className="flex flex-wrap items-center gap-1">
              <BotIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium">{run.agent.name}</span>
              <span className="text-muted-foreground">
                · {KIND_TEXT[run.kind] ?? run.kind}
                {run.stage ? ` in ${run.stage}` : ''} · {statusText(run)}
              </span>
            </p>
            <p className="text-muted-foreground">
              {run.ranWith ? (
                <>
                  Ran with <span className="text-foreground">{ranWithText(run.ranWith)}</span>
                </>
              ) : run.status === 'claimed' ? (
                'Running (model not reported yet)'
              ) : (
                'Model not reported'
              )}
              {(run.endedAt ?? run.startedAt) ? (
                <>
                  {' · '}
                  <RelativeTime value={(run.endedAt ?? run.startedAt) as string} />
                </>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
