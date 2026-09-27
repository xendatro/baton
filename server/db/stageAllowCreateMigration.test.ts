import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR } from './migrate';

/**
 * Migration 0021 (BAT-34, "New tasks can start here") against data shaped like before it: each
 * pipeline's default stage (else its first) accepts new tasks, every other stage doesn't, and
 * nothing else changes.
 */

const TAG = '0021_stage_allow_create';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-stage-allow-create-'));
  db = openDatabase(path.join(dir, 'baton.db'));
  const entries = journal().entries;
  const before = entries[entries.findIndex((entry) => entry.tag === TAG) - 1];
  if (!before) throw new Error('no migration before 0021');
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

describe('migration 0021 (new tasks can start here)', () => {
  it("turns the rule on for each pipeline's default stage only", () => {
    const ann = createUser(db, { username: 'ann' });
    const { team } = createTeam(db, { ownerId: ann.id, slug: 'acme' });
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    exec(
      `insert into project (id, team_id, name, key, color, task_seq, created_at, updated_at)
       values ('P', ?, 'API', 'API', '#6366f1', 1, ?, ?)`,
      team.id,
      t0,
      t0,
    );
    for (const [id, position, isDefault] of [
      ['main', 0, 1],
      ['review', 1, 0],
    ] as const) {
      exec(
        `insert into pipeline (id, project_id, name, slug, position, is_default, created_at, updated_at)
         values (?, 'P', ?, ?, ?, ?, ?, ?)`,
        id,
        id,
        id,
        position,
        isDefault,
        t0,
        t0,
      );
    }
    // main: Build (default, not first), Open, Done; review (no marked default): Triage, Check.
    const stages: Array<[string, string, number, number]> = [
      ['open', 'main', 0, 0],
      ['build', 'main', 1, 1],
      ['done', 'main', 2, 0],
      ['triage', 'review', 0, 0],
      ['check', 'review', 1, 0],
    ];
    for (const [id, pipeline, position, isDefault] of stages) {
      exec(
        `insert into status (id, project_id, pipeline_id, name, color, category, position, is_default,
           created_at, updated_at)
         values (?, 'P', ?, ?, '#6b7280', 'open', ?, ?, ?, ?)`,
        id,
        pipeline,
        id,
        position,
        isDefault,
        t0,
        t0,
      );
    }
    exec(
      `insert into task (id, project_id, team_id, number, title, status_id, position, author_id,
         created_at, updated_at, last_activity_at)
       values ('t1', 'P', ?, 1, 'Task', 'done', 'a0', ?, ?, ?, ?)`,
      team.id,
      ann.id,
      t0,
      t0,
      t0,
    );

    migrate(db.orm, { migrationsFolder: MIGRATIONS_DIR });

    expect(all('select id, allow_create, is_default from status order by id')).toEqual([
      { id: 'build', allow_create: 1, is_default: 1 },
      { id: 'check', allow_create: 0, is_default: 0 },
      { id: 'done', allow_create: 0, is_default: 0 },
      { id: 'open', allow_create: 0, is_default: 0 },
      { id: 'triage', allow_create: 1, is_default: 0 },
    ]);
    expect(all('select id, status_id from task')).toEqual([{ id: 't1', status_id: 'done' }]);
  });
});
