import { and, eq, sql } from 'drizzle-orm';
import type { Principal, PrincipalRule } from '@shared/principals';
import {
  DEFAULT_STAGE_RULES,
  hasStageRules,
  rulePrincipals,
  type CopyPipelineInput,
  type CopyPipelinePreview,
  type StageRules,
  type UnresolvedPrincipal,
} from '@shared/schemas/pipelines';
import { PROJECT_LIMITS, type StatusListResponse } from '@shared/schemas/projects';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { requirePermission } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { mergeRules, ruleColumns, rulesOf, type StatusRow } from './pipelines';
import { defaultPipeline, pipelineStatuses, resolvePipeline } from './projectPipelines';
import { requireProject } from './projects';
import { statusesOf, syncCompletion } from './statuses';

/**
 * "Copy pipeline from…" (design §5): copies another project's statuses and their rules into this
 * one. Statuses are matched by name (case-insensitive): a match gets the source's rules (its name,
 * color and icon stay; its tasks' completion follows the copied `blocksDependents`), a status the
 * target lacks is created with the source's color and icon, and
 * the target's other statuses stay after the copied ones. People, roles and project roles the
 * target team doesn't have are listed by the preview and must be re-picked (or explicitly dropped)
 * in `replacements`; nothing is dropped silently.
 */

interface Scope {
  teamId: string;
  projectId: string;
}

interface PipelineChoice {
  fromPipelineId?: string | undefined;
  pipelineId?: string | undefined;
}

function access(
  deps: AppDeps,
  actor: Actor,
  targetId: string,
  sourceId: string,
  choice: PipelineChoice = {},
) {
  const { orm } = deps.db;
  const target = requireProject(orm, actor, targetId);
  requirePermission(
    target.membership,
    'MANAGE_STATUSES',
    "You don't have permission to manage statuses",
  );
  const source = requireProject(orm, actor, sourceId);
  requirePermission(
    source.membership,
    'MANAGE_STATUSES',
    'You can only copy the pipeline of a project whose statuses you can manage',
  );
  // BAT-25: pipeline to pipeline, the default ones unless chosen (another of the same project too).
  const pick = (projectId: string, ref: string | undefined) =>
    ref ? resolvePipeline(orm, projectId, ref) : defaultPipeline(orm, projectId);
  const sourcePipeline = pick(sourceId, choice.fromPipelineId);
  const targetPipeline = pick(targetId, choice.pipelineId);
  if (sourcePipeline.id === targetPipeline.id) {
    throw errors.validation('Pick another pipeline to copy from');
  }
  return { target, source, sourcePipeline, targetPipeline };
}

function principalKey(principal: Principal): string {
  switch (principal.type) {
    case 'user':
      return `user:${principal.userId}`;
    case 'role':
      return `role:${principal.roleId}:${principal.scope}`;
    case 'project_role':
      return `project_role:${principal.roleId}:${principal.scope}`;
    case 'everyone':
      return `everyone:${principal.scope}`;
  }
}

/** The principal in the target team, or null when the target has no such member or role. */
function resolvePrincipal(
  db: DbExecutor,
  source: Scope,
  target: Scope,
  principal: Principal,
): Principal | null {
  switch (principal.type) {
    case 'everyone':
      return principal;
    case 'user': {
      const member = db
        .select({ userId: s.teamMember.userId })
        .from(s.teamMember)
        .where(
          and(eq(s.teamMember.teamId, target.teamId), eq(s.teamMember.userId, principal.userId)),
        )
        .get();
      return member ? principal : null;
    }
    case 'role': {
      const role = db
        .select({ name: s.role.name, isEveryone: s.role.isEveryone, teamId: s.role.teamId })
        .from(s.role)
        .where(eq(s.role.id, principal.roleId))
        .get();
      if (!role || role.teamId !== source.teamId) return null;
      if (source.teamId === target.teamId) return principal;
      const match = db
        .select({ id: s.role.id })
        .from(s.role)
        .where(
          and(
            eq(s.role.teamId, target.teamId),
            role.isEveryone
              ? eq(s.role.isEveryone, true)
              : sql`lower(${s.role.name}) = lower(${role.name})`,
          ),
        )
        .get();
      return match ? { ...principal, roleId: match.id } : null;
    }
    case 'project_role': {
      const role = db
        .select({ name: s.projectRole.name })
        .from(s.projectRole)
        .where(
          and(
            eq(s.projectRole.id, principal.roleId),
            eq(s.projectRole.projectId, source.projectId),
          ),
        )
        .get();
      if (!role) return null;
      const match = db
        .select({ id: s.projectRole.id })
        .from(s.projectRole)
        .where(
          and(
            eq(s.projectRole.projectId, target.projectId),
            sql`lower(${s.projectRole.name}) = lower(${role.name})`,
          ),
        )
        .get();
      return match ? { ...principal, roleId: match.id } : null;
    }
  }
}

/** How the source project names a principal. */
function sourceLabel(db: DbExecutor, principal: Principal): string {
  const scope = 'scope' in principal && principal.scope !== 'both' ? `, ${principal.scope}` : '';
  switch (principal.type) {
    case 'everyone':
      return 'everyone';
    case 'user': {
      const user = db
        .select({ username: s.user.username })
        .from(s.user)
        .where(eq(s.user.id, principal.userId))
        .get();
      return user ? `@${user.username ?? principal.userId}` : 'a deleted account';
    }
    case 'role': {
      const role = db
        .select({ name: s.role.name })
        .from(s.role)
        .where(eq(s.role.id, principal.roleId))
        .get();
      return `${role?.name ?? 'a deleted role'} (role${scope})`;
    }
    case 'project_role': {
      const role = db
        .select({ name: s.projectRole.name })
        .from(s.projectRole)
        .where(eq(s.projectRole.id, principal.roleId))
        .get();
      return `${role?.name ?? 'a deleted project role'} (project role${scope})`;
    }
  }
}

/** Principals of the source statuses' rules that the target team doesn't have. */
function unresolvedOf(
  db: DbExecutor,
  source: Scope,
  target: Scope,
  statuses: readonly StatusRow[],
): UnresolvedPrincipal[] {
  const found = new Map<string, UnresolvedPrincipal>();
  for (const status of statuses) {
    for (const { where, rule } of rulePrincipals(rulesOf(status))) {
      for (const principal of [...rule.allow, ...rule.deny]) {
        if (resolvePrincipal(db, source, target, principal)) continue;
        const key = principalKey(principal);
        const entry = found.get(key) ?? {
          key,
          principal,
          label: sourceLabel(db, principal),
          usedIn: [],
        };
        const use = `${status.name}: ${where}`;
        if (!entry.usedIn.includes(use)) entry.usedIn.push(use);
        found.set(key, entry);
      }
    }
  }
  return [...found.values()];
}

/** `GET /api/projects/:projectId/pipeline/copy-preview?from=…`. */
export function copyPipelinePreview(
  deps: AppDeps,
  actor: Actor,
  targetProjectId: string,
  fromProjectId: string,
  choice: PipelineChoice = {},
): CopyPipelinePreview {
  const { orm } = deps.db;
  const { target, source, sourcePipeline, targetPipeline } = access(
    deps,
    actor,
    targetProjectId,
    fromProjectId,
    choice,
  );
  const sourceStatuses = pipelineStatuses(orm, sourcePipeline.id);
  const targetNames = new Set(
    pipelineStatuses(orm, targetPipeline.id).map((row) => row.name.toLowerCase()),
  );
  return {
    source: {
      id: source.project.id,
      key: source.project.key,
      name: source.project.name,
      teamName: source.team.name,
    },
    statuses: sourceStatuses.map((row) => ({
      name: row.name,
      action: targetNames.has(row.name.toLowerCase()) ? 'update' : 'create',
      hasRules: hasStageRules(rulesOf(row)) || row.instructions.trim() !== '',
    })),
    unresolved: unresolvedOf(
      orm,
      { teamId: source.project.teamId, projectId: source.project.id },
      { teamId: target.project.teamId, projectId: target.project.id },
      sourceStatuses,
    ),
  };
}

/** `POST /api/projects/:projectId/pipeline/copy`. */
export function copyPipeline(
  deps: AppDeps,
  actor: Actor,
  targetProjectId: string,
  input: CopyPipelineInput,
): StatusListResponse {
  const { orm } = deps.db;
  const { target, source, sourcePipeline, targetPipeline } = access(
    deps,
    actor,
    targetProjectId,
    input.fromProjectId,
    { fromPipelineId: input.fromPipelineId, pipelineId: input.pipelineId },
  );
  const replacements = input.replacements ?? {};
  const sourceScope = { teamId: source.project.teamId, projectId: source.project.id };
  const targetScope = { teamId: target.project.teamId, projectId: target.project.id };

  deps.db.write((tx) => {
    const now = new Date();
    const sourceStatuses = pipelineStatuses(tx, sourcePipeline.id);
    const unresolved = unresolvedOf(tx, sourceScope, targetScope, sourceStatuses);
    const unanswered = unresolved.filter((entry) => !(entry.key in replacements));
    if (unanswered.length > 0) {
      throw errors.validation(
        `Re-pick or drop these before copying (the target team doesn't have them): ${unanswered
          .map((entry) => entry.label)
          .join(', ')}`,
        { unresolved: unanswered },
      );
    }
    const unresolvedKeys = new Set(unresolved.map((entry) => entry.key));
    const mapPrincipal = (principal: Principal): Principal | null => {
      const key = principalKey(principal);
      if (unresolvedKeys.has(key)) return replacements[key] ?? null;
      return resolvePrincipal(tx, sourceScope, targetScope, principal);
    };
    const mapRule = (rule: PrincipalRule, where: string): PrincipalRule => {
      const allow = rule.allow.map(mapPrincipal).filter((p): p is Principal => p !== null);
      const deny = rule.deny.map(mapPrincipal).filter((p): p is Principal => p !== null);
      if (rule.allow.length > 0 && allow.length === 0) {
        throw errors.validation(
          `${where} would name nobody after dropping its people and roles: pick a replacement`,
        );
      }
      return { allow, deny };
    };

    const existing = pipelineStatuses(tx, targetPipeline.id);
    const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row]));
    const toCreate = sourceStatuses.filter((row) => !byName.has(row.name.toLowerCase()));
    const projectTotal = tx
      .select({ id: s.status.id })
      .from(s.status)
      .where(eq(s.status.projectId, target.project.id))
      .all().length;
    if (projectTotal + toCreate.length > PROJECT_LIMITS.statuses) {
      throw errors.validation(`A project can have at most ${PROJECT_LIMITS.statuses} statuses`);
    }
    const idMap = new Map<string, string>();
    const created: string[] = [];
    const updated: string[] = [];
    for (const row of sourceStatuses) {
      const match = byName.get(row.name.toLowerCase());
      if (match) {
        idMap.set(row.id, match.id);
        updated.push(match.name);
        continue;
      }
      const id = newId();
      tx.insert(s.status)
        .values({
          id,
          projectId: target.project.id,
          pipelineId: targetPipeline.id,
          name: row.name,
          color: row.color,
          icon: row.icon,
          position: existing.length + created.length,
          isDefault: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      idMap.set(row.id, id);
      created.push(row.name);
      recordActivity(tx, actor, {
        teamId: target.project.teamId,
        projectId: target.project.id,
        entityType: 'status',
        entityId: id,
        action: 'status.created',
        meta: {
          name: row.name,
          color: row.color,
          icon: row.icon,
          copiedFrom: source.project.key,
        },
      });
    }

    for (const row of sourceStatuses) {
      const targetId = idMap.get(row.id);
      if (!targetId) continue;
      const rules = rulesOf(row);
      const where = (what: string) => `${row.name}: ${what}`;
      const mapped: StageRules = {
        ...rules,
        handoff: {
          mode: rules.handoff.mode,
          ...(rules.handoff.rule ? { rule: mapRule(rules.handoff.rule, where('hand-off')) } : {}),
          ...(rules.handoff.statusId
            ? { statusId: idMap.get(rules.handoff.statusId) ?? rules.handoff.statusId }
            : {}),
        },
        notify: rules.notify ? mapRule(rules.notify, where('notify')) : null,
        moveRule: rules.moveRule ? mapRule(rules.moveRule, where('who can move on')) : null,
        approvals: rules.approvals
          ? { ...rules.approvals, rule: mapRule(rules.approvals.rule, where('approvers')) }
          : null,
        nextStatusId: rules.nextStatusId ? (idMap.get(rules.nextStatusId) ?? null) : null,
      };
      const valid = mergeRules(tx, targetScope, targetId, DEFAULT_STAGE_RULES, mapped);
      const before = tx
        .select({ blocksDependents: s.status.blocksDependents })
        .from(s.status)
        .where(eq(s.status.id, targetId))
        .get();
      tx.update(s.status)
        .set({ ...ruleColumns(valid), updatedAt: now })
        .where(eq(s.status.id, targetId))
        .run();
      // Its tasks' completion follows whether the stage blocks its dependents.
      if (before && before.blocksDependents !== valid.blocksDependents) {
        syncCompletion(tx, targetId, valid.blocksDependents);
      }
    }

    // The copied order first, then the target's own other statuses.
    const copiedIds = sourceStatuses.flatMap((row) => idMap.get(row.id) ?? []);
    const rest = existing.filter((row) => !copiedIds.includes(row.id)).map((row) => row.id);
    [...copiedIds, ...rest].forEach((id, position) => {
      tx.update(s.status).set({ position }).where(eq(s.status.id, id)).run();
    });

    recordActivity(tx, actor, {
      teamId: target.project.teamId,
      projectId: target.project.id,
      entityType: 'project',
      entityId: target.project.id,
      action: 'project.pipeline_copied',
      meta: {
        name: target.project.name,
        key: target.project.key,
        from: `${source.team.slug}/${source.project.key}`,
        ...(sourcePipeline.isDefault ? {} : { fromPipeline: sourcePipeline.name }),
        ...(targetPipeline.isDefault ? {} : { pipeline: targetPipeline.name }),
        created,
        updated,
      },
    });
    emitAfterCommit(tx, {
      type: 'status.changed',
      teamId: target.project.teamId,
      projectId: target.project.id,
      entityType: 'status',
      entityId: target.project.id,
      actorId: actor.userId,
    });
  });
  return { items: statusesOf(orm, target.project.id) };
}
