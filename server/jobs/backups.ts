import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { BACKUP_RETENTION_COUNT } from '@shared/constants';
import type { AppDeps } from '../context';
import { dataPaths, ensureDataDirs } from '../lib/paths';
import type { JobDefinition } from './types';

const BACKUP_FILE_PATTERN = /^baton-\d{8}\.db$/;

/** Snapshots the deploy script writes before migrating (`backups/pre-deploy/baton-<id>.db`). */
const PRE_DEPLOY_DIR = 'pre-deploy';

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

/**
 * Relative paths (with forward slashes, like `attachment.storage_path`) of every file under `dir`.
 */
function listFiles(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(path.join(dir, entry.name), relative);
    return entry.isFile() ? [relative] : [];
  });
}

/** Removes the empty folders under `dir` (not `dir` itself). */
function removeEmptyFolders(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    removeEmptyFolders(folder);
    if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
  }
}

/** The files a snapshot's attachments point to; null when the snapshot can't be read. */
function snapshotStoragePaths(file: string): string[] | null {
  let snapshot: SqliteDatabase.Database | undefined;
  try {
    snapshot = new SqliteDatabase(file, { readonly: true, fileMustExist: true });
    return snapshot.prepare('SELECT storage_path FROM attachment').pluck().all() as string[];
  } catch {
    return null;
  } finally {
    snapshot?.close();
  }
}

/** Database snapshots a restore can start from: the daily ones and the pre-deploy ones. */
function retainedSnapshots(backupsDir: string): string[] {
  const daily = fs
    .readdirSync(backupsDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .map((name) => path.join(backupsDir, name));
  const preDeployDir = path.join(backupsDir, PRE_DEPLOY_DIR);
  const preDeploy = fs.existsSync(preDeployDir)
    ? fs
        .readdirSync(preDeployDir)
        .filter((name) => name.endsWith('.db'))
        .map((name) => path.join(preDeployDir, name))
    : [];
  return [...daily, ...preDeploy];
}

export type MirrorPruneResult =
  | { removedFiles: number }
  /** Nothing was removed, because a snapshot could not be read to learn which files it needs. */
  | { skipped: string };

/**
 * Deletes mirrored upload files that no restore can need any more: gone from `uploads/` (purged
 * from Trash, replaced or removed avatars, deleted accounts' files) and referenced by no retained
 * snapshot. So the mirror follows the snapshots' 14-day retention instead of growing forever.
 * When a snapshot can't be read, nothing is removed.
 */
function pruneMirror(paths: ReturnType<typeof dataPaths>): MirrorPruneResult {
  const keep = new Set(listFiles(paths.uploads));
  for (const snapshot of retainedSnapshots(paths.backups)) {
    const storagePaths = snapshotStoragePaths(snapshot);
    if (storagePaths === null) return { skipped: `unreadable snapshot ${path.basename(snapshot)}` };
    for (const storagePath of storagePaths) keep.add(storagePath);
  }
  let removedFiles = 0;
  for (const relative of listFiles(paths.backupUploads)) {
    if (keep.has(relative)) continue;
    fs.rmSync(path.join(paths.backupUploads, ...relative.split('/')), { force: true });
    removedFiles += 1;
  }
  if (fs.existsSync(paths.backupUploads)) removeEmptyFolders(paths.backupUploads);
  return { removedFiles };
}

export interface BackupResult {
  file: string;
  removed: string[];
  mirroredFiles: number;
  /** Mirrored files deleted because no retained snapshot needs them (see `pruneMirror`). */
  pruned: MirrorPruneResult;
}

/**
 * Snapshots the database with `VACUUM INTO DATA_DIR/backups/baton-YYYYMMDD.db` (replacing a
 * snapshot from earlier the same day), keeps the newest 14 snapshots, mirrors upload files that
 * are not yet in `backups/uploads/` and deletes mirrored files that no retained snapshot (daily or
 * pre-deploy) references and `uploads/` no longer has. Restore: stop the service, copy a snapshot
 * to baton.db and copy the missing files back from `backups/uploads/`.
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
  const pruned = pruneMirror(paths);
  return { file, removed, mirroredFiles, pruned };
}

export const backupJobs: JobDefinition[] = [
  {
    name: 'backup',
    schedule: '30 3 * * *',
    run(deps) {
      const result = runBackup(deps);
      if ('skipped' in result.pruned) {
        deps.logger.warn(
          result,
          'backup written; old upload files were kept (snapshot unreadable)',
        );
      } else {
        deps.logger.info(result, 'backup written');
      }
    },
  },
];
