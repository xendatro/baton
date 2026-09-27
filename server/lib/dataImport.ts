import fs from 'node:fs';
import path from 'node:path';
import type { DataPaths } from './paths';

/**
 * Moving to a new host (docs/DEPLOY-RENDER.md): a snapshot of another server's data is copied into
 * `DATA_DIR/import/` (`baton.db`, and optionally `uploads/`) while this server runs, and swapped in
 * at the next start, before the database is opened — never under a running server. What it
 * replaces is kept in `DATA_DIR/replaced-<timestamp>/`. Returns that folder, or null when there was
 * nothing to import.
 */
export function importPendingData(paths: DataPaths, now: Date = new Date()): string | null {
  const incoming = path.join(paths.root, 'import');
  const database = path.join(incoming, 'baton.db');
  if (!fs.existsSync(database)) return null;

  const replaced = path.join(paths.root, `replaced-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(replaced, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${paths.database}${suffix}`;
    if (fs.existsSync(file)) fs.renameSync(file, path.join(replaced, path.basename(file)));
  }
  fs.renameSync(database, paths.database);

  const uploads = path.join(incoming, 'uploads');
  if (fs.existsSync(uploads)) {
    if (fs.existsSync(paths.uploads)) fs.renameSync(paths.uploads, path.join(replaced, 'uploads'));
    fs.renameSync(uploads, paths.uploads);
  }
  fs.rmSync(incoming, { recursive: true, force: true });
  return replaced;
}
