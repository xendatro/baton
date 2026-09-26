import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { NotificationType } from '@shared/constants';
import type { Paginated } from '@shared/schemas/common';
import type {
  ListNotificationsQuery,
  MarkNotificationsReadInput,
  MarkNotificationsReadResponse,
  Notification,
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
  hasPermission,
  memberTeamIds,
  roleMemberIds,
  teamMemberIds,
} from './access';
import { emitAfterCommit } from './events';
import { subscriberIds } from './subscriptions';
import { getUserSummaries } from './users';

/**
 * Notifications (SPEC §1.10). Feature services call the `notify*` helpers inside their `db.write`
 * transaction; each helper skips the actor (including their own keys), non-members and anyone
 * already notified for the same event (pass one `notified` set through every call of an event),
 * inserts the rows and queues a personal `notification.created` event per recipient.
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
 * Notifies `userIds` (members of the target's team only), skipping anyone in `notified` and the
 * actor, unless the actor worked through an API key: an agent's replies and mentions reach the
 * key's owner too, since the owner didn't write them (BAT-6). Returns the ids notified by this
 * call and adds them to `notified`.
 */
export function notifyUsers(
  tx: Tx,
  actor: Actor | null,
  type: NotificationType,
  userIds: Iterable<string>,
  target: NotificationTarget,
  notified: NotifiedSet = new Set(),
): string[] {
  const candidates = [...new Set(userIds)].filter(
    (id) => (id !== actor?.userId || Boolean(actor.key)) && !notified.has(id),
  );
  if (candidates.length === 0) return [];
  const members = new Set(
    tx
      .select({ userId: s.teamMember.userId })
      .from(s.teamMember)
      .where(and(eq(s.teamMember.teamId, target.teamId), inArray(s.teamMember.userId, candidates)))
      .all()
      .map((row) => row.userId),
  );
  const recipients = candidates.filter((id) => members.has(id));
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
      entityType: 'notification',
      entityId: row.id,
      actorId: row.actorId,
      userId: row.userId,
    });
  }
  return recipients;
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
  const membership = actor ? getMembership(tx, target.teamId, actor.userId) : null;
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
  return and(
    eq(s.notification.userId, actor.userId),
    inArray(s.notification.teamId, memberTeamIds(db, actor.userId)),
    liveSubjectCondition,
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

/**
 * Marks the given notifications (or all) as read. Only the actor's own unread notifications are
 * touched; read state is personal, so it is not written to the team audit log.
 */
export function markNotificationsRead(
  deps: AppDeps,
  actor: Actor,
  input: MarkNotificationsReadInput,
): MarkNotificationsReadResponse {
  const result = deps.db.write((tx) =>
    tx
      .update(s.notification)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(s.notification.userId, actor.userId),
          isNull(s.notification.readAt),
          input.ids ? inArray(s.notification.id, input.ids) : undefined,
        ),
      )
      .run(),
  );
  return { updated: result.changes };
}
