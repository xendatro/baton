import { ArrowRightIcon, CornerUpLeftIcon } from 'lucide-react';
import type { Status } from '@shared/schemas/projects';
import { backStagesOf, nextStageOf, type MoveStage } from '@shared/stageMoves';
import { StatusIcon } from '@web/components/common/StatusBadge';

/**
 * A small arrow diagram of one pipeline's moves (BAT-27): each stage in column order with the only
 * stage it moves on to (green) and the earlier stages it may send tasks back to (amber).
 */

type Stage = Status & MoveStage;

function withMoves(statuses: readonly Status[]): Stage[] {
  return statuses.map((status) => ({
    ...status,
    nextStatusId: status.rules?.nextStatusId ?? null,
    sendBackTo: status.rules?.sendBackTo ?? [],
  }));
}

export function PipelineDiagram({ statuses }: { statuses: readonly Status[] }) {
  const stages = withMoves(statuses);
  if (stages.length < 2) return null;
  return (
    <section
      aria-labelledby="pipeline-diagram-heading"
      className="mt-4"
      data-testid="pipeline-diagram"
    >
      <h3 id="pipeline-diagram-heading" className="mb-2 text-sm font-medium">
        How tasks move
      </h3>
      <ol className="flex flex-wrap items-start gap-x-1 gap-y-3">
        {stages.map((stage, index) => {
          const next = nextStageOf(stages, stage);
          const back = backStagesOf(stages, stage);
          const following = stages[index + 1];
          const jumps = next && next.id !== following?.id;
          return (
            <li key={stage.id} className="flex items-start gap-1">
              <div className="grid min-w-24 gap-1 rounded-md border bg-card px-2 py-1.5 text-xs">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <StatusIcon status={stage} />
                  {stage.name}
                </span>
                {jumps ? (
                  <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <ArrowRightIcon className="size-3" aria-hidden="true" />
                    <span>
                      <span className="sr-only">Moves on to </span>
                      {next.name}
                    </span>
                  </span>
                ) : null}
                {back.length > 0 ? (
                  <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                    <CornerUpLeftIcon className="size-3" aria-hidden="true" />
                    <span>
                      <span className="sr-only">Can be sent back to </span>
                      {back.map((item) => item.name).join(', ')}
                    </span>
                  </span>
                ) : null}
                {!next ? <span className="text-muted-foreground">Last stage</span> : null}
              </div>
              {following ? (
                <ArrowRightIcon
                  className={
                    next?.id === following.id
                      ? 'mt-2 size-4 text-emerald-600 dark:text-emerald-400'
                      : 'mt-2 size-4 text-muted-foreground/40'
                  }
                  aria-label={
                    next?.id === following.id ? `moves on to ${following.name}` : undefined
                  }
                  aria-hidden={next?.id === following.id ? undefined : true}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
