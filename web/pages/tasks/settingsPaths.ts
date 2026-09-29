/**
 * `/t/:team/p/:key/settings/pipelines` (optionally one pipeline's stages, highlighting one stage),
 * or `…/labels`.
 */
export function projectSettingsPath(
  projectBase: string,
  section: 'pipelines' | 'labels',
  statusId?: string,
  /** BAT-25: the pipeline whose statuses to show. */
  pipelineId?: string,
): string {
  const path = `${projectBase}/settings/${section}`;
  const params = new URLSearchParams();
  if (pipelineId) params.set('pipeline', pipelineId);
  if (statusId) params.set('status', statusId);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
