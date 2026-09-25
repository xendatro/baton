import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/** Escapes LIKE wildcards so user input matches literally (used with `escape '\'`). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Case-insensitive (ASCII) substring match. */
export function likeContains(column: SQLiteColumn, needle: string): SQL {
  return sql`${column} like ${`%${escapeLike(needle)}%`} escape '\\'`;
}

/** Case-insensitive (ASCII) prefix match. */
export function likePrefix(column: SQLiteColumn, prefix: string): SQL {
  return sql`${column} like ${`${escapeLike(prefix)}%`} escape '\\'`;
}
