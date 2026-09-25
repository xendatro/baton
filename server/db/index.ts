import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LiveEvent } from '@shared/events';
import * as schema from './schema';

export { schema };

export type Schema = typeof schema;
export type Orm = BetterSQLite3Database<Schema>;
/** The transaction handle passed to `db.write` callbacks (same query API as `db.orm`). */
export type Tx = Parameters<Parameters<Orm['transaction']>[0]>[0];
/** Either the ORM or an open transaction — for helpers that work inside or outside `db.write`. */
export type DbExecutor = Orm | Tx;

/** Receives the live events queued by a transaction, once it has committed. */
export type CommittedEventsSink = (events: readonly LiveEvent[]) => void;

export interface Database {
  /** Typed Drizzle instance for reads (and single-statement writes that need no transaction). */
  orm: Orm;
  /** Raw better-sqlite3 handle (FTS5 queries, pragmas, backups). */
  sqlite: SqliteDatabase.Database;
  /**
   * Runs `fn` in a write transaction started with `BEGIN IMMEDIATE`, so the write lock is taken up
   * front and concurrent writers queue on `busy_timeout` instead of failing mid-transaction.
   * `fn` must be synchronous (better-sqlite3 rejects a returned promise). Throwing rolls back.
   * Live events queued inside `fn` with `queueLiveEvent(tx, …)` are delivered after the commit;
   * a rollback discards them.
   */
  write<T>(fn: (tx: Tx) => T): T;
  /** Absolute path of the database file, or `:memory:`. */
  file: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Where events queued with `queueLiveEvent` go after commit (the app's event bus). */
  onCommittedEvents?: CommittedEventsSink;
}

/** Events queued by each open `db.write` transaction, keyed by its transaction handle. */
const pendingEvents = new WeakMap<Tx, LiveEvent[]>();

/**
 * Queues a live event to be emitted once the surrounding `db.write` transaction commits (and
 * dropped if it rolls back). Must be called with the transaction handle `db.write` passed in.
 */
export function queueLiveEvent(tx: Tx, event: Omit<LiveEvent, 'at'>): void {
  const queue = pendingEvents.get(tx);
  if (!queue) throw new Error('queueLiveEvent must be called with the transaction of db.write');
  queue.push({ ...event, at: new Date().toISOString() });
}

/** Opens (creating if needed) the SQLite database at `file` with Baton's pragmas. */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): Database {
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
    write(fn) {
      const queued: LiveEvent[] = [];
      const result = orm.transaction(
        (tx) => {
          pendingEvents.set(tx, queued);
          try {
            return fn(tx);
          } finally {
            pendingEvents.delete(tx);
          }
        },
        { behavior: 'immediate' },
      );
      if (queued.length > 0) options.onCommittedEvents?.(queued);
      return result;
    },
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
