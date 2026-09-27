import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { AgentNotificationLevel, NotificationType, ReplyParentType } from '@shared/constants';
import type { Paginated } from '@shared/schemas/common';
import type {
  ListNotificationsQuery,
  MarkNotificationsReadInput,
  MarkNotificationsReadResponse,
  Notification,
  NotificationItem,
} from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { decodeCursor, encodeCursor, timeIdCursorSchema } from '../lib/cursor';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/markdown';
import { addedMentions } from '../lib/mentions';
import {
  getMembership,
  getProjectAccess,
  hasPermission,
  memberTeamIds,
  projectViewerIds,
  roleMemberIds,
  teamMemberIds,
  visibleProjectIds,
} from './access';
import { emitAfterCommit } from './events';
import { subscriberIds } from './subscriptions';
import { getUserSummaries } from './users';

/**
 * Notifications (SPEC §1.10). Feature services call the `notify*` helpers inside their `db.write`
 * transaction; each helper skips the actor, agent members (they have no inbox), non-members and
 * anyone already notified for the same event (pass one `notified` set through every call of an
 * event), inserts the rows and queues a personal `notification.created` event per recipient.
 */

/** What the notification is about and where it links. */
export interface NotificationTarget {
  teamId: string;
  /** e.g. `task`, `issue`, `reply`. */
  entityType: string;
  entityId: string;
  /** e.g. `API-12: Fix login`. */
  title: string;
  /** Plain-text excerpt (markdown is accepted and flattened). */
  snippet?: string;
  /** Relative app URL. */
  url: string;
}

/** Users already notified for the current event (dedupe across helper calls). */
export type NotifiedSet = Set<string>;

const SNIPPET_LENGTH = 200;

/**
 * Notification types that "need" an agent's owner under `needs_me` (agents A): their agent
 * mentioned or assigned them. Answers to the owner's own reply count too (`direct`).
 */
const NEEDS_ME_TYPES: ReadonlySet<NotificationType> = new Set([
  'mention',
  'role_mention',
  'assigned',
]);

export interface NotifyOptions {
  /** The notification answers the recipients directly (a reply to their reply). */
  direct?: boolean;
  /**
   * The owner hears about it whatever their `agent_notifications` level: their agent asks for
   * their sign-off (`agent_action_request`, design §6).
   */
  always?: boolean;
}

/** The `agent_notifications` level of an agent actor's owner, or null for people. */
function ownerLevel(tx: Tx, actor: Actor | null): AgentNotificationLevel | null {
  if (!actor?.ownerId) return null;
  return (
    tx
      .select({ level: s.user.agentNotifications })
      .from(s.user)
      .where(eq(s.user.id, actor.ownerId))
      .get()?.level ?? 'needs_me'
  );
}

/**
 * Notifies `userIds` (people in the target's team only), skipping the actor, agent members and
 * anyone in `notified`. When the actor is an agent member, its owner's `agent_notifications`
 * decides whether the owner hears about it (agents A): `all` — whatever the agent's action
 * notifies anyone of, the owner gets too; `needs_me` — only mentions, assignments and direct
 * answers reaching the owner; `none` — never. Returns the ids notified by this call and adds them
 * to `notified`.
 */
export function notifyUsers(
  tx: Tx,
  actor: Actor | null,
  type: NotificationType,
  userIds: Iterable<string>,
  target: NotificationTarget,
  notified: NotifiedSet = new Set(),
  options: NotifyOptions = {},
): string[] {
  const level = ownerLevel(tx, actor);
  const ownerId = actor?.ownerId;
  const ownerWanted =
    options.always === true ||
    level === 'all' ||
    (level === 'needs_me' && (NEEDS_ME_TYPES.has(type) || options.direct === true));
  const candidates = [...new Set(userIds)].filter(
    (id) => id !== actor?.userId && !notified.has(id) && (id !== ownerId || ownerWanted),
  );
  const people = (ids: readonly string[]) =>
    ids.length === 0
      ? new Set<string>()
      : new Set(
          tx
            .select({ userId: s.teamMember.userId })
            .from(s.teamMember)
            .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
            .where(
              and(
                eq(s.teamMember.teamId, target.teamId),
                inArray(s.teamMember.userId, [...ids]),
                eq(s.user.kind, 'human'),
              ),
            )
            .all()
            .map((row) => row.userId),
        );
  const members = people(candidates);
  let recipients = candidates.filter((id) => members.has(id));
  if (
    level === 'all' &&
    ownerId &&
    recipients.length > 0 &&
    !recipients.includes(ownerId) &&
    !notified.has(ownerId) &&
    people([ownerId]).has(ownerId)
  ) {
    recipients.push(ownerId);
  }
  // Nobody hears about a project they can't see (VIEW_PROJECT, design §3).
  const item = itemOfTarget(tx, target);
  if (item.projectId) recipients = projectViewerIds(tx, item.projectId, recipients);
  if (recipients.length === 0) return [];

  const snippet = target.snippet ? excerpt(target.snippet, SNIPPET_LENGTH) : '';
  const now = new Date();
  const rows = recipients.map((userId) => ({
    id: newId(),
    userId,
    teamId: target.teamId,
    type,
    entityType: target.entityType,
    entityId: target.entityId,
    actorId: actor?.userId ?? null,
    viaKeyName: actor?.key?.name ?? null,
    viaAgentName: actor?.key?.agentName ?? null,
    title: target.title,
    snippet,
    url: target.url,
    createdAt: now,
  }));
  tx.insert(s.notification).values(rows).run();
  for (const row of rows) {
    notified.add(row.userId);
    emitAfterCommit(tx, {
      type: 'notification.created',
      teamId: row.teamId,
      projectId: item.projectId,
      entityType: 'notification',
      entityId: row.id,
      parentType: item.type,
      parentId: item.id,
      actorId: row.actorId,
      userId: row.userId,
    });
  }
  return recipients;
}

interface NotificationItemRef {
  /** The task or issue the notification is about (a reply's item), or null. */
  type: ReplyParentType | null;
  id: string | null;
  projectId: string | null;
}

/**
 * The project and item (task or issue) of a notification target, carried by its live events so
 * clients can refresh the item's unread badge and tell whether it is on screen (BAT-15, BAT-16).
 */
function itemOfTarget(tx: Tx, target: NotificationTarget): NotificationItemRef {
  const none: NotificationItemRef = { type: null, id: null, projectId: null };
  switch (target.entityType) {
    case 'task': {
      const row = tx
        .select({ projectId: s.task.projectId })
        .from(s.task)
        .where(eq(s.task.id, target.entityId))
        .get();
      return row ? { type: 'task', id: target.entityId, projectId: row.projectId } : none;
    }
    case 'issue': {
      const row = tx
        .select({ projectId: s.issue.projectId })
        .from(s.issue)
        .where(eq(s.issue.id, target.entityId))
        .get();
      return row ? { type: 'issue', id: target.entityId, projectId: row.projectId } : none;
    }
    case 'reply': {
      const row = tx
        .select({
          projectId: s.reply.projectId,
          parentType: s.reply.parentType,
          parentId: s.reply.parentId,
        })
        .from(s.reply)
        .where(eq(s.reply.id, target.entityId))
        .get();
      return row ? { type: row.parentType, id: row.parentId, projectId: row.projectId } : none;
    }
    case 'project':
      return { ...none, projectId: target.entityId };
    default:
      return none;
  }
}

export interface MentionOptions {
  /** Previous body when editing: only newly added mentions notify. */
  previousBody?: string | null;
  notified?: NotifiedSet;
}

/**
 * Notifies members mentioned in `body`: `@username` (type `mention`), `@&role` and `@everyone`
 * (type `role_mention`). Role mentions need the role to be mentionable or the actor to have
 * `MENTION_EVERYONE`; `@everyone` always needs `MENTION_EVERYONE`. Direct mentions win over role
 * mentions for the same person.
 */
export function notifyMentions(
  tx: Tx,
  actor: Actor | null,
  target: NotificationTarget,
  body: string,
  options: MentionOptions = {},
): string[] {
  const notified = options.notified ?? new Set<string>();
  const mentions = addedMentions(body, options.previousBody);
  // MENTION_EVERYONE is project-level: the actor's permission in the target's project, if any.
  const projectId = itemOfTarget(tx, target).projectId;
  const membership = !actor
    ? null
    : projectId
      ? getProjectAccess(tx, actor.userId, projectId)
      : getMembership(tx, target.teamId, actor.userId);
  const mentionAll = membership ? hasPermission(membership, 'MENTION_EVERYONE') : false;

  const direct =
    mentions.usernames.length === 0
      ? []
      : tx
          .select({ id: s.user.id })
          .from(s.user)
          .where(inArray(s.user.username, mentions.usernames))
          .all()
          .map((row) => row.id);

  const roleIds =
    mentions.roleSlugs.length === 0
      ? []
      : tx
          .select({ id: s.role.id, mentionable: s.role.mentionable })
          .from(s.role)
          .where(and(eq(s.role.teamId, target.teamId), inArray(s.role.slug, mentions.roleSlugs)))
          .all()
          .filter((role) => role.mentionable || mentionAll)
          .map((role) => role.id);

  const group = new Set(roleMemberIds(tx, roleIds));
  if (mentions.everyone && mentionAll) {
    for (const id of teamMemberIds(tx, target.teamId)) group.add(id);
  }

  return [
    ...notifyUsers(tx, actor, 'mention', direct, target, notified),
    ...notifyUsers(tx, actor, 'role_mention', group, target, notified),
  ];
}

/** Notifies users assigned to a task, directly or through one of `roleIds`. */
export function notifyAssigned(
  tx: Tx,
  actor: Actor | null,
  target: NotificationTarget,
  assignees: { userIds?: readonly string[]; roleIds?: readonly string[] },
  notified: NotifiedSet = new Set(),
): string[] {
  const userIds = new Set(assignees.userIds ?? []);
  for (const id of roleMemberIds(tx, assignees.roleIds ?? [])) userIds.add(id);
  return notifyUsers(tx, actor, 'assigned', userIds, target, notified);
}

/** Notifies everyone subscribed to the issue or task a reply was posted on. */
export function notifyReply(
  tx: Tx,
  actor: Actor | null,
  parent: { type: 'issue' | 'task'; id: string },
  target: NotificationTarget,
  notified: NotifiedSet = new Set(),
): string[] {
  return notifyUsers(
    tx,
    actor,
    'reply',
    subscriberIds(tx, parent.type, parent.id),
    target,
    notified,
  );
}

/** Notification types whose snippet is an excerpt of the subject's text (body, description). */
const TEXT_SNIPPET_TYPES = ['mention', 'role_mention', 'assigned', 'reply'] as const;

/**
 * Brings the notifications already sent about `target` up to date after its text was edited:
 * every one gets the new title, and those quoting the text (`TEXT_SNIPPET_TYPES`) a new snippet,
 * so text removed by an edit doesn't live on in inboxes. Call inside the edit's transaction.
 */
export function refreshNotificationText(tx: Tx, target: NotificationTarget): void {
  const about = and(
    eq(s.notification.entityType, target.entityType),
    eq(s.notification.entityId, target.entityId),
  );
  tx.update(s.notification).set({ title: target.title }).where(about).run();
  tx.update(s.notification)
    .set({ snippet: target.snippet ? excerpt(target.snippet, SNIPPET_LENGTH) : '' })
    .where(and(about, inArray(s.notification.type, [...TEXT_SNIPPET_TYPES])))
    .run();
}

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

type NotificationRow = typeof s.notification.$inferSelect;

function toNotifications(db: DbExecutor, rows: readonly NotificationRow[]): Notification[] {
  const actors = getUserSummaries(
    db,
    rows.map((row) => row.actorId),
  );
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    actor: row.actorId ? (actors.get(row.actorId) ?? null) : null,
    viaKeyName: row.viaKeyName,
    viaAgentName: row.viaAgentName,
    title: row.title,
    snippet: row.snippet,
    url: row.url,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * The notification's subject is live: its issue, task, reply (and that reply's issue or task) or
 * project is not in Trash, nor is the project it belongs to. Deleted items disappear from lists
 * (SPEC §1.12), and the stored title and snippet would otherwise keep showing deleted text; the
 * notification comes back if the item is restored. Subjects of other types are always shown.
 */
const liveSubjectCondition = sql`(case ${s.notification.entityType}
  when 'issue' then exists (
    select 1 from ${s.issue} i join ${s.project} p on p.id = i.project_id
    where i.id = ${s.notification.entityId} and i.deleted_at is null and p.deleted_at is null)
  when 'task' then exists (
    select 1 from ${s.task} t join ${s.project} p on p.id = t.project_id
    where t.id = ${s.notification.entityId} and t.deleted_at is null and p.deleted_at is null)
  when 'reply' then exists (
    select 1 from ${s.reply} r join ${s.project} p on p.id = r.project_id
    left join ${s.issue} i on r.parent_type = 'issue' and i.id = r.parent_id
    left join ${s.task} t on r.parent_type = 'task' and t.id = r.parent_id
    where r.id = ${s.notification.entityId} and r.deleted_at is null and p.deleted_at is null
      and ((i.id is not null and i.deleted_at is null) or (t.id is not null and t.deleted_at is null)))
  when 'project' then exists (
    select 1 from ${s.project} p where p.id = ${s.notification.entityId} and p.deleted_at is null)
  else 1 end)`;

/** The actor's notifications from teams they still belong to, about items that aren't deleted. */
function visibleCondition(db: DbExecutor, actor: Actor) {
  const teamIds = memberTeamIds(db, actor.userId);
  return and(
    eq(s.notification.userId, actor.userId),
    or(
      inArray(s.notification.teamId, teamIds),
      // An agent's sign-off request can be about a team in Trash (restoring it, design §6).
      and(
        eq(s.notification.type, 'agent_action_request'),
        inArray(
          s.notification.teamId,
          db
            .select({ teamId: s.teamMember.teamId })
            .from(s.teamMember)
            .where(eq(s.teamMember.userId, actor.userId)),
        ),
      ),
    ),
    liveSubjectCondition,
    // Notifications about projects the actor can no longer see are hidden with the project.
    or(
      sql`${notificationProjectId} is null`,
      inArray(notificationProjectId, visibleProjectIds(db, actor.userId, teamIds)),
    ),
  );
}

/** Inbox, newest first, cursor-paginated; `unread=1` for unread only. */
export function listNotifications(
  deps: AppDeps,
  actor: Actor,
  query: ListNotificationsQuery,
): Paginated<Notification> {
  const { orm } = deps.db;
  let cursor;
  if (query.cursor) {
    const [createdAtMs, id] = decodeCursor(query.cursor, timeIdCursorSchema);
    const createdAt = new Date(createdAtMs);
    cursor = or(
      lt(s.notification.createdAt, createdAt),
      and(eq(s.notification.createdAt, createdAt), lt(s.notification.id, id)),
    );
  }
  const rows = orm
    .select()
    .from(s.notification)
    .where(
      and(
        visibleCondition(orm, actor),
        query.unread === '1' ? isNull(s.notification.readAt) : undefined,
        cursor,
      ),
    )
    .orderBy(desc(s.notification.createdAt), desc(s.notification.id))
    .limit(query.limit + 1)
    .all();
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);
  return {
    items: toNotifications(orm, items),
    nextCursor: hasMore && last ? encodeCursor([last.createdAt.getTime(), last.id]) : null,
  };
}

export function unreadNotificationCount(deps: AppDeps, actor: Actor): number {
  const { orm } = deps.db;
  const row = orm
    .select({ value: count() })
    .from(s.notification)
    .where(and(visibleCondition(orm, actor), isNull(s.notification.readAt)))
    .get();
  return row?.value ?? 0;
}

/** The project a notification's subject belongs to, or null (team-level subjects). */
const notificationProjectId = sql<string | null>`(case ${s.notification.entityType}
  when 'task' then (select t.project_id from ${s.task} t where t.id = ${s.notification.entityId})
  when 'issue' then (select i.project_id from ${s.issue} i where i.id = ${s.notification.entityId})
  when 'reply' then (select r.project_id from ${s.reply} r where r.id = ${s.notification.entityId})
  when 'project' then ${s.notification.entityId}
  else null end)`;

/** Notifications about a task or issue itself, or about one of its replies. */
function aboutItem(db: DbExecutor, item: NotificationItem) {
  return or(
    and(eq(s.notification.entityType, item.type), eq(s.notification.entityId, item.id)),
    and(
      eq(s.notification.entityType, 'reply'),
      inArray(
        s.notification.entityId,
        db
          .select({ id: s.reply.id })
          .from(s.reply)
          .where(and(eq(s.reply.parentType, item.type), eq(s.reply.parentId, item.id))),
      ),
    ),
  );
}

/**
 * Marks the given notifications, those about an item (a task or issue and its replies, BAT-15),
 * or all of them as read. Only the actor's own unread notifications are touched; read state is
 * personal, so it is not written to the team audit log. A personal `notification.read` event per
 * affected project lets the actor's other tabs refresh their badges.
 */
export function markNotificationsRead(
  deps: AppDeps,
  actor: Actor,
  input: MarkNotificationsReadInput,
): MarkNotificationsReadResponse {
  const result = deps.db.write((tx) => {
    const unread = and(
      eq(s.notification.userId, actor.userId),
      isNull(s.notification.readAt),
      input.ids ? inArray(s.notification.id, input.ids) : undefined,
      input.item ? aboutItem(tx, input.item) : undefined,
    );
    const groups = tx
      .selectDistinct({ teamId: s.notification.teamId, projectId: notificationProjectId })
      .from(s.notification)
      .where(unread)
      .all();
    const changed = tx.update(s.notification).set({ readAt: new Date() }).where(unread).run();
    for (const group of groups) {
      emitAfterCommit(tx, {
        type: 'notification.read',
        teamId: group.teamId,
        projectId: group.projectId,
        entityType: 'notification',
        entityId: group.projectId ?? group.teamId,
        parentType: input.item?.type ?? null,
        parentId: input.item?.id ?? null,
        actorId: actor.userId,
        userId: actor.userId,
      });
    }
    return changed;
  });
  return { updated: result.changes };
}

/**
 * The viewer's unread notifications per task or issue among `itemIds`, counting those about the
 * item and about its (not deleted) replies (BAT-16). One grouped query; items without unread
 * notifications are absent.
 */
export function unreadCountsByItem(
  db: DbExecutor,
  userId: string,
  itemType: ReplyParentType,
  itemIds: readonly string[],
): Map<string, number> {
  if (itemIds.length === 0) return new Map();
  const ids = [...new Set(itemIds)];
  const itemId = sql<string>`coalesce(${s.reply.parentId}, ${s.notification.entityId})`;
  const rows = db
    .select({ itemId, unread: count() })
    .from(s.notification)
    .leftJoin(
      s.reply,
      and(eq(s.notification.entityType, 'reply'), eq(s.reply.id, s.notification.entityId)),
    )
    .where(
      and(
        eq(s.notification.userId, userId),
        isNull(s.notification.readAt),
        or(
          and(eq(s.notification.entityType, itemType), inArray(s.notification.entityId, ids)),
          and(
            eq(s.reply.parentType, itemType),
            inArray(s.reply.parentId, ids),
            isNull(s.reply.deletedAt),
          ),
        ),
      ),
    )
    .groupBy(itemId)
    .all();
  return new Map(rows.map((row) => [row.itemId, row.unread]));
}
