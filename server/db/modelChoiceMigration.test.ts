import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR } from './migrate';

/**
 * Migration 0028 (difficulty removed, direct model choice): each person's per-project models by
 * difficulty become one default chain per project — the "Normal" level's chain, else the mapped
 * level closest to the middle (the easier one on a tie) — and nothing is deleted.
 */

const TAG = '0028_model_choice';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-model-choice-'));
  db = openDatabase(path.join(dir, 'baton.db'));
  const entries = journal().entries;
  const before = entries[entries.findIndex((entry) => entry.tag === TAG) - 1];
  if (!before) throw new Error('no migration before 0028');
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

const t0 = Date.parse('2026-09-01T00:00:00Z');

function project(id: string, teamId: string, levels: Array<[string, string, number]>) {
  exec(
    `insert into project (id, team_id, name, key, color, task_seq, created_at, updated_at)
     values (?, ?, ?, ?, '#6366f1', 0, ?, ?)`,
    id,
    teamId,
    id,
    id,
    t0,
    t0,
  );
  for (const [levelId, name, position] of levels) {
    exec(
      `insert into difficulty (id, project_id, name, color, position, created_at, updated_at)
       values (?, ?, ?, '#6b7280', ?, ?, ?)`,
      levelId,
      id,
      name,
      position,
      t0,
      t0,
    );
  }
}

const chain = (model: string) => [{ harness: 'claude', model, effort: 'high' }];

function mapping(userId: string, projectId: string, levels: Record<string, unknown>) {
  exec(
    `insert into agent_project_mapping (user_id, project_id, levels, updated_at) values (?, ?, ?, ?)`,
    userId,
    projectId,
    JSON.stringify(levels),
    t0,
  );
}

describe('migration 0028 (direct model choice)', () => {
  it('turns each project’s models by difficulty into one default chain', () => {
    const owner = createUser(db, { username: 'owner' });
    const { team } = createTeam(db, { ownerId: owner.id, slug: 'acme' });
    const people = ['ann', 'bob', 'cara', 'dan', 'eve'].map(
      (username) => createUser(db, { username }).id,
    );
    const [ann, bob, cara, dan, eve] = people as [string, string, string, string, string];
    project('API', team.id, [
      ['easy', 'Easy', 0],
      ['normal', 'Normal', 1],
      ['hard', 'Hard', 2],
    ]);
    project('WEB', team.id, [
      ['trivial', 'Trivial', 0],
      ['small', 'Small', 1],
      ['medium', 'Medium', 2],
      ['large', 'Large', 3],
      ['huge', 'Huge', 4],
    ]);
    // The "Normal" level wins.
    mapping(ann, 'API', { easy: chain('haiku'), normal: chain('sonnet'), hard: chain('opus') });
    // Easy and Hard are as close to the middle: the easier one.
    mapping(bob, 'API', { easy: chain('haiku'), hard: chain('opus') });
    // The only mapped level; an empty chain doesn't count.
    mapping(cara, 'API', { normal: [], hard: chain('opus') });
    // Nothing usable (a deleted level, empty chains): the account default.
    mapping(dan, 'API', { gone: chain('opus'), easy: [] });
    // No "Normal": the one closest to the middle (Medium) is Small here.
    mapping(eve, 'WEB', { small: chain('sonnet'), huge: chain('opus') });

    migrate(db.orm, { migrationsFolder: MIGRATIONS_DIR });

    const rows = new Map(
      all('select user_id, project_id, levels, chain from agent_project_mapping').map((row) => [
        `${String(row.user_id)}:${String(row.project_id)}`,
        row,
      ]),
    );
    const chainOf = (userId: string, projectId: string) => {
      const value = rows.get(`${userId}:${projectId}`)?.chain;
      return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    };
    expect(chainOf(ann, 'API')).toEqual(chain('sonnet'));
    expect(chainOf(bob, 'API')).toEqual(chain('haiku'));
    expect(chainOf(cara, 'API')).toEqual(chain('opus'));
    expect(chainOf(dan, 'API')).toBeNull();
    expect(chainOf(eve, 'WEB')).toEqual(chain('sonnet'));
    // Nothing is deleted: the old mapping and the levels stay.
    expect(JSON.parse(String(rows.get(`${ann}:API`)?.levels))).toMatchObject({
      normal: chain('sonnet'),
    });
    expect(all('select id from difficulty')).toHaveLength(8);
    // The new columns start empty.
    expect(all('select suggested_model from status where suggested_model is not null')).toEqual([]);
    expect(all('select suggested_model from reply where suggested_model is not null')).toEqual([]);
  });
});
