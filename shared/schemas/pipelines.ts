import { z } from 'zod';
import { principalRuleSchema, principalSchema, type PrincipalRule } from '../principals';
import { idSchema, timestampSchema } from './common';
import { userSummarySchema, viaKeySchema } from './core';

/**
 * Pipelines (docs/design/agents-and-pipelines.md §5): optional per-status ("stage") rules, and
 * what a task shows about its stage. Every rule is optional; a project whose statuses have none
 * behaves exactly as before.
 */

export const PIPELINE_LIMITS = {
  instructions: 20_000,
  criteria: 20,
  criterionText: 300,
  evidence: 5_000,
  maxApprovals: 10,
  comment: 2_000,
  reason: 500,
} as const;

// ---------------------------------------------------------------------------------------------
// Stage rules (on each status)
// ---------------------------------------------------------------------------------------------

/**
 * Who a task's assignees are in the stage it enters (assignments belong to a task and a stage):
 * `keep` (the assignees it had in this stage on an earlier visit, else the previous stage's),
 * `nobody` (no assignees here), `specific` (the users of `rule`), `pool` (nobody; anyone matching
 * `rule` may claim it), `round_robin` / `least_busy` (one of `rule`'s users), `author`, `mover`,
 * `stage_holder` (whoever held it in `statusId`).
 */
export const HANDOFF_MODES = [
  'keep',
  'nobody',
  'specific',
  'pool',
  'round_robin',
  'least_busy',
  'author',
  'mover',
  'stage_holder',
] as const;
export type HandoffMode = (typeof HANDOFF_MODES)[number];

/** Modes that pick people from `rule`. */
export const RULE_HANDOFF_MODES: ReadonlySet<HandoffMode> = new Set([
  'specific',
  'pool',
  'round_robin',
  'least_busy',
]);

export const handoffSchema = z
  .object({
    mode: z.enum(HANDOFF_MODES),
    rule: principalRuleSchema.optional(),
    /** `stage_holder`: the stage whose last holder gets the task. */
    statusId: idSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (RULE_HANDOFF_MODES.has(value.mode) && !value.rule?.allow.length) {
      ctx.addIssue({ code: 'custom', path: ['rule'], message: 'Choose who gets the task' });
    }
    if (value.mode === 'stage_holder' && !value.statusId) {
      ctx.addIssue({ code: 'custom', path: ['statusId'], message: 'Choose the stage' });
    }
  });
export type Handoff = z.infer<typeof handoffSchema>;

export const criterionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, 'Only letters, digits, - and _');

export const exitCriterionSchema = z.object({
  /** Stable id (agents pass evidence by it). */
  id: criterionIdSchema,
  text: z
    .string()
    .trim()
    .min(1, 'Required')
    .max(PIPELINE_LIMITS.criterionText, `At most ${PIPELINE_LIMITS.criterionText} characters`),
});
export type ExitCriterion = z.infer<typeof exitCriterionSchema>;

export const approvalsRuleSchema = z.object({
  /** Approvals needed to leave the stage; each person or agent counts once. */
  count: z.number().int().min(1).max(PIPELINE_LIMITS.maxApprovals),
  /** Who may approve. */
  rule: principalRuleSchema,
  /** Editing the title, description or evidence dismisses the stage's approvals. */
  dismissOnChange: z.boolean().default(false),
});
export type ApprovalsRule = z.infer<typeof approvalsRuleSchema>;

const criteriaListSchema = z
  .array(exitCriterionSchema)
  .max(PIPELINE_LIMITS.criteria, `At most ${PIPELINE_LIMITS.criteria} criteria`)
  .refine(
    (items) => new Set(items.map((item) => item.id.toLowerCase())).size === items.length,
    'Each criterion needs its own id',
  );

/** What entering the stage does besides the hand-off (only `notifyAssignees` is on by default). */
export const onEnterRulesSchema = z.object({
  /** Resolve the open issues the task `fixes`. */
  resolveIssues: z.boolean(),
  /** Release the task's claim. */
  releaseClaim: z.boolean(),
  /** Tell the task's author it reached this stage. */
  notifyAuthor: z.boolean(),
  /** Notify the people the hand-off assigns (default true). */
  notifyAssignees: z.boolean().default(true),
  /** Tell whoever held the task in the stage it left that it reached this stage. */
  notifyPreviousHolder: z.boolean().default(false),
});
export type OnEnterRules = z.infer<typeof onEnterRulesSchema>;

/** Who may move a task on, besides a `moveRule`: its assignees, whoever claimed it. */
export const moveBySchema = z.object({ assignees: z.boolean(), claimer: z.boolean() });
export type MoveBy = z.infer<typeof moveBySchema>;

export const stageRulesSchema = z.object({
  /** Markdown: what to do in this stage. */
  instructions: z.string().max(PIPELINE_LIMITS.instructions),
  /** On enter: who gets the task. */
  handoff: handoffSchema,
  /** On enter: who is notified (not assigned). */
  notify: principalRuleSchema.nullable(),
  /** On enter: resolve fixed issues, release the claim, tell the author. */
  onEnter: onEnterRulesSchema,
  /**
   * A task in this stage still blocks the tasks waiting on it (default). Tasks in a stage that
   * doesn't are "completed" (`completedAt`).
   */
  blocksDependents: z.boolean(),
  /** `claim_next_task` may pick tasks in this stage, and `claim_task` works here (default). */
  claimable: z.boolean(),
  /** To leave forward: each needs evidence text. */
  exitCriteria: criteriaListSchema,
  /**
   * To leave forward: who may move it out besides `moveRule`. With neither, whoever may move tasks
   * can; `assignees` also lets anyone move a task that has no assignees and no claim.
   */
  moveBy: moveBySchema,
  /** To leave forward: who may move it out (null: whoever may move tasks). */
  moveRule: principalRuleSchema.nullable(),
  /** To leave forward: approvals needed. */
  approvals: approvalsRuleSchema.nullable(),
  /** Move on by itself once the criteria and approvals are satisfied. */
  autoAdvance: z.boolean(),
  /** The stage after this one (null: the next column). */
  nextStatusId: z.string().nullable(),
  /** Request changes / moving back goes to the previous stage (only). */
  allowSendBack: z.boolean(),
});
export type StageRules = z.infer<typeof stageRulesSchema>;

export const DEFAULT_STAGE_RULES: StageRules = {
  instructions: '',
  handoff: { mode: 'keep' },
  notify: null,
  onEnter: {
    resolveIssues: false,
    releaseClaim: false,
    notifyAuthor: false,
    notifyAssignees: true,
    notifyPreviousHolder: false,
  },
  blocksDependents: true,
  claimable: true,
  exitCriteria: [],
  moveBy: { assignees: false, claimer: false },
  moveRule: null,
  approvals: null,
  autoAdvance: false,
  nextStatusId: null,
  allowSendBack: true,
};

/** A change to a status's rules: only the fields given change. */
export const stageRulesPatchSchema = z.object({
  instructions: z.string().max(PIPELINE_LIMITS.instructions).optional(),
  handoff: handoffSchema.optional(),
  notify: principalRuleSchema.nullable().optional(),
  /** Only the flags given change. */
  onEnter: z
    .object({
      resolveIssues: z.boolean(),
      releaseClaim: z.boolean(),
      notifyAuthor: z.boolean(),
      notifyAssignees: z.boolean(),
      notifyPreviousHolder: z.boolean(),
    })
    .partial()
    .optional(),
  blocksDependents: z.boolean().optional(),
  claimable: z.boolean().optional(),
  exitCriteria: criteriaListSchema.optional(),
  moveBy: moveBySchema.optional(),
  moveRule: principalRuleSchema.nullable().optional(),
  approvals: approvalsRuleSchema.nullable().optional(),
  autoAdvance: z.boolean().optional(),
  nextStatusId: idSchema.nullable().optional(),
  allowSendBack: z.boolean().optional(),
});
export type StageRulesPatch = z.infer<typeof stageRulesPatchSchema>;

/** Rules that must be met (or checked) to leave the stage forward. */
export function isGatedStage(rules: StageRules): boolean {
  return (
    rules.exitCriteria.length > 0 ||
    rules.approvals !== null ||
    rules.moveRule !== null ||
    rules.moveBy.assignees ||
    rules.moveBy.claimer
  );
}

/** Does the stage have any rule beyond its instructions? */
export function hasStageRules(rules: StageRules): boolean {
  return (
    isGatedStage(rules) ||
    rules.handoff.mode !== 'keep' ||
    rules.notify !== null ||
    rules.onEnter.resolveIssues ||
    rules.onEnter.releaseClaim ||
    rules.onEnter.notifyAuthor ||
    !rules.onEnter.notifyAssignees ||
    rules.onEnter.notifyPreviousHolder ||
    !rules.blocksDependents ||
    !rules.claimable ||
    rules.autoAdvance ||
    rules.nextStatusId !== null ||
    !rules.allowSendBack
  );
}

/** Every rule of a stage, for copying and summaries. */
export function rulePrincipals(rules: StageRules): Array<{ where: string; rule: PrincipalRule }> {
  return [
    ...(rules.handoff.rule ? [{ where: 'hand-off', rule: rules.handoff.rule }] : []),
    ...(rules.notify ? [{ where: 'notify', rule: rules.notify }] : []),
    ...(rules.moveRule ? [{ where: 'who can move on', rule: rules.moveRule }] : []),
    ...(rules.approvals ? [{ where: 'approvers', rule: rules.approvals.rule }] : []),
  ];
}

// ---------------------------------------------------------------------------------------------
// A task's stage (task page, get_task)
// ---------------------------------------------------------------------------------------------

export const stageRefSchema = z.object({ id: z.string(), name: z.string() });

export const stageEvidenceSchema = z.object({
  text: z.string(),
  user: userSummarySchema.nullable(),
  via: viaKeySchema.nullable(),
  updatedAt: timestampSchema,
});
export type StageEvidence = z.infer<typeof stageEvidenceSchema>;

export const stageCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  evidence: stageEvidenceSchema.nullable(),
});
export type StageCriterion = z.infer<typeof stageCriterionSchema>;

export const APPROVAL_DECISIONS = ['approve', 'request_changes'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const stageApprovalSchema = z.object({
  id: z.string(),
  user: userSummarySchema.nullable(),
  via: viaKeySchema.nullable(),
  decision: z.enum(APPROVAL_DECISIONS),
  comment: z.string().nullable(),
  createdAt: timestampSchema,
});
export type StageApproval = z.infer<typeof stageApprovalSchema>;

export const taskStageSchema = z.object({
  /** The stage the task is in. */
  status: stageRefSchema,
  /** Markdown. */
  instructions: z.string(),
  /** Exit criteria with their evidence (editable while the task is in this stage). */
  criteria: z.array(stageCriterionSchema),
  approvals: z
    .object({
      required: z.number().int(),
      approved: z.number().int(),
      /** Who may approve, in words. */
      rule: z.string(),
      dismissOnChange: z.boolean(),
      /** Current decisions (dismissed ones left out), oldest first. */
      given: z.array(stageApprovalSchema),
      /** The viewer may approve or request changes. */
      canApprove: z.boolean(),
    })
    .nullable(),
  /** Who may move it on, in words (null: whoever may move tasks). */
  moveRule: z.string().nullable(),
  /** The stage it moves on to (null: the last stage). */
  next: stageRefSchema.nullable(),
  /** Where "Request changes" / moving back sends it (null: not allowed). */
  sendBackTo: stageRefSchema.nullable(),
  autoAdvance: z.boolean(),
  /** Unassigned and claimable by the pool (`rule` in words). */
  pool: z.object({ rule: z.string(), canClaim: z.boolean() }).nullable(),
  canEditEvidence: z.boolean(),
  /** The viewer may move it on to `next` now. */
  canMove: z.boolean(),
  /** The viewer is the team owner or an administrator (may force a move with a reason). */
  canForce: z.boolean(),
  /** What is still missing to move on (human-readable). */
  missing: z.array(z.string()),
  /** Why the viewer can't move it to other statuses: status id → reason. */
  blockedMoves: z.record(z.string(), z.string()),
  /** Evidence given in earlier stages (read-only). */
  previousEvidence: z.array(
    z.object({ status: stageRefSchema, criteria: z.array(stageCriterionSchema) }),
  ),
  /**
   * Approvals and change requests given in earlier stages, with their comments (read-only), so
   * what a reviewer asked for isn't lost once the task moves on. Optional for older fixtures.
   */
  previousApprovals: z
    .array(z.object({ status: stageRefSchema, decisions: z.array(stageApprovalSchema) }))
    .optional(),
});
export type TaskStage = z.infer<typeof taskStageSchema>;

/** What a board card shows about its stage: "Approvals 1/2", "Criteria 2/3", "Claimable". */
export const taskPipelineSummarySchema = z.object({
  approvals: z.object({ approved: z.number().int(), required: z.number().int() }).nullable(),
  criteria: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
  claimable: z.boolean(),
});
export type TaskPipelineSummary = z.infer<typeof taskPipelineSummarySchema>;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** Evidence for the current stage's exit criteria: criterion id → text ("" removes it). */
export const evidenceInputSchema = z
  .record(criterionIdSchema, z.string().trim().max(PIPELINE_LIMITS.evidence))
  .refine((value) => Object.keys(value).length <= PIPELINE_LIMITS.criteria, 'Too many criteria');
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

/** `PUT /api/tasks/:taskId/evidence`. */
export const saveEvidenceInputSchema = z.object({ evidence: evidenceInputSchema });
export type SaveEvidenceInput = z.infer<typeof saveEvidenceInputSchema>;

/** Team owner / administrator override of every stage rule (audited as `task.forced`). */
export const forceMoveFields = {
  force: z.boolean().optional(),
  reason: z.string().trim().max(PIPELINE_LIMITS.reason).optional(),
};

/** `POST /api/tasks/:taskId/approvals`. */
export const approvalInputSchema = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  comment: z.string().trim().max(PIPELINE_LIMITS.comment).optional(),
});
export type ApprovalInput = z.infer<typeof approvalInputSchema>;

// ---------------------------------------------------------------------------------------------
// Copy pipeline
// ---------------------------------------------------------------------------------------------

/** `GET /api/projects/:projectId/pipeline/copy-preview?from=<projectId>`. */
export const copyPipelinePreviewQuerySchema = z.object({
  from: idSchema,
  /** BAT-25: the source project's pipeline (default: its default pipeline). */
  fromPipeline: idSchema.optional(),
  /** BAT-25: the pipeline copied into (default: the target's default pipeline). */
  pipeline: idSchema.optional(),
});

export const unresolvedPrincipalSchema = z.object({
  /** Stable key to answer in `replacements`. */
  key: z.string(),
  principal: principalSchema,
  /** How the source project names it ("@ann", "Reviewer (role)"). */
  label: z.string(),
  /** Where it is used: "In review: approvers". */
  usedIn: z.array(z.string()),
});
export type UnresolvedPrincipal = z.infer<typeof unresolvedPrincipalSchema>;

export const copyPipelinePreviewSchema = z.object({
  source: z.object({ id: z.string(), key: z.string(), name: z.string(), teamName: z.string() }),
  statuses: z.array(
    z.object({ name: z.string(), action: z.enum(['create', 'update']), hasRules: z.boolean() }),
  ),
  /** Principals the target team doesn't have: re-pick (or drop) each before copying. */
  unresolved: z.array(unresolvedPrincipalSchema),
});
export type CopyPipelinePreview = z.infer<typeof copyPipelinePreviewSchema>;

/** `POST /api/projects/:projectId/pipeline/copy`. */
export const copyPipelineInputSchema = z.object({
  fromProjectId: idSchema,
  /** BAT-25: the source project's pipeline (default: its default pipeline). */
  fromPipelineId: idSchema.optional(),
  /** BAT-25: the pipeline copied into (default: the target's default pipeline). */
  pipelineId: idSchema.optional(),
  /** Unresolved principal key → its replacement in the target team, or null to drop it. */
  replacements: z.record(z.string().max(200), principalSchema.nullable()).default({}),
});
export type CopyPipelineInput = z.input<typeof copyPipelineInputSchema>;
