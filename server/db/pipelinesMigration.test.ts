import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR, runMigrations } from './migrate';

/**
 * Migration 0017 (BAT-25, pipelines) against data shaped like before it: every project gets one
 * Default pipeline holding all its statuses, and nothing else changes (rules, tasks, assignments,
 * stage history, approvals). A status without a pipeline is refused afterwards.
 */

const BEFORE = '0016_groovy_monster_badoon';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-pipelines-'));
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

describe('migration 0017 (pipelines)', () => {
  it("puts every project's statuses in its own Default pipeline and keeps everything else", () => {
    const ann = createUser(db, { username: 'ann' });
    const { team } = createTeam(db, { ownerId: ann.id, slug: 'acme' });
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    for (const key of ['API', 'WEB']) {
      exec(
        `insert into project (id, team_id, name, key, color, task_seq, created_at, updated_at)
         values (?, ?, ?, ?, '#6366f1', 1, ?, ?)`,
        key,
        team.id,
        key,
        key,
        t0,
        t0,
      );
      exec(
        `insert into status (id, project_id, name, color, category, position, is_default, created_at, updated_at)
         values (?, ?, 'Open', '#6b7280', 'open', 0, 1, ?, ?), (?, ?, 'Review', '#6b7280', 'open', 1, 0, ?, ?)`,
        `${key}-open`,
        key,
        t0,
        t0,
        `${key}-review`,
        key,
        t0,
        t0,
      );
      exec(
        `update status set next_status_id = ?, exit_criteria = '[{"id":"c1","text":"Tests"}]' where id = ?`,
        `${key}-review`,
        `${key}-open`,
      );
      exec(
        `insert into task (id, project_id, team_id, number, title, status_id, position, author_id,
           last_activity_at, created_at, updated_at)
         values (?, ?, ?, 1, 'Task', ?, 'a0', ?, ?, ?, ?)`,
        `${key}-t1`,
        key,
        team.id,
        `${key}-review`,
        ann.id,
        t0,
        t0,
        t0,
      );
      exec(
        `insert into task_assignee_user (task_id, status_id, user_id) values (?, ?, ?)`,
        `${key}-t1`,
        `${key}-review`,
        ann.id,
      );
      exec(
        `insert into task_stage_entry (id, task_id, status_id, entered_at) values (?, ?, ?, ?)`,
        `${key}-e1`,
        `${key}-t1`,
        `${key}-review`,
        t0,
      );
      exec(
        `insert into task_approval (id, task_id, status_id, user_id, decision, created_at)
         values (?, ?, ?, ?, 'approve', ?)`,
        `${key}-a1`,
        `${key}-t1`,
        `${key}-review`,
        ann.id,
        t0,
      );
    }
    const snapshot = () => ({
      statuses: all(
        'select id, project_id, name, position, is_default, next_status_id, exit_criteria from status order by id',
      ),
      tasks: all('select * from task order by id'),
      assignees: all('select * from task_assignee_user order by task_id'),
      entries: all('select * from task_stage_entry order by id'),
      approvals: all('select * from task_approval order by id'),
    });
    const before = snapshot();

    runMigrations(db);

    expect(snapshot()).toEqual(before);
    const pipelines = all(
      'select id, project_id, name, is_default from pipeline order by project_id',
    );
    expect(pipelines).toMatchObject([
      { project_id: 'API', name: 'Default', is_default: 1 },
      { project_id: 'WEB', name: 'Default', is_default: 1 },
    ]);
    for (const pipeline of pipelines) {
      const statuses = all('select project_id from status where pipeline_id = ?', pipeline.id);
      expect(statuses).toEqual([
        { project_id: pipeline.project_id },
        { project_id: pipeline.project_id },
      ]);
    }
    expect(all('pragma foreign_key_check')).toEqual([]);
    expect(() =>
      exec(
        `insert into status (id, project_id, name, color, category, position, is_default, created_at, updated_at)
         values ('x', 'API', 'Loose', '#000000', 'open', 9, 0, 0, 0)`,
      ),
    ).toThrow(/pipeline_id is required/);
  });
});
