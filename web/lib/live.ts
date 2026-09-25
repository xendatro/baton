import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { LiveEvent, LiveEventType } from '@shared/events';
import { queryKeys } from './queryKeys';

/**
 * Live event → query invalidation map (SPEC §5). Every event type must be listed (the Record type
 * enforces it). Invalidation matches by key prefix, so broad keys refresh everything below them.
 * The SSE connection that feeds `invalidateForEvent` lives with the app shell.
 */
export type Invalidation = (event: LiveEvent) => QueryKey[];

function teamKeys(event: LiveEvent, ...builders: Array<(teamId: string) => QueryKey>): QueryKey[] {
  const { teamId } = event;
  return teamId ? builders.map((build) => build(teamId)) : [];
}

function projectKeys(
  event: LiveEvent,
  ...builders: Array<(projectId: string) => QueryKey>
): QueryKey[] {
  const { projectId } = event;
  return projectId ? builders.map((build) => build(projectId)) : [];
}

/** The key of the entity named by `parentType`/`parentId`, when both are present. */
function parentKey(event: LiveEvent, build: (type: string, id: string) => QueryKey): QueryKey[] {
  return event.parentType && event.parentId ? [build(event.parentType, event.parentId)] : [];
}

/** Issue or task queries of a reply's or attachment's parent item. */
function parentItemKeys(event: LiveEvent): QueryKey[] {
  if (event.parentType === 'issue') return projectKeys(event, queryKeys.issues.all);
  if (event.parentType === 'task') return projectKeys(event, queryKeys.tasks.all);
  return [];
}

const trash = (event: LiveEvent) => teamKeys(event, queryKeys.teams.trash);

const memberChange: Invalidation = (e) => [
  queryKeys.me(),
  ...teamKeys(e, queryKeys.teams.members, (teamId) => queryKeys.teams.mentionables(teamId)),
  queryKeys.work.all(),
];

const projectChange: Invalidation = (e) => [
  queryKeys.me(),
  ...teamKeys(e, queryKeys.teams.projects),
  ...projectKeys(e, queryKeys.projects.detail),
  queryKeys.work.all(),
];

// Tasks show linked issues and issues list the tasks addressing them, so both refresh.
const issueChange: Invalidation = (e) => [
  ...projectKeys(e, queryKeys.issues.all, queryKeys.tasks.all),
  queryKeys.work.dashboard(),
];

const taskChange: Invalidation = (e) => [
  ...projectKeys(e, queryKeys.tasks.all, queryKeys.issues.all),
  queryKeys.work.all(),
];

const replyChange: Invalidation = (e) => [
  ...parentKey(e, queryKeys.replies.list),
  ...parentItemKeys(e),
];

export const LIVE_INVALIDATIONS: Readonly<Record<LiveEventType, Invalidation>> = {
  'team.updated': (e) => [queryKeys.me(), ...teamKeys(e, queryKeys.teams.detail)],
  'team.deleted': () => [
    queryKeys.me(),
    queryKeys.teams.all(),
    queryKeys.work.all(),
    queryKeys.account.all(),
  ],
  'member.joined': memberChange,
  'member.left': memberChange,
  'member.updated': memberChange,
  'role.changed': (e) => [...memberChange(e), ...teamKeys(e, queryKeys.teams.roles)],
  'invite.changed': (e) => teamKeys(e, queryKeys.teams.invites),
  'project.created': projectChange,
  'project.updated': projectChange,
  'project.deleted': (e) => [...projectChange(e), ...trash(e)],
  'project.restored': (e) => [...projectChange(e), ...trash(e)],
  'status.changed': (e) => projectKeys(e, queryKeys.projects.statuses, queryKeys.tasks.all),
  'label.changed': (e) =>
    projectKeys(e, queryKeys.projects.labels, queryKeys.tasks.all, queryKeys.issues.all),
  'issue.created': issueChange,
  'issue.updated': issueChange,
  'issue.deleted': (e) => [...issueChange(e), ...trash(e)],
  'issue.restored': (e) => [...issueChange(e), ...trash(e)],
  'task.created': taskChange,
  'task.updated': taskChange,
  'task.deleted': (e) => [...taskChange(e), ...trash(e)],
  'task.restored': (e) => [...taskChange(e), ...trash(e)],
  'task.claimed': taskChange,
  'task.released': taskChange,
  'reply.created': replyChange,
  'reply.updated': replyChange,
  'reply.deleted': (e) => [...replyChange(e), ...trash(e)],
  // Attachments are embedded in replies and items; a reply attachment doesn't name its thread.
  'attachment.changed': (e) => [
    ...parentKey(e, queryKeys.attachments),
    ...(e.parentType === 'reply' ? [queryKeys.replies.all()] : parentItemKeys(e)),
    ...trash(e),
  ],
  // For activity events parentType/parentId name the entity the activity row is about.
  'activity.created': (e) => [
    ...parentKey(e, queryKeys.activity),
    ...teamKeys(e, (teamId) => queryKeys.teams.auditLog(teamId)),
    queryKeys.work.dashboard(),
  ],
  'notification.created': () => [queryKeys.notifications.all()],
  'me.updated': () => [queryKeys.me(), queryKeys.account.all()],
};

/** Invalidates every query affected by `event`. */
export async function invalidateForEvent(
  queryClient: QueryClient,
  event: LiveEvent,
): Promise<void> {
  await Promise.all(
    LIVE_INVALIDATIONS[event.type](event).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}
