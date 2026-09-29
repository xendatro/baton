import { z } from 'zod';

/**
 * Live events (SPEC §5). Services emit them on the in-process event bus after their transaction
 * commits; `GET /api/events` streams them over SSE to members of the event's team (personal events
 * only to `userId`); the web client maps each type to TanStack Query invalidations (web/lib/live.ts).
 * Events are hints to refetch — they never carry entity data.
 */

export const LIVE_EVENT_TYPES = [
  'team.updated',
  'team.deleted',
  'member.joined',
  'member.left',
  'member.updated',
  'role.changed',
  'invite.changed',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.restored',
  /** A project's roles, their members or its permission overrides changed (design §3). */
  'project_access.changed',
  'status.changed',
  'label.changed',
  'issue.created',
  'issue.updated',
  'issue.deleted',
  'issue.restored',
  'task.created',
  'task.updated',
  'task.deleted',
  'task.restored',
  'task.claimed',
  'task.released',
  'reply.created',
  'reply.updated',
  'reply.deleted',
  /** BAT-14: an emoji reaction was added or removed; entity = the task, issue or reply. */
  'reaction.changed',
  'attachment.changed',
  'activity.created',
  'notification.created',
  'notification.read',
  'me.updated',
  /** Members of the team came online or went offline (design §4, throttled). Entity: the team. */
  'presence.changed',
  /** Personal, to an agent's owner: its jobs or listener sessions changed (design §4). */
  'agent_job.changed',
  /** Personal: an agent sign-off request was made, approved, denied or expired (design §6). */
  'agent_action.changed',
  /**
   * Chat: someone (`actorId`) is typing in an issue's or task's conversation; entity = the item.
   * Ephemeral (never stored, no queries to refresh): clients show it for a few seconds.
   */
  'typing',
  /**
   * BAT#42: the agents working on an issue or task changed (a harness started or stopped running
   * one of their jobs about it, or the agent answered); entity = the item.
   */
  'item.working_changed',
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

/** Events delivered only to one user (`userId`) instead of a whole team. */
export const PERSONAL_EVENT_TYPES = [
  'notification.created',
  'notification.read',
  'me.updated',
  'agent_job.changed',
  'agent_action.changed',
] as const satisfies readonly LiveEventType[];

export type PersonalEventType = (typeof PERSONAL_EVENT_TYPES)[number];

export const LIVE_ENTITY_TYPES = [
  'user',
  'team',
  'member',
  'role',
  'invite',
  'project',
  'status',
  'label',
  'difficulty',
  'issue',
  'task',
  'reply',
  'attachment',
  'activity',
  'notification',
  'agent_job',
  'agent_action',
] as const;

export type LiveEntityType = (typeof LIVE_ENTITY_TYPES)[number];

export const liveEventSchema = z.object({
  type: z.enum(LIVE_EVENT_TYPES),
  /** Team the event belongs to; null only for personal events without a team (`me.updated`). */
  teamId: z.string().nullable(),
  projectId: z.string().nullable().optional(),
  entityType: z.enum(LIVE_ENTITY_TYPES),
  entityId: z.string(),
  /**
   * For `reply.*` and `attachment.changed`: the item they belong to (e.g. `task` + task id).
   * For `activity.created`: the entity the activity row is about (`entityId` is the row id).
   * For `notification.created` / `notification.read`: the task or issue the notification is
   * about (a reply notification names the reply's item), when there is one.
   * For `reaction.changed` on a reply: the reply's task or issue.
   */
  parentType: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  /** Who caused the event; null for system jobs. */
  actorId: z.string().nullable(),
  /** Recipient of a personal event. */
  userId: z.string().nullable().optional(),
  /** ISO 8601 timestamp. */
  at: z.string(),
});

export type LiveEvent = z.infer<typeof liveEventSchema>;

const PERSONAL_SET: ReadonlySet<LiveEventType> = new Set(PERSONAL_EVENT_TYPES);

export function isPersonalEvent(event: Pick<LiveEvent, 'type'>): boolean {
  return PERSONAL_SET.has(event.type);
}

/** `GET /api/events/poll` (long-poll fallback for clients whose SSE stream never delivers). */
export const livePollQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
});

export const livePollResponseSchema = z.object({
  /** LiveEvents (validate each: a newer server may send types this client doesn't know). */
  events: z.array(z.unknown()),
  /** Pass back as `cursor` on the next poll. */
  cursor: z.string(),
  /** Events may have been missed (server restart, long gap): refetch everything. */
  reset: z.boolean(),
});

export type LivePollResponse = z.infer<typeof livePollResponseSchema>;
