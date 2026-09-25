/**
 * Relative web-app paths of entities (SPEC §6 routes). Notifications, activity rows and search
 * results link with these; MCP tools turn them into absolute URLs with `absoluteUrl`.
 */

export const appPaths = {
  team: (teamSlug: string) => `/t/${teamSlug}`,
  teamSettings: (teamSlug: string, section: string) => `/t/${teamSlug}/settings/${section}`,
  role: (teamSlug: string, roleId: string) => `/t/${teamSlug}/settings/roles/${roleId}`,
  project: (teamSlug: string, projectKey: string) => `/t/${teamSlug}/p/${projectKey}`,
  projectSettings: (teamSlug: string, projectKey: string, section: string) =>
    `/t/${teamSlug}/p/${projectKey}/settings/${section}`,
  issue: (teamSlug: string, projectKey: string, number: number) =>
    `/t/${teamSlug}/p/${projectKey}/issues/${number}`,
  task: (teamSlug: string, projectKey: string, number: number) =>
    `/t/${teamSlug}/p/${projectKey}/tasks/${number}`,
  /** A reply inside its issue/task thread. */
  reply: (parentPath: string, replyId: string) => `${parentPath}#reply-${replyId}`,
  accountSecurity: () => '/settings/security',
  apiKeys: () => '/settings/api-keys',
} as const;

/** `BASE_URL` + path. */
export function absoluteUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Download URL of an attachment (relative to the origin). */
export function attachmentPath(id: string, filename: string): string {
  return `/api/attachments/${id}/${encodeURIComponent(filename)}`;
}
