import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR } from './migrate';

/**
 * Migration 0020 (BAT-28, difficulty per stage) against data shaped like before it: every task's
 * difficulty becomes its current stage's, the current visits record it, stage defaults start
 * empty, and nothing else changes.
 */

const TAG = '0020_stage_difficulty';

let dir: string;
let db: Database;

interface Journal {
  entries: Array<{ tag: string; idx: number }>;
}

function journal(): Journal {
  return JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
}

/** A copy of the migrations folder that stops at `tag` (in its own folder). */
function migrationsUpTo(tag: string): string {
  const folder = path.join(dir, `migrations-${tag}`);
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const all = journal();
  const entries = all.entries.slice(0, all.entries.findIndex((entry) => entry.tag === tag) + 1);
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  }
  fs.writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ ...all, entries }));
  return folder;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-stage-difficulty-'));
  db = openDatabase(path.join(dir, 'baton.db'));
  const entries = journal().entries;
  const before = entries[entries.findIndex((entry) => entry.tag === TAG) - 1];
  if (!before) throw new Error('no migration before 0020');
  migrate(db.orm, { migrationsFolder: migrationsUpTo(before.tag) });
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

describe('migration 0020 (difficulty per stage)', () => {
  it('copies each task’s difficulty to its current stage and keeps everything else', () => {
    const ann = createUser(db, { username: 'ann' });
    const { team } = createTeam(db, { ownerId: ann.id, slug: 'acme' });
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    exec(
      `insert into project (id, team_id, name, key, color, task_seq, created_at, updated_at)
       values ('P', ?, 'API', 'API', '#6366f1', 3, ?, ?)`,
      team.id,
      t0,
      t0,
    );
    exec(
      `insert into pipeline (id, project_id, name, slug, position, is_default, created_at, updated_at)
       values ('main', 'P', 'Default', 'default', 0, 1, ?, ?)`,
      t0,
      t0,
    );
    exec(
      `insert into difficulty (id, project_id, name, color, position, created_at, updated_at)
       values ('easy', 'P', 'Easy', '#22c55e', 0, ?, ?), ('hard', 'P', 'Hard', '#ef4444', 2, ?, ?)`,
      t0,
      t0,
      t0,
      t0,
    );
    for (const [id, position] of [
      ['open', 0],
      ['build', 1],
    ] as const) {
      exec(
        `insert into status (id, project_id, pipeline_id, name, color, category, position, is_default,
           created_at, updated_at)
         values (?, 'P', 'main', ?, '#6b7280', 'open', ?, ?, ?, ?)`,
        id,
        id,
        position,
        position === 0 ? 1 : 0,
        t0,
        t0,
      );
    }
    const tasks: Array<[string, string, string | null, number | null]> = [
      ['t1', 'build', 'hard', null],
      ['t2', 'open', null, null],
      ['t3', 'build', 'easy', t0], // in Trash
    ];
    for (const [id, status, difficulty, deletedAt] of tasks) {
      exec(
        `insert into task (id, project_id, team_id, number, title, status_id, difficulty_id, position,
           author_id, last_activity_at, created_at, updated_at, deleted_at)
         values (?, 'P', ?, ?, 'Task', ?, ?, 'a0', ?, ?, ?, ?, ?)`,
        id,
        team.id,
        Number(id.slice(1)),
        status,
        difficulty,
        ann.id,
        t0,
        t0,
        t0,
        deletedAt,
      );
    }
    exec(
      `insert into task_stage_entry (id, task_id, status_id, entered_at, left_at)
       values ('e1', 't1', 'open', ?, ?), ('e2', 't1', 'build', ?, null), ('e3', 't2', 'open', ?, null)`,
      t0,
      t0 + 1,
      t0 + 1,
      t0,
    );
    const snapshot = () => ({
      tasks: all('select * from task order by id'),
      statuses: all('select id, name, position, send_back_to from status order by id'),
      entries: all(
        'select id, task_id, status_id, entered_at, left_at from task_stage_entry order by id',
      ),
    });
    const before = snapshot();

    migrate(db.orm, { migrationsFolder: migrationsUpTo(TAG) });

    expect(snapshot()).toEqual(before);
    expect(
      all('select task_id, status_id, difficulty_id from task_stage_difficulty order by task_id'),
    ).toEqual([
      { task_id: 't1', status_id: 'build', difficulty_id: 'hard' },
      { task_id: 't2', status_id: 'open', difficulty_id: null },
      { task_id: 't3', status_id: 'build', difficulty_id: 'easy' },
    ]);
    expect(all('select id, difficulty_id from task_stage_entry order by id')).toEqual([
      { id: 'e1', difficulty_id: null },
      { id: 'e2', difficulty_id: 'hard' },
      { id: 'e3', difficulty_id: null },
    ]);
    expect(all('select default_difficulty_id from status')).toEqual([
      { default_difficulty_id: null },
      { default_difficulty_id: null },
    ]);
    expect(all('pragma foreign_key_check')).toEqual([]);
    // Deleting a level clears it everywhere it is used.
    exec(`delete from difficulty where id = 'hard'`);
    expect(all(`select difficulty_id from task_stage_difficulty where task_id = 't1'`)).toEqual([
      { difficulty_id: null },
    ]);
  });
});
