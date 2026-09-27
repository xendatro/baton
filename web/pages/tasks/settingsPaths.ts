/** `/t/:team/p/:key/settings/statuses` (optionally highlighting one status) or `…/labels`. */
export function projectSettingsPath(
  projectBase: string,
  section: 'statuses' | 'labels' | 'difficulty',
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
