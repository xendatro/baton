/** `/t/:team/p/:key/settings/statuses` (optionally highlighting one status) or `…/labels`. */
export function projectSettingsPath(
  projectBase: string,
  section: 'statuses' | 'labels',
  statusId?: string,
): string {
  const path = `${projectBase}/settings/${section}`;
  return statusId ? `${path}?status=${encodeURIComponent(statusId)}` : path;
}
