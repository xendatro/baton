import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Principal, PrincipalRule } from '@shared/principals';
import { formatTaskRef } from '@shared/refs';
import type { StatusIconShape } from '@shared/constants';
import { backStagesOf, earlierStageIds, nextStageOf } from '@shared/stageMoves';
import {
  DEFAULT_STAGE_RULES,
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
import { insertChangeReply } from './replies';
import { onStageApprovalsReset, onTaskEnteredStage } from './pipelineHooks';
import { pipelinePermissions } from './projectPipelines';
import { matchesRule, expandRule } from './principals';
import { autoSubscribe } from './subscriptions';
import { currentUserRow, setStageAssignees, stageRoleIds, stageUserIds } from './taskAssignees';
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
 *     Wave 2C hook `onTaskEnteredStage` (server/services/pipelineHooks.ts). Coming back to a
 *     stage starts a fresh visit: its earlier approvals are dismissed and its evidence archived.
 *   - Strict moves (BAT-27), like invisible arrows between the stages of a pipeline:
 *     - forward only to the stage's next stage (`nextStatusId`, else the next column), through its
 *       leave rules: the move rule, evidence for every exit criterion and enough approvals;
 *     - back only to the earlier stages checked in its `sendBackTo`, by whoever may move it on or
 *       approve the stage, always with a reason (stored on the new visit, posted in the thread and
 *       given to the agents working on it next).
 *   - Team owner / ADMINISTRATOR may force any move with a reason (`task.forced`).
 *
 * Every function taking a `tx` runs inside the caller's write.
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
    onEnter: {
      ...DEFAULT_STAGE_RULES.onEnter,
      // Before the split, `notifyAuthor` also told the previous holder.
      notifyPreviousHolder: row.onEnter?.notifyAuthor ?? false,
      ...row.onEnter,
    },
    blocksDependents: row.blocksDependents,
    claimable: row.claimable,
    exitCriteria: row.exitCriteria,
    moveBy: row.moveBy ?? { assignees: false, claimer: false },
    moveRule: row.moveRule ?? null,
    approvals: row.approvals
      ? { ...row.approvals, dismissOnChange: row.approvals.dismissOnChange ?? false }
      : null,
    autoAdvance: row.autoAdvance,
    nextStatusId: row.nextStatusId,
    sendBackTo: row.sendBackTo,
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
  const { onEnter } = rules;
  return {
    instructions: rules.instructions,
    handoff,
    notify: rules.notify,
    onEnter: (Object.keys(onEnter) as Array<keyof typeof onEnter>).some(
      (flag) => onEnter[flag] !== DEFAULT_STAGE_RULES.onEnter[flag],
    )
      ? onEnter
      : null,
    blocksDependents: rules.blocksDependents,
    claimable: rules.claimable,
    exitCriteria: rules.exitCriteria,
    moveBy: rules.moveBy.assignees || rules.moveBy.claimer ? rules.moveBy : null,
    moveRule: rules.moveRule,
    approvals: rules.approvals,
    autoAdvance: rules.autoAdvance,
    nextStatusId: rules.nextStatusId,
    sendBackTo: rules.sendBackTo,
  };
}

/** Status columns of a seeded status (new projects, test fixtures): its icon and rules. */
export function seedStatusColumns(seed: {
  name: string;
  color: string;
  icon: StatusIconShape;
  isDefault: boolean;
  rules: Partial<StageRules> | null;
}) {
  return {
    name: seed.name,
    color: seed.color,
    icon: seed.icon,
    isDefault: seed.isDefault,
    ...ruleColumns({ ...DEFAULT_STAGE_RULES, ...seed.rules }),
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

/** The stages of `status`'s pipeline in column order (BAT-25: stage order is per pipeline). */
export function stagesOf(db: DbExecutor, status: Pick<StatusRow, 'pipelineId'>): StatusRow[] {
  return db
    .select()
    .from(s.status)
    .where(eq(s.status.pipelineId, status.pipelineId))
    .orderBy(asc(s.status.position), asc(s.status.createdAt))
    .all();
}

/** The stage after `from`: its `nextStatusId`, else the next column (null: the last stage). */
export function nextStage(statuses: readonly StatusRow[], from: StatusRow): StatusRow | null {
  return nextStageOf(statuses, from);
}

/** The earlier stages `from` may send tasks back to (its `sendBackTo`), nearest first. */
export function backStages(statuses: readonly StatusRow[], from: StatusRow): StatusRow[] {
  return backStagesOf(statuses, from);
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
  nobody: 'Assign nobody',
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
  const onEnter = [
    ...(rules.onEnter.resolveIssues ? ['resolve fixed issues'] : []),
    ...(rules.onEnter.releaseClaim ? ['release the claim'] : []),
    ...(rules.onEnter.notifyAuthor ? ['notify the author'] : []),
    ...(rules.onEnter.notifyPreviousHolder ? ['notify the previous holder'] : []),
    ...(rules.onEnter.notifyAssignees ? [] : ["don't notify the assignees"]),
  ];
  return {
    instructions: excerpt(rules.instructions, 140),
    handoff: handoffText,
    notify: rules.notify ? ruleText(rules.notify, book) : null,
    onEnter: onEnter.length > 0 ? onEnter.join(', ') : null,
    blocksDependents: rules.blocksDependents,
    claimable: rules.claimable,
    exitCriteria: rules.exitCriteria.map((criterion) => criterion.text),
    moveBy: moveByWords(rules.moveBy) || null,
    moveRule: rules.moveRule ? ruleText(rules.moveRule, book) : null,
    approvals: rules.approvals
      ? `${rules.approvals.count} from ${ruleText(rules.approvals.rule, book)}${
          rules.approvals.dismissOnChange ? ', dismissed on change' : ''
        }`
      : null,
    autoAdvance: rules.autoAdvance,
    nextStatusId: statusName(rules.nextStatusId),
    sendBackTo: rules.sendBackTo.map((id) => statusName(id) ?? 'a deleted stage'),
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
  validateRulePrincipals(db, scope, [
    rules.handoff.rule,
    rules.notify,
    rules.moveRule,
    rules.approvals?.rule,
  ]);
}

/** Throws `validation_failed` naming principals of `rules` the project's team doesn't have. */
export function validateRulePrincipals(
  db: DbExecutor,
  scope: Scope,
  rules: ReadonlyArray<PrincipalRule | null | undefined>,
): void {
  const principals = rules.flatMap((rule) => (rule ? [...rule.allow, ...rule.deny] : []));
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
 * statuses of the same pipeline (send-back stages earlier ones, unless `options.anyOrder`: a copy
 * reorders the stages afterwards), principals exist in its team.
 */
export function mergeRules(
  db: DbExecutor,
  scope: Scope,
  statusId: string,
  current: StageRules,
  patch: StageRulesPatch,
  options: { anyOrder?: boolean } = {},
): StageRules {
  const { allowSendBack, ...fields } = patch;
  // Before BAT-27: `allowSendBack` meant "back to the previous stages".
  const legacySendBack =
    fields.sendBackTo === undefined && allowSendBack !== undefined
      ? {
          sendBackTo: allowSendBack
            ? earlierStageIds(
                stagesOf(db, {
                  pipelineId:
                    db
                      .select({ pipelineId: s.status.pipelineId })
                      .from(s.status)
                      .where(eq(s.status.id, statusId))
                      .get()?.pipelineId ?? '',
                }),
                statusId,
              )
            : [],
        }
      : {};
  const parsed = stageRulesSchema.safeParse({
    ...current,
    ...fields,
    ...legacySendBack,
    onEnter: { ...current.onEnter, ...fields.onEnter },
  });
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
  // Stages a rule names are stages of the same pipeline (BAT-25).
  const pipelineOf = (id: string) =>
    db.select({ pipelineId: s.status.pipelineId }).from(s.status).where(eq(s.status.id, id)).get()
      ?.pipelineId;
  const own = pipelineOf(statusId);
  const samePipeline = (id: string) =>
    statusIds.has(id) && (own === undefined || pipelineOf(id) === own);
  if (merged.nextStatusId !== null) {
    if (merged.nextStatusId === statusId) {
      throw errors.validation('A stage can’t be its own next stage');
    }
    if (!samePipeline(merged.nextStatusId)) {
      throw errors.validation('The next stage must be a stage of the same pipeline');
    }
  }
  if (merged.handoff.mode === 'stage_holder' && !samePipeline(merged.handoff.statusId ?? '')) {
    throw errors.validation('The hand-off stage must be a stage of the same pipeline');
  }
  if (merged.sendBackTo.length > 0) {
    const earlier = new Set(
      own === undefined ? [] : earlierStageIds(stagesOf(db, { pipelineId: own }), statusId),
    );
    const bad = merged.sendBackTo.filter((id) =>
      options.anyOrder ? id === statusId || !samePipeline(id) : !earlier.has(id),
    );
    if (bad.length > 0 && patch.sendBackTo === undefined) {
      // Stages deleted or reordered after since: dropped when another rule is saved.
      merged.sendBackTo = merged.sendBackTo.filter((id) => !bad.includes(id));
    } else if (bad.length > 0) {
      throw errors.validation(
        'A stage can only send tasks back to earlier stages of its own pipeline',
        { sendBackTo: bad },
      );
    }
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

/**
 * Evidence of the task: of `statusId`'s current visit (archived evidence of earlier visits left
 * out), or every row of every stage and visit.
 */
function evidenceRows(db: DbExecutor, taskId: string, statusId?: string) {
  return db
    .select()
    .from(s.taskStageEvidence)
    .where(
      and(
        eq(s.taskStageEvidence.taskId, taskId),
        statusId
          ? and(eq(s.taskStageEvidence.statusId, statusId), isNull(s.taskStageEvidence.archivedAt))
          : undefined,
      ),
    )
    .orderBy(asc(s.taskStageEvidence.createdAt), asc(s.taskStageEvidence.id))
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
  /** Why the mover may not make this move at all (403): not a move the stage allows, or not them. */
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

/** Memo of the checks that are the same for every target of one stage. */
interface LeaveMemo {
  forbidden?: string | null;
  missing?: string[];
  backForbidden?: string | null;
}

/**
 * Can the task move from `from` to `to` (without force)? Pure check; nothing is written. Strict
 * (BAT-27): forward only to the next stage, through its leave rules; back only to a stage checked
 * in `from`'s `sendBackTo`, by whoever may move it on or approve `from` (the caller asks for the
 * reason). Everything else is refused.
 */
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
  const next = nextStage(statuses, from);
  if (next?.id === to.id) {
    if (memo.forbidden === undefined) {
      memo.forbidden = mayMoveOn(db, subject, rules)
        ? null
        : `Only ${whoMovesOn(rules, (rule) => describeRule(db, rule))} can move tasks out of ${from.name}`;
    }
    memo.missing ??= missingToLeave(db, subject.task, from);
    return { direction: 'forward', forbidden: memo.forbidden, missing: [...memo.missing] };
  }
  const back = backStages(statuses, from);
  if (back.some((row) => row.id === to.id)) {
    if (memo.backForbidden === undefined) {
      memo.backForbidden = maySendBack(db, subject, rules)
        ? null
        : `Only ${whoSendsBack(rules, (rule) => describeRule(db, rule))} can send tasks back from ${from.name}`;
    }
    return { direction: 'backward', forbidden: memo.backForbidden, missing: [] };
  }
  const fromIndex = statuses.findIndex((row) => row.id === from.id);
  const toIndex = statuses.findIndex((row) => row.id === to.id);
  if (toIndex > fromIndex) {
    return {
      direction: 'forward',
      forbidden: next
        ? `From ${from.name}, tasks only move on to ${next.name}`
        : `${from.name} is the last stage: tasks don’t move on from it`,
      missing: [],
    };
  }
  return {
    direction: 'backward',
    forbidden:
      back.length > 0
        ? `From ${from.name}, tasks can only be sent back to ${joinOr(back.map((row) => row.name))}`
        : `${from.name} doesn’t send tasks back`,
    missing: [],
  };
}

function moveByWords(moveBy: StageRules['moveBy']): string {
  return [
    ...(moveBy.assignees ? ['its assignees'] : []),
    ...(moveBy.claimer ? ['whoever claimed it'] : []),
  ].join(' or ');
}

/** Who may move a task out of a stage, in words ("its assignees or Reviewer"); null: anyone. */
export function whoMovesOn(
  rules: StageRules,
  words: (rule: PrincipalRule) => string,
): string | null {
  const parts = [
    ...(moveByWords(rules.moveBy) ? [moveByWords(rules.moveBy)] : []),
    ...(rules.moveRule ? [words(rules.moveRule)] : []),
  ];
  return parts.length > 0 ? parts.join(' or ') : null;
}

/**
 * May `subject.userId` move the task out of its stage forward (who may, not whether it's ready)?
 * With no `moveBy` and no `moveRule`, anyone who may move tasks can; `moveBy.assignees` also lets
 * anyone move a task that has no assignees and no claim, so unassigned work can't get stuck.
 */
function mayMoveOn(db: DbExecutor, subject: MoveSubject, rules: StageRules): boolean {
  const { moveBy, moveRule } = rules;
  if (!moveBy.assignees && !moveBy.claimer && !moveRule) return true;
  const { userId, task } = subject;
  if (!userId) return false;
  const claimer = task.claimedById && isClaimValid(task, new Date()) ? task.claimedById : null;
  if (moveBy.claimer && claimer === userId) return true;
  if (moveBy.assignees) {
    const users = stageUserIds(db, task.id, task.statusId);
    const roles = stageRoleIds(db, task.id, task.statusId);
    if (users.length === 0 && roles.length === 0 && !claimer) return true;
    if (users.includes(userId)) return true;
    if (
      roles.length > 0 &&
      matchesRule(db, subject.scope, userId, {
        allow: roles.map((roleId) => ({ type: 'role' as const, roleId, scope: 'both' as const })),
        deny: [],
      })
    ) {
      return true;
    }
  }
  return moveRule ? matchesRule(db, subject.scope, userId, moveRule) : false;
}

/**
 * May `subject.userId` send the task back from its stage? Whoever may move it on (anyone who may
 * move tasks when the stage names nobody), and whoever may approve the stage.
 */
function maySendBack(db: DbExecutor, subject: MoveSubject, rules: StageRules): boolean {
  if (mayMoveOn(db, subject, rules)) return true;
  return Boolean(
    rules.approvals &&
    subject.userId &&
    matchesRule(db, subject.scope, subject.userId, rules.approvals.rule),
  );
}

/** May the actor approve the task's current stage (and so send it back, BAT-27)? */
export function mayApproveStage(db: DbExecutor, actor: Actor, task: TaskRow): boolean {
  const status = db.select().from(s.status).where(eq(s.status.id, task.statusId)).get();
  const approvals = status ? rulesOf(status).approvals : null;
  return Boolean(
    approvals &&
    matchesRule(
      db,
      { teamId: task.teamId, projectId: task.projectId },
      actor.userId,
      approvals.rule,
    ),
  );
}

/** Who may send a task back from a stage, in words. */
function whoSendsBack(rules: StageRules, words: (rule: PrincipalRule) => string): string {
  const parts = [
    whoMovesOn(rules, words) ?? 'whoever may move tasks',
    ...(rules.approvals ? [`its approvers (${words(rules.approvals.rule)})`] : []),
  ];
  return parts.join(' or ');
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
  /** Which way the move goes within the pipeline (`pipeline`: to another pipeline). */
  direction: 'none' | 'forward' | 'backward' | 'pipeline';
  /** The reason given (required to send a task back, and to force a move). */
  reason: string | null;
}

/**
 * The audit meta of a move (BAT-27): a move back says so, with its reason
 * (`{ direction: 'back', reason }`).
 */
export function moveMeta(guard: GuardResult | null): Record<string, unknown> {
  return guard?.direction === 'backward' && guard.reason
    ? { direction: 'back', reason: guard.reason }
    : {};
}

/** Entry options for a guarded move: a move back carries its reason into the stage. */
export function returnOf(guard: GuardResult | null): EnterOptions {
  return guard?.direction === 'backward' && guard.reason
    ? { returned: { reason: guard.reason } }
    : {};
}

const EVIDENCE_HINT =
  ' Give evidence for each criterion (move_task evidence: [{ criterion, text }], or on the task page).';

/**
 * Checks a status change of the task against the stage rules, inside the write (BAT-27: forward
 * only to the next stage, back only to a send-back stage with a reason). Throws 403 when the mover
 * may not make the move, 409 listing everything that is missing and 400 when a move back has no
 * reason, unless a team owner or administrator forces it with a reason.
 */
export function guardStageMove(
  tx: Tx,
  actor: Actor,
  access: { task: TaskRow; project: ProjectRow; membership: Membership },
  from: StatusRow,
  to: StatusRow,
  options: ForceOptions = {},
): GuardResult {
  const reason = options.reason?.trim() || null;
  if (from.id === to.id) return { bypassed: [], direction: 'none', reason: null };
  if (from.pipelineId !== to.pipelineId) {
    return {
      ...guardPipelineMove(tx, actor, access, from, to, options),
      direction: 'pipeline',
      reason,
    };
  }
  const statuses = stagesOf(tx, from);
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
  const ref = formatTaskRef(access.project.key, access.task.number);
  const problems = [...(check.forbidden ? [check.forbidden] : []), ...check.missing];
  if (problems.length === 0) {
    if (check.direction === 'backward' && !reason) {
      throw errors.validation(
        `Give a reason for sending ${ref} back to ${to.name} (reason): it is posted on the task and given to whoever works on it next.`,
        { field: 'reason' },
      );
    }
    return { bypassed: [], direction: check.direction, reason };
  }
  if (options.force) {
    if (!canForceMove(access.membership)) {
      throw errors.forbidden(
        'Only the team owner or an administrator can force a move past the stage rules',
      );
    }
    if (!reason) throw errors.validation('Give a reason for forcing the move');
    return { bypassed: problems, direction: check.direction, reason };
  }
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

function forceOrThrow(
  access: { membership: Membership },
  options: ForceOptions,
  problems: string[],
  fail: () => never,
): Pick<GuardResult, 'bypassed'> {
  if (problems.length === 0) return { bypassed: [] };
  if (!options.force) fail();
  if (!canForceMove(access.membership)) {
    throw errors.forbidden(
      'Only the team owner or an administrator can force a move past the stage rules',
    );
  }
  if (!options.reason?.trim()) throw errors.validation('Give a reason for forcing the move');
  return { bypassed: problems };
}

/**
 * A move to a stage of another pipeline (BAT-25): the mover must be someone who may move the task
 * on from its stage (its move rule) and may create tasks in the other pipeline. The stage's
 * criteria and approvals don't apply: the task leaves this pipeline rather than finishing it.
 * Owners and administrators can force it like any move.
 */
function guardPipelineMove(
  tx: Tx,
  actor: Actor,
  access: { task: TaskRow; project: ProjectRow; membership: Membership },
  from: StatusRow,
  to: StatusRow,
  options: ForceOptions,
): Pick<GuardResult, 'bypassed'> {
  const problems: string[] = [];
  const rules = rulesOf(from);
  const subject = {
    task: access.task,
    scope: { teamId: access.project.teamId, projectId: access.project.id },
    userId: actor.userId,
  };
  if (!mayMoveOn(tx, subject, rules)) {
    problems.push(
      `Only ${whoMovesOn(rules, (rule) => describeRule(tx, rule))} can move tasks out of ${from.name}`,
    );
  }
  const target = tx.select().from(s.pipeline).where(eq(s.pipeline.id, to.pipelineId)).get();
  if (target && !pipelinePermissions(tx, access.membership, target).create) {
    problems.push(`You can’t add tasks to the ${target.name} pipeline`);
  }
  return forceOrThrow(access, options, problems, () => {
    throw errors.forbidden(`${problems.join('. ')}.`, {
      from: from.name,
      to: to.name,
      missing: problems,
    });
  });
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

/**
 * Of `candidates`, whoever is directly assigned to the fewest other live tasks of the project in
 * those tasks' current stages.
 */
function leastBusy(tx: Tx, task: TaskRow, candidates: readonly string[]): string[] {
  if (candidates.length === 0) return [];
  const load = new Map(
    tx
      .select({ userId: s.taskAssigneeUser.userId, n: count() })
      .from(s.taskAssigneeUser)
      .innerJoin(s.task, eq(s.task.id, s.taskAssigneeUser.taskId))
      .where(
        and(
          eq(s.task.projectId, task.projectId),
          isNull(s.task.deletedAt),
          currentUserRow,
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

interface Assignees {
  users: string[];
  roles: string[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function isEmpty(assignees: Assignees): boolean {
  return assignees.users.length === 0 && assignees.roles.length === 0;
}

/**
 * Whom a hand-off picks by itself (`specific`, `round_robin`, `least_busy`, `author`, `mover`,
 * `stage_holder`); null for the other modes, or when nobody matched.
 */
function handoffPick(
  tx: Tx,
  actor: Actor | null,
  task: TaskRow,
  status: StatusRow,
  rules: StageRules,
): Assignees | null {
  const scope = { teamId: task.teamId, projectId: task.projectId };
  const viewers = (ids: string[]) => projectViewerIds(tx, task.projectId, ids).sort();
  const { handoff } = rules;
  let users: string[];
  let roles: string[] = [];
  switch (handoff.mode) {
    case 'keep':
    case 'nobody':
    case 'pool':
      return null;
    case 'specific':
      users = ruleCandidates(tx, scope, handoff.rule);
      break;
    case 'round_robin':
      users = roundRobin(tx, status.id, ruleCandidates(tx, scope, handoff.rule));
      break;
    case 'least_busy':
      users = leastBusy(tx, task, ruleCandidates(tx, scope, handoff.rule));
      break;
    case 'author':
      users = task.authorId ? viewers([task.authorId]) : [];
      break;
    case 'mover':
      users = actor ? viewers([actor.userId]) : [];
      break;
    case 'stage_holder':
      // Whoever held it in that stage: its assignments there (people who can still see the
      // project, and roles).
      users = handoff.statusId ? viewers(stageUserIds(tx, task.id, handoff.statusId)) : [];
      roles = handoff.statusId ? stageRoleIds(tx, task.id, handoff.statusId) : [];
      break;
  }
  return users.length > 0 || roles.length > 0 ? { users, roles } : null;
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
  /**
   * The same request set the assignees explicitly while moving the task (`update_task` with a
   * status and assignees): they become the new stage's assignees and the hand-off is skipped.
   */
  assignees?: Assignees;
  /**
   * BAT-27: the task was sent back into `to` (a backward move): the reason is stored on the new
   * visit, posted in the task's thread ("Sent back from …: …") and given to its agents' jobs.
   */
  returned?: { reason: string };
}

/**
 * Everything that happens when a task enters `to` (inside the caller's write, after the status
 * column and the move's own audit row are written): closes the visit of `from` (remembering who
 * held it), dismisses leftover approvals and archives the evidence of an earlier visit of `to` (a
 * new visit needs new ones; the old ones stay as history), decides `to`'s assignees
 * with the hand-off, applies `notify`, records the new visit and calls the Wave 2C hook. Returns
 * the task row afterwards.
 *
 * Assignments belong to a task and a stage: `from`'s rows stay as history ("who held it there"),
 * and `to`'s rows become the task's current assignees:
 *   - `keep`: the assignees it had in `to` on an earlier visit, when it had any there (restored);
 *     otherwise a copy of `from`'s;
 *   - `nobody` and `pool`: none;
 *   - `specific`, `round_robin`, `least_busy`, `author`, `mover`, `stage_holder`: whom they pick,
 *     or as `keep` when nobody matched.
 * A task created with assignees keeps them; one created without goes through the first stage's
 * hand-off like any entry.
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
  const returned = options.returned?.reason.trim() ? options.returned : null;
  // Who had the task before: the stage it left (at creation, whom it was created with).
  const previous: Assignees = {
    users: stageUserIds(tx, task.id, from?.id ?? to.id),
    roles: stageRoleIds(tx, task.id, from?.id ?? to.id),
  };
  // Who held it in `to` on an earlier visit.
  const earlier: Assignees = from
    ? { users: stageUserIds(tx, task.id, to.id), roles: stageRoleIds(tx, task.id, to.id) }
    : previous;

  // Close the previous visit(s), remembering who held the task.
  if (from) {
    const holders = previous.users;
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

  // A new visit starts without the decisions and evidence of an earlier one.
  if (from) {
    tx.update(s.taskStageEvidence)
      .set({ archivedAt: now })
      .where(
        and(
          eq(s.taskStageEvidence.taskId, task.id),
          eq(s.taskStageEvidence.statusId, to.id),
          isNull(s.taskStageEvidence.archivedAt),
        ),
      )
      .run();
  }
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
  let after: Assignees;
  let restored = false;
  const none: Assignees = { users: [], roles: [] };
  if (options.assignees) {
    after = options.assignees;
  } else if (options.keepAssignees) {
    after = previous;
  } else if (rules.handoff.mode === 'nobody') {
    after = none;
  } else if (rules.handoff.mode === 'pool' && rules.handoff.rule) {
    pool = rules.handoff.rule;
    patch.poolRule = pool;
    after = none;
  } else {
    const picked = handoffPick(tx, actor, task, to, rules);
    if (picked) {
      assignedUserIds = picked.users;
      after = picked;
    } else if (from && !isEmpty(earlier)) {
      after = earlier;
      restored = true;
    } else {
      after = previous;
    }
  }

  if (!sameSet(after.users, earlier.users) || !sameSet(after.roles, earlier.roles)) {
    setStageAssignees(tx, task.id, to.id, after.users, after.roles);
  }
  const changed = !sameSet(after.users, previous.users) || !sameSet(after.roles, previous.roles);
  const target = {
    teamId: task.teamId,
    entityType: 'task' as const,
    entityId: task.id,
    title: `${formatTaskRef(context.projectKey, task.number)}: ${task.title}`,
    snippet: `Moved to ${to.name}`,
    url: appPaths.task(context.teamSlug, context.projectKey, task.number),
  };
  // Explicit assignees are audited and notified by the request that set them.
  if (changed && !options.assignees) {
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'task.handed_off',
      changes: {
        assignees: change(
          [...userLabels(tx, previous.users), ...roleLabels(tx, previous.roles)],
          [...userLabels(tx, after.users), ...roleLabels(tx, after.roles)],
        ),
      },
      meta: {
        ...taskMeta(task, context.projectKey),
        stage: to.name,
        mode: rules.handoff.mode,
        ...(restored ? { restored: true } : {}),
      },
    });
    const addedUsers = after.users.filter((id) => !previous.users.includes(id));
    const addedRoles = after.roles.filter((id) => !previous.roles.includes(id));
    if (addedUsers.length > 0 || addedRoles.length > 0) {
      autoSubscribe(tx, addedUsers, 'task', task.id);
      if (rules.onEnter.notifyAssignees) {
        notifyAssigned(tx, actor, target, { userIds: addedUsers, roleIds: addedRoles }, notified);
      }
    }
  }
  // The claim goes with the hand-off (a pool or `nobody` always frees it) unless the holder still
  // has the task.
  const handedOff =
    pool !== null ||
    assignedUserIds.length > 0 ||
    (rules.handoff.mode === 'nobody' && !options.assignees && !options.keepAssignees);
  if (
    handedOff &&
    task.claimedById &&
    isClaimValid(task, now) &&
    !after.users.includes(task.claimedById)
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
      ...(returned
        ? {
            returnReason: returned.reason,
            returnedById: actor?.userId ?? null,
            returnedViaKeyId: actor?.key?.id ?? null,
            returnedFromStatusId: from?.id ?? null,
          }
        : {}),
    })
    .run();
  if (returned && actor) {
    insertChangeReply(
      tx,
      actor,
      { type: 'task', id: task.id },
      `Sent back from ${from?.name ?? 'another stage'}: ${returned.reason}`,
    );
  }

  onTaskEnteredStage(tx, updated, to, actor, {
    from,
    rules,
    pool,
    assignedUserIds,
    needsApprovals: rules.approvals !== null,
    returned: returned ? { reason: returned.reason, from: from?.name ?? null } : null,
  });
  return updated;
}

/**
 * Moves the task to `to` on the system's initiative (auto-advance, Request changes): end of the
 * column, the stage's on-enter effects, a `task.moved` row (`meta` says why), the entry rules, and the
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
  enter: EnterOptions = {},
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
    enter,
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
  const next = nextStage(stagesOf(tx, current), current);
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
  return stageUserIds(tx, task.id, task.statusId).includes(membership.userId);
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
 * one of the stage's send-back stages (`sendBackTo`, default the nearest) with the comment as the
 * reason (required then); a stage that can't send back blocks leaving until it is dismissed. An
 * approval that satisfies the stage auto-advances it when `autoAdvance`.
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
    // Request changes sends it back (BAT-27): to the stage asked for, else the nearest one.
    let sendBackTo: StatusRow | null = null;
    if (input.decision === 'request_changes') {
      const back = backStages(stagesOf(tx, status), status);
      if (input.sendBackTo) {
        sendBackTo = back.find((row) => row.id === input.sendBackTo) ?? null;
        if (!sendBackTo) {
          throw errors.validation(
            back.length > 0
              ? `From ${status.name}, tasks can only be sent back to ${joinOr(back.map((row) => row.name))}`
              : `${status.name} doesn’t send tasks back`,
            { field: 'sendBackTo' },
          );
        }
      } else {
        sendBackTo = back[0] ?? null;
      }
      if (sendBackTo && !comment) {
        throw errors.validation(
          `Say what has to change (comment): it is the reason ${ref} goes back to ${sendBackTo.name}`,
          { field: 'comment' },
        );
      }
    }
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
      if (sendBackTo && comment) {
        changeStatus(
          tx,
          actor,
          context,
          status,
          sendBackTo,
          now,
          { changesRequested: true, direction: 'back', reason: comment },
          { returned: { reason: comment } },
        );
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
  const beforeUsers = stageUserIds(tx, task.id, task.statusId);
  const beforeRoles = stageRoleIds(tx, task.id, task.statusId);
  setStageAssignees(tx, task.id, task.statusId, [actor.userId], []);
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

type EntryRow = typeof s.taskStageEntry.$inferSelect;

/** The visit of `statusId` a row written at `at` belongs to: the latest one entered by then. */
function visitAt(entries: readonly EntryRow[], statusId: string, at: Date): EntryRow | null {
  let found: EntryRow | null = null;
  for (const entry of entries) {
    if (entry.statusId !== statusId || entry.enteredAt.getTime() > at.getTime()) continue;
    if (!found || entry.enteredAt.getTime() >= found.enteredAt.getTime()) found = entry;
  }
  return found;
}

function visitRef(entry: EntryRow | null) {
  return entry
    ? { enteredAt: entry.enteredAt.toISOString(), leftAt: entry.leftAt?.toISOString() ?? null }
    : null;
}

/**
 * The task's stage as the viewer sees it (task page, `get_task`), or null when its status is gone:
 * what to do, the criteria and approvals of the current visit, where it can move (BAT-27), why it
 * came back, and the evidence, decisions and visits of earlier ones.
 */
export function stageOf(db: DbExecutor, viewer: Actor, task: TaskRow): TaskStage | null {
  const own = db.select().from(s.status).where(eq(s.status.id, task.statusId)).get();
  const statuses = own ? stagesOf(db, own) : [];
  const current = statuses.find((row) => row.id === task.statusId);
  if (!current) return null;
  const rules = rulesOf(current);
  const scope = { teamId: task.teamId, projectId: task.projectId };
  const access = getProjectAccess(db, viewer.userId, task.projectId);
  const canUpdate = access ? canUpdateTask(access, task) : false;
  const book = nameBook(db, [rules.moveRule, rules.approvals?.rule, task.poolRule]);
  const statusNames = new Map(projectStatuses(db, task.projectId).map((row) => [row.id, row.name]));
  const ref = (id: string) => ({ id, name: statusNames.get(id) ?? 'a deleted stage' });

  const entries = db
    .select()
    .from(s.taskStageEntry)
    .where(eq(s.taskStageEntry.taskId, task.id))
    .orderBy(asc(s.taskStageEntry.enteredAt), asc(s.taskStageEntry.id))
    .all();
  const currentVisit =
    [...entries].reverse().find((entry) => entry.statusId === current.id && !entry.leftAt) ?? null;

  const evidence = evidenceRows(db, task.id);
  const criteria = criteriaWithEvidence(
    db,
    rules.exitCriteria,
    evidence.filter((row) => row.statusId === current.id && !row.archivedAt),
    false,
  );

  const canApprove = rules.approvals
    ? matchesRule(db, scope, viewer.userId, rules.approvals.rule)
    : false;
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
      canApprove,
    };
  }

  // Where it can go (BAT-27).
  const next = nextStage(statuses, current);
  const back = backStages(statuses, current);
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
  const mayBack = (canUpdate && maySendBack(db, subject, rules)) || canApprove;
  const canMoveTo = {
    forward:
      next && nextCheck
        ? {
            id: next.id,
            name: next.name,
            missing: [
              ...(canUpdate ? [] : ['permission to move tasks']),
              ...(nextCheck.forbidden ? [nextCheck.forbidden] : []),
              ...nextCheck.missing,
            ],
          }
        : null,
    back: mayBack ? back.map((row) => ({ id: row.id, name: row.name })) : [],
  };
  const assigned = stageUserIds(db, task.id, task.statusId).includes(viewer.userId);

  const people = getUserSummaries(
    db,
    entries.flatMap((entry) => [entry.enteredById, entry.returnedById]),
  );
  const entryKeys = getViaKeys(
    db,
    entries.map((entry) => entry.returnedViaKeyId),
  );
  const returnReason =
    currentVisit?.returnReason != null
      ? {
          reason: currentVisit.returnReason,
          by: currentVisit.returnedById ? (people.get(currentVisit.returnedById) ?? null) : null,
          via: currentVisit.returnedViaKeyId
            ? (entryKeys.get(currentVisit.returnedViaKeyId) ?? null)
            : null,
          from: currentVisit.returnedFromStatusId ? ref(currentVisit.returnedFromStatusId) : null,
          at: currentVisit.enteredAt.toISOString(),
        }
      : null;
  const visits = entries.map((entry) => ({
    id: entry.id,
    status: ref(entry.statusId),
    enteredAt: entry.enteredAt.toISOString(),
    leftAt: entry.leftAt?.toISOString() ?? null,
    enteredBy: entry.enteredById ? (people.get(entry.enteredById) ?? null) : null,
    returnReason: entry.returnReason,
    returnedFrom: entry.returnedFromStatusId ? ref(entry.returnedFromStatusId) : null,
  }));

  // Evidence of other stages and of earlier visits of this one, a group per visit.
  const evidenceGroups = new Map<
    string,
    { status: string; visit: EntryRow | null; rows: typeof evidence }
  >();
  for (const row of evidence) {
    if (row.statusId === current.id && !row.archivedAt) continue;
    const visit = visitAt(entries, row.statusId, row.createdAt);
    const key = `${row.statusId}:${visit?.id ?? ''}`;
    const group = evidenceGroups.get(key) ?? { status: row.statusId, visit, rows: [] };
    group.rows.push(row);
    evidenceGroups.set(key, group);
  }
  const statusRules = new Map(statuses.map((row) => [row.id, rulesOf(row)]));
  const previousEvidence = [...evidenceGroups.values()]
    .sort(
      (a, b) =>
        (a.visit?.enteredAt.getTime() ?? a.rows[0]?.createdAt.getTime() ?? 0) -
        (b.visit?.enteredAt.getTime() ?? b.rows[0]?.createdAt.getTime() ?? 0),
    )
    .map((group) => {
      const stageCriteria = (statusRules.get(group.status)?.exitCriteria ?? []).filter(
        (criterion) => group.rows.some((item) => item.criterionId === criterion.id),
      );
      return {
        status: ref(group.status),
        visit: visitRef(group.visit),
        criteria: criteriaWithEvidence(db, stageCriteria, group.rows),
      };
    });

  // Decisions of other stages and earlier visits (those dismissed during their visit left out).
  const decisions = db
    .select()
    .from(s.taskApproval)
    .where(eq(s.taskApproval.taskId, task.id))
    .orderBy(asc(s.taskApproval.createdAt), asc(s.taskApproval.id))
    .all()
    .flatMap((row) => {
      const visit = visitAt(entries, row.statusId, row.createdAt);
      // The current visit's decisions are `approvals.given`.
      if (row.statusId === current.id && (!visit || visit.id === currentVisit?.id)) return [];
      if (row.dismissedAt && (!visit?.leftAt || row.dismissedAt < visit.leftAt)) return [];
      return [{ row, visit }];
    });
  const deciders = getUserSummaries(
    db,
    decisions.map((item) => item.row.userId),
  );
  const decisionKeys = getViaKeys(
    db,
    decisions.map((item) => item.row.viaKeyId),
  );
  const decisionGroups = new Map<
    string,
    { status: string; visit: EntryRow | null; rows: Array<(typeof decisions)[number]['row']> }
  >();
  for (const { row, visit } of decisions) {
    const key = `${row.statusId}:${visit?.id ?? ''}`;
    const group = decisionGroups.get(key) ?? { status: row.statusId, visit, rows: [] };
    group.rows.push(row);
    decisionGroups.set(key, group);
  }
  const previousApprovals = [...decisionGroups.values()].map((group) => ({
    status: ref(group.status),
    visit: visitRef(group.visit),
    decisions: group.rows.map((decision) => ({
      id: decision.id,
      user: decision.userId ? (deciders.get(decision.userId) ?? null) : null,
      via: decision.viaKeyId ? (decisionKeys.get(decision.viaKeyId) ?? null) : null,
      decision: decision.decision,
      comment: decision.comment,
      createdAt: decision.createdAt.toISOString(),
    })),
  }));

  return {
    status: { id: current.id, name: current.name },
    instructions: rules.instructions,
    criteria,
    approvals,
    moveRule: whoMovesOn(rules, (rule) => ruleText(rule, book)),
    next: next ? { id: next.id, name: next.name } : null,
    sendBackTo: back[0] ? { id: back[0].id, name: back[0].name } : null,
    canMoveTo,
    returnReason,
    visits,
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
    previousApprovals,
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
    .where(and(inArray(s.taskStageEvidence.taskId, ids), isNull(s.taskStageEvidence.archivedAt)))
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
