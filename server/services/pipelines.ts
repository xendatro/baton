import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Principal, PrincipalRule } from '@shared/principals';
import { formatTaskRef } from '@shared/refs';
import {
  DEFAULT_STAGE_RULES,
  hasStageRules,
  isGatedStage,
  RULE_HANDOFF_MODES,
  stageRulesSchema,
  type ApprovalInput,
  type EvidenceInput,
  type StageApproval,
  type StageCriterion,
  type StageRules,
  type StageRulesPatch,
  type TaskPipelineSummary,
  type TaskStage,
} from '@shared/schemas/pipelines';
import type { Task } from '@shared/schemas/tasks';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change, type Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/markdown';
import { appPaths } from '../lib/urls';
import { getProjectAccess, hasPermission, projectViewerIds, type Membership } from './access';
import { recordActivity } from './activity';
import { isClaimValid } from './claimLease';
import { emitAfterCommit } from './events';
import { queueLinkedIssueEvents } from './linkEvents';
import { notifyAssigned, notifyUsers, type NotifiedSet } from './notifications';
import { onStageApprovalsReset, onTaskEnteredStage } from './pipelineHooks';
import { matchesRule, expandRule } from './principals';
import { autoSubscribe } from './subscriptions';
import {
  appendPosition,
  applyStatusTransition,
  canUpdateTask,
  getTask,
  releasedClaim,
  requireTask,
  taskEvent,
  taskMeta,
} from './tasks';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Pipelines (docs/design/agents-and-pipelines.md §5): per-status ("stage") rules.
 *
 *   - On enter: the hand-off (who gets the task), `notify`, a `task_stage_entry` row, and the
 *     Wave 2C hook `onTaskEnteredStage` (server/services/pipelineHooks.ts).
 *   - To leave forward (to a later column or the stage's `nextStatusId`): the move rule, evidence
 *     for every exit criterion and enough approvals. Skipping a later stage that has such rules
 *     is refused too, so a gate can't be jumped over.
 *   - Backward from a gated stage: only to the previous column, when `allowSendBack`.
 *   - Team owner / ADMINISTRATOR may force any move with a reason (`task.forced`).
 *
 * Every function taking a `tx` runs inside the caller's write. A project whose statuses have no
 * rules behaves exactly as before (nothing is checked; only the stage entries are recorded).
 */

export type StatusRow = typeof s.status.$inferSelect;
type TaskRow = typeof s.task.$inferSelect;
type ProjectRow = typeof s.project.$inferSelect;

interface Scope {
  teamId: string;
  projectId: string;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/** The rules of a status row (defaults for columns never set). */
export function rulesOf(row: StatusRow): StageRules {
  return {
    instructions: row.instructions,
    handoff: row.handoff ?? { mode: 'keep' },
    notify: row.notify ?? null,
    exitCriteria: row.exitCriteria,
    moveRule: row.moveRule ?? null,
    approvals: row.approvals
      ? { ...row.approvals, dismissOnChange: row.approvals.dismissOnChange ?? false }
      : null,
    autoAdvance: row.autoAdvance,
    nextStatusId: row.nextStatusId,
    allowSendBack: row.allowSendBack,
  };
}

/** Status columns for `rules`. */
export function ruleColumns(rules: StageRules) {
  const handoff =
    rules.handoff.mode === 'keep'
      ? null
      : {
          mode: rules.handoff.mode,
          ...(RULE_HANDOFF_MODES.has(rules.handoff.mode) && rules.handoff.rule
            ? { rule: rules.handoff.rule }
            : {}),
          ...(rules.handoff.mode === 'stage_holder' && rules.handoff.statusId
            ? { statusId: rules.handoff.statusId }
            : {}),
        };
  return {
    instructions: rules.instructions,
    handoff,
    notify: rules.notify,
    exitCriteria: rules.exitCriteria,
    moveRule: rules.moveRule,
    approvals: rules.approvals,
    autoAdvance: rules.autoAdvance,
    nextStatusId: rules.nextStatusId,
    allowSendBack: rules.allowSendBack,
  };
}

/** The project's statuses in column order. */
export function projectStatuses(db: DbExecutor, projectId: string): StatusRow[] {
  return db
    .select()
    .from(s.status)
    .where(eq(s.status.projectId, projectId))
    .orderBy(asc(s.status.position), asc(s.status.createdAt))
    .all();
}

/** The stage after `from`: its `nextStatusId`, else the next column (null: the last stage). */
export function nextStage(statuses: readonly StatusRow[], from: StatusRow): StatusRow | null {
  const rules = rulesOf(from);
  if (rules.nextStatusId) {
    const next = statuses.find((row) => row.id === rules.nextStatusId);
    if (next && next.id !== from.id) return next;
  }
  const index = statuses.findIndex((row) => row.id === from.id);
  return statuses[index + 1] ?? null;
}

function previousStage(statuses: readonly StatusRow[], from: StatusRow): StatusRow | null {
  const index = statuses.findIndex((row) => row.id === from.id);
  return index > 0 ? (statuses[index - 1] ?? null) : null;
}

/** Does any status of the project have pipeline rules (or instructions)? */
function hasPipeline(statuses: readonly StatusRow[]): boolean {
  return statuses.some((row) => {
    const rules = rulesOf(row);
    return hasStageRules(rules) || rules.instructions.trim() !== '';
  });
}

// ---------------------------------------------------------------------------------------------
// Describing rules
// ---------------------------------------------------------------------------------------------

interface NameBook {
  users: Map<string, string>;
  roles: Map<string, { name: string; isEveryone: boolean }>;
  projectRoles: Map<string, string>;
}

function nameBook(
  db: DbExecutor,
  rules: ReadonlyArray<PrincipalRule | null | undefined>,
): NameBook {
  const principals = rules.flatMap((rule) => (rule ? [...rule.allow, ...rule.deny] : []));
  const ids = (type: Principal['type']) => [
    ...new Set(
      principals.flatMap((p) =>
        p.type === type && 'userId' in p
          ? [p.userId]
          : p.type === type && 'roleId' in p
            ? [p.roleId]
            : [],
      ),
    ),
  ];
  const userIds = ids('user');
  const roleIds = ids('role');
  const projectRoleIds = ids('project_role');
  return {
    users: new Map(
      userIds.length
        ? db
            .select({ id: s.user.id, username: s.user.username })
            .from(s.user)
            .where(inArray(s.user.id, userIds))
            .all()
            .map((row) => [row.id, `@${row.username ?? row.id}`])
        : [],
    ),
    roles: new Map(
      roleIds.length
        ? db
            .select({ id: s.role.id, name: s.role.name, isEveryone: s.role.isEveryone })
            .from(s.role)
            .where(inArray(s.role.id, roleIds))
            .all()
            .map((row) => [row.id, { name: row.name, isEveryone: row.isEveryone }])
        : [],
    ),
    projectRoles: new Map(
      projectRoleIds.length
        ? db
            .select({ id: s.projectRole.id, name: s.projectRole.name })
            .from(s.projectRole)
            .where(inArray(s.projectRole.id, projectRoleIds))
            .all()
            .map((row) => [row.id, row.name])
        : [],
    ),
  };
}

const SCOPE_WORDS = { both: '', people: 'people', agents: 'agents' } as const;

function principalLabel(principal: Principal, book: NameBook): string {
  switch (principal.type) {
    case 'user':
      return book.users.get(principal.userId) ?? 'a former member';
    case 'everyone':
      return principal.scope === 'both'
        ? 'everyone'
        : principal.scope === 'people'
          ? 'every person'
          : 'every agent';
    case 'role': {
      const role = book.roles.get(principal.roleId);
      const name = role ? (role.isEveryone ? '@everyone' : role.name) : 'a deleted role';
      const scope = SCOPE_WORDS[principal.scope];
      return scope ? `${name} (${scope})` : name;
    }
    case 'project_role': {
      const name = book.projectRoles.get(principal.roleId) ?? 'a deleted project role';
      const scope = SCOPE_WORDS[principal.scope];
      return `${name} (project role${scope ? `, ${scope}` : ''})`;
    }
  }
}

/** "a, b or c". */
function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

function ruleText(rule: PrincipalRule, book: NameBook): string {
  if (rule.allow.length === 0) return 'nobody';
  const allowed = joinOr(rule.allow.map((p) => principalLabel(p, book)));
  if (rule.deny.length === 0) return allowed;
  return `${allowed}, except ${joinOr(rule.deny.map((p) => principalLabel(p, book)))}`;
}

/** A "who" rule in words: "Reviewer (people) or @ann, except @ben". */
export function describeRule(db: DbExecutor, rule: PrincipalRule): string {
  return ruleText(rule, nameBook(db, [rule]));
}

const HANDOFF_WORDS: Record<StageRules['handoff']['mode'], string> = {
  keep: 'Keep the assignees',
  specific: 'Assign',
  pool: 'Pool for',
  round_robin: 'Round robin among',
  least_busy: 'Least busy of',
  author: 'Assign the author',
  mover: 'Assign whoever moved it',
  stage_holder: 'Assign whoever held it in',
};

/** Rule values as the audit log shows them (status names, rules in words). */
function ruleSummaries(db: DbExecutor, rules: StageRules): Record<keyof StageRules, unknown> {
  const book = nameBook(db, [
    rules.handoff.rule,
    rules.notify,
    rules.moveRule,
    rules.approvals?.rule,
  ]);
  const statusName = (id: string | null | undefined) =>
    id
      ? (db.select({ name: s.status.name }).from(s.status).where(eq(s.status.id, id)).get()?.name ??
        null)
      : null;
  const { handoff } = rules;
  const handoffText = RULE_HANDOFF_MODES.has(handoff.mode)
    ? `${HANDOFF_WORDS[handoff.mode]} ${handoff.rule ? ruleText(handoff.rule, book) : 'nobody'}`
    : handoff.mode === 'stage_holder'
      ? `${HANDOFF_WORDS.stage_holder} ${statusName(handoff.statusId) ?? 'a deleted stage'}`
      : HANDOFF_WORDS[handoff.mode];
  return {
    instructions: excerpt(rules.instructions, 140),
    handoff: handoffText,
    notify: rules.notify ? ruleText(rules.notify, book) : null,
    exitCriteria: rules.exitCriteria.map((criterion) => criterion.text),
    moveRule: rules.moveRule ? ruleText(rules.moveRule, book) : null,
    approvals: rules.approvals
      ? `${rules.approvals.count} from ${ruleText(rules.approvals.rule, book)}${
          rules.approvals.dismissOnChange ? ', dismissed on change' : ''
        }`
      : null,
    autoAdvance: rules.autoAdvance,
    nextStatusId: statusName(rules.nextStatusId),
    allowSendBack: rules.allowSendBack,
  };
}

/** Field changes between two rule sets, with human-readable values. */
export function ruleChanges(db: DbExecutor, before: StageRules, after: StageRules): Changes {
  const a = ruleSummaries(db, before);
  const b = ruleSummaries(db, after);
  const changes: Changes = {};
  for (const key of Object.keys(after) as Array<keyof StageRules>) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    const field = key === 'nextStatusId' ? 'nextStage' : key;
    changes[field] = change(a[key], b[key]);
  }
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Validating rules (status settings, copying)
// ---------------------------------------------------------------------------------------------

/** Throws `validation_failed` naming principals the project's team doesn't have. */
function validatePrincipals(db: DbExecutor, scope: Scope, rules: StageRules): void {
  const principals = [
    rules.handoff.rule,
    rules.notify,
    rules.moveRule,
    rules.approvals?.rule,
  ].flatMap((rule) => (rule ? [...rule.allow, ...rule.deny] : []));
  const bad: string[] = [];
  for (const principal of principals) {
    if (principal.type === 'user') {
      const member = db
        .select({ userId: s.teamMember.userId })
        .from(s.teamMember)
        .where(
          and(eq(s.teamMember.teamId, scope.teamId), eq(s.teamMember.userId, principal.userId)),
        )
        .get();
      if (!member) bad.push(`user ${principal.userId}`);
    } else if (principal.type === 'role') {
      const role = db
        .select({ id: s.role.id })
        .from(s.role)
        .where(and(eq(s.role.id, principal.roleId), eq(s.role.teamId, scope.teamId)))
        .get();
      if (!role) bad.push(`role ${principal.roleId}`);
    } else if (principal.type === 'project_role') {
      const role = db
        .select({ id: s.projectRole.id })
        .from(s.projectRole)
        .where(
          and(eq(s.projectRole.id, principal.roleId), eq(s.projectRole.projectId, scope.projectId)),
        )
        .get();
      if (!role) bad.push(`project role ${principal.roleId}`);
    }
  }
  if (bad.length > 0) {
    throw errors.validation(
      'Rules can only name members, roles and project roles of this team and project',
      { principals: bad },
    );
  }
}

/**
 * The rules of `status` with `patch` applied, validated against the project: stages it names are
 * statuses of the project, principals exist in its team.
 */
export function mergeRules(
  db: DbExecutor,
  scope: Scope,
  statusId: string,
  current: StageRules,
  patch: StageRulesPatch,
): StageRules {
  const parsed = stageRulesSchema.safeParse({ ...current, ...patch });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw errors.validation(issue?.message ?? 'Invalid stage rules', {
      issues: parsed.error.issues.map((item) => ({
        path: item.path.join('.'),
        message: item.message,
      })),
    });
  }
  const merged = parsed.data;
  const statusIds = new Set(projectStatuses(db, scope.projectId).map((row) => row.id));
  if (merged.nextStatusId !== null) {
    if (merged.nextStatusId === statusId) {
      throw errors.validation('A stage can’t be its own next stage');
    }
    if (!statusIds.has(merged.nextStatusId)) {
      throw errors.validation('The next stage must be a status of this project');
    }
  }
  if (merged.handoff.mode === 'stage_holder' && !statusIds.has(merged.handoff.statusId ?? '')) {
    throw errors.validation('The hand-off stage must be a status of this project');
  }
  validatePrincipals(db, scope, merged);
  return merged;
}

// ---------------------------------------------------------------------------------------------
// What is missing to leave a stage
// ---------------------------------------------------------------------------------------------

interface ActiveApproval {
  id: string;
  userId: string | null;
  viaKeyId: string | null;
  decision: 'approve' | 'request_changes';
  comment: string | null;
  createdAt: Date;
}

function activeApprovals(db: DbExecutor, taskId: string, statusId: string): ActiveApproval[] {
  return db
    .select({
      id: s.taskApproval.id,
      userId: s.taskApproval.userId,
      viaKeyId: s.taskApproval.viaKeyId,
      decision: s.taskApproval.decision,
      comment: s.taskApproval.comment,
      createdAt: s.taskApproval.createdAt,
    })
    .from(s.taskApproval)
    .where(
      and(
        eq(s.taskApproval.taskId, taskId),
        eq(s.taskApproval.statusId, statusId),
        isNull(s.taskApproval.dismissedAt),
      ),
    )
    .orderBy(asc(s.taskApproval.createdAt), asc(s.taskApproval.id))
    .all();
}

function evidenceRows(db: DbExecutor, taskId: string, statusId?: string) {
  return db
    .select()
    .from(s.taskStageEvidence)
    .where(
      and(
        eq(s.taskStageEvidence.taskId, taskId),
        statusId ? eq(s.taskStageEvidence.statusId, statusId) : undefined,
      ),
    )
    .all();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What the task still needs to leave `status` forward: evidence and approvals (human-readable). */
export function missingToLeave(db: DbExecutor, task: TaskRow, status: StatusRow): string[] {
  const rules = rulesOf(status);
  const missing: string[] = [];
  if (rules.exitCriteria.length > 0) {
    const given = new Set(evidenceRows(db, task.id, status.id).map((row) => row.criterionId));
    for (const criterion of rules.exitCriteria) {
      if (!given.has(criterion.id)) {
        missing.push(`evidence for “${criterion.text}” (criterion ${criterion.id})`);
      }
    }
  }
  if (rules.approvals) {
    const active = activeApprovals(db, task.id, status.id);
    const approvers = new Set(
      active.filter((row) => row.decision === 'approve').map((row) => row.userId ?? row.id),
    );
    const needed = rules.approvals.count - approvers.size;
    if (needed > 0) {
      missing.push(
        `${plural(needed, `${approvers.size > 0 ? 'more ' : ''}approval`)} from ${describeRule(
          db,
          rules.approvals.rule,
        )}`,
      );
    }
    const changes = active.filter((row) => row.decision === 'request_changes');
    if (changes.length > 0) {
      const names = getUserSummaries(
        db,
        changes.map((row) => row.userId),
      );
      for (const row of changes) {
        const user = row.userId ? names.get(row.userId) : undefined;
        missing.push(`changes requested by ${user ? `@${user.username}` : 'a former member'}`);
      }
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Checking a move
// ---------------------------------------------------------------------------------------------

export interface MoveCheck {
  direction: 'none' | 'forward' | 'backward';
  /** Why the mover may not make this move at all (403). */
  forbidden: string | null;
  /** What the task still needs (409). */
  missing: string[];
}

interface MoveSubject {
  task: TaskRow;
  scope: Scope;
  /** Null for system moves. */
  userId: string | null;
}

/** Memo of the checks that are the same for every forward target of one stage. */
interface LeaveMemo {
  forbidden?: string | null;
  missing?: string[];
  gated?: Map<string, boolean>;
}

function isGated(memo: LeaveMemo, row: StatusRow): boolean {
  memo.gated ??= new Map();
  let gated = memo.gated.get(row.id);
  if (gated === undefined) {
    gated = isGatedStage(rulesOf(row));
    memo.gated.set(row.id, gated);
  }
  return gated;
}

/** Stages a forward move from `from` to `to` jumps over (following the `next` chain). */
function skippedStages(
  statuses: readonly StatusRow[],
  from: StatusRow,
  to: StatusRow,
): StatusRow[] {
  const chain: StatusRow[] = [];
  let at: StatusRow | null = nextStage(statuses, from);
  for (let steps = 0; at && steps < statuses.length; steps += 1) {
    if (at.id === to.id) return chain;
    chain.push(at);
    at = nextStage(statuses, at);
  }
  // Not on the chain: the columns in between.
  const a = statuses.findIndex((row) => row.id === from.id);
  const b = statuses.findIndex((row) => row.id === to.id);
  return statuses.slice(a + 1, b);
}

/** Can the task move from `from` to `to` (without force)? Pure check; nothing is written. */
export function evaluateMove(
  db: DbExecutor,
  subject: MoveSubject,
  statuses: readonly StatusRow[],
  from: StatusRow,
  to: StatusRow,
  memo: LeaveMemo = {},
): MoveCheck {
  if (from.id === to.id) return { direction: 'none', forbidden: null, missing: [] };
  const rules = rulesOf(from);
  const fromIndex = statuses.findIndex((row) => row.id === from.id);
  const toIndex = statuses.findIndex((row) => row.id === to.id);
  const next = nextStage(statuses, from);
  const forward = next?.id === to.id || toIndex > fromIndex;

  if (!forward) {
    if (!isGatedStage(rules) && rules.allowSendBack) {
      return { direction: 'backward', forbidden: null, missing: [] };
    }
    if (!rules.allowSendBack) {
      return {
        direction: 'backward',
        forbidden: `${from.name} doesn’t allow moving tasks back`,
        missing: [],
      };
    }
    const previous = previousStage(statuses, from);
    return {
      direction: 'backward',
      forbidden:
        previous && previous.id !== to.id
          ? `From ${from.name}, tasks can only be sent back to ${previous.name}`
          : null,
      missing: [],
    };
  }

  if (memo.forbidden === undefined) {
    memo.forbidden =
      rules.moveRule &&
      (!subject.userId || !matchesRule(db, subject.scope, subject.userId, rules.moveRule))
        ? `Only ${describeRule(db, rules.moveRule)} can move tasks out of ${from.name}`
        : null;
  }
  memo.missing ??= isGatedStage(rules) ? missingToLeave(db, subject.task, from) : [];
  const missing = [...memo.missing];
  if (next?.id !== to.id) {
    for (const skipped of skippedStages(statuses, from, to)) {
      if (isGated(memo, skipped)) {
        missing.push(`going through ${skipped.name} first (it has rules to leave it)`);
      }
    }
  }
  return { direction: 'forward', forbidden: memo.forbidden, missing };
}

/** Team owner or ADMINISTRATOR: may force a move past every rule. */
export function canForceMove(membership: Membership): boolean {
  return membership.isOwner || hasPermission(membership, 'ADMINISTRATOR');
}

export interface ForceOptions {
  force?: boolean | undefined;
  reason?: string | undefined;
}

export interface GuardResult {
  /** Rules a forced move went past (empty when nothing was bypassed). */
  bypassed: string[];
}

const EVIDENCE_HINT =
  ' Give evidence for each criterion (move_task evidence: [{ criterion, text }], or on the task page).';

/**
 * Checks a status change of the task against the stage rules, inside the write. Throws 403 when
 * the mover may not make the move and 409 listing everything that is missing, unless a team owner
 * or administrator forces it with a reason.
 */
export function guardStageMove(
  tx: Tx,
  actor: Actor,
  access: { task: TaskRow; project: ProjectRow; membership: Membership },
  from: StatusRow,
  to: StatusRow,
  options: ForceOptions = {},
): GuardResult {
  if (from.id === to.id) return { bypassed: [] };
  const statuses = projectStatuses(tx, access.project.id);
  if (!statuses.some((row) => isGatedStage(rulesOf(row)) || !row.allowSendBack)) {
    return { bypassed: [] };
  }
  const check = evaluateMove(
    tx,
    {
      task: access.task,
      scope: { teamId: access.project.teamId, projectId: access.project.id },
      userId: actor.userId,
    },
    statuses,
    from,
    to,
  );
  const problems = [...(check.forbidden ? [check.forbidden] : []), ...check.missing];
  if (problems.length === 0) return { bypassed: [] };
  if (options.force) {
    if (!canForceMove(access.membership)) {
      throw errors.forbidden(
        'Only the team owner or an administrator can force a move past the stage rules',
      );
    }
    if (!options.reason?.trim()) throw errors.validation('Give a reason for forcing the move');
    return { bypassed: problems };
  }
  const ref = formatTaskRef(access.project.key, access.task.number);
  const details = { from: from.name, to: to.name, missing: problems };
  if (check.forbidden) throw errors.forbidden(`${check.forbidden}.`, details);
  const needsEvidence = check.missing.some((item) => item.startsWith('evidence for'));
  throw errors.conflict(
    `${ref} can’t move from ${from.name} to ${to.name} yet. Missing: ${check.missing.join('; ')}.${
      needsEvidence ? EVIDENCE_HINT : ''
    }`,
    details,
  );
}

/** Audits a forced move (`task.forced`) after the move itself. */
export function recordForced(
  tx: Tx,
  actor: Actor,
  task: TaskRow,
  projectKey: string,
  from: StatusRow,
  to: StatusRow,
  bypassed: readonly string[],
  reason: string | undefined,
): void {
  if (bypassed.length === 0) return;
  recordActivity(tx, actor, {
    teamId: task.teamId,
    projectId: task.projectId,
    entityType: 'task',
    entityId: task.id,
    action: 'task.forced',
    changes: { status: change(from.name, to.name) },
    meta: { ...taskMeta(task, projectKey), reason: reason?.trim() ?? '', bypassed: [...bypassed] },
  });
}

// ---------------------------------------------------------------------------------------------
// Entering a stage
// ---------------------------------------------------------------------------------------------

function directUserAssignees(tx: Tx, taskId: string): string[] {
  return tx
    .select({ id: s.taskAssigneeUser.userId })
    .from(s.taskAssigneeUser)
    .where(eq(s.taskAssigneeUser.taskId, taskId))
    .all()
    .map((row) => row.id);
}

function roleAssignees(tx: Tx, taskId: string): string[] {
  return tx
    .select({ id: s.taskAssigneeRole.roleId })
    .from(s.taskAssigneeRole)
    .where(eq(s.taskAssigneeRole.taskId, taskId))
    .all()
    .map((row) => row.id);
}

/** Candidates of a rule who can see the project, in a stable order (by id). */
function ruleCandidates(tx: Tx, scope: Scope, rule: PrincipalRule | undefined): string[] {
  if (!rule) return [];
  return projectViewerIds(tx, scope.projectId, expandRule(tx, scope, rule)).sort();
}

function roundRobin(tx: Tx, statusId: string, candidates: readonly string[]): string[] {
  if (candidates.length === 0) return [];
  const last = tx
    .select({ assigned: s.taskStageEntry.assignedUserIds })
    .from(s.taskStageEntry)
    .where(
      and(eq(s.taskStageEntry.statusId, statusId), eq(s.taskStageEntry.handoffMode, 'round_robin')),
    )
    .orderBy(desc(s.taskStageEntry.enteredAt), desc(s.taskStageEntry.id))
    .get()?.assigned[0];
  const next = last ? candidates.find((id) => id > last) : undefined;
  return [next ?? candidates[0] ?? ''].filter(Boolean);
}

function leastBusy(tx: Tx, task: TaskRow, candidates: readonly string[]): string[] {
  if (candidates.length === 0) return [];
  const load = new Map(
    tx
      .select({ userId: s.taskAssigneeUser.userId, n: count() })
      .from(s.taskAssigneeUser)
      .innerJoin(s.task, eq(s.task.id, s.taskAssigneeUser.taskId))
      .innerJoin(s.status, eq(s.status.id, s.task.statusId))
      .where(
        and(
          eq(s.task.projectId, task.projectId),
          isNull(s.task.deletedAt),
          eq(s.status.category, 'open'),
          sql`${s.task.id} <> ${task.id}`,
          inArray(s.taskAssigneeUser.userId, [...candidates]),
        ),
      )
      .groupBy(s.taskAssigneeUser.userId)
      .all()
      .map((row) => [row.userId, row.n]),
  );
  let best = candidates[0] ?? '';
  for (const id of candidates) {
    if ((load.get(id) ?? 0) < (load.get(best) ?? 0)) best = id;
  }
  return best ? [best] : [];
}

function stageHolders(tx: Tx, taskId: string, statusId: string | undefined): string[] {
  if (!statusId) return [];
  const row = tx
    .select({ holders: s.taskStageEntry.holderUserIds })
    .from(s.taskStageEntry)
    .where(
      and(
        eq(s.taskStageEntry.taskId, taskId),
        eq(s.taskStageEntry.statusId, statusId),
        sql`${s.taskStageEntry.holderUserIds} is not null`,
      ),
    )
    .orderBy(desc(s.taskStageEntry.enteredAt), desc(s.taskStageEntry.id))
    .get();
  return row?.holders ?? [];
}

/** Whom the hand-off of `rules` assigns (null: leave the assignees alone). */
function handoffUsers(
  tx: Tx,
  actor: Actor | null,
  task: TaskRow,
  status: StatusRow,
  rules: StageRules,
): string[] | null {
  const scope = { teamId: task.teamId, projectId: task.projectId };
  const viewers = (ids: string[]) => projectViewerIds(tx, task.projectId, ids).sort();
  const { handoff } = rules;
  let ids: string[];
  switch (handoff.mode) {
    case 'keep':
    case 'pool':
      return null;
    case 'specific':
      ids = ruleCandidates(tx, scope, handoff.rule);
      break;
    case 'round_robin':
      ids = roundRobin(tx, status.id, ruleCandidates(tx, scope, handoff.rule));
      break;
    case 'least_busy':
      ids = leastBusy(tx, task, ruleCandidates(tx, scope, handoff.rule));
      break;
    case 'author':
      ids = task.authorId ? viewers([task.authorId]) : [];
      break;
    case 'mover':
      ids = actor ? viewers([actor.userId]) : [];
      break;
    case 'stage_holder':
      ids = viewers(stageHolders(tx, task.id, handoff.statusId));
      break;
  }
  // Nobody matched: the task keeps its assignees rather than ending up with nobody.
  return ids.length > 0 ? ids : null;
}

function userLabels(tx: Tx, ids: readonly string[]): string[] {
  const users = getUserSummaries(tx, ids);
  return ids.map((id) => `@${users.get(id)?.username ?? id}`).sort((a, b) => a.localeCompare(b));
}

function roleLabels(tx: Tx, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return tx
    .select({ name: s.role.name })
    .from(s.role)
    .where(inArray(s.role.id, [...ids]))
    .all()
    .map((row) => `${row.name} (role)`)
    .sort((a, b) => a.localeCompare(b));
}

interface EnterContext {
  /** The task row after the move (its `statusId` is `to`). */
  task: TaskRow;
  projectKey: string;
  teamSlug: string;
}

export interface EnterOptions {
  /** The task was just created with explicit assignees: the hand-off leaves them alone. */
  keepAssignees?: boolean;
}

/**
 * Everything that happens when a task enters `to` (inside the caller's write, after the status
 * column and the move's own audit row are written): closes the visit of `from` (remembering who
 * held it), dismisses leftover approvals of an earlier visit of `to`, applies the hand-off and
 * `notify`, records the new visit and calls the Wave 2C hook. Returns the task row afterwards.
 */
export function enterStage(
  tx: Tx,
  actor: Actor | null,
  context: EnterContext,
  from: StatusRow | null,
  to: StatusRow,
  now: Date,
  notified: NotifiedSet = new Set(),
  options: EnterOptions = {},
): TaskRow {
  const { task } = context;
  const rules = rulesOf(to);

  // Close the previous visit(s), remembering who held the task.
  if (from) {
    const holders = directUserAssignees(tx, task.id);
    const open = tx
      .select({ id: s.taskStageEntry.id, statusId: s.taskStageEntry.statusId })
      .from(s.taskStageEntry)
      .where(and(eq(s.taskStageEntry.taskId, task.id), isNull(s.taskStageEntry.leftAt)))
      .all();
    if (open.length > 0) {
      tx.update(s.taskStageEntry)
        .set({ leftAt: now, holderUserIds: holders })
        .where(and(eq(s.taskStageEntry.taskId, task.id), isNull(s.taskStageEntry.leftAt)))
        .run();
    }
    if (!open.some((row) => row.statusId === from.id)) {
      // A task that was in `from` before visits were recorded.
      tx.insert(s.taskStageEntry)
        .values({
          id: newId(),
          taskId: task.id,
          statusId: from.id,
          enteredAt: task.createdAt,
          leftAt: now,
          holderUserIds: holders,
        })
        .run();
    }
  }

  // A new visit starts without the decisions of an earlier one.
  tx.update(s.taskApproval)
    .set({ dismissedAt: now })
    .where(
      and(
        eq(s.taskApproval.taskId, task.id),
        eq(s.taskApproval.statusId, to.id),
        isNull(s.taskApproval.dismissedAt),
      ),
    )
    .run();

  const patch: Partial<TaskRow> = {};
  if (task.poolRule) patch.poolRule = null;
  let assignedUserIds: string[] = [];
  let pool: PrincipalRule | null = null;
  const beforeUsers = directUserAssignees(tx, task.id);
  const beforeRoles = roleAssignees(tx, task.id);
  let afterUsers = beforeUsers;
  let afterRoles = beforeRoles;
  if (!options.keepAssignees && rules.handoff.mode !== 'keep') {
    if (rules.handoff.mode === 'pool' && rules.handoff.rule) {
      pool = rules.handoff.rule;
      patch.poolRule = pool;
      afterUsers = [];
      afterRoles = [];
    } else {
      const users = handoffUsers(tx, actor, task, to, rules);
      if (users) {
        assignedUserIds = users;
        afterUsers = users;
        afterRoles = [];
      }
    }
  }
  const usersChanged =
    afterUsers.length !== beforeUsers.length || afterUsers.some((id) => !beforeUsers.includes(id));
  const rolesChanged = afterRoles.length !== beforeRoles.length;
  const target = {
    teamId: task.teamId,
    entityType: 'task' as const,
    entityId: task.id,
    title: `${formatTaskRef(context.projectKey, task.number)}: ${task.title}`,
    snippet: `Moved to ${to.name}`,
    url: appPaths.task(context.teamSlug, context.projectKey, task.number),
  };
  if (usersChanged || rolesChanged) {
    tx.delete(s.taskAssigneeUser).where(eq(s.taskAssigneeUser.taskId, task.id)).run();
    tx.delete(s.taskAssigneeRole).where(eq(s.taskAssigneeRole.taskId, task.id)).run();
    if (afterUsers.length > 0) {
      tx.insert(s.taskAssigneeUser)
        .values(afterUsers.map((userId) => ({ taskId: task.id, userId })))
        .run();
    }
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'task.handed_off',
      changes: {
        assignees: change(
          [...userLabels(tx, beforeUsers), ...roleLabels(tx, beforeRoles)],
          userLabels(tx, afterUsers),
        ),
      },
      meta: { ...taskMeta(task, context.projectKey), stage: to.name, mode: rules.handoff.mode },
    });
    const added = afterUsers.filter((id) => !beforeUsers.includes(id));
    if (added.length > 0) {
      autoSubscribe(tx, added, 'task', task.id);
      notifyAssigned(tx, actor, target, { userIds: added }, notified);
    }
  }
  // The claim goes with the hand-off (a pool always frees it) unless the holder still has the task.
  const handedOff = pool !== null || assignedUserIds.length > 0;
  if (
    handedOff &&
    task.claimedById &&
    isClaimValid(task, now) &&
    !afterUsers.includes(task.claimedById)
  ) {
    Object.assign(patch, releasedClaim());
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'task.released',
      meta: { ...taskMeta(task, context.projectKey), reason: 'handoff' },
    });
    emitAfterCommit(tx, taskEvent('task.released', task, actor));
  }
  const updated =
    Object.keys(patch).length > 0
      ? (tx.update(s.task).set(patch).where(eq(s.task.id, task.id)).returning().get() ?? task)
      : task;

  if (rules.notify) {
    const ids = expandRule(tx, { teamId: task.teamId, projectId: task.projectId }, rules.notify);
    notifyUsers(tx, actor, 'stage_entered', ids, target, notified);
  }

  tx.insert(s.taskStageEntry)
    .values({
      id: newId(),
      taskId: task.id,
      statusId: to.id,
      enteredAt: now,
      enteredById: actor?.userId ?? null,
      enteredViaKeyId: actor?.key?.id ?? null,
      handoffMode: rules.handoff.mode,
      assignedUserIds,
    })
    .run();

  onTaskEnteredStage(tx, updated, to, actor, {
    from,
    rules,
    pool,
    assignedUserIds,
    needsApprovals: rules.approvals !== null,
  });
  return updated;
}

/**
 * Moves the task to `to` on the system's initiative (auto-advance, Request changes): end of the
 * column, done/open side effects, a `task.moved` row (`meta` says why), the entry rules, and the
 * live events.
 */
function changeStatus(
  tx: Tx,
  actor: Actor,
  access: { task: TaskRow; projectKey: string; teamSlug: string },
  from: StatusRow,
  to: StatusRow,
  now: Date,
  meta: Record<string, unknown>,
): TaskRow {
  const notified = new Set<string>();
  const transition = applyStatusTransition(
    tx,
    actor,
    { task: access.task, projectKey: access.projectKey, teamSlug: access.teamSlug },
    from,
    to,
    now,
    notified,
  );
  const updated =
    tx
      .update(s.task)
      .set({
        statusId: to.id,
        position: appendPosition(tx, to.id),
        ...transition.patch,
        updatedAt: now,
        lastActivityAt: now,
      })
      .where(eq(s.task.id, access.task.id))
      .returning()
      .get() ?? access.task;
  recordActivity(tx, actor, {
    teamId: updated.teamId,
    projectId: updated.projectId,
    entityType: 'task',
    entityId: updated.id,
    action: 'task.moved',
    changes: { status: change(from.name, to.name) },
    meta: { ...taskMeta(updated, access.projectKey), status: to.name, ...meta },
  });
  transition.recordRelease();
  const entered = enterStage(
    tx,
    actor,
    { task: updated, projectKey: access.projectKey, teamSlug: access.teamSlug },
    from,
    to,
    now,
    notified,
  );
  emitAfterCommit(tx, taskEvent('task.updated', updated, actor));
  queueLinkedIssueEvents(tx, actor, [updated.id]);
  return entered;
}

function statusRow(tx: DbExecutor, statusId: string): StatusRow {
  const row = tx.select().from(s.status).where(eq(s.status.id, statusId)).get();
  if (!row) throw errors.notFound('Status');
  return row;
}

function taskContext(tx: Tx, taskId: string) {
  const row = tx
    .select({ task: s.task, key: s.project.key, slug: s.team.slug })
    .from(s.task)
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .innerJoin(s.team, eq(s.team.id, s.task.teamId))
    .where(eq(s.task.id, taskId))
    .get();
  if (!row) throw errors.notFound('Task');
  return { task: row.task, projectKey: row.key, teamSlug: row.slug };
}

/**
 * `auto_advance`: once the current stage's criteria and approvals are satisfied, the task moves to
 * the next stage by itself, attributed to `actor` (whoever completed it) with `meta.autoAdvance`.
 * The stage's move rule doesn't apply (the stage's own setting moves it). At most one step per
 * request: entering the next stage never advances again. Returns whether it moved.
 */
export function maybeAutoAdvance(tx: Tx, actor: Actor, taskId: string, now: Date): boolean {
  const context = taskContext(tx, taskId);
  const current = statusRow(tx, context.task.statusId);
  if (!current.autoAdvance) return false;
  const statuses = projectStatuses(tx, context.task.projectId);
  const next = nextStage(statuses, current);
  if (!next) return false;
  if (missingToLeave(tx, context.task, current).length > 0) return false;
  changeStatus(tx, actor, context, current, next, now, { autoAdvance: true });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/** May the member give evidence on the task (who works on it)? */
function canGiveEvidence(tx: DbExecutor, membership: Membership, task: TaskRow): boolean {
  if (canUpdateTask(membership, task)) return true;
  if (task.claimedById === membership.userId) return true;
  return tx
    .select({ userId: s.taskAssigneeUser.userId })
    .from(s.taskAssigneeUser)
    .where(
      and(eq(s.taskAssigneeUser.taskId, task.id), eq(s.taskAssigneeUser.userId, membership.userId)),
    )
    .get()
    ? true
    : false;
}

/**
 * Dismisses the approvals of the task's current stage (`dismissOnChange`), audited as
 * `task.approvals_dismissed`. Returns how many were dismissed.
 */
export function dismissStageApprovals(
  tx: Tx,
  actor: Actor | null,
  task: TaskRow,
  projectKey: string,
  why: 'edited' | 'evidence',
  now: Date,
): number {
  const status = statusRow(tx, task.statusId);
  if (!rulesOf(status).approvals?.dismissOnChange) return 0;
  const active = activeApprovals(tx, task.id, status.id);
  if (active.length === 0) return 0;
  tx.update(s.taskApproval)
    .set({ dismissedAt: now })
    .where(
      inArray(
        s.taskApproval.id,
        active.map((row) => row.id),
      ),
    )
    .run();
  recordActivity(tx, actor, {
    teamId: task.teamId,
    projectId: task.projectId,
    entityType: 'task',
    entityId: task.id,
    action: 'task.approvals_dismissed',
    meta: { ...taskMeta(task, projectKey), stage: status.name, count: active.length, reason: why },
  });
  onStageApprovalsReset(tx, task, status, actor);
  return active.length;
}

/**
 * Saves evidence for the current stage's exit criteria ("" removes one). Evidence of other stages
 * is locked: only the stage the task is in takes evidence. Audited as `task.evidence_updated`;
 * dismisses the stage's approvals when `dismissOnChange`; may auto-advance (unless the caller is
 * about to move the task itself).
 */
export function saveEvidence(
  deps: AppDeps,
  actor: Actor,
  taskId: string,
  evidence: EvidenceInput,
  options: { autoAdvance?: boolean } = {},
): void {
  const { orm } = deps.db;
  const { task, project, membership } = requireTask(orm, actor, taskId);
  if (!canGiveEvidence(orm, membership, task)) {
    throw errors.forbidden("You don't have permission to give evidence on this task");
  }
  deps.db.write((tx) => {
    const now = new Date();
    const current = tx.select().from(s.task).where(eq(s.task.id, taskId)).get() ?? task;
    const status = statusRow(tx, current.statusId);
    const rules = rulesOf(status);
    const byId = new Map(rules.exitCriteria.map((criterion) => [criterion.id, criterion]));
    const unknown = Object.keys(evidence).filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw errors.validation(
        rules.exitCriteria.length === 0
          ? `${status.name} has no exit criteria, so it takes no evidence`
          : `${unknown.map((id) => `“${id}”`).join(', ')} ${
              unknown.length === 1 ? 'is not an exit criterion' : 'are not exit criteria'
            } of ${status.name}. Its criteria: ${rules.exitCriteria
              .map((criterion) => `${criterion.id} (${criterion.text})`)
              .join(', ')}`,
        { criteria: rules.exitCriteria },
      );
    }
    const existing = new Map(
      evidenceRows(tx, taskId, status.id).map((row) => [row.criterionId, row]),
    );
    const changes: Changes = {};
    for (const [id, text] of Object.entries(evidence)) {
      const criterion = byId.get(id);
      if (!criterion) continue;
      const row = existing.get(id);
      if (text === '') {
        if (!row) continue;
        tx.delete(s.taskStageEvidence).where(eq(s.taskStageEvidence.id, row.id)).run();
        changes[criterion.text] = change(excerpt(row.text, 140), null);
        continue;
      }
      if (row?.text === text) continue;
      if (row) {
        tx.update(s.taskStageEvidence)
          .set({ text, userId: actor.userId, viaKeyId: actor.key?.id ?? null, updatedAt: now })
          .where(eq(s.taskStageEvidence.id, row.id))
          .run();
      } else {
        tx.insert(s.taskStageEvidence)
          .values({
            id: newId(),
            taskId,
            statusId: status.id,
            criterionId: id,
            text,
            userId: actor.userId,
            viaKeyId: actor.key?.id ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      changes[criterion.text] = change(row ? excerpt(row.text, 140) : null, excerpt(text, 140));
    }
    if (Object.keys(changes).length === 0) return;
    tx.update(s.task)
      .set({ updatedAt: now, lastActivityAt: now })
      .where(eq(s.task.id, taskId))
      .run();
    recordActivity(tx, actor, {
      teamId: current.teamId,
      projectId: current.projectId,
      entityType: 'task',
      entityId: taskId,
      action: 'task.evidence_updated',
      changes,
      meta: { ...taskMeta(current, project.key), stage: status.name },
    });
    dismissStageApprovals(tx, actor, current, project.key, 'evidence', now);
    emitAfterCommit(tx, taskEvent('task.updated', current, actor));
    if (options.autoAdvance !== false) maybeAutoAdvance(tx, actor, taskId, now);
  });
}

/** `PUT /api/tasks/:taskId/evidence`. */
export function saveTaskEvidence(
  deps: AppDeps,
  actor: Actor,
  taskId: string,
  evidence: EvidenceInput,
): Task {
  saveEvidence(deps, actor, taskId, evidence);
  return getTask(deps, actor, taskId);
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

/**
 * Approve / Request changes on the task's current stage (`POST /api/tasks/:id/approvals`, MCP
 * `approve_task`). Only people and agents matching the stage's `approvals.rule` may decide; each
 * counts once (a new decision replaces their previous one). Request changes sends the task back to
 * the previous stage when the stage allows it; otherwise it blocks leaving until it is dismissed.
 * An approval that satisfies the stage auto-advances it when `autoAdvance`.
 */
export function decideApproval(
  deps: AppDeps,
  actor: Actor,
  taskId: string,
  input: ApprovalInput,
): Task {
  const { orm } = deps.db;
  const { project } = requireTask(orm, actor, taskId);
  deps.db.write((tx) => {
    const now = new Date();
    const context = taskContext(tx, taskId);
    const { task } = context;
    const status = statusRow(tx, task.statusId);
    const rules = rulesOf(status);
    const ref = formatTaskRef(project.key, task.number);
    if (!rules.approvals) {
      throw errors.conflict(`${ref} is in ${status.name}, which doesn’t take approvals`);
    }
    const scope = { teamId: task.teamId, projectId: task.projectId };
    if (!matchesRule(tx, scope, actor.userId, rules.approvals.rule)) {
      throw errors.forbidden(
        `Only ${describeRule(tx, rules.approvals.rule)} can approve tasks in ${status.name}`,
      );
    }
    tx.update(s.taskApproval)
      .set({ dismissedAt: now })
      .where(
        and(
          eq(s.taskApproval.taskId, task.id),
          eq(s.taskApproval.statusId, status.id),
          eq(s.taskApproval.userId, actor.userId),
          isNull(s.taskApproval.dismissedAt),
        ),
      )
      .run();
    const comment = input.comment?.trim() || null;
    tx.insert(s.taskApproval)
      .values({
        id: newId(),
        taskId: task.id,
        statusId: status.id,
        userId: actor.userId,
        viaKeyId: actor.key?.id ?? null,
        decision: input.decision,
        comment,
        createdAt: now,
      })
      .run();
    tx.update(s.task)
      .set({ updatedAt: now, lastActivityAt: now })
      .where(eq(s.task.id, task.id))
      .run();
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: task.id,
      action: input.decision === 'approve' ? 'task.approved' : 'task.changes_requested',
      meta: {
        ...taskMeta(task, project.key),
        stage: status.name,
        ...(comment ? { comment: excerpt(comment, 500) } : {}),
      },
    });
    emitAfterCommit(tx, taskEvent('task.updated', task, actor));
    if (input.decision === 'request_changes') {
      const previous = rules.allowSendBack
        ? previousStage(projectStatuses(tx, task.projectId), status)
        : null;
      if (previous) {
        changeStatus(tx, actor, context, status, previous, now, { reason: 'changes_requested' });
      }
      return;
    }
    maybeAutoAdvance(tx, actor, task.id, now);
  });
  return getTask(deps, actor, taskId);
}

// ---------------------------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------------------------

/** Does the task wait in a pool the user may claim from? */
export function canClaimFromPool(db: DbExecutor, task: TaskRow, userId: string): boolean {
  if (!task.poolRule) return false;
  return matchesRule(db, { teamId: task.teamId, projectId: task.projectId }, userId, task.poolRule);
}

/** Why the user can't claim the pool task, naming who can. */
export function poolClaimRefusal(db: DbExecutor, task: TaskRow, ref: string): string {
  return `${ref} waits in a pool: only ${task.poolRule ? describeRule(db, task.poolRule) : 'nobody'} can claim it`;
}

/**
 * Assigns a pool task to whoever claimed it (inside the claim's write): the task leaves the pool,
 * the claimer becomes its only assignee. Returns the audit change of the assignees.
 */
export function takeFromPool(tx: Tx, actor: Actor, task: TaskRow): Changes {
  const beforeUsers = directUserAssignees(tx, task.id);
  const beforeRoles = roleAssignees(tx, task.id);
  tx.delete(s.taskAssigneeUser).where(eq(s.taskAssigneeUser.taskId, task.id)).run();
  tx.delete(s.taskAssigneeRole).where(eq(s.taskAssigneeRole.taskId, task.id)).run();
  tx.insert(s.taskAssigneeUser).values({ taskId: task.id, userId: actor.userId }).run();
  tx.update(s.task).set({ poolRule: null }).where(eq(s.task.id, task.id)).run();
  autoSubscribe(tx, [actor.userId], 'task', task.id);
  return {
    assignees: change(
      [...userLabels(tx, beforeUsers), ...roleLabels(tx, beforeRoles)],
      userLabels(tx, [actor.userId]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

function criteriaWithEvidence(
  db: DbExecutor,
  criteria: StageRules['exitCriteria'],
  rows: ReadonlyArray<typeof s.taskStageEvidence.$inferSelect>,
  extraIds = true,
): StageCriterion[] {
  const users = getUserSummaries(
    db,
    rows.map((row) => row.userId),
  );
  const keys = getViaKeys(
    db,
    rows.map((row) => row.viaKeyId),
  );
  const byId = new Map(rows.map((row) => [row.criterionId, row]));
  const toEvidence = (row: (typeof rows)[number] | undefined) =>
    row
      ? {
          text: row.text,
          user: row.userId ? (users.get(row.userId) ?? null) : null,
          via: row.viaKeyId ? (keys.get(row.viaKeyId) ?? null) : null,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null;
  const listed = criteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    evidence: toEvidence(byId.get(criterion.id)),
  }));
  if (!extraIds) return listed;
  // Evidence for criteria removed from the stage since.
  const known = new Set(criteria.map((criterion) => criterion.id));
  const orphans = rows
    .filter((row) => !known.has(row.criterionId))
    .map((row) => ({ id: row.criterionId, text: row.criterionId, evidence: toEvidence(row) }));
  return [...listed, ...orphans];
}

/**
 * The task's stage as the viewer sees it (task page, `get_task`), or null when the project has no
 * pipeline rules.
 */
export function stageOf(db: DbExecutor, viewer: Actor, task: TaskRow): TaskStage | null {
  const statuses = projectStatuses(db, task.projectId);
  if (!hasPipeline(statuses) && !task.poolRule) return null;
  const current = statuses.find((row) => row.id === task.statusId);
  if (!current) return null;
  const rules = rulesOf(current);
  const scope = { teamId: task.teamId, projectId: task.projectId };
  const access = getProjectAccess(db, viewer.userId, task.projectId);
  const canUpdate = access ? canUpdateTask(access, task) : false;
  const book = nameBook(db, [rules.moveRule, rules.approvals?.rule, task.poolRule]);

  const evidence = evidenceRows(db, task.id);
  const criteria = criteriaWithEvidence(
    db,
    rules.exitCriteria,
    evidence.filter((row) => row.statusId === current.id),
    false,
  );

  let approvals: TaskStage['approvals'] = null;
  if (rules.approvals) {
    const active = activeApprovals(db, task.id, current.id);
    const users = getUserSummaries(
      db,
      active.map((row) => row.userId),
    );
    const keys = getViaKeys(
      db,
      active.map((row) => row.viaKeyId),
    );
    const given: StageApproval[] = active.map((row) => ({
      id: row.id,
      user: row.userId ? (users.get(row.userId) ?? null) : null,
      via: row.viaKeyId ? (keys.get(row.viaKeyId) ?? null) : null,
      decision: row.decision,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
    }));
    approvals = {
      required: rules.approvals.count,
      approved: new Set(
        active.filter((row) => row.decision === 'approve').map((row) => row.userId ?? row.id),
      ).size,
      rule: ruleText(rules.approvals.rule, book),
      dismissOnChange: rules.approvals.dismissOnChange,
      given,
      canApprove: matchesRule(db, scope, viewer.userId, rules.approvals.rule),
    };
  }

  const next = nextStage(statuses, current);
  const previous = previousStage(statuses, current);
  const subject = { task, scope, userId: viewer.userId };
  const memo: LeaveMemo = {};
  const blockedMoves: Record<string, string> = {};
  for (const target of statuses) {
    if (target.id === current.id) continue;
    const check = evaluateMove(db, subject, statuses, current, target, memo);
    const reasons = [...(check.forbidden ? [check.forbidden] : []), ...check.missing];
    if (reasons.length > 0) blockedMoves[target.id] = reasons.join('; ');
  }
  const nextCheck = next ? evaluateMove(db, subject, statuses, current, next, memo) : null;
  const assigned = db
    .select({ userId: s.taskAssigneeUser.userId })
    .from(s.taskAssigneeUser)
    .where(
      and(eq(s.taskAssigneeUser.taskId, task.id), eq(s.taskAssigneeUser.userId, viewer.userId)),
    )
    .get();

  const previousEvidence = statuses
    .filter((row) => row.id !== current.id)
    .flatMap((row) => {
      const rowsOfStage = evidence.filter((item) => item.statusId === row.id);
      if (rowsOfStage.length === 0) return [];
      const stageCriteria = rulesOf(row).exitCriteria.filter((criterion) =>
        rowsOfStage.some((item) => item.criterionId === criterion.id),
      );
      return [
        {
          status: { id: row.id, name: row.name },
          criteria: criteriaWithEvidence(db, stageCriteria, rowsOfStage),
        },
      ];
    });

  return {
    status: { id: current.id, name: current.name },
    instructions: rules.instructions,
    criteria,
    approvals,
    moveRule: rules.moveRule ? ruleText(rules.moveRule, book) : null,
    next: next ? { id: next.id, name: next.name } : null,
    sendBackTo: previous && rules.allowSendBack ? { id: previous.id, name: previous.name } : null,
    autoAdvance: rules.autoAdvance,
    pool: task.poolRule
      ? {
          rule: ruleText(task.poolRule, book),
          canClaim: matchesRule(db, scope, viewer.userId, task.poolRule),
        }
      : null,
    canEditEvidence:
      rules.exitCriteria.length > 0 &&
      (canUpdate || task.claimedById === viewer.userId || Boolean(assigned)),
    canMove: Boolean(
      next &&
      canUpdate &&
      nextCheck &&
      nextCheck.forbidden === null &&
      nextCheck.missing.length === 0,
    ),
    canForce: access ? canForceMove(access) : false,
    missing: nextCheck?.missing ?? [],
    blockedMoves,
    previousEvidence,
  };
}

/** Card summaries ("Approvals 1/2", "Criteria 2/3", "Claimable"), keyed by task id. */
export function pipelineSummaries(
  db: DbExecutor,
  rows: readonly TaskRow[],
): Map<string, TaskPipelineSummary> {
  const result = new Map<string, TaskPipelineSummary>();
  if (rows.length === 0) return result;
  const statuses = new Map(
    db
      .select()
      .from(s.status)
      .where(inArray(s.status.id, [...new Set(rows.map((row) => row.statusId))]))
      .all()
      .map((row) => [row.id, rulesOf(row)]),
  );
  const relevant = rows.filter((row) => {
    const rules = statuses.get(row.statusId);
    return row.poolRule || (rules && (rules.exitCriteria.length > 0 || rules.approvals));
  });
  if (relevant.length === 0) return result;
  const ids = relevant.map((row) => row.id);
  const evidence = db
    .select({
      taskId: s.taskStageEvidence.taskId,
      statusId: s.taskStageEvidence.statusId,
      criterionId: s.taskStageEvidence.criterionId,
    })
    .from(s.taskStageEvidence)
    .where(inArray(s.taskStageEvidence.taskId, ids))
    .all();
  const approvals = db
    .select({
      id: s.taskApproval.id,
      taskId: s.taskApproval.taskId,
      statusId: s.taskApproval.statusId,
      userId: s.taskApproval.userId,
      decision: s.taskApproval.decision,
    })
    .from(s.taskApproval)
    .where(and(inArray(s.taskApproval.taskId, ids), isNull(s.taskApproval.dismissedAt)))
    .all();
  for (const row of relevant) {
    const rules = statuses.get(row.statusId) ?? DEFAULT_STAGE_RULES;
    const criteriaIds = new Set(rules.exitCriteria.map((criterion) => criterion.id));
    const done = new Set(
      evidence
        .filter(
          (item) =>
            item.taskId === row.id &&
            item.statusId === row.statusId &&
            criteriaIds.has(item.criterionId),
        )
        .map((item) => item.criterionId),
    ).size;
    const approved = new Set(
      approvals
        .filter(
          (item) =>
            item.taskId === row.id && item.statusId === row.statusId && item.decision === 'approve',
        )
        .map((item) => item.userId ?? item.id),
    ).size;
    result.set(row.id, {
      approvals: rules.approvals ? { approved, required: rules.approvals.count } : null,
      criteria: rules.exitCriteria.length > 0 ? { done, total: rules.exitCriteria.length } : null,
      claimable: row.poolRule !== null,
    });
  }
  return result;
}
