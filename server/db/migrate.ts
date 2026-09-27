import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { backfillAgents } from '../services/agents';
import type { Database } from './index';

/**
 * SQL migrations folder. In development and tests this is server/db/migrations; the production
 * bundle (dist/server/index.js) resolves it next to itself, where the build copies the folder.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Applies pending migrations, then the data backfills that need application code: every person
 * gets their agent member (`backfillAgents`, which a SQL migration can't do because agent ids are
 * ULIDs and new agents join their owner's teams). Idempotent; runs at server startup and via
 * `npm run db:migrate`.
 */
export function runMigrations(db: Database, migrationsFolder: string = MIGRATIONS_DIR): void {
  migrate(db.orm, { migrationsFolder });
  backfillAgents(db);
}
