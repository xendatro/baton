import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVERYONE_DEFAULTS, type Permission } from '@shared/permissions';
import { claimNextResponseSchema, taskSchema, type CreateTaskData } from '@shared/schemas/tasks';
import type { LiveEvent } from '@shared/events';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { openDatabase } from '../db';
import { allJobs } from '../jobs';
import { CLAIM_SWEEP_JOB } from '../jobs/claims';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  giveAgentOwnerRoles,
  json,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { claimNextTask, claimTask, expireClaims, releaseTask, renewClaim } from './claims';
import { createTask, getTask, updateTask } from './tasks';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let bob: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let events: LiveEvent[];

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });
const agent = (user: { id: string }, keyId: string, name = 'Claude on laptop'): Actor => ({
  userId: user.id,
  source: 'mcp',
  key: { id: keyId, name },
});

let miaAgent: Actor;
let miaOtherAgent: Actor;

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  mia = createUser(ctx.db, { username: 'mia' });
  bob = createUser(ctx.db, { username: 'bob' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  addMember(ctx.db, { teamId: team.team.id, userId: bob.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  miaAgent = agent(
    mia,
    createApiKey(ctx.db, { userId: mia.id, name: 'Claude on laptop' }).apiKey.id,
  );
  miaOtherAgent = agent(
    mia,
    createApiKey(ctx.db, { userId: mia.id, name: 'Codex desktop' }).apiKey.id,
    'Codex desktop',
  );
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  vi.useRealTimers();
  ctx.close();
});

const [openStatus, doneStatus] = [0, 1] as const;
const statusId = (index: number) => project.statuses[index]?.id ?? '';

function newTask(title: string, extra: Partial<CreateTaskData> = {}) {
  return createTask(ctx.deps, web(owner), project.project.id, { title, ...extra });
}

function actions(taskId: string) {
  return ctx.db.orm
    .select()
    .from(s.activity)
    .where(eq(s.activity.entityId, taskId))
    .all()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => row.action);
}

function setEveryone(permissions: readonly Permission[]) {
  ctx.db.orm
    .update(s.role)
    .set({ permissions: [...permissions] })
    .where(eq(s.role.id, team.everyoneRole.id))
    .run();
}

function next(actor: Actor, input: Parameters<typeof claimNextTask>[3] = {}) {
  return claimNextTask(ctx.deps, actor, project.project.id, input).task;
}

describe('claim_next_task', () => {
  it('picks assigned-to-me first, then unassigned, then by priority, due date and number', () => {
    const backend = createRole(ctx.db, { teamId: team.team.id, name: 'Backend', slug: 'backend' });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: mia.id, roleId: backend.id })
      .run();
    const others = newTask('Assigned to bob', { assigneeUserIds: [bob.id], priority: 4 });
    const low = newTask('Unassigned low', { priority: 1 });
    const dueLater = newTask('Unassigned high later', { priority: 3, dueDate: '2030-03-01' });
    const dueSoon = newTask('Unassigned high soon', { priority: 3, dueDate: '2030-02-01' });
    const noDate = newTask('Unassigned high no date', { priority: 3 });
    const viaRole = newTask('Mia via role', { assigneeRoleIds: [backend.id] });
    const direct = newTask('Mia direct', { assigneeUserIds: [mia.id] });

    const order = [];
    for (let i = 0; i < 7; i += 1) order.push(next(miaAgent)?.title);
    expect(order).toEqual([
      viaRole.title,
      direct.title,
      dueSoon.title,
      dueLater.title,
      noDate.title,
      low.title,
      others.title,
    ]);
    expect(next(miaAgent)).toBeNull();
  });

  it('skips done, blocked, deleted and validly claimed tasks, and honours filters', () => {
    const blocker = newTask('Blocker');
    newTask('Blocked', { blockedByTaskIds: [blocker.id], priority: 4 });
    newTask('Done', { statusId: statusId(doneStatus), priority: 4 });
    const label = ctx.db.orm
      .insert(s.label)
      .values({ projectId: project.project.id, name: 'ai', color: '#000000' })
      .returning()
      .get();
    const labelled = newTask('Labelled', { labelIds: [label.id] });
    const urgent = newTask('Urgent', { priority: 4 });
    expect(next(miaAgent, { labelId: label.id })?.id).toBe(labelled.id);
    expect(next(miaAgent, { priority: [4] })?.id).toBe(urgent.id);
    expect(next(miaAgent, { assignedToMe: true })).toBeNull();
    expect(next(miaAgent)?.id).toBe(blocker.id);
    // Everything eligible is claimed now; another agent of the same user gets nothing.
    expect(next(miaOtherAgent)).toBeNull();
  });

  it('claims for (user, key), optionally moving the task, and audits it', () => {
    const inProgress = ctx.db.orm
      .insert(s.status)
      .values({
        projectId: project.project.id,
        name: 'In Progress',
        color: '#f59e0b',
        category: 'open',
        position: 2,
      })
      .returning()
      .get();
    newTask('Work');
    // `leaseMinutes` is still accepted from older agents, and ignored.
    const task = next(miaAgent, { leaseMinutes: 90, moveToStatusId: inProgress.id });
    expect(taskSchema.parse(task)).toBeTruthy();
    expect(task?.status.name).toBe('In Progress');
    expect(task?.claim?.user.username).toBe('mia');
    expect(task?.claim?.via?.keyName).toBe('Claude on laptop');
    expect(task?.claim?.expiresAt).toBeNull();
    expect(actions(task?.id ?? '')).toEqual(['task.created', 'task.moved', 'task.claimed']);
    expect(events.map((e) => e.type)).toContain('task.claimed');
    expect(() => next(miaAgent, { moveToStatusId: statusId(doneStatus) })).toThrow(/open status/);
  });

  it('needs UPDATE_TASKS', async () => {
    newTask('Work');
    setEveryone(EVERYONE_DEFAULTS.filter((p) => p !== 'UPDATE_TASKS'));
    expect(() => next(web(mia))).toThrow(/permission to claim/);
    // The owner can (owners have every permission); through a key, so can his agent once it has
    // the owner's Admin role (agents start with @everyone only).
    const key = createApiKey(ctx.db, { userId: owner.id }).key;
    giveAgentOwnerRoles(ctx.db, owner.id);
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/claim-next`,
      json('POST', {}, bearer(key)),
    );
    expect(claimNextResponseSchema.parse(await res.json()).task?.title).toBe('Work');
  });

  it('never hands out the same task twice under concurrent callers', async () => {
    const count = 12;
    for (let i = 0; i < count; i += 1) newTask(`Task ${i}`);
    const keys = Array.from({ length: 20 }, (_, i) =>
      createApiKey(ctx.db, {
        userId: [owner, mia, bob][i % 3]?.id ?? owner.id,
        name: `Agent ${i}`,
      }),
    );
    // Parallel HTTP requests on the app, plus claims from separate database connections.
    const other = openDatabase(ctx.db.file);
    const otherDeps = { ...ctx.deps, db: other };
    try {
      const results = await Promise.all([
        ...keys.map(async ({ key }) => {
          const res = await ctx.app.request(
            `/api/projects/${project.project.id}/claim-next`,
            json('POST', {}, bearer(key)),
          );
          return claimNextResponseSchema.parse(await res.json()).task?.id ?? null;
        }),
        ...keys.slice(0, 5).map(
          (key) =>
            new Promise<string | null>((resolve) =>
              setTimeout(() => {
                resolve(
                  claimNextTask(otherDeps, agent(owner, key.apiKey.id), project.project.id, {}).task
                    ?.id ?? null,
                );
              }, 0),
            ),
        ),
      ]);
      const claimed = results.filter((id): id is string => id !== null);
      expect(claimed).toHaveLength(count);
      expect(new Set(claimed).size).toBe(count);
    } finally {
      other.close();
    }
  });
});

describe('claim_task', () => {
  it('claims, renews for the holder, refuses others and lets UPDATE_TASKS take over', () => {
    const task = newTask('Contested');
    const claimed = claimTask(ctx.deps, miaAgent, task.id, {});
    expect(claimed.claim?.via?.keyName).toBe('Claude on laptop');
    // Same holder: a renewal.
    claimTask(ctx.deps, miaAgent, task.id, { leaseMinutes: 60 });
    // Same user, other key: a different holder.
    expect(() => claimTask(ctx.deps, miaOtherAgent, task.id, {})).toThrow(
      /claimed by @mia via Claude on laptop/,
    );
    expect(() => claimTask(ctx.deps, web(bob), task.id, {})).toThrow(/force/);
    const taken = claimTask(ctx.deps, web(bob), task.id, { force: true });
    expect(taken.claim).toMatchObject({ user: { username: 'bob' }, via: null });
    expect(actions(task.id)).toEqual([
      'task.created',
      'task.claimed',
      'task.claim_renewed',
      'task.claim_taken_over',
    ]);
    const takeover = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'task.claim_taken_over'))
      .get();
    expect(takeover?.meta).toMatchObject({ previousHolder: '@mia via Claude on laptop' });
  });

  it('only lets authors without UPDATE_TASKS claim their own tasks, never force', () => {
    const own = createTask(ctx.deps, web(mia), project.project.id, { title: 'Mine' });
    const theirs = newTask('Theirs');
    setEveryone(EVERYONE_DEFAULTS.filter((p) => p !== 'UPDATE_TASKS'));
    expect(claimTask(ctx.deps, web(mia), own.id, {}).claim?.user.username).toBe('mia');
    expect(() => claimTask(ctx.deps, web(mia), theirs.id, {})).toThrow(/permission to claim/);
    claimTask(ctx.deps, web(owner), theirs.id, {});
    const ownTaken = claimTask(ctx.deps, web(owner), own.id, { force: true });
    expect(ownTaken.claim?.user.username).toBe('owner');
    expect(() => claimTask(ctx.deps, web(mia), own.id, { force: true })).toThrow(/Update tasks/);
  });

  it('refuses done tasks unless moved to an open status', () => {
    const task = newTask('Finished', { statusId: statusId(doneStatus) });
    expect(() => claimTask(ctx.deps, miaAgent, task.id, {})).toThrow(/done/);
    const reopened = claimTask(ctx.deps, miaAgent, task.id, {
      moveToStatusId: statusId(openStatus),
    });
    expect(reopened).toMatchObject({ status: { name: 'Open' }, completedAt: null });
  });
});

describe('leases', () => {
  // Claims are held until released, taken over or finished (2026-09-27): no expiry, no renewal.
  it('keeps a claim until it is released, however long it takes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
    const task = newTask('Long job');
    claimTask(ctx.deps, miaAgent, task.id, { leaseMinutes: 60 });
    expect(getTask(ctx.deps, web(owner), task.id).claim).toMatchObject({ expiresAt: null });

    vi.setSystemTime(new Date('2030-01-09T10:00:00Z'));
    expect(expireClaims(ctx.deps)).toBe(0);
    expect(getTask(ctx.deps, web(owner), task.id).claim?.user.username).toBe('mia');
    expect(next(web(bob))).toBeNull();
    // renew_claim is kept for older agents: it only confirms the holder.
    expect(renewClaim(ctx.deps, miaAgent, task.id, {}).claim?.user.username).toBe('mia');
    expect(() => renewClaim(ctx.deps, miaOtherAgent, task.id, {})).toThrow(/not by you/);
  });

  it('clears the claims of deleted accounts in the sweeper, audited as a system action', () => {
    const task = newTask('Abandoned');
    const kept = newTask('Kept');
    claimTask(ctx.deps, miaAgent, task.id, {});
    claimTask(ctx.deps, web(bob), kept.id, {});
    expect(expireClaims(ctx.deps)).toBe(0);
    // Deleting an account nulls its claims' holder (ON DELETE SET NULL).
    ctx.db.orm.update(s.task).set({ claimedById: null }).where(eq(s.task.id, task.id)).run();
    events = [];
    expect(expireClaims(ctx.deps)).toBe(1);
    const row = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'task.claim_expired'))
      .get();
    expect(row).toMatchObject({ actorId: null, source: 'system', entityId: task.id });
    expect(events.map((e) => e.type)).toEqual(['activity.created', 'task.released']);
    expect(getTask(ctx.deps, web(owner), task.id).claim).toBeNull();
    expect(getTask(ctx.deps, web(owner), kept.id).claim?.user.username).toBe('bob');
  });

  it('registers the sweeper as an every-minute job', () => {
    const job = allJobs.find((candidate) => candidate.name === CLAIM_SWEEP_JOB.name);
    expect(job?.schedule).toBe('* * * * *');
  });
});

describe('release_task', () => {
  it('releases with a note posted as a reply; others need UPDATE_TASKS', () => {
    const task = newTask('Handoff');
    claimTask(ctx.deps, miaAgent, task.id, {});
    const released = releaseTask(ctx.deps, miaAgent, task.id, {
      note: 'Did the API part; UI is left',
    });
    expect(released.claim).toBeNull();
    expect(released.replyCount).toBe(1);
    expect(actions(task.id)).toEqual(['task.created', 'task.claimed', 'task.released']);
    // Releasing an unclaimed task is a no-op.
    releaseTask(ctx.deps, miaAgent, task.id, {});
    expect(actions(task.id)).toHaveLength(3);

    claimTask(ctx.deps, web(bob), task.id, {});
    setEveryone(EVERYONE_DEFAULTS.filter((p) => p !== 'UPDATE_TASKS'));
    expect(() => releaseTask(ctx.deps, web(mia), task.id, {})).toThrow(/Update tasks/);
    releaseTask(ctx.deps, web(owner), task.id, {});
    const row = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'task.released'))
      .all()
      .at(-1);
    expect(row?.meta).toMatchObject({ previousHolder: '@bob (web)' });
  });

  it('releases automatically when the task enters a done status', () => {
    const task = newTask('Almost');
    claimTask(ctx.deps, miaAgent, task.id, {});
    const finished = updateTask(ctx.deps, miaAgent, task.id, { statusId: statusId(doneStatus) });
    expect(finished.claim).toBeNull();
    expect(actions(task.id)).toEqual([
      'task.created',
      'task.claimed',
      'task.updated',
      'task.released',
    ]);
    const released = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'task.released'))
      .get();
    expect(released?.meta).toMatchObject({ reason: 'done' });
  });
});
