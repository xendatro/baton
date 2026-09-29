import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentAccessRulesSchema } from '@shared/schemas/agentAccess';
import { createTeam, createUser } from '../test/fixtures';
import { openDatabase, type Database } from './index';
import { MIGRATIONS_DIR } from './migrate';

/**
 * Migration 0026 (agent access) against data shaped like before it: each owner's "Whose jobs
 * run" becomes a team default in every team they belong to, with whoever ran automatically in
 * "Start automatically" and everyone else in "Can ask you". `me` (the old default) needs no row.
 */

const TAG = '0026_agent_access';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-agent-access-'));
  db = openDatabase(path.join(dir, 'baton.db'));
  const entries = journal().entries;
  const before = entries[entries.findIndex((entry) => entry.tag === TAG) - 1];
  if (!before) throw new Error('no migration before 0026');
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

function setSources(userId: string, sources: unknown): void {
  db.sqlite
    .prepare(
      `insert into agent_settings (user_id, job_sources, updated_at) values (?, ?, ?)
       on conflict (user_id) do update set job_sources = excluded.job_sources`,
    )
    .run(userId, JSON.stringify(sources), Date.parse('2026-09-01T00:00:00Z'));
}

function addToTeam(teamId: string, userId: string): void {
  db.sqlite
    .prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)')
    .run(teamId, userId, Date.now());
}

describe('migration 0026 (agent access from job sources)', () => {
  it('turns each owner’s job sources into a team default per team', () => {
    const ann = createUser(db, { username: 'ann' });
    const ben = createUser(db, { username: 'ben' });
    const cat = createUser(db, { username: 'cat' });
    const dan = createUser(db, { username: 'dan' });
    const one = createTeam(db, { ownerId: ann.id, slug: 'one' }).team;
    const two = createTeam(db, { ownerId: ben.id, slug: 'two' }).team;
    addToTeam(one.id, ben.id);
    addToTeam(one.id, cat.id);
    addToTeam(one.id, dan.id);
    // Ann: only her own jobs (the old default), Ben: anyone, Cat: Dan and every agent, Dan: none.
    setSources(ann.id, { mode: 'me', rule: null });
    setSources(ben.id, { mode: 'anyone', rule: null });
    setSources(cat.id, {
      mode: 'custom',
      rule: {
        allow: [
          { type: 'user', userId: dan.id },
          { type: 'everyone', scope: 'agents' },
        ],
        deny: [{ type: 'user', userId: ben.id }],
      },
    });

    migrate(db.orm, { migrationsFolder: MIGRATIONS_DIR });

    const rows = all(
      'select owner_id, team_id, project_id, rules from agent_access order by owner_id, team_id',
    ).map((row) => ({
      ...row,
      rules: agentAccessRulesSchema.parse(JSON.parse(String(row.rules))),
    }));
    const everyone = [
      { type: 'everyone', scope: 'people' },
      { type: 'everyone', scope: 'agents' },
    ];
    expect(rows).toEqual(
      [
        {
          owner_id: ben.id,
          team_id: one.id,
          project_id: null,
          rules: { auto: { allow: everyone, deny: [] }, ask: { allow: [], deny: [] } },
        },
        {
          owner_id: ben.id,
          team_id: two.id,
          project_id: null,
          rules: { auto: { allow: everyone, deny: [] }, ask: { allow: [], deny: [] } },
        },
        {
          owner_id: cat.id,
          team_id: one.id,
          project_id: null,
          rules: {
            auto: {
              allow: [
                { type: 'user', userId: dan.id },
                { type: 'everyone', scope: 'agents' },
              ],
              deny: [{ type: 'user', userId: ben.id }],
            },
            // Every person may ask; every agent already starts it.
            ask: { allow: [{ type: 'everyone', scope: 'people' }], deny: [] },
          },
        },
      ].sort((a, b) => `${a.owner_id}${a.team_id}`.localeCompare(`${b.owner_id}${b.team_id}`)),
    );
    expect(all('select model_override, request_decision from agent_job')).toEqual([]);
  });
});
