import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { LIMITS, PRIORITIES, type PriorityValue } from '@shared/constants';
import { formatIssueRef, formatTaskRef } from '@shared/refs';
import type {
  BoardQuery,
  BoardResponse,
  CreateTaskData,
  CreateTaskFromIssueInput,
  IdListChange,
  ListTasksQuery,
  MoveTaskInput,
  Task,
  TaskListResponse,
  UpdateTaskData,
} from '@shared/schemas/tasks';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change, hasChanges, type Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt, markdownToPlainText } from '../lib/markdown';
import { appPaths } from '../lib/urls';
import {
  canEditContent,
  canRestoreContent,
  hasPermission,
  requireCanDeleteContent,
  requireCanEditContent,
  requireMember,
  requirePermission,
  roleMemberIds,
  type Membership,
} from './access';
import { recordActivity } from './activity';
import { attachToParent, referencedPendingUploads } from './attachments';
import { isClaimValid, renewClaimOnWrite } from './claimLease';
import { emitAfterCommit } from './events';
import {
  notifyAssigned,
  notifyMentions,
  notifyUsers,
  refreshNotificationText,
  type NotificationTarget,
  type NotifiedSet,
} from './notifications';
import { canTriageIssue } from './issues';
import { requireProject } from './projects';
import { indexSearch } from './search';
import { autoSubscribe } from './subscriptions';
import {
  applyBlockersChange,
  applyIdChange,
  applyIssueLinksChange,
  resolveFixedIssues,
  type LinkSubject,
} from './taskLinks';
import { boardOf, listOf, toTask, type TaskRow } from './taskViews';

/**
 * Tasks (SPEC §1.8): numbered `KEY-12` per project, on a board of status columns ordered by
 * fractional-index positions. Everything a task changes is audited on it (`task.*`, with
 * human-readable field changes and `meta: { ref, title }`), indexed for search, notified (new
 * assignees, mentions, `task_done`) and announced with live events after commit.
 *
 * Permissions: members with `CREATE_TASKS` create; the title and description are edited by the
 * author or `EDIT_ANY_CONTENT`; every other field (status, position, priority, due date,
 * assignees, labels, links, blockers) by the author or `UPDATE_TASKS`; deletion by the author or
 * `DELETE_ANY_CONTENT`; restoring by the author or `MANAGE_TRASH`.
 */

export type { TaskRow };
type ProjectRow = typeof s.project.$inferSelect;
type TeamRow = typeof s.team.$inferSelect;
type StatusRow = typeof s.status.$inferSelect;

/** A live task (in a live project and team) and the actor's membership. */
export interface TaskAccess {
  task: TaskRow;
  project: ProjectRow;
  team: TeamRow;
  membership: Membership;
}

/** The live task `taskId`; missing, deleted and other teams' tasks are all `not_found`. */
export function requireTask(db: DbExecutor, actor: Actor, taskId: string): TaskAccess {
  const row = db
    .select({ task: s.task, project: s.project, team: s.team })
    .from(s.task)
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .innerJoin(s.team, eq(s.team.id, s.task.teamId))
    .where(
      and(
        eq(s.task.id, taskId),
        isNull(s.task.deletedAt),
        isNull(s.project.deletedAt),
        isNull(s.team.deletedAt),
      ),
    )
    .get();
  if (!row) throw errors.notFound('Task');
  return { ...row, membership: requireMember(db, actor, row.team.id, 'Task') };
}

/** May the member change the task's workflow fields (status, assignees, …) and claim it? */
export function canUpdateTask(membership: Membership, task: Pick<TaskRow, 'authorId'>): boolean {
  return task.authorId === membership.userId || hasPermission(membership, 'UPDATE_TASKS');
}

export function requireCanUpdateTask(
  membership: Membership,
  task: Pick<TaskRow, 'authorId'>,
  message = "You don't have permission to update tasks",
): void {
  if (!canUpdateTask(membership, task)) throw errors.forbidden(message);
}

export function linkSubject(task: TaskRow, projectKey: string): LinkSubject {
  return {
    id: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    ref: formatTaskRef(projectKey, task.number),
    title: task.title,
  };
}

export function taskMeta(task: Pick<TaskRow, 'number' | 'title'>, projectKey: string) {
  return { ref: formatTaskRef(projectKey, task.number), title: task.title };
}

export function taskEvent(
  type:
    | 'task.created'
    | 'task.updated'
    | 'task.deleted'
    | 'task.restored'
    | 'task.claimed'
    | 'task.released',
  task: Pick<TaskRow, 'id' | 'teamId' | 'projectId'>,
  actor: Actor | null,
) {
  return {
    type,
    teamId: task.teamId,
    projectId: task.projectId,
    entityType: 'task' as const,
    entityId: task.id,
    actorId: actor?.userId ?? null,
  };
}

function notificationTarget(
  task: Pick<TaskRow, 'id' | 'teamId' | 'number' | 'title'>,
  project: { key: string },
  team: { slug: string },
  snippet: string,
): NotificationTarget {
  return {
    teamId: task.teamId,
    entityType: 'task',
    entityId: task.id,
    title: `${formatTaskRef(project.key, task.number)}: ${task.title}`,
    snippet,
    url: appPaths.task(team.slug, project.key, task.number),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** The full task: description, status, assignees, labels, links, blockers, claim, files. */
export function getTask(deps: AppDeps, actor: Actor, taskId: string): Task {
  const { orm } = deps.db;
  const { task } = requireTask(orm, actor, taskId);
  return toTask(orm, actor, task);
}

/** A task of a project by number (`/tasks/:number`). */
export function getTaskByNumber(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  number: number,
): Task {
  const { orm } = deps.db;
  requireProject(orm, actor, projectId, 'Task');
  const row = orm
    .select()
    .from(s.task)
    .where(
      and(eq(s.task.projectId, projectId), eq(s.task.number, number), isNull(s.task.deletedAt)),
    )
    .get();
  if (!row) throw errors.notFound('Task');
  return toTask(orm, actor, row);
}

/** The board of a project: every status column with its (filtered) tasks in order. */
export function getBoard(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  query: BoardQuery,
): BoardResponse {
  const { orm } = deps.db;
  const { membership } = requireProject(orm, actor, projectId);
  return boardOf(orm, projectId, membership, query);
}

/** The list view of a project: filtered, sorted and paginated. */
export function listTasks(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  query: ListTasksQuery,
): TaskListResponse {
  const { orm } = deps.db;
  const { membership } = requireProject(orm, actor, projectId);
  return listOf(orm, projectId, membership, query);
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/** Live tasks of a column in board order. */
function columnOf(tx: Tx, statusId: string, exceptId?: string) {
  return tx
    .select({ id: s.task.id, position: s.task.position })
    .from(s.task)
    .where(and(eq(s.task.statusId, statusId), isNull(s.task.deletedAt)))
    .orderBy(asc(sql`${s.task.position} collate binary`), asc(s.task.number))
    .all()
    .filter((row) => row.id !== exceptId);
}

/** Rewrites a column with fresh, evenly spaced keys (repairs invalid or duplicate keys). */
function rebalance(tx: Tx, ids: readonly string[]): string[] {
  const keys = generateNKeysBetween(null, null, ids.length);
  ids.forEach((id, index) => {
    tx.update(s.task)
      .set({ position: keys[index], updatedAt: sql`${s.task.updatedAt}` })
      .where(eq(s.task.id, id))
      .run();
  });
  return keys;
}

/**
 * A key placing a task at `index` of `column` (which doesn't contain it). When neighbouring keys
 * are unusable (written by hand, or equal after concurrent moves) the column is rebalanced first.
 */
function keyAt(tx: Tx, column: ReadonlyArray<{ id: string; position: string }>, index: number) {
  const lower = column[index - 1]?.position ?? null;
  const upper = column[index]?.position ?? null;
  try {
    return generateKeyBetween(lower, upper);
  } catch {
    const keys = rebalance(
      tx,
      column.map((row) => row.id),
    );
    return generateKeyBetween(keys[index - 1] ?? null, keys[index] ?? null);
  }
}

/**
 * A key at the end of a status column. Deleted tasks are counted too, so a later restore never
 * lands on the same key as a newer task.
 */
export function appendPosition(tx: Tx, statusId: string): string {
  const last = tx
    .select({ position: s.task.position })
    .from(s.task)
    .where(eq(s.task.statusId, statusId))
    .orderBy(desc(sql`${s.task.position} collate binary`))
    .get();
  try {
    return generateKeyBetween(last?.position ?? null, null);
  } catch {
    const column = columnOf(tx, statusId);
    return keyAt(tx, column, column.length);
  }
}

// ---------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------

export function statusOfProject(db: DbExecutor, projectId: string, statusId: string): StatusRow {
  const status = db
    .select()
    .from(s.status)
    .where(and(eq(s.status.id, statusId), eq(s.status.projectId, projectId)))
    .get();
  if (!status) throw errors.validation('That status is not one of this project’s statuses');
  return status;
}

function defaultStatus(db: DbExecutor, projectId: string): StatusRow {
  const status =
    db
      .select()
      .from(s.status)
      .where(and(eq(s.status.projectId, projectId), eq(s.status.isDefault, true)))
      .get() ??
    db
      .select()
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .orderBy(asc(s.status.position))
      .get();
  if (!status) throw errors.conflict('This project has no statuses');
  return status;
}

interface NamedRef {
  id: string;
  label: string;
}

/** Team members among `ids` (as `@username`); anyone else is a validation error. */
function memberRefs(db: DbExecutor, teamId: string, ids: readonly string[]): NamedRef[] {
  if (ids.length === 0) return [];
  const rows = db
    .select({ id: s.user.id, username: s.user.username })
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(and(eq(s.teamMember.teamId, teamId), inArray(s.teamMember.userId, [...ids])))
    .all();
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length > 0) {
    throw errors.validation('Only members of the team can be assigned', { userIds: missing });
  }
  return rows.map((row) => ({ id: row.id, label: `@${row.username ?? row.id}` }));
}

/** Team roles among `ids` (as "Name (role)"); `@everyone` can't be assigned. */
function roleRefs(db: DbExecutor, teamId: string, ids: readonly string[]): NamedRef[] {
  if (ids.length === 0) return [];
  const rows = db
    .select({ id: s.role.id, name: s.role.name, isEveryone: s.role.isEveryone })
    .from(s.role)
    .where(and(eq(s.role.teamId, teamId), inArray(s.role.id, [...ids])))
    .all();
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length > 0) {
    throw errors.validation('Only roles of the team can be assigned', { roleIds: missing });
  }
  if (rows.some((row) => row.isEveryone)) {
    throw errors.validation(
      'Tasks can’t be assigned to @everyone. Leave the task unassigned so anyone can pick it up.',
    );
  }
  return rows.map((row) => ({ id: row.id, label: `${row.name} (role)` }));
}

function labelRefs(db: DbExecutor, projectId: string, ids: readonly string[]): NamedRef[] {
  if (ids.length === 0) return [];
  const rows = db
    .select({ id: s.label.id, name: s.label.name })
    .from(s.label)
    .where(and(eq(s.label.projectId, projectId), inArray(s.label.id, [...ids])))
    .all();
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length > 0) {
    throw errors.validation('Labels must be labels of this project', { labelIds: missing });
  }
  return rows.map((row) => ({ id: row.id, label: row.name }));
}

function sortedLabels(refs: readonly NamedRef[]): string[] {
  return refs
    .map((ref) => ref.label)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function priorityLabel(value: PriorityValue): string {
  return PRIORITIES[value]?.label ?? 'No priority';
}

const EXCERPT_LENGTH = 140;

/** Search text and audit excerpt of a description, computed before the write lock is taken. */
function describe(description: string) {
  return { plain: markdownToPlainText(description), excerpt: excerpt(description, EXCERPT_LENGTH) };
}

// ---------------------------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------------------------

/** Assigned users, directly or through their roles. */
function assignedUserIds(tx: Tx, taskId: string): string[] {
  const direct = tx
    .select({ id: s.taskAssigneeUser.userId })
    .from(s.taskAssigneeUser)
    .where(eq(s.taskAssigneeUser.taskId, taskId))
    .all()
    .map((row) => row.id);
  const roleIds = tx
    .select({ id: s.taskAssigneeRole.roleId })
    .from(s.taskAssigneeRole)
    .where(eq(s.taskAssigneeRole.taskId, taskId))
    .all()
    .map((row) => row.id);
  return [...new Set([...direct, ...roleMemberIds(tx, roleIds)])];
}

export interface TransitionContext {
  task: TaskRow;
  projectKey: string;
  teamSlug: string;
}

export interface StatusTransition {
  /** Columns to set on the task. */
  patch: Partial<TaskRow>;
  /**
   * Audits the claim release a done status caused (`task.released`); the caller runs it after
   * recording its own status change, so history reads "moved to Done", then "released".
   */
  recordRelease: () => void;
}

/**
 * Side effects of moving a task from one status to another, inside the caller's write. Entering
 * a `done` status sets `completedAt`, resolves the issues it `fixes`, notifies the author and
 * assignees (`task_done`) and releases the claim; returning to an `open` status clears
 * `completedAt`.
 */
export function applyStatusTransition(
  tx: Tx,
  actor: Actor,
  context: TransitionContext,
  from: Pick<StatusRow, 'category'>,
  to: Pick<StatusRow, 'category' | 'name'>,
  now: Date,
  notified: NotifiedSet,
): StatusTransition {
  const none = () => undefined;
  if (from.category === to.category) return { patch: {}, recordRelease: none };
  if (to.category === 'open') return { patch: { completedAt: null }, recordRelease: none };
  const { task, projectKey, teamSlug } = context;
  resolveFixedIssues(tx, actor, linkSubject(task, projectKey), notified, now);
  notifyUsers(
    tx,
    actor,
    'task_done',
    [...(task.authorId ? [task.authorId] : []), ...assignedUserIds(tx, task.id)],
    notificationTarget(task, { key: projectKey }, { slug: teamSlug }, `Moved to ${to.name}`),
    notified,
  );
  const claimed = task.claimedById !== null || task.claimedAt !== null;
  const wasValid = isClaimValid(task, now);
  return {
    patch: { completedAt: now, ...(claimed ? releasedClaim() : {}) },
    recordRelease: () => {
      if (!wasValid) return;
      recordActivity(tx, actor, {
        teamId: task.teamId,
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        action: 'task.released',
        meta: { ...taskMeta(task, projectKey), reason: 'done' },
      });
      emitAfterCommit(tx, taskEvent('task.released', task, actor));
    },
  };
}

/** Task columns that clear a claim. */
export function releasedClaim() {
  return { claimedById: null, claimedViaKeyId: null, claimedAt: null, claimExpiresAt: null };
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface CreateOptions {
  /** Issue the task was created from (`meta.fromIssue`). */
  fromIssue?: string;
}

/**
 * Creates a task (`CREATE_TASKS`): next number of the project, in the default status unless
 * another is given, at the end of its column. The author and user assignees are subscribed;
 * assignees (directly or through a role) and mentioned members are notified.
 */
export function createTask(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateTaskData,
  options: CreateOptions = {},
): Task {
  const { orm } = deps.db;
  const { project, team, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'CREATE_TASKS', "You don't have permission to create tasks");
  const description = input.description ?? '';
  const text = describe(description);

  const taskId = deps.db.write((tx) => {
    const now = new Date();
    const status = input.statusId
      ? statusOfProject(tx, projectId, input.statusId)
      : defaultStatus(tx, projectId);
    const users = memberRefs(tx, team.id, [...new Set(input.assigneeUserIds ?? [])]);
    const roles = roleRefs(tx, team.id, [...new Set(input.assigneeRoleIds ?? [])]);
    const labels = labelRefs(tx, projectId, [...new Set(input.labelIds ?? [])]);
    const counter = tx
      .update(s.project)
      .set({ taskSeq: sql`${s.project.taskSeq} + 1`, updatedAt: sql`${s.project.updatedAt}` })
      .where(eq(s.project.id, projectId))
      .returning({ taskSeq: s.project.taskSeq })
      .get();
    if (!counter) throw errors.notFound('Project');

    const row = tx
      .insert(s.task)
      .values({
        id: newId(),
        projectId,
        teamId: team.id,
        number: counter.taskSeq,
        title: input.title,
        description,
        statusId: status.id,
        priority: input.priority ?? 0,
        dueDate: input.dueDate ?? null,
        position: appendPosition(tx, status.id),
        authorId: actor.userId,
        viaKeyId: actor.key?.id ?? null,
        completedAt: status.category === 'done' ? now : null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (labels.length > 0) {
      tx.insert(s.taskLabel)
        .values(labels.map((label) => ({ taskId: row.id, labelId: label.id })))
        .run();
    }
    if (users.length > 0) {
      tx.insert(s.taskAssigneeUser)
        .values(users.map((user) => ({ taskId: row.id, userId: user.id })))
        .run();
    }
    if (roles.length > 0) {
      tx.insert(s.taskAssigneeRole)
        .values(roles.map((role) => ({ taskId: row.id, roleId: role.id })))
        .run();
    }
    const subject = linkSubject(row, project.key);
    if (input.blockedByTaskIds?.length) {
      applyBlockersChange(tx, subject, { add: input.blockedByTaskIds });
    }
    if (input.issueLinks?.length) {
      applyIssueLinksChange(tx, actor, membership, subject, { add: input.issueLinks });
    }
    attachToParent(
      tx,
      actor,
      [
        ...new Set([
          ...(input.attachmentIds ?? []),
          ...referencedPendingUploads(tx, actor, team.id, description),
        ]),
      ],
      { type: 'task', id: row.id, teamId: team.id, projectId },
    );
    autoSubscribe(tx, [actor.userId, ...users.map((user) => user.id)], 'task', row.id);
    recordActivity(tx, actor, {
      teamId: team.id,
      projectId,
      entityType: 'task',
      entityId: row.id,
      action: 'task.created',
      meta: {
        ...taskMeta(row, project.key),
        status: status.name,
        ...(options.fromIssue ? { fromIssue: options.fromIssue } : {}),
      },
    });
    indexSearch(tx, {
      entityType: 'task',
      entityId: row.id,
      teamId: team.id,
      projectId,
      title: row.title,
      text: text.plain,
    });
    const target = notificationTarget(row, project, team, description);
    const notified = new Set<string>();
    notifyAssigned(
      tx,
      actor,
      target,
      { userIds: users.map((user) => user.id), roleIds: roles.map((role) => role.id) },
      notified,
    );
    notifyMentions(tx, actor, target, description, { notified });
    if (status.category === 'done') {
      resolveFixedIssues(tx, actor, subject, notified, now);
    }
    emitAfterCommit(tx, taskEvent('task.created', row, actor));
    return row.id;
  });
  return getTask(deps, actor, taskId);
}

/**
 * Creates a task from an issue (the issue page's "Create task"): the issue's title, a link back
 * to the issue at the top of the description followed by the issue's body, the issue's labels
 * (matched by name in the task's project) and a `fixes` link, so finishing the task resolves the
 * issue. Members who may not resolve the issue (not its author, no `RESOLVE_ISSUES`) get a
 * `relates` link instead. Audited on both: `task.created` (`meta.fromIssue`) and `issue.links_changed`.
 */
export function createTaskFromIssue(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateTaskFromIssueInput,
): Task {
  const { orm } = deps.db;
  const { team, membership } = requireProject(orm, actor, projectId);
  const found = orm
    .select({ issue: s.issue, key: s.project.key })
    .from(s.issue)
    .innerJoin(s.project, eq(s.project.id, s.issue.projectId))
    .where(
      and(
        eq(s.issue.id, input.issueId),
        eq(s.issue.teamId, team.id),
        isNull(s.issue.deletedAt),
        isNull(s.project.deletedAt),
      ),
    )
    .get();
  if (!found) throw errors.notFound('Issue');
  const { issue, key } = found;
  const ref = formatIssueRef(key, issue.number);

  const header = `From issue [${ref}](${appPaths.issue(team.slug, key, issue.number)}): ${issue.title}`;
  const room = LIMITS.body.max - header.length - 2;
  const body = issue.body.trim().slice(0, Math.max(0, room));
  const description = body ? `${header}\n\n${body}` : header;

  const issueLabelNames = orm
    .select({ name: s.label.name })
    .from(s.issueLabel)
    .innerJoin(s.label, eq(s.label.id, s.issueLabel.labelId))
    .where(eq(s.issueLabel.issueId, issue.id))
    .all()
    .map((row) => row.name.toLowerCase());
  const labelIds = orm
    .select({ id: s.label.id, name: s.label.name })
    .from(s.label)
    .where(eq(s.label.projectId, projectId))
    .all()
    .filter((label) => issueLabelNames.includes(label.name.toLowerCase()))
    .map((label) => label.id);

  return createTask(
    deps,
    actor,
    projectId,
    {
      title: issue.title,
      description,
      labelIds,
      // `fixes` resolves the issue when the task is done: only for those who may resolve it.
      issueLinks: [
        {
          issueId: issue.id,
          kind: canTriageIssue(membership, issue.authorId) ? 'fixes' : 'relates',
        },
      ],
    },
    { fromIssue: ref },
  );
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

function currentIds(
  tx: Tx,
  table: typeof s.taskAssigneeUser | typeof s.taskAssigneeRole | typeof s.taskLabel,
  taskId: string,
): string[] {
  if (table === s.taskAssigneeUser) {
    return tx
      .select({ id: s.taskAssigneeUser.userId })
      .from(s.taskAssigneeUser)
      .where(eq(s.taskAssigneeUser.taskId, taskId))
      .all()
      .map((row) => row.id);
  }
  if (table === s.taskAssigneeRole) {
    return tx
      .select({ id: s.taskAssigneeRole.roleId })
      .from(s.taskAssigneeRole)
      .where(eq(s.taskAssigneeRole.taskId, taskId))
      .all()
      .map((row) => row.id);
  }
  return tx
    .select({ id: s.taskLabel.labelId })
    .from(s.taskLabel)
    .where(eq(s.taskLabel.taskId, taskId))
    .all()
    .map((row) => row.id);
}

interface ListDiff {
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
}

function listDiff(current: readonly string[], changeSet: IdListChange | undefined): ListDiff {
  const after = changeSet ? applyIdChange(current, changeSet) : [...current];
  return {
    before: [...current],
    after,
    added: after.filter((id) => !current.includes(id)),
    removed: current.filter((id) => !after.includes(id)),
  };
}

/** Writes a join-table diff (assignees, labels). */
function writeJoin(
  tx: Tx,
  kind: 'users' | 'roles' | 'labels',
  taskId: string,
  diff: ListDiff,
): void {
  if (diff.removed.length > 0) {
    if (kind === 'users') {
      tx.delete(s.taskAssigneeUser)
        .where(
          and(
            eq(s.taskAssigneeUser.taskId, taskId),
            inArray(s.taskAssigneeUser.userId, diff.removed),
          ),
        )
        .run();
    } else if (kind === 'roles') {
      tx.delete(s.taskAssigneeRole)
        .where(
          and(
            eq(s.taskAssigneeRole.taskId, taskId),
            inArray(s.taskAssigneeRole.roleId, diff.removed),
          ),
        )
        .run();
    } else {
      tx.delete(s.taskLabel)
        .where(and(eq(s.taskLabel.taskId, taskId), inArray(s.taskLabel.labelId, diff.removed)))
        .run();
    }
  }
  if (diff.added.length > 0) {
    if (kind === 'users') {
      tx.insert(s.taskAssigneeUser)
        .values(diff.added.map((userId) => ({ taskId, userId })))
        .run();
    } else if (kind === 'roles') {
      tx.insert(s.taskAssigneeRole)
        .values(diff.added.map((roleId) => ({ taskId, roleId })))
        .run();
    } else {
      tx.insert(s.taskLabel)
        .values(diff.added.map((labelId) => ({ taskId, labelId })))
        .run();
    }
  }
}

function hasWorkflowFields(input: UpdateTaskData): boolean {
  return (
    input.statusId !== undefined ||
    input.priority !== undefined ||
    input.dueDate !== undefined ||
    input.assigneeUsers !== undefined ||
    input.assigneeRoles !== undefined ||
    input.labels !== undefined ||
    input.blockedBy !== undefined ||
    input.issueLinks !== undefined
  );
}

/**
 * Updates a task. Lists (assignees, labels, blockers, issue links) take `set`, or `add`/`remove`.
 * A new status puts the task at the end of that column (see `moveTask` for exact placement).
 * Audited once as `task.updated` with every field change; an update that changes nothing is a
 * no-op. A write by the claim holder renews the lease.
 */
export function updateTask(
  deps: AppDeps,
  actor: Actor,
  taskId: string,
  input: UpdateTaskData,
): Task {
  const { orm } = deps.db;
  const { task, project, team, membership } = requireTask(orm, actor, taskId);
  if (input.title !== undefined || input.description !== undefined) {
    requireCanEditContent(membership, task.authorId);
  }
  if (hasWorkflowFields(input)) requireCanUpdateTask(membership, task);
  if (
    input.attachmentIds?.length &&
    !canEditContent(membership, task.authorId) &&
    !canUpdateTask(membership, task)
  ) {
    throw errors.forbidden("You can't add files to this task");
  }
  const descriptionChanged =
    input.description !== undefined && input.description !== task.description;
  const newText = descriptionChanged ? describe(input.description ?? '') : null;
  const oldExcerpt = descriptionChanged ? excerpt(task.description, EXCERPT_LENGTH) : '';

  deps.db.write((tx) => {
    const now = new Date();
    const current = tx.select().from(s.task).where(eq(s.task.id, taskId)).get() ?? task;
    const changes: Changes = {};
    const patch: Partial<TaskRow> = {};
    const notified = new Set<string>();
    let transition: StatusTransition | null = null;

    if (input.title !== undefined && input.title !== current.title) {
      changes.title = change(current.title, input.title);
      patch.title = input.title;
    }
    if (descriptionChanged && newText && input.description !== undefined) {
      changes.description = change(oldExcerpt, newText.excerpt);
      patch.description = input.description;
    }
    if (patch.title !== undefined || patch.description !== undefined) patch.editedAt = now;
    if (input.priority !== undefined && input.priority !== current.priority) {
      changes.priority = change(priorityLabel(current.priority), priorityLabel(input.priority));
      patch.priority = input.priority;
    }
    if (input.dueDate !== undefined && input.dueDate !== current.dueDate) {
      changes.dueDate = change(current.dueDate, input.dueDate);
      patch.dueDate = input.dueDate;
    }

    // Assignees (members and roles, audited together) and labels.
    const users = listDiff(currentIds(tx, s.taskAssigneeUser, taskId), input.assigneeUsers);
    const roles = listDiff(currentIds(tx, s.taskAssigneeRole, taskId), input.assigneeRoles);
    const labels = listDiff(currentIds(tx, s.taskLabel, taskId), input.labels);
    const addedUsers = memberRefs(tx, team.id, users.added);
    const addedRoles = roleRefs(tx, team.id, roles.added);
    labelRefs(tx, project.id, labels.added);
    if (users.added.length || users.removed.length || roles.added.length || roles.removed.length) {
      const names = new Map(
        [
          ...memberNames(tx, [...users.before, ...users.after]),
          ...roleNames(tx, [...roles.before, ...roles.after]),
        ].map((ref) => [ref.id, ref.label]),
      );
      const label = (ids: readonly string[]) =>
        ids.map((id) => names.get(id) ?? id).sort((a, b) => a.localeCompare(b));
      changes.assignees = change(
        [...label(users.before), ...label(roles.before)],
        [...label(users.after), ...label(roles.after)],
      );
      writeJoin(tx, 'users', taskId, users);
      writeJoin(tx, 'roles', taskId, roles);
    }
    if (labels.added.length || labels.removed.length) {
      const names = labelRefs(tx, project.id, [...new Set([...labels.before, ...labels.after])]);
      const pick = (ids: readonly string[]) =>
        sortedLabels(names.filter((ref) => ids.includes(ref.id)));
      changes.labels = change(pick(labels.before), pick(labels.after));
      writeJoin(tx, 'labels', taskId, labels);
    }

    const subject = linkSubject(current, project.key);
    if (input.blockedBy) Object.assign(changes, applyBlockersChange(tx, subject, input.blockedBy));
    if (input.issueLinks) {
      Object.assign(
        changes,
        applyIssueLinksChange(tx, actor, membership, subject, input.issueLinks),
      );
    }

    if (input.statusId !== undefined && input.statusId !== current.statusId) {
      const from = statusOfProject(tx, project.id, current.statusId);
      const to = statusOfProject(tx, project.id, input.statusId);
      changes.status = change(from.name, to.name);
      patch.statusId = to.id;
      patch.position = appendPosition(tx, to.id);
      transition = applyStatusTransition(
        tx,
        actor,
        { task: current, projectKey: project.key, teamSlug: team.slug },
        from,
        to,
        now,
        notified,
      );
      Object.assign(patch, transition.patch);
    }

    const uploads = [
      ...new Set([
        ...(input.attachmentIds ?? []),
        ...(descriptionChanged && input.description !== undefined
          ? referencedPendingUploads(tx, actor, team.id, input.description)
          : []),
      ]),
    ];
    attachToParent(tx, actor, uploads, {
      type: 'task',
      id: taskId,
      teamId: team.id,
      projectId: project.id,
    });
    if (!hasChanges(changes)) {
      if (uploads.length > 0) renewClaimOnWrite(tx, actor, taskId, now);
      return;
    }

    const updated = tx
      .update(s.task)
      .set({ ...patch, updatedAt: now, lastActivityAt: now })
      .where(eq(s.task.id, taskId))
      .returning()
      .get();
    renewClaimOnWrite(tx, actor, taskId, now);
    recordActivity(tx, actor, {
      teamId: team.id,
      projectId: project.id,
      entityType: 'task',
      entityId: taskId,
      action: 'task.updated',
      changes,
      meta: taskMeta(updated, project.key),
    });
    transition?.recordRelease();
    if (changes.title || changes.description) {
      indexSearch(tx, {
        entityType: 'task',
        entityId: taskId,
        teamId: team.id,
        projectId: project.id,
        title: updated.title,
        text: newText?.plain ?? markdownToPlainText(updated.description),
      });
    }
    const target = notificationTarget(updated, project, team, updated.description);
    if (changes.title || changes.description) refreshNotificationText(tx, target);
    if (addedUsers.length || addedRoles.length) {
      autoSubscribe(
        tx,
        addedUsers.map((user) => user.id),
        'task',
        taskId,
      );
      notifyAssigned(
        tx,
        actor,
        target,
        { userIds: addedUsers.map((user) => user.id), roleIds: addedRoles.map((role) => role.id) },
        notified,
      );
    }
    if (descriptionChanged) {
      notifyMentions(tx, actor, target, updated.description, {
        previousBody: current.description,
        notified,
      });
    }
    emitAfterCommit(tx, taskEvent('task.updated', updated, actor));
  });
  return getTask(deps, actor, taskId);
}

/** `@username` of users (any team membership), for audit values of removed assignees. */
function memberNames(tx: Tx, ids: readonly string[]): NamedRef[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return tx
    .select({ id: s.user.id, username: s.user.username })
    .from(s.user)
    .where(inArray(s.user.id, unique))
    .all()
    .map((row) => ({ id: row.id, label: `@${row.username ?? row.id}` }));
}

function roleNames(tx: Tx, ids: readonly string[]): NamedRef[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return tx
    .select({ id: s.role.id, name: s.role.name })
    .from(s.role)
    .where(inArray(s.role.id, unique))
    .all()
    .map((row) => ({ id: row.id, label: `${row.name} (role)` }));
}

// ---------------------------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------------------------

/**
 * Moves a task on the board: to another status and/or between two neighbours (`afterId` is the
 * card above, `beforeId` the card below; neither means the end of the column). Across columns it
 * is audited as a status change (with the done/open side effects); within a column as a position
 * change (1-based, top to bottom).
 */
export function moveTask(deps: AppDeps, actor: Actor, taskId: string, input: MoveTaskInput): Task {
  const { orm } = deps.db;
  const { task, project, team, membership } = requireTask(orm, actor, taskId);
  requireCanUpdateTask(membership, task, "You don't have permission to move tasks");
  if (input.afterId === taskId || input.beforeId === taskId) {
    throw errors.validation('A task can’t be placed next to itself');
  }

  deps.db.write((tx) => {
    const now = new Date();
    const current = tx.select().from(s.task).where(eq(s.task.id, taskId)).get() ?? task;
    const from = statusOfProject(tx, project.id, current.statusId);
    const to = input.statusId ? statusOfProject(tx, project.id, input.statusId) : from;
    const column = columnOf(tx, to.id, taskId);
    const neighbour = input.afterId ?? input.beforeId;
    let index = column.length;
    if (neighbour) {
      const at = column.findIndex((row) => row.id === neighbour);
      if (at === -1) {
        throw errors.validation(`The task to place it next to isn't in the ${to.name} column`);
      }
      index = input.afterId ? at + 1 : at;
    }

    const changes: Changes = {};
    const patch: Partial<TaskRow> = {};
    const notified = new Set<string>();
    let transition: StatusTransition | null = null;
    if (to.id !== from.id) {
      changes.status = change(from.name, to.name);
      patch.statusId = to.id;
      transition = applyStatusTransition(
        tx,
        actor,
        { task: current, projectKey: project.key, teamSlug: team.slug },
        from,
        to,
        now,
        notified,
      );
      Object.assign(patch, transition.patch);
    } else {
      const before = columnOf(tx, to.id).findIndex((row) => row.id === taskId);
      if (before === index) return;
      changes.position = change(before + 1, index + 1);
    }
    patch.position = keyAt(tx, column, index);

    const updated = tx
      .update(s.task)
      .set({ ...patch, updatedAt: now, lastActivityAt: now })
      .where(eq(s.task.id, taskId))
      .returning()
      .get();
    renewClaimOnWrite(tx, actor, taskId, now);
    recordActivity(tx, actor, {
      teamId: team.id,
      projectId: project.id,
      entityType: 'task',
      entityId: taskId,
      action: 'task.moved',
      changes,
      meta: { ...taskMeta(updated, project.key), status: to.name },
    });
    transition?.recordRelease();
    emitAfterCommit(tx, taskEvent('task.updated', updated, actor));
  });
  return getTask(deps, actor, taskId);
}

// ---------------------------------------------------------------------------------------------
// Delete / restore
// ---------------------------------------------------------------------------------------------

/**
 * Moves a task to Trash (author, or `DELETE_ANY_CONTENT`). It disappears from boards, lists,
 * search and MCP results; its claim is dropped. Restorable for 30 days.
 */
export function deleteTask(deps: AppDeps, actor: Actor, taskId: string): { ok: true } {
  const { orm } = deps.db;
  const { task, project, membership } = requireTask(orm, actor, taskId);
  requireCanDeleteContent(membership, task.authorId);
  deps.db.write((tx) => {
    tx.update(s.task)
      .set({
        deletedAt: new Date(),
        deletedById: actor.userId,
        deletedViaKeyId: actor.key?.id ?? null,
        ...releasedClaim(),
      })
      .where(eq(s.task.id, taskId))
      .run();
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: taskId,
      action: 'task.deleted',
      meta: taskMeta(task, project.key),
    });
    emitAfterCommit(tx, taskEvent('task.deleted', task, actor));
  });
  return { ok: true };
}

/**
 * Restores a task from Trash (author, or `MANAGE_TRASH`) at its old place on the board. A task of
 * a project in Trash can't come back on its own: restore the project instead.
 */
export function restoreTask(deps: AppDeps, actor: Actor, taskId: string): Task {
  const { orm } = deps.db;
  const found = orm
    .select({ task: s.task, project: s.project })
    .from(s.task)
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .where(eq(s.task.id, taskId))
    .get();
  if (!found?.task.deletedAt) throw errors.notFound('Deleted task');
  const { task, project } = found;
  const membership = requireMember(orm, actor, task.teamId, 'Deleted task');
  if (!canRestoreContent(membership, task.authorId)) {
    throw errors.forbidden('You can only restore your own tasks');
  }
  if (project.deletedAt) {
    throw errors.conflict(
      `This task's project is in Trash. Restore the project ${project.key} instead`,
    );
  }
  deps.db.write((tx) => {
    tx.update(s.task)
      .set({ deletedAt: null, deletedById: null, deletedViaKeyId: null })
      .where(eq(s.task.id, taskId))
      .run();
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: taskId,
      action: 'task.restored',
      meta: taskMeta(task, project.key),
    });
    emitAfterCommit(tx, taskEvent('task.restored', task, actor));
  });
  return getTask(deps, actor, taskId);
}
