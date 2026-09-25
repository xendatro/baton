import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_RETENTION_COUNT } from '@shared/constants';
import type { AppDeps } from '../context';
import { dataPaths, ensureDataDirs } from '../lib/paths';
import type { JobDefinition } from './types';

const BACKUP_FILE_PATTERN = /^baton-\d{8}\.db$/;

function backupFileName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `baton-${y}${m}${d}.db`;
}

/** Copies files present in `from` but missing in `to` (recursively). Returns how many were copied. */
function mirrorNewFiles(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copied += mirrorNewFiles(source, target);
    } else if (entry.isFile() && !fs.existsSync(target)) {
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      copied += 1;
    }
  }
  return copied;
}

export interface BackupResult {
  file: string;
  removed: string[];
  mirroredFiles: number;
}

/**
 * Snapshots the database with `VACUUM INTO DATA_DIR/backups/baton-YYYYMMDD.db` (replacing a
 * snapshot from earlier the same day), keeps the newest 14 snapshots and mirrors upload files that
 * are not yet in `backups/uploads/`. Restore: stop the service and copy a snapshot to baton.db.
 */
export function runBackup(deps: Pick<AppDeps, 'env' | 'db'>, now: Date = new Date()): BackupResult {
  const paths = dataPaths(deps.env.dataDir);
  ensureDataDirs(paths);

  const file = path.join(paths.backups, backupFileName(now));
  fs.rmSync(file, { force: true });
  deps.db.sqlite.prepare('VACUUM INTO ?').run(file);

  const snapshots = fs
    .readdirSync(paths.backups)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort()
    .reverse();
  const removed = snapshots.slice(BACKUP_RETENTION_COUNT);
  for (const name of removed) fs.rmSync(path.join(paths.backups, name), { force: true });

  const mirroredFiles = mirrorNewFiles(paths.uploads, paths.backupUploads);
  return { file, removed, mirroredFiles };
}

export const backupJobs: JobDefinition[] = [
  {
    name: 'backup',
    schedule: '30 3 * * *',
    run(deps) {
      const result = runBackup(deps);
      deps.logger.info(result, 'backup written');
    },
  },
];
