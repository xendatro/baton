import fs from 'node:fs';
import path from 'node:path';

export interface DataPaths {
  root: string;
  /** SQLite database file. */
  database: string;
  /** Attachment files; `attachment.storage_path` is relative to this folder. */
  uploads: string;
  /** Daily `VACUUM INTO` snapshots. */
  backups: string;
  /** Mirror of `uploads` kept alongside the database snapshots. */
  backupUploads: string;
}

/** Layout of DATA_DIR. */
export function dataPaths(dataDir: string): DataPaths {
  const root = path.resolve(dataDir);
  const backups = path.join(root, 'backups');
  return {
    root,
    database: path.join(root, 'baton.db'),
    uploads: path.join(root, 'uploads'),
    backups,
    backupUploads: path.join(backups, 'uploads'),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.uploads, paths.backups, paths.backupUploads]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
