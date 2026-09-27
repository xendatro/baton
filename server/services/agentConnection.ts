import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AGENT_LISTENER } from '@shared/constants';
import type { AgentConnection, AgentConnectionRunner } from '@shared/schemas/agentRunner';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { canViewProject, getProjectAccess, requireProjectAccess } from './access';
import { agentPauseReason, findAgentId } from './agents';
import { canClaimFromPool, rulesOf } from './pipelines';
import { isSessionListening } from './presence';
import { matchesRule } from './principals';
import { stageUserIds } from './taskAssignees';

/**
 * Is the viewer's agent connected to a project (design §8, BAT-24)? The desktop runner only takes
 * the jobs of projects mapped to a folder on its machine, and an MCP listener only those of the
 * projects it listens to: otherwise the agent's jobs there wait forever, silently. The web app asks
 * this wherever the viewer involves their agent and shows "Connect now" when it isn't covered.
 */

type SessionRow = typeof s.agentSession.$inferSelect;
type JobRow = typeof s.agentJob.$inferSelect;

function sessionOnline(deps: AppDeps, row: SessionRow, now: number): boolean {
  return (
    now - row.lastSeenAt.getTime() < AGENT_LISTENER.sessionTimeoutMs ||
    isSessionListening(deps, row.id)
  );
}

/** The viewer's agent: a person's agent member, or the agent a key acts as. */
function viewerAgent(db: DbExecutor, actor: Actor): { id: string; ownerId: string } | null {
  if (actor.ownerId) return { id: actor.userId, ownerId: actor.ownerId };
  const agentId = findAgentId(db, actor.userId);
  return agentId ? { id: agentId, ownerId: actor.userId } : null;
}

/** Is the job about the task: the task itself, or a reply in its thread? */
function jobIsAboutTask(db: DbExecutor, jobs: readonly JobRow[], taskId: string): JobRow[] {
  const replyIds = jobs.filter((job) => job.targetType === 'reply').map((job) => job.targetId);
  const replyTasks = new Map(
    replyIds.length === 0
      ? []
      : db
          .select({ id: s.reply.id, parentType: s.reply.parentType, parentId: s.reply.parentId })
          .from(s.reply)
          .where(inArray(s.reply.id, replyIds))
          .all()
          .map((row) => [row.id, row.parentType === 'task' ? row.parentId : null]),
  );
  return jobs.filter((job) =>
    job.targetType === 'task'
      ? job.targetId === taskId
      : job.targetType === 'reply' && replyTasks.get(job.targetId) === taskId,
  );
}

/** Does the task's current stage involve the agent (assigned, pool, hand-off, approvals)? */
function stageInvolvesAgent(
  db: DbExecutor,
  task: typeof s.task.$inferSelect,
  agentId: string,
): boolean {
  if (stageUserIds(db, task.id, task.statusId).includes(agentId)) return true;
  if (canClaimFromPool(db, task, agentId)) return true;
  const status = db.select().from(s.status).where(eq(s.status.id, task.statusId)).get();
  if (!status) return false;
  const rules = rulesOf(status);
  const scope = { teamId: task.teamId, projectId: task.projectId };
  if (rules.handoff.rule && matchesRule(db, scope, agentId, rules.handoff.rule)) return true;
  return rules.approvals ? matchesRule(db, scope, agentId, rules.approvals.rule) : false;
}

/** `GET /api/projects/:projectId/agent-connection?taskId=`. */
export function getAgentConnection(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: { taskId?: string } = {},
): AgentConnection {
  const { orm } = deps.db;
  requireProjectAccess(orm, actor, projectId);
  const project = orm
    .select({
      id: s.project.id,
      key: s.project.key,
      name: s.project.name,
      repoUrl: s.project.repoUrl,
      teamId: s.project.teamId,
      teamSlug: s.team.slug,
    })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.project.id, projectId), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  if (!project) throw errors.notFound('Project');
  const task = input.taskId
    ? orm
        .select()
        .from(s.task)
        .where(
          and(
            eq(s.task.id, input.taskId),
            eq(s.task.projectId, projectId),
            isNull(s.task.deletedAt),
          ),
        )
        .get()
    : undefined;
  if (input.taskId && !task) throw errors.notFound('Task');

  const base = {
    project: {
      id: project.id,
      ref: `${project.teamSlug}/${project.key}`,
      name: project.name,
      repoUrl: project.repoUrl ?? null,
    },
  };
  const agent = viewerAgent(orm, actor);
  if (!agent) {
    return {
      ...base,
      agent: null,
      paused: false,
      pausedReason: null,
      pausedBy: null,
      agentCanView: false,
      covered: false,
      runners: [],
      listening: false,
      pendingJobs: 0,
      ...(task ? { pendingJobsForTask: 0, taskInvolvesAgent: false } : {}),
    };
  }

  const agentUser = orm
    .select({ username: s.user.username, name: s.user.name })
    .from(s.user)
    .where(eq(s.user.id, agent.id))
    .get();
  const access = getProjectAccess(orm, agent.id, projectId);
  const agentCanView = access !== null && canViewProject(access);

  const pausedReason = agentPauseReason(
    orm,
    { agentId: agent.id, ownerId: agent.ownerId },
    project.teamId,
    project.id,
  );
  let pausedBy: AgentConnection['pausedBy'] = null;
  if (pausedReason) {
    const owner = orm
      .select({ pausedAt: s.user.agentPausedAt })
      .from(s.user)
      .where(eq(s.user.id, agent.ownerId))
      .get();
    const team = orm
      .select({ pausedAt: s.team.agentsPausedAt })
      .from(s.team)
      .where(eq(s.team.id, project.teamId))
      .get();
    pausedBy = owner?.pausedAt ? 'owner' : team?.pausedAt ? 'team' : 'project';
  }

  const now = Date.now();
  const sessions = orm
    .select()
    .from(s.agentSession)
    .where(eq(s.agentSession.agentUserId, agent.id))
    .all();
  const runners: AgentConnectionRunner[] = sessions
    .filter((row) => row.kind === 'runner')
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .map((row) => ({
      id: row.id,
      machineName: row.machineName ?? 'Unknown machine',
      online: sessionOnline(deps, row, now),
      coversProject: row.projectIds.includes(projectId),
    }));
  const listening = sessions.some(
    (row) =>
      row.kind === 'listener' &&
      row.projectIds.includes(projectId) &&
      sessionOnline(deps, row, now),
  );
  const covered = listening || runners.some((runner) => runner.online && runner.coversProject);

  const pending = orm
    .select()
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, agent.id),
        eq(s.agentJob.projectId, projectId),
        eq(s.agentJob.status, 'pending'),
      ),
    )
    .all();
  const taskFields = task
    ? (() => {
        const pendingJobsForTask = jobIsAboutTask(orm, pending, task.id).length;
        return {
          pendingJobsForTask,
          taskInvolvesAgent: pendingJobsForTask > 0 || stageInvolvesAgent(orm, task, agent.id),
        };
      })()
    : {};

  return {
    ...base,
    agent: { id: agent.id, username: agentUser?.username ?? null, name: agentUser?.name ?? '' },
    paused: pausedReason !== null,
    pausedReason,
    pausedBy,
    agentCanView,
    covered,
    runners,
    listening,
    pendingJobs: pending.length,
    ...taskFields,
  };
}
