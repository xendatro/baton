import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR } from './migrate';

/**
 * Migration 0025 (chat conversations) against data shaped like before it: existing issues and
 * tasks keep the threaded forum view, their replies and everything hanging off them survive (the
 * migration only adds a column and a table), and `catch_up_summary` exists afterwards.
 */

const TAG = '0025_conversation_mode';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-conversation-mode-'));
  db = openDatabase(path.join(dir, 'baton.db'));
  const entries = journal().entries;
  const before = entries[entries.findIndex((entry) => entry.tag === TAG) - 1];
  if (!before) throw new Error('no migration before 0025');
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

describe('migration 0025 (conversation mode)', () => {
  it('keeps existing issues and tasks as forums, with their replies, and adds catch-up summaries', () => {
    const ann = createUser(db, { username: 'ann' });
    const { team } = createTeam(db, { ownerId: ann.id, slug: 'acme' });
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    exec(
      `insert into project (id, team_id, name, key, color, task_seq, issue_seq, created_at, updated_at)
       values ('P', ?, 'API', 'API', '#6366f1', 1, 1, ?, ?)`,
      team.id,
      t0,
      t0,
    );
    exec(
      `insert into pipeline (id, project_id, name, slug, position, is_default, created_at, updated_at)
       values ('main', 'P', 'Main', 'main', 0, 1, ?, ?)`,
      t0,
      t0,
    );
    exec(
      `insert into status (id, project_id, pipeline_id, name, color, category, position, is_default,
         created_at, updated_at)
       values ('open', 'P', 'main', 'Open', '#6b7280', 'open', 0, 1, ?, ?)`,
      t0,
      t0,
    );
    exec(
      `insert into task (id, project_id, team_id, number, title, status_id, position, author_id,
         reply_count, created_at, updated_at, last_activity_at)
       values ('t1', 'P', ?, 1, 'Task', 'open', 'a0', ?, 1, ?, ?, ?)`,
      team.id,
      ann.id,
      t0,
      t0,
      t0,
    );
    exec(
      `insert into issue (id, project_id, team_id, number, title, body, author_id, reply_count,
         created_at, updated_at, last_activity_at)
       values ('i1', 'P', ?, 1, 'Issue', 'Body', ?, 1, ?, ?, ?)`,
      team.id,
      ann.id,
      t0,
      t0,
      t0,
    );
    for (const [id, parentType, parentId] of [
      ['r1', 'task', 't1'],
      ['r2', 'issue', 'i1'],
    ] as const) {
      exec(
        `insert into reply (id, team_id, project_id, parent_type, parent_id, author_id, body,
           created_at, updated_at)
         values (?, ?, 'P', ?, ?, ?, 'Hello', ?, ?)`,
        id,
        team.id,
        parentType,
        parentId,
        ann.id,
        t0,
        t0,
      );
    }

    migrate(db.orm, { migrationsFolder: MIGRATIONS_DIR });

    expect(all('select id, conversation_mode from task')).toEqual([
      { id: 't1', conversation_mode: 'forum' },
    ]);
    expect(all('select id, conversation_mode, body, reply_count from issue')).toEqual([
      { id: 'i1', conversation_mode: 'forum', body: 'Body', reply_count: 1 },
    ]);
    expect(all('select id from reply order by id')).toEqual([{ id: 'r1' }, { id: 'r2' }]);
    exec(
      `insert into catch_up_summary (id, user_id, project_id, item_type, item_id, range, summary,
         created_at)
       values ('c1', ?, 'P', 'issue', 'i1', '{"kind":"last","count":1}', 'All quiet', ?)`,
      ann.id,
      t0,
    );
    expect(all('select id, summary from catch_up_summary')).toEqual([
      { id: 'c1', summary: 'All quiet' },
    ]);
  });
});
