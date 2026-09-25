import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export { schema };

export type Schema = typeof schema;
export type Orm = BetterSQLite3Database<Schema>;
/** The transaction handle passed to `db.write` callbacks (same query API as `db.orm`). */
export type Tx = Parameters<Parameters<Orm['transaction']>[0]>[0];
/** Either the ORM or an open transaction — for helpers that work inside or outside `db.write`. */
export type DbExecutor = Orm | Tx;

export interface Database {
  /** Typed Drizzle instance for reads (and single-statement writes that need no transaction). */
  orm: Orm;
  /** Raw better-sqlite3 handle (FTS5 queries, pragmas, backups). */
  sqlite: SqliteDatabase.Database;
  /**
   * Runs `fn` in a write transaction started with `BEGIN IMMEDIATE`, so the write lock is taken up
   * front and concurrent writers queue on `busy_timeout` instead of failing mid-transaction.
   * `fn` must be synchronous (better-sqlite3 rejects a returned promise). Throwing rolls back.
   * Emit live events only after `write` returns, i.e. after commit.
   */
  write<T>(fn: (tx: Tx) => T): T;
  /** Absolute path of the database file, or `:memory:`. */
  file: string;
  close(): void;
}

/** Opens (creating if needed) the SQLite database at `file` with Baton's pragmas. */
export function openDatabase(file: string): Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new SqliteDatabase(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  const orm = drizzle({ client: sqlite, schema });

  return {
    orm,
    sqlite,
    file,
    write: (fn) => orm.transaction(fn, { behavior: 'immediate' }),
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
