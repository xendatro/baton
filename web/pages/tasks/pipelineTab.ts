import type { Pipeline } from '@shared/schemas/projects';

/**
 * The pipeline a project's Tasks page shows (`?pipeline=`): one pipeline's stages, or `all` of
 * them. Without the parameter it is the tab last picked in this browser, else the project's default
 * pipeline, so the board always reads as one pipeline's stages. The Tasks page, the sidebar and the
 * header's breadcrumbs all resolve it here, so they agree.
 */

export const ALL_PIPELINES = 'all';

function storageKey(projectId: string) {
  return `baton.pipelineTab.${projectId}`;
}

export function rememberedPipelineTab(projectId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(projectId));
  } catch {
    return null;
  }
}

export function rememberPipelineTab(projectId: string, tab: string): void {
  try {
    window.localStorage.setItem(storageKey(projectId), tab);
  } catch {
    // Storage unavailable: the tab just isn't remembered.
  }
}

/**
 * The selected tab: a pipeline's id or `all`; undefined while the pipelines load. An unknown id
 * (a deleted or hidden pipeline) falls back like a missing one.
 */
export function resolvePipelineTab(
  projectId: string,
  param: string | null,
  pipelines: readonly Pipeline[] | undefined,
): string | undefined {
  if (!pipelines) return undefined;
  const valid = (tab: string | null): tab is string =>
    tab === ALL_PIPELINES || pipelines.some((pipeline) => pipeline.id === tab);
  if (valid(param)) return param;
  const remembered = rememberedPipelineTab(projectId);
  if (valid(remembered)) return remembered;
  return (pipelines.find((pipeline) => pipeline.isDefault) ?? pipelines[0])?.id ?? ALL_PIPELINES;
}

/** `…/tasks?pipeline=<id>`: a pipeline's board. */
export function pipelineBoardPath(projectBase: string, pipelineId: string): string {
  return `${projectBase}/tasks?pipeline=${encodeURIComponent(pipelineId)}`;
}
