import type { StageRules } from '@shared/schemas/pipelines';
import type { Pipeline } from '@shared/schemas/projects';

/**
 * BAT-34: "New tasks can start here" (the stage rule `allowCreate`). Only such stages get the +
 * on their board column and appear in the New task form's status picker.
 */

type StageLike = { rules?: StageRules | undefined; isDefault?: boolean };

/** Can new tasks start in this status? (Without rules: only the default one.) */
export function acceptsNewTasks(status: StageLike): boolean {
  return status.rules?.allowCreate ?? status.isDefault === true;
}

/**
 * The pipelines (by id) none of whose stages accept new tasks, among `statuses` (each pipeline
 * with at least one stage listed).
 */
export function pipelinesWithoutStart(
  statuses: ReadonlyArray<StageLike & { pipelineId?: string | undefined }>,
): string[] {
  const starts = new Map<string, boolean>();
  for (const status of statuses) {
    const id = status.pipelineId ?? '';
    starts.set(id, (starts.get(id) ?? false) || acceptsNewTasks(status));
  }
  return [...starts].filter(([, ok]) => !ok).map(([id]) => id);
}

/**
 * The pipelines shown whose stages all refuse new tasks (among those the viewer may add tasks
 * to), and whether the New task button's pipeline (the selected one, else the default) is one.
 * With `allStatuses` (every stage of the project), also the shown pipelines with no stages at all
 * (`stageless`, any viewer), which block the New task button too.
 */
export function blockedPipelines(
  statuses: ReadonlyArray<StageLike & { pipelineId?: string | undefined }>,
  pipelines: readonly Pipeline[],
  selectedId: string | undefined,
  allStatuses?: ReadonlyArray<{ pipelineId?: string | undefined }>,
): { blocked: Pipeline[]; createBlocked: boolean; stageless: Pipeline[] } {
  const ids = new Set(pipelinesWithoutStart(statuses));
  const blocked = pipelines.filter((pipeline) => pipeline.canCreateTasks && ids.has(pipeline.id));
  const stageless = stagelessPipelines(allStatuses, pipelines).filter(
    (pipeline) => !selectedId || pipeline.id === selectedId,
  );
  const target = selectedId ?? pipelines.find((pipeline) => pipeline.isDefault)?.id;
  return {
    blocked,
    stageless,
    createBlocked: [...blocked, ...stageless].some((pipeline) => pipeline.id === target),
  };
}

/** The pipelines with no stages at all (every one deleted): no task can be in them yet. */
export function stagelessPipelines(
  statuses: ReadonlyArray<{ pipelineId?: string | undefined }> | undefined,
  pipelines: readonly Pipeline[],
): Pipeline[] {
  // Statuses without their pipeline (older fixtures) can't tell.
  if (!statuses || statuses.some((status) => !status.pipelineId)) return [];
  const withStages = new Set(statuses.map((status) => status.pipelineId));
  return pipelines.filter((pipeline) => !withStages.has(pipeline.id));
}
