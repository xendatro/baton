import SqliteDatabase from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createProject,
  createTeam,
  createUser,
  type TestContext,
} from '../test/helpers';
import { runMigrations } from './migrate';
import * as s from './schema';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

const EXPECTED_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'api_key',
  'team',
  'team_member',
  'role',
  'member_role',
  'invite',
  'project',
  'project_key_alias',
  'status',
  'label',
  'issue',
  'issue_label',
  'task',
  'task_label',
  'task_assignee_user',
  'task_assignee_role',
  'task_issue_link',
  'task_dependency',
  'reply',
  'attachment',
  'subscription',
  'notification',
  'activity',
  'search_index',
];

describe('migrations', () => {
  it('create every table of the data model', () => {
    const rows = ctx.db.sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    for (const table of EXPECTED_TABLES) expect(names, table).toContain(table);
  });

  it('are idempotent', () => {
    expect(() => runMigrations(ctx.db)).not.toThrow();
  });

  it('create a working FTS5 search index', () => {
    const insert = ctx.db.sqlite.prepare(
      'insert into search_index (entity_type, entity_id, team_id, project_id, title, body) values (?, ?, ?, ?, ?, ?)',
    );
    insert.run('task', 't1', 'team1', 'p1', 'Fix login redirect', 'Users bounce after signing in');
    insert.run('issue', 'i1', 'team1', 'p1', 'Crash on upload', 'Uploading a PNG crashes');
    const match = (query: string) =>
      (
        ctx.db.sqlite
          .prepare('select entity_id from search_index where search_index match ? order by rank')
          .all(query) as Array<{ entity_id: string }>
      ).map((row) => row.entity_id);
    expect(match('login')).toEqual(['t1']);
    expect(match('uploads')).toEqual(['i1']); // porter stemming
    expect(match('cra*')).toEqual(['i1']); // prefix queries
    expect(match('task')).toEqual([]); // entity_type is not searchable text
  });
});

describe('openDatabase', () => {
  it('applies the SPEC pragmas', () => {
    const pragma = (name: string): unknown => ctx.db.sqlite.pragma(name, { simple: true });
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('busy_timeout')).toBe(5000);
    expect(pragma('synchronous')).toBe(1); // NORMAL
  });

  it('enforces foreign keys', () => {
    expect(() =>
      ctx.db.orm.insert(s.teamMember).values({ teamId: 'missing', userId: 'missing' }).run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('db.write', () => {
  it('commits and returns the callback result', () => {
    const user = ctx.db.write(() => createUser(ctx.db));
    expect(ctx.db.orm.select().from(s.user).where(eq(s.user.id, user.id)).get()).toBeDefined();
  });

  it('rolls back everything when the callback throws', () => {
    expect(() =>
      ctx.db.write((tx) => {
        tx.insert(s.user)
          .values({
            id: 'u-rollback',
            name: 'X',
            email: 'x@example.test',
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(
      ctx.db.orm.select().from(s.user).where(eq(s.user.id, 'u-rollback')).get(),
    ).toBeUndefined();
  });

  it('rejects async callbacks', () => {
    expect(() => ctx.db.write(async () => Promise.resolve(1))).toThrow();
  });

  it('takes the write lock up front (BEGIN IMMEDIATE)', () => {
    const other = new SqliteDatabase(ctx.db.file);
    other.pragma('busy_timeout = 0');
    try {
      // No statement has run yet: a DEFERRED transaction would not hold the lock at this point.
      ctx.db.write(() => {
        expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
      });
    } finally {
      other.close();
    }
  });
});

describe('constraints', () => {
  it('keeps team slugs unique among non-deleted teams only', () => {
    const owner = createUser(ctx.db);
    const { team } = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
    expect(() => createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' })).toThrow(/UNIQUE/);
    ctx.db.orm.update(s.team).set({ deletedAt: new Date() }).where(eq(s.team.id, team.id)).run();
    expect(() => createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' })).not.toThrow();
  });

  it('keeps project keys unique per team among non-deleted projects', () => {
    const owner = createUser(ctx.db);
    const { team } = createTeam(ctx.db, { ownerId: owner.id });
    const { project } = createProject(ctx.db, { teamId: team.id, key: 'BAT' });
    expect(() => createProject(ctx.db, { teamId: team.id, key: 'BAT' })).toThrow(/UNIQUE/);
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, project.id))
      .run();
    expect(() => createProject(ctx.db, { teamId: team.id, key: 'BAT' })).not.toThrow();
  });

  it('allows one @everyone role and one default status', () => {
    const owner = createUser(ctx.db);
    const { team } = createTeam(ctx.db, { ownerId: owner.id });
    expect(() =>
      ctx.db.orm
        .insert(s.role)
        .values({ teamId: team.id, name: 'x', slug: 'x', position: 0, isEveryone: true })
        .run(),
    ).toThrow(/UNIQUE/);
    const { project, pipeline } = createProject(ctx.db, { teamId: team.id });
    expect(() =>
      ctx.db.orm
        .insert(s.status)
        .values({
          projectId: project.id,
          pipelineId: pipeline.id,
          name: 'Other',
          color: '#000000',
          position: 9,
          isDefault: true,
        })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('rejects a task blocking itself', () => {
    const owner = createUser(ctx.db);
    const { team } = createTeam(ctx.db, { ownerId: owner.id });
    const { project, statuses } = createProject(ctx.db, { teamId: team.id });
    const task = ctx.db.orm
      .insert(s.task)
      .values({
        projectId: project.id,
        teamId: team.id,
        number: 1,
        title: 'T',
        statusId: statuses[0]?.id ?? '',
        position: 'a0',
      })
      .returning()
      .get();
    expect(() =>
      ctx.db.orm
        .insert(s.taskDependency)
        .values({ taskId: task.id, blockedByTaskId: task.id })
        .run(),
    ).toThrow(/CHECK/);
  });

  it('cascades member roles when a member leaves', () => {
    const owner = createUser(ctx.db);
    const { team, adminRole } = createTeam(ctx.db, { ownerId: owner.id });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.id, userId: owner.id, roleId: adminRole.id })
      .run();
    ctx.db.orm.delete(s.teamMember).where(eq(s.teamMember.userId, owner.id)).run();
    expect(ctx.db.orm.select().from(s.memberRole).all()).toEqual([]);
  });
});
