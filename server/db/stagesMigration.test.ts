import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR, runMigrations } from './migrate';

/**
 * Migration 0012 (stages) against data shaped like before it: open/done categories, assignments
 * without a stage, and recorded stage visits. It must keep today's behaviour: done statuses get
 * the rules they implied, current assignments stay current, and tasks sitting in a done status
 * (without a hand-off) keep their assignees only as history of the stage they were in before.
 */

const BEFORE = '0011_pipelines';

let dir: string;
let db: Database;

/** A copy of the migrations folder that stops at `BEFORE`. */
function migrationsUpTo(tag: string): string {
  const folder = path.join(dir, 'migrations');
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string; idx: number }> };
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  const entries = journal.entries.slice(0, last + 1);
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  }
  fs.writeFileSync(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  return folder;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-stages-'));
  db = openDatabase(path.join(dir, 'baton.db'));
  migrate(db.orm, { migrationsFolder: migrationsUpTo(BEFORE) });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

function all(sql: string, ...params: unknown[]): Row[] {
  return db.sqlite.prepare(sql).all(...params) as Row[];
}

function exec(sql: string, ...params: unknown[]): void {
  db.sqlite.prepare(sql).run(...params);
}

describe('migration 0012 (stages)', () => {
  it('turns categories into rules and assignments into per-stage rows', () => {
    const ann = createUser(db, { username: 'ann' });
    const ben = createUser(db, { username: 'ben' });
    const { team, everyoneRole } = createTeam(db, { ownerId: ann.id, slug: 'acme' });
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    exec(
      `insert into project (id, team_id, name, key, color, task_seq, created_at, updated_at)
       values ('p1', ?, 'API', 'API', '#6366f1', 5, ?, ?)`,
      team.id,
      t0,
      t0,
    );
    const status = (id: string, name: string, category: string, position: number) =>
      exec(
        `insert into status (id, project_id, name, color, category, position, is_default, created_at, updated_at)
         values (?, 'p1', ?, '#6b7280', ?, ?, ?, ?, ?)`,
        id,
        name,
        category,
        position,
        position === 0 ? 1 : 0,
        t0,
        t0,
      );
    status('todo', 'Todo', 'open', 0);
    status('doing', 'Doing', 'open', 1);
    status('done', 'Done', 'done', 2);
    status('shipped', 'Shipped', 'done', 3);
    // A done status that already had a hand-off keeps it.
    exec(`update status set handoff = '{"mode":"author"}' where id = 'shipped'`);

    const task = (id: string, number: number, statusId: string, completedAt: number | null) =>
      exec(
        `insert into task (id, project_id, team_id, number, title, status_id, position, author_id,
           completed_at, last_activity_at, created_at, updated_at)
         values (?, 'p1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        team.id,
        number,
        `Task ${number}`,
        statusId,
        `a${number}`,
        ann.id,
        completedAt,
        t0,
        t0,
        t0 + number,
      );
    task('t1', 1, 'doing', null); // in progress, Ann assigned
    task('t2', 2, 'done', t0); // finished, visited Doing (recorded), Ben assigned
    task('t3', 3, 'done', null); // finished before visits were recorded, Ann + @everyone
    task('t4', 4, 'shipped', t0); // in a done status with a hand-off: keeps its assignee
    task('t5', 5, 'todo', null); // back in Todo after Doing: Ben held Doing

    const assign = (taskId: string, userId: string) =>
      exec(`insert into task_assignee_user (task_id, user_id) values (?, ?)`, taskId, userId);
    assign('t1', ann.id);
    assign('t2', ben.id);
    assign('t3', ann.id);
    exec(`insert into task_assignee_role (task_id, role_id) values ('t3', ?)`, everyoneRole.id);
    assign('t4', ann.id);
    const entry = (
      id: string,
      taskId: string,
      statusId: string,
      enteredAt: number,
      leftAt: number | null,
      holders: string[] | null,
    ) =>
      exec(
        `insert into task_stage_entry (id, task_id, status_id, entered_at, left_at, holder_user_ids)
         values (?, ?, ?, ?, ?, ?)`,
        id,
        taskId,
        statusId,
        enteredAt,
        leftAt,
        holders ? JSON.stringify(holders) : null,
      );
    entry('e1', 't2', 'todo', t0, t0 + 1, [ann.id]);
    entry('e2', 't2', 'doing', t0 + 1, t0 + 2, [ben.id]);
    entry('e3', 't2', 'done', t0 + 2, null, null);
    entry('e4', 't5', 'doing', t0, t0 + 5, [ben.id]);
    entry('e5', 't5', 'todo', t0 + 5, null, null);

    runMigrations(db);

    // Statuses: done → the finishing rules, open → defaults; icons follow.
    const statuses = all(
      `select id, icon, on_enter, blocks_dependents, claimable, handoff from status order by position`,
    );
    const finishing = JSON.stringify({
      resolveIssues: true,
      releaseClaim: true,
      notifyAuthor: true,
    });
    expect(statuses).toEqual([
      {
        id: 'todo',
        icon: 'circle',
        on_enter: null,
        blocks_dependents: 1,
        claimable: 1,
        handoff: null,
      },
      {
        id: 'doing',
        icon: 'circle',
        on_enter: null,
        blocks_dependents: 1,
        claimable: 1,
        handoff: null,
      },
      {
        id: 'done',
        icon: 'check-circle',
        on_enter: finishing,
        blocks_dependents: 0,
        claimable: 0,
        handoff: '{"mode":"nobody"}',
      },
      {
        id: 'shipped',
        icon: 'check-circle',
        on_enter: finishing,
        blocks_dependents: 0,
        claimable: 0,
        handoff: '{"mode":"author"}',
      },
    ]);

    // Assignments: current ones stay current; finished tasks' become history.
    const users = all(
      `select task_id, status_id, user_id from task_assignee_user order by task_id, status_id, user_id`,
    ).map((row) => [row.task_id, row.status_id, row.user_id === ann.id ? 'ann' : 'ben']);
    expect(users).toEqual([
      ['t1', 'doing', 'ann'],
      // t2: Ann held Todo, Ben held Doing (recorded visits); nothing in Done.
      ['t2', 'doing', 'ben'],
      ['t2', 'todo', 'ann'],
      // t3: no recorded visits: history of the project's default status.
      ['t3', 'todo', 'ann'],
      // t4: Shipped kept its own hand-off, so its assignee stays current.
      ['t4', 'shipped', 'ann'],
      // t5: Ben's recorded time in Doing becomes Doing's history.
      ['t5', 'doing', 'ben'],
    ]);
    expect(
      all(`select task_id, status_id, role_id from task_assignee_role`).map((row) => [
        row.task_id,
        row.status_id,
      ]),
    ).toEqual([['t3', 'todo']]);

    // completedAt follows blocks_dependents (t3 had lost it; it gets its last update time).
    const completed = all(`select id, completed_at from task order by number`);
    expect(completed.map((row) => [row.id, row.completed_at !== null])).toEqual([
      ['t1', false],
      ['t2', true],
      ['t3', true],
      ['t4', true],
      ['t5', false],
    ]);
    // The legacy column is still there, unused.
    expect(all(`select category from status where id = 'done'`)).toEqual([{ category: 'done' }]);
  });
});
