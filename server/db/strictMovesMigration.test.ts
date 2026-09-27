import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR } from './migrate';

/**
 * Migration 0019 (BAT-27, strict moves) against data shaped like before it: every stage that
 * allowed sending back can send back to every earlier stage of its pipeline, the others to none;
 * evidence, stage visits and approvals are kept as they were.
 */

const TAG = '0019_strict_moves';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-strict-moves-'));
  db = openDatabase(path.join(dir, 'baton.db'));
  const entries = journal().entries;
  const before = entries[entries.findIndex((entry) => entry.tag === TAG) - 1];
  if (!before) throw new Error('no migration before 0019');
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

describe('migration 0019 (strict moves)', () => {
  it('turns allow_send_back into send_back_to and keeps everything else', () => {
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
    exec(
      `insert into pipeline (id, project_id, name, slug, position, is_default, created_at, updated_at)
       values ('main', 'P', 'Default', 'default', 0, 1, ?, ?), ('ops', 'P', 'Ops', 'ops', 1, 0, ?, ?)`,
      t0,
      t0,
      t0,
      t0,
    );
    // Main: Open, Build, Review (no send-back), Done (inserted out of order). Ops: Triage, Fix.
    const stages: Array<[string, string, string, number, number]> = [
      ['done', 'main', 'Done', 3, 1],
      ['open', 'main', 'Open', 0, 1],
      ['review', 'main', 'Review', 2, 0],
      ['build', 'main', 'Build', 1, 1],
      ['triage', 'ops', 'Triage', 0, 1],
      ['fix', 'ops', 'Fix', 1, 1],
    ];
    for (const [id, pipeline, name, position, allow] of stages) {
      exec(
        `insert into status (id, project_id, pipeline_id, name, color, category, position, is_default,
           allow_send_back, created_at, updated_at)
         values (?, 'P', ?, ?, '#6b7280', 'open', ?, ?, ?, ?, ?)`,
        id,
        pipeline,
        name,
        position,
        position === 0 ? 1 : 0,
        allow,
        t0,
        t0,
      );
    }
    exec(
      `insert into task (id, project_id, team_id, number, title, status_id, position, author_id,
         last_activity_at, created_at, updated_at)
       values ('t1', 'P', ?, 1, 'Task', 'review', 'a0', ?, ?, ?, ?)`,
      team.id,
      ann.id,
      t0,
      t0,
      t0,
    );
    exec(
      `insert into task_stage_entry (id, task_id, status_id, entered_at, left_at)
       values ('e1', 't1', 'build', ?, ?), ('e2', 't1', 'review', ?, null)`,
      t0,
      t0 + 1,
      t0 + 1,
    );
    exec(
      `insert into task_stage_evidence (id, task_id, status_id, criterion_id, text, created_at, updated_at)
       values ('ev1', 't1', 'build', 'tests', 'green', ?, ?)`,
      t0,
      t0,
    );
    exec(
      `insert into task_approval (id, task_id, status_id, user_id, decision, created_at)
       values ('a1', 't1', 'review', ?, 'approve', ?)`,
      ann.id,
      t0 + 2,
    );
    const snapshot = () => ({
      statuses: all(
        'select id, pipeline_id, name, position, allow_send_back, next_status_id from status order by id',
      ),
      tasks: all('select * from task order by id'),
      entries: all(
        'select id, task_id, status_id, entered_at, left_at from task_stage_entry order by id',
      ),
      evidence: all(
        'select id, task_id, status_id, criterion_id, text from task_stage_evidence order by id',
      ),
      approvals: all('select * from task_approval order by id'),
    });
    const before = snapshot();

    migrate(db.orm, { migrationsFolder: migrationsUpTo(TAG) });

    expect(snapshot()).toEqual(before);
    const sendBack = Object.fromEntries(
      all('select id, send_back_to from status').map((row): [string, string[]] => [
        String(row.id),
        JSON.parse(String(row.send_back_to)) as string[],
      ]),
    );
    expect(sendBack).toEqual({
      open: [],
      build: ['open'],
      review: [],
      done: ['open', 'build', 'review'],
      triage: [],
      fix: ['triage'],
    });
    expect(all('select archived_at from task_stage_evidence')).toEqual([{ archived_at: null }]);
    expect(all('select return_reason, returned_by_id from task_stage_entry')).toEqual([
      { return_reason: null, returned_by_id: null },
      { return_reason: null, returned_by_id: null },
    ]);
    expect(all('pragma foreign_key_check')).toEqual([]);
    // Only the current visit's evidence is unique per criterion.
    exec(`update task_stage_evidence set archived_at = ? where id = 'ev1'`, t0 + 3);
    exec(
      `insert into task_stage_evidence (id, task_id, status_id, criterion_id, text, created_at, updated_at)
       values ('ev2', 't1', 'build', 'tests', 'green again', ?, ?)`,
      t0 + 3,
      t0 + 3,
    );
    expect(() =>
      exec(
        `insert into task_stage_evidence (id, task_id, status_id, criterion_id, text, created_at, updated_at)
         values ('ev3', 't1', 'build', 'tests', 'dup', ?, ?)`,
        t0 + 4,
        t0 + 4,
      ),
    ).toThrow(/UNIQUE/);
  });
});
