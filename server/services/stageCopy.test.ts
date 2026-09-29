import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createdStatusSchema, type Status } from '@shared/schemas/projects';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { coreTools } from '../mcp/tools/core';
import { registerTools } from '../mcp/tools/index';
import { projectsTools } from '../mcp/tools/projects';
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
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createProjectRole } from './projectAccess';
import { createStatus, listStatuses, updateStatus } from './statuses';

/** "New stage": plain defaults, and "Create from existing" (`copyRulesFrom`, 2026-09-27). */

let ctx: TestContext;
let owner: UserRow;
let ann: UserRow;
let bob: UserRow;
let teamA: string;
let teamB: string;
let projectA: string;
let projectB: string;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ann = createUser(ctx.db, { username: 'ann' });
  bob = createUser(ctx.db, { username: 'bob' });
  teamA = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme', name: 'Acme' }).team.id;
  teamB = createTeam(ctx.db, { ownerId: owner.id, slug: 'globex', name: 'Globex' }).team.id;
  addMember(ctx.db, { teamId: teamA, userId: ann.id });
  addMember(ctx.db, { teamId: teamA, userId: bob.id });
  addMember(ctx.db, { teamId: teamB, userId: bob.id });
  projectA = createProject(ctx.db, {
    teamId: teamA,
    key: 'API',
    createdById: owner.id,
    stages: 'default',
  }).project.id;
  projectB = createProject(ctx.db, {
    teamId: teamB,
    key: 'WEB',
    createdById: owner.id,
    stages: 'default',
  }).project.id;
});

afterEach(() => {
  ctx.close();
});

function stages(projectId: string): Status[] {
  return listStatuses(ctx.deps, web(owner), projectId).items;
}

function stage(projectId: string, name: string): Status {
  const found = stages(projectId).find((item) => item.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

/** Gives API's In review a rule of every kind. */
function configureReview() {
  const reviewer = createRole(ctx.db, { teamId: teamA, name: 'Reviewer' });
  const qa = createProjectRole(ctx.deps, web(owner), projectA, { name: 'QA' });
  const review = stage(projectA, 'In review');
  updateStatus(ctx.deps, web(owner), review.id, {
    rules: {
      instructions: 'Check the diff.',
      handoff: { mode: 'stage_holder', statusId: stage(projectA, 'In progress').id },
      exitCriteria: [{ id: 'tests', text: 'Tests pass' }],
      approvals: {
        count: 1,
        rule: {
          allow: [
            { type: 'role', roleId: reviewer.id, scope: 'both' },
            { type: 'user', userId: ann.id },
          ],
          deny: [],
        },
        dismissOnChange: true,
      },
      moveRule: { allow: [{ type: 'project_role', roleId: qa.id, scope: 'both' }], deny: [] },
      notify: { allow: [{ type: 'user', userId: bob.id }], deny: [] },
      onEnter: { notifyAuthor: true },
      claimable: false,
      nextStatusId: stage(projectA, 'Done').id,
      sendBackTo: [stage(projectA, 'In progress').id, stage(projectA, 'To do').id],
    },
  });
  return { review: stage(projectA, 'In review'), reviewer };
}

describe('new stages', () => {
  it('start plain: nothing assigned or gated, sent back to every earlier stage', () => {
    const created = createStatus(ctx.deps, web(owner), projectA, { name: 'New stage' });
    expect(created.copied).toBeUndefined();
    expect(created.rules).toEqual({
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
      allowCreate: false,
      exitCriteria: [],
      moveBy: { assignees: false, claimer: false },
      moveRule: null,
      approvals: null,
      autoAdvance: false,
      nextStatusId: null,
      sendBackTo: stages(projectA)
        .slice(0, 5)
        .map((item) => item.id),
      suggestedModel: null,
    });
  });
});

describe('create from existing (copyRulesFrom)', () => {
  it('copies every rule of a stage of the same pipeline, keeping its own name and look', () => {
    const { review } = configureReview();
    const copy = createStatus(ctx.deps, web(owner), projectA, {
      name: 'Security review',
      color: '#ef4444',
      icon: 'diamond',
      copyRulesFrom: review.id,
    });
    expect(copy).toMatchObject({
      name: 'Security review',
      color: '#ef4444',
      icon: 'diamond',
      isDefault: false,
      position: 5,
      copied: { from: 'In review', dropped: [] },
    });
    expect(copy.rules).toEqual(review.rules);
    const activity = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.entityId, copy.id))
      .all();
    expect(activity[0]).toMatchObject({
      action: 'status.created',
      meta: { copiedFrom: 'In review' },
    });
  });

  it('applies rules and the default flag on top of the copy', () => {
    const { review } = configureReview();
    const copy = createStatus(ctx.deps, web(owner), projectA, {
      name: 'Triage',
      isDefault: true,
      copyRulesFrom: review.id,
      rules: { instructions: 'Sort it.' },
    });
    expect(copy.isDefault).toBe(true);
    expect(copy.rules).toMatchObject({
      instructions: 'Sort it.',
      allowCreate: true,
      exitCriteria: [{ id: 'tests', text: 'Tests pass' }],
    });
  });

  it('maps stages by name and people and roles across teams, dropping what has no match', () => {
    const { review } = configureReview();
    // Globex has a Reviewer role and Bob, but not Ann or the QA project role.
    const globexReviewer = createRole(ctx.db, { teamId: teamB, name: 'reviewer' });
    const res = createStatus(ctx.deps, web(owner), projectB, {
      name: 'Code review',
      copyRulesFrom: review.id,
    });
    const web2 = (name: string) => stage(projectB, name).id;
    expect(res.copied?.from).toBe('Acme / API / Main / In review');
    expect(res.copied?.dropped).toEqual([
      '@ann (approvers)',
      'QA (project role) (who can move on)',
      'who can move on: it named nobody here, so it was cleared',
    ]);
    expect(res.rules).toMatchObject({
      instructions: 'Check the diff.',
      handoff: { mode: 'stage_holder', statusId: web2('In progress') },
      exitCriteria: [{ id: 'tests', text: 'Tests pass' }],
      approvals: {
        count: 1,
        rule: { allow: [{ type: 'role', roleId: globexReviewer.id, scope: 'both' }], deny: [] },
        dismissOnChange: true,
      },
      moveRule: null,
      notify: { allow: [{ type: 'user', userId: bob.id }], deny: [] },
      claimable: false,
      nextStatusId: web2('Done'),
      sendBackTo: [web2('In progress'), web2('To do')],
    });
  });

  it('drops stage references without a stage of that name, and clears rules naming nobody', () => {
    const { review } = configureReview();
    // Rename Globex's stages so nothing matches by name.
    for (const item of stages(projectB)) {
      updateStatus(ctx.deps, web(owner), item.id, { name: `${item.name} (web)` });
    }
    const res = createStatus(ctx.deps, web(owner), projectB, {
      name: 'Code review',
      copyRulesFrom: review.id,
    });
    expect(res.copied?.dropped).toEqual([
      'Hand-off to whoever held “In progress” (no stage of that name here)',
      'Next stage “Done” (no stage of that name here)',
      'Send back to “In progress” (no stage of that name here)',
      'Send back to “To do” (no stage of that name here)',
      'Reviewer (role) (approvers)',
      '@ann (approvers)',
      'approvers: it named nobody here, so it was cleared',
      'QA (project role) (who can move on)',
      'who can move on: it named nobody here, so it was cleared',
    ]);
    expect(res.rules).toMatchObject({
      handoff: { mode: 'keep' },
      approvals: null,
      moveRule: null,
      nextStatusId: null,
      sendBackTo: [],
      exitCriteria: [{ id: 'tests', text: 'Tests pass' }],
    });
  });

  it('refuses a stage the actor can’t see', () => {
    const outsider = createUser(ctx.db, { username: 'eve' });
    const eveTeam = createTeam(ctx.db, { ownerId: outsider.id, slug: 'eve' }).team.id;
    const eveProject = createProject(ctx.db, { teamId: eveTeam, key: 'EVE' }).project.id;
    const hidden = stage(projectA, 'In review');
    expect(() =>
      createStatus(ctx.deps, web(outsider), eveProject, {
        name: 'Stolen',
        copyRulesFrom: hidden.id,
      }),
    ).toThrow(/Stage to copy not found/);
    expect(stages(projectA).map((item) => item.name)).not.toContain('Stolen');
  });

  it('works over REST and MCP (copyFrom, copyFromProject)', async () => {
    const { review } = configureReview();
    const { key, apiKey } = createApiKey(ctx.db, { userId: owner.id, name: 'Claude on laptop' });
    giveAgentOwnerRoles(ctx.db, owner.id);
    const res = await ctx.app.request(
      `/api/projects/${projectA}/statuses`,
      json('POST', { name: 'QA pass', copyRulesFrom: review.id }, bearer(key)),
    );
    expect(res.status).toBe(201);
    const body = createdStatusSchema.parse(await res.json());
    expect(body).toMatchObject({ name: 'QA pass', copied: { from: 'In review', dropped: [] } });

    const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
    registerTools(
      server,
      {
        deps: ctx.deps,
        actor: { userId: owner.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
      },
      [...coreTools, ...projectsTools],
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const created = await client.callTool({
        name: 'create_status',
        arguments: {
          project: 'globex/WEB',
          name: 'Review 2',
          copyFrom: 'In review',
          copyFromProject: 'acme/API',
        },
      });
      expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
      expect(created.structuredContent).toMatchObject({
        name: 'Review 2',
        rules: { exitCriteria: [{ id: 'tests', text: 'Tests pass' }] },
        copied: { from: 'Acme / API / Main / In review' },
      });
    } finally {
      await client.close();
    }
  });
});
