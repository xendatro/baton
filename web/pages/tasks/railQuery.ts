import { useInfiniteQuery } from '@tanstack/react-query';
import type { Status } from '@shared/schemas/projects';
import { taskListResponseSchema, type TaskCard } from '@shared/schemas/tasks';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

const enc = encodeURIComponent;

/** Rows per page of the rail. */
export const RAIL_PAGE_SIZE = 50;

/** The project's unfinished tasks by latest activity, with their newest reply (BAT-44). */
export function useTaskRail(projectId: string, q: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.tasks.list(projectId, { view: 'rail', q }),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/projects/${enc(projectId)}/tasks`, {
        query: {
          sort: 'lastActivityAt',
          order: 'desc',
          completed: 'no',
          latestReply: 'true',
          q: q || undefined,
          limit: RAIL_PAGE_SIZE,
          cursor: pageParam,
        },
        schema: taskListResponseSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
}

/**
 * The stage "Mark done" moves a task to: the last stage of its pipeline that counts as finished
 * (doesn't block dependents), else the pipeline's last stage. Null when the task's stage is
 * unknown.
 */
export function finishingStage(statuses: readonly Status[], task: TaskCard): Status | null {
  const current = statuses.find((status) => status.id === task.status.id);
  const pipelineId = current?.pipelineId ?? task.status.pipeline?.id;
  if (!current && !pipelineId) return null;
  const own = statuses
    .filter((status) => !pipelineId || !status.pipelineId || status.pipelineId === pipelineId)
    .sort((a, b) => a.position - b.position);
  const finished = own.filter((status) => status.rules?.blocksDependents === false);
  return finished.at(-1) ?? own.at(-1) ?? null;
}
