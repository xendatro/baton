/** `npm run db:migrate`: applies pending migrations to DATA_DIR/baton.db and exits. */
import { loadDotEnv, parseEnv } from '../env';
import { dataPaths } from '../lib/paths';
import { openDatabase } from './index';
import { runMigrations } from './migrate';

loadDotEnv();
const env = parseEnv(process.env);
const db = openDatabase(dataPaths(env.dataDir).database);
try {
  runMigrations(db);
  console.log(`Migrations applied to ${db.file}`);
} finally {
  db.close();
}
