import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../context';
import { isAppError } from '../lib/errors';
import {
  addMember,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  createDifficulty,
  deleteDifficulty,
  listDifficulties,
  reorderDifficulties,
  updateDifficulty,
} from './difficulties';
import { createProject as createProjectService, getProject } from './projects';
import { createTask, getTask, updateTask } from './tasks';

/** Difficulty levels (BAT-24): seeded per project, managed like labels, one per task. */

let ctx: TestContext;
let owner: UserRow;
let ben: UserRow;
let teamId: string;
let project: CreatedProject;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ben = createUser(ctx.db, { username: 'ben' });
  teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' }).team.id;
  addMember(ctx.db, { teamId, userId: ben.id });
  project = createProject(ctx.db, { teamId, key: 'API', createdById: owner.id });
});

afterEach(() => ctx.close());

function names(): string[] {
  return listDifficulties(ctx.deps, web(ben), project.project.id).items.map((level) => level.name);
}

describe('difficulty levels', () => {
  it('start as Easy, Normal, Hard, on the project too', () => {
    expect(names()).toEqual(['Easy', 'Normal', 'Hard']);
    const created = createProjectService(ctx.deps, web(owner), teamId, { name: 'Web', key: 'WEB' });
    expect(created.difficulties?.map((level) => level.name)).toEqual(['Easy', 'Normal', 'Hard']);
  });

  it('are added, renamed, reordered and deleted (MANAGE_LABELS)', () => {
    const projectId = project.project.id;
    const epic = createDifficulty(ctx.deps, web(owner), projectId, {
      name: 'Epic',
      color: '#a855f7',
    });
    expect(epic.position).toBe(3);
    expect(
      failure(() => createDifficulty(ctx.deps, web(owner), projectId, { name: 'easy' })).message,
    ).toBe('There is already a level named "Easy"');
    updateDifficulty(ctx.deps, web(owner), epic.id, { name: 'Huge' });
    const [easy, normal, hard, huge] = listDifficulties(ctx.deps, web(owner), projectId).items;
    if (!easy || !normal || !hard || !huge) throw new Error('levels');
    reorderDifficulties(ctx.deps, web(owner), projectId, {
      difficultyIds: [huge.id, easy.id, normal.id, hard.id],
    });
    expect(names()).toEqual(['Huge', 'Easy', 'Normal', 'Hard']);
    expect(
      failure(() =>
        reorderDifficulties(ctx.deps, web(owner), projectId, { difficultyIds: [easy.id] }),
      ).code,
    ).toBe('validation_failed');

    const task = createTask(ctx.deps, web(owner), projectId, {
      title: 'Big one',
      difficultyId: huge.id,
    });
    expect(deleteDifficulty(ctx.deps, web(owner), huge.id)).toEqual({ ok: true, clearedTasks: 1 });
    expect(getTask(ctx.deps, web(owner), task.id).difficulty).toBeNull();
  });

  it('sit on tasks: set on create, changed and cleared, audited in words', () => {
    const projectId = project.project.id;
    const [easy, , hard] = getProject(ctx.deps, web(owner), projectId).difficulties ?? [];
    if (!easy || !hard) throw new Error('levels');
    const task = createTask(ctx.deps, web(owner), projectId, {
      title: 'Fix it',
      difficultyId: easy.id,
    });
    expect(task.difficulty).toEqual({ id: easy.id, name: 'Easy', color: easy.color, position: 0 });
    const updated = updateTask(ctx.deps, web(owner), task.id, { difficultyId: hard.id });
    expect(updated.difficulty?.name).toBe('Hard');
    expect(updateTask(ctx.deps, web(owner), task.id, { difficultyId: null }).difficulty).toBeNull();
    // Another project's level is refused.
    const other = createProject(ctx.db, { teamId, key: 'OTH' });
    const foreign = listDifficulties(ctx.deps, web(owner), other.project.id).items[0];
    expect(
      failure(() => updateTask(ctx.deps, web(owner), task.id, { difficultyId: foreign?.id ?? '' }))
        .message,
    ).toMatch(/^Difficulty must be one of this project's levels: Easy, Normal, Hard/);
  });
});
