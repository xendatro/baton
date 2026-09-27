import { and, eq, isNull } from 'drizzle-orm';
import type { Principal, PrincipalRule } from '@shared/principals';
import { RULE_HANDOFF_MODES, type StageRules } from '@shared/schemas/pipelines';
import type { Actor } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { requireProjectAccess } from './access';
import { resolvePrincipal, sourceLabel } from './pipelineCopy';
import { rulesOf, stagesOf, type StatusRow } from './pipelines';
import { pipelinePermissions } from './projectPipelines';

/**
 * "Create from existing" (2026-09-27): the rules of a stage the viewer can see, in any project,
 * made to fit a new stage at the end of another pipeline. Everything but the name, look, position
 * and default flag is copied. Stages it names (next stage, send-back stages, the stage-holder
 * hand-off) map to the target pipeline's stage of the same name (case-insensitive; the same stage
 * within one pipeline); people, roles and project roles map like "Copy pipeline from…" does
 * (`resolvePrincipal`). What has no match is dropped rather than blocking the copy, and listed so
 * the UI and agents can say so: a rule left naming nobody is cleared (a hand-off falls back to
 * `keep`, approvals and move rules go).
 */

export interface CopiedStage {
  rules: StageRules;
  defaultDifficultyId: string | null;
  /** "Team / KEY / Pipeline / Stage", shorter when the source is closer. */
  from: string;
  dropped: string[];
}

interface Target {
  teamId: string;
  projectId: string;
  pipelineId: string;
}

/** The source stage, when the actor can see it (404 otherwise). */
function requireVisibleStage(db: DbExecutor, actor: Actor, statusId: string) {
  const row = db
    .select({ status: s.status, project: s.project, team: s.team, pipeline: s.pipeline })
    .from(s.status)
    .innerJoin(s.project, eq(s.project.id, s.status.projectId))
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .innerJoin(s.pipeline, eq(s.pipeline.id, s.status.pipelineId))
    .where(
      and(
        eq(s.status.id, statusId),
        isNull(s.project.deletedAt),
        isNull(s.team.deletedAt),
        isNull(s.pipeline.deletedAt),
      ),
    )
    .get();
  if (!row) throw errors.notFound('Stage to copy');
  const membership = requireProjectAccess(db, actor, row.project.id, 'Stage to copy');
  if (!pipelinePermissions(db, membership, row.pipeline).view) {
    throw errors.notFound('Stage to copy');
  }
  return row;
}

export function copyStageRules(
  db: DbExecutor,
  actor: Actor,
  target: Target,
  sourceStatusId: string,
): CopiedStage {
  const source = requireVisibleStage(db, actor, sourceStatusId);
  const src = rulesOf(source.status);
  const dropped: string[] = [];
  const sourceScope = { teamId: source.project.teamId, projectId: source.project.id };
  const targetScope = { teamId: target.teamId, projectId: target.projectId };

  // Stages: the same stage within one pipeline, else the target's stage of the same name.
  const sourceStages = stagesOf(db, source.status);
  const targetStages = stagesOf(db, { pipelineId: target.pipelineId });
  const samePipeline = source.status.pipelineId === target.pipelineId;
  const stageName = (id: string) => sourceStages.find((row) => row.id === id)?.name;
  const mapStage = (id: string): StatusRow | null => {
    if (samePipeline) return targetStages.find((row) => row.id === id) ?? null;
    const name = stageName(id)?.toLowerCase();
    return name ? (targetStages.find((row) => row.name.toLowerCase() === name) ?? null) : null;
  };
  const noStage = (id: string, what: string) =>
    dropped.push(`${what} “${stageName(id) ?? 'a deleted stage'}” (no stage of that name here)`);

  // People and roles, like "Copy pipeline from…".
  const mapRule = (rule: PrincipalRule, where: string): PrincipalRule | null => {
    const keep = (principal: Principal) => {
      const mapped = resolvePrincipal(db, sourceScope, targetScope, principal);
      if (!mapped) dropped.push(`${sourceLabel(db, principal)} (${where})`);
      return mapped;
    };
    const allow = rule.allow.map(keep).filter((p): p is Principal => p !== null);
    const deny = rule.deny.map(keep).filter((p): p is Principal => p !== null);
    if (rule.allow.length > 0 && allow.length === 0) {
      dropped.push(`${where}: it named nobody here, so it was cleared`);
      return null;
    }
    return { allow, deny };
  };

  let handoff: StageRules['handoff'] = { mode: src.handoff.mode };
  if (RULE_HANDOFF_MODES.has(src.handoff.mode) && src.handoff.rule) {
    const rule = mapRule(src.handoff.rule, 'hand-off');
    handoff = rule ? { mode: src.handoff.mode, rule } : { mode: 'keep' };
  } else if (src.handoff.mode === 'stage_holder' && src.handoff.statusId) {
    const stage = mapStage(src.handoff.statusId);
    if (stage) handoff = { mode: 'stage_holder', statusId: stage.id };
    else {
      noStage(src.handoff.statusId, 'Hand-off to whoever held');
      handoff = { mode: 'keep' };
    }
  }

  let nextStatusId: string | null = null;
  if (src.nextStatusId) {
    const stage = mapStage(src.nextStatusId);
    if (stage) nextStatusId = stage.id;
    else noStage(src.nextStatusId, 'Next stage');
  }

  // The new stage goes last, so every mapped stage is an earlier one.
  const sendBackTo: string[] = [];
  for (const id of src.sendBackTo) {
    if (id === source.status.id) continue;
    const stage = mapStage(id);
    if (stage) {
      if (!sendBackTo.includes(stage.id)) sendBackTo.push(stage.id);
    } else noStage(id, 'Send back to');
  }

  const approvalsRule = src.approvals ? mapRule(src.approvals.rule, 'approvers') : null;
  const rules: StageRules = {
    ...src,
    handoff,
    notify: src.notify ? mapRule(src.notify, 'notify') : null,
    moveRule: src.moveRule ? mapRule(src.moveRule, 'who can move on') : null,
    approvals: src.approvals && approvalsRule ? { ...src.approvals, rule: approvalsRule } : null,
    nextStatusId,
    sendBackTo,
  };

  // BAT-28: the default difficulty, by level name in another project.
  let defaultDifficultyId: string | null = null;
  if (source.status.defaultDifficultyId) {
    if (source.project.id === target.projectId) {
      defaultDifficultyId = source.status.defaultDifficultyId;
    } else {
      const level = db
        .select({ name: s.difficulty.name })
        .from(s.difficulty)
        .where(eq(s.difficulty.id, source.status.defaultDifficultyId))
        .get();
      const match = level
        ? db
            .select({ id: s.difficulty.id, name: s.difficulty.name })
            .from(s.difficulty)
            .where(eq(s.difficulty.projectId, target.projectId))
            .all()
            .find((row) => row.name.toLowerCase() === level.name.toLowerCase())
        : undefined;
      if (match) defaultDifficultyId = match.id;
      else if (level)
        dropped.push(`Default difficulty “${level.name}” (no level of that name here)`);
    }
  }

  const from = [
    ...(source.project.teamId === target.teamId ? [] : [source.team.name]),
    ...(source.project.id === target.projectId ? [] : [source.project.key]),
    ...(samePipeline ? [] : [source.pipeline.name]),
    source.status.name,
  ].join(' / ');
  return { rules, defaultDifficultyId, from, dropped };
}
