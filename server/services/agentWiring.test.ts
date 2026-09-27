import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  agentActor,
  createAgent,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type RoleRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { claimTask } from './claims';
import { createStatus, updateStatus } from './statuses';
import { createTask, moveTask } from './tasks';

/**
 * The lead's wiring of the parallel waves: pipeline stage entries (§5) create agent jobs (§4) —
 * `pool` jobs for agents who may claim a pooled task, `approval` jobs for agents who may approve —
 * and a pool claim cancels the other agents' pool jobs.
 */

let ctx: TestContext;
let owner: UserRow;
let ann: UserRow;
let ben: UserRow;
let annAi: UserRow;
let benAi: UserRow;
let team: CreatedTeam;
let devs: RoleRow;
let project: CreatedProject;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

function jobsOf(agent: UserRow, kind: 'pool' | 'approval') {
  return ctx.db.orm
    .select()
    .from(s.agentJob)
    .where(and(eq(s.agentJob.agentUserId, agent.id), eq(s.agentJob.kind, kind)))
    .all();
}

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ann = createUser(ctx.db, { username: 'ann' });
  ben = createUser(ctx.db, { username: 'ben' });
  annAi = createAgent(ctx.db, ann.id);
  benAi = createAgent(ctx.db, ben.id);
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  devs = createRole(ctx.db, { teamId: team.team.id, name: 'Devs' });
  addMember(ctx.db, { teamId: team.team.id, userId: ann.id, roleIds: [devs.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: ben.id, roleIds: [devs.id] });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
});

afterEach(() => {
  ctx.close();
});

describe('pipeline stages create agent jobs', () => {
  it('offers a pooled task to the pool’s agents and cancels the others’ jobs on a claim', () => {
    const pool = createStatus(ctx.deps, web(owner), project.project.id, {
      name: 'Development',
    });
    updateStatus(ctx.deps, web(owner), pool.id, {
      rules: {
        instructions: 'Build it on a branch.',
        handoff: {
          mode: 'pool',
          rule: { allow: [{ type: 'role', roleId: devs.id, scope: 'agents' }], deny: [] },
        },
      },
    });
    // Open moves on to it (BAT-27: moves go to the next stage only).
    updateStatus(ctx.deps, web(owner), project.statuses[0]?.id ?? '', {
      rules: { nextStatusId: pool.id },
    });
    const task = createTask(ctx.deps, web(owner), project.project.id, { title: 'Pooled' });
    moveTask(ctx.deps, web(owner), task.id, { statusId: pool.id });

    expect(jobsOf(annAi, 'pool')).toEqual([
      expect.objectContaining({ status: 'pending', targetId: task.id }),
    ]);
    expect(jobsOf(annAi, 'pool')[0]?.payload).toMatchObject({
      stage: 'Development',
      instructions: 'Build it on a branch.',
    });
    expect(jobsOf(benAi, 'pool')).toHaveLength(1);

    const key = { id: 'k1', name: 'MSI', agentName: 'Claude' };
    ctx.db.orm
      .insert(s.apiKey)
      .values({ id: 'k1', userId: ann.id, name: 'MSI', prefix: 'x', hash: 'h1' })
      .run();
    claimTask(ctx.deps, agentActor(ctx.db, ann.id, key), task.id, {});
    expect(jobsOf(benAi, 'pool')[0]?.status).toBe('cancelled');
    expect(jobsOf(annAi, 'pool')[0]?.status).not.toBe('cancelled');
  });

  it('asks the agents who may approve a stage for their approval', () => {
    const review = createStatus(ctx.deps, web(owner), project.project.id, {
      name: 'AI Review',
    });
    updateStatus(ctx.deps, web(owner), review.id, {
      rules: {
        approvals: {
          count: 1,
          rule: { allow: [{ type: 'user', userId: annAi.id }], deny: [] },
          dismissOnChange: false,
        },
      },
    });
    updateStatus(ctx.deps, web(owner), project.statuses[0]?.id ?? '', {
      rules: { nextStatusId: review.id },
    });
    const task = createTask(ctx.deps, web(owner), project.project.id, { title: 'Review me' });
    moveTask(ctx.deps, web(owner), task.id, { statusId: review.id });
    expect(jobsOf(annAi, 'approval')).toEqual([
      expect.objectContaining({ status: 'pending', targetId: task.id }),
    ]);
    expect(jobsOf(benAi, 'approval')).toEqual([]);
  });
});
