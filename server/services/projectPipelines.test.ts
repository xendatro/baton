import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchQuerySchema } from '@shared/schemas/core';
import { myTasksQuerySchema } from '@shared/schemas/work';
import { boardQuerySchema, listTasksQuerySchema, type Task } from '@shared/schemas/tasks';
import { pipelineListResponseSchema } from '@shared/schemas/projects';
import type { Actor } from '../context';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
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
import { updateStatus } from './statuses';
import { listMyTasks } from './myWork';
import {
  createPipeline,
  deletePipeline,
  listPipelines,
  reorderPipelines,
  updatePipeline,
} from './projectPipelines';
import { search } from './search';
import { createTask, getBoard, getTask, listTasks, moveTask } from './tasks';
import { resolveStatus } from './refs';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let team: CreatedTeam;
let project: CreatedProject;

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });
const only = (user: { id: string }) => ({
  allow: [{ type: 'user' as const, userId: user.id }],
  deny: [],
});

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  mia = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme', agentSignoff: false });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'GAME' });
});

afterEach(() => ctx.close());

function addModeling(rules: Partial<Parameters<typeof createPipeline>[3]> = {}) {
  return createPipeline(ctx.deps, actorOf(owner), project.project.id, {
    name: 'Modeling',
    ...rules,
  });
}

describe('pipelines (BAT-25)', () => {
  it('gives every project a default pipeline holding its statuses', () => {
    const { items } = listPipelines(ctx.deps, actorOf(mia), project.project.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'Main', isDefault: true, statusCount: 2 });
    expect(project.statuses.every((status) => status.pipelineId === project.pipeline.id)).toBe(
      true,
    );
  });

  it('adds a pipeline with its own Open and Done, names unique per pipeline', () => {
    const modeling = addModeling();
    expect(modeling).toMatchObject({ name: 'Modeling', slug: 'modeling', statusCount: 2 });
    // "Done" exists twice now: the task's own pipeline wins, Pipeline/Status picks one.
    const orm = ctx.deps.db.orm;
    expect(() => resolveStatus(orm, project.project.id, 'Done')).toThrow(/ambiguous/);
    expect(resolveStatus(orm, project.project.id, 'Modeling/Done').pipelineId).toBe(modeling.id);
    expect(
      resolveStatus(orm, project.project.id, 'Done', { pipelineId: project.pipeline.id }).id,
    ).toBe(project.statuses[1]?.id);
    expect(() =>
      createPipeline(ctx.deps, actorOf(owner), project.project.id, { name: 'modeling' }),
    ).toThrow(/already a pipeline/);
    expect(() =>
      createPipeline(ctx.deps, actorOf(mia), project.project.id, { name: 'Scripting' }),
    ).toThrow(/permission/);
  });

  it('starts tasks in the chosen pipeline and checks who may create there', () => {
    const modeling = addModeling({ createRule: only(owner) });
    const task = createTask(ctx.deps, actorOf(owner), project.project.id, {
      title: 'Model the tree',
      pipelineId: modeling.id,
    });
    expect(task.status).toMatchObject({ name: 'Open', pipeline: { id: modeling.id } });
    expect(() =>
      createTask(ctx.deps, actorOf(mia), project.project.id, {
        title: 'Not mine',
        pipelineId: modeling.id,
      }),
    ).toThrow(/create tasks in Modeling/);
    // The default pipeline is unchanged for everyone.
    expect(
      createTask(ctx.deps, actorOf(mia), project.project.id, { title: 'Fine' }).status,
    ).toMatchObject({ name: 'Open', pipeline: { id: project.pipeline.id, isDefault: true } });
  });

  it('hides a pipeline and its tasks from people its view rule leaves out', () => {
    const secret = addModeling({ viewRule: only(owner) });
    const hidden = createTask(ctx.deps, actorOf(owner), project.project.id, {
      title: 'Secret sculpture',
      pipelineId: secret.id,
      assigneeUserIds: [mia.id],
    });
    const visible = createTask(ctx.deps, actorOf(owner), project.project.id, {
      title: 'Public sculpture',
      assigneeUserIds: [mia.id],
    });
    const miaActor = actorOf(mia);
    expect(listPipelines(ctx.deps, miaActor, project.project.id).items.map((p) => p.name)).toEqual([
      'Main',
    ]);
    const board = getBoard(ctx.deps, miaActor, project.project.id, boardQuerySchema.parse({}));
    expect(board.columns.map((column) => column.status.pipelineId)).toEqual([
      project.pipeline.id,
      project.pipeline.id,
    ]);
    expect(board.total).toBe(1);
    const list = listTasks(ctx.deps, miaActor, project.project.id, listTasksQuerySchema.parse({}));
    expect(list.items.map((card) => card.id)).toEqual([visible.id]);
    expect(() => getTask(ctx.deps, miaActor, hidden.id)).toThrow(/not found/);
    const found = search(ctx.deps, miaActor, searchQuerySchema.parse({ q: 'sculpture' }));
    expect(found.results.map((result) => result.entityId)).toEqual([visible.id]);
    const mine = listMyTasks(ctx.deps, miaActor, myTasksQuerySchema.parse({}));
    expect(mine.items.map((item: { id: string }) => item.id)).toEqual([visible.id]);
    // The owner (MANAGE_STATUSES) sees everything.
    expect(getTask(ctx.deps, actorOf(owner), hidden.id).id).toBe(hidden.id);
    expect(
      getBoard(ctx.deps, actorOf(owner), project.project.id, boardQuerySchema.parse({})).total,
    ).toBe(2);
    // And the board can show one pipeline.
    const one = getBoard(
      ctx.deps,
      actorOf(owner),
      project.project.id,
      boardQuerySchema.parse({ pipeline: secret.id }),
    );
    expect(one.total).toBe(1);
    expect(one.columns.every((column) => column.status.pipelineId === secret.id)).toBe(true);
  });

  it('moves a task to another pipeline without its stage criteria, if the mover may add there', () => {
    addModeling({ createRule: only(owner) });
    const [open] = project.statuses;
    if (!open) throw new Error('no status');
    updateStatus(ctx.deps, actorOf(owner), open.id, {
      rules: { exitCriteria: [{ id: 'model', text: 'Model attached' }] },
    });
    const task = createTask(ctx.deps, actorOf(mia), project.project.id, { title: 'Crate' });
    const modelingOpen = resolveStatus(ctx.deps.db.orm, project.project.id, 'Modeling/Open');
    expect(() => moveTask(ctx.deps, actorOf(mia), task.id, { statusId: modelingOpen.id })).toThrow(
      /can’t add tasks to the Modeling pipeline/,
    );
    const moved: Task = moveTask(ctx.deps, actorOf(owner), task.id, { statusId: modelingOpen.id });
    expect(moved.status).toMatchObject({ name: 'Open', pipeline: { name: 'Modeling' } });
    // Within a pipeline the rules still apply.
    const back = createTask(ctx.deps, actorOf(owner), project.project.id, { title: 'Barrel' });
    expect(() =>
      moveTask(ctx.deps, actorOf(owner), back.id, { statusId: project.statuses[1]?.id ?? '' }),
    ).toThrow(/Missing/);
  });

  it('deletes a pipeline, moving its tasks; the default one stays', () => {
    const modeling = addModeling();
    const task = createTask(ctx.deps, actorOf(owner), project.project.id, {
      title: 'Crate',
      pipelineId: modeling.id,
    });
    const [open] = project.statuses;
    if (!open) throw new Error('no status');
    expect(() =>
      deletePipeline(ctx.deps, actorOf(owner), project.pipeline.id, { moveTo: open.id }),
    ).toThrow(/default pipeline/);
    expect(deletePipeline(ctx.deps, actorOf(owner), modeling.id, { moveTo: open.id })).toEqual({
      ok: true,
      movedTasks: 1,
    });
    expect(getTask(ctx.deps, actorOf(owner), task.id).status.id).toBe(open.id);
    expect(listPipelines(ctx.deps, actorOf(owner), project.project.id).items).toHaveLength(1);
    // Its name is free again.
    expect(addModeling().slug).toBe('modeling');
  });

  it('renames and reorders pipelines; only status managers change who may use them', () => {
    const modeling = addModeling();
    expect(updatePipeline(ctx.deps, actorOf(owner), modeling.id, { name: 'Art' }).slug).toBe('art');
    const { items } = reorderPipelines(ctx.deps, actorOf(owner), project.project.id, {
      pipelineIds: [modeling.id, project.pipeline.id],
    });
    expect(items.map((item) => item.name)).toEqual(['Art', 'Main']);
    const managed = addModeling({ manageRule: only(mia) });
    expect(updatePipeline(ctx.deps, actorOf(mia), managed.id, { name: 'Sculpting' }).name).toBe(
      'Sculpting',
    );
    expect(() =>
      updatePipeline(ctx.deps, actorOf(mia), managed.id, { viewRule: only(mia) }),
    ).toThrow(/manage statuses/);
  });

  it('serves pipelines over REST', async () => {
    const key = createApiKey(ctx.db, { userId: owner.id }).key;
    giveAgentOwnerRoles(ctx.db, owner.id);
    const created = await ctx.app.request(
      `/api/projects/${project.project.id}/pipelines`,
      json('POST', { name: 'Audio' }, bearer(key)),
    );
    expect(created.status).toBe(201);
    const list = await ctx.app.request(`/api/projects/${project.project.id}/pipelines`, {
      headers: bearer(key),
    });
    expect(pipelineListResponseSchema.parse(await list.json()).items.map((p) => p.name)).toEqual([
      'Main',
      'Audio',
    ]);
  });
});
