import fs from 'node:fs';
import path from 'node:path';
import { PENDING_UPLOAD_TTL_HOURS } from '@shared/constants';
import type { AppDeps } from '../context';
import { dataPaths } from '../lib/paths';
import { removeAttachmentFiles } from '../services/attachments';
import {
  purgeExpiredAuthRows,
  purgePendingUploads,
  purgeTrash,
  referencedStoragePaths,
} from '../services/trash';
import type { JobDefinition } from './types';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Upload files are written before their row is inserted, so a file younger than this may belong
 * to an upload still in flight and is never treated as orphaned.
 */
const ORPHAN_GRACE_MS = HOUR_MS;

/** Relative (forward-slash) paths of every file under `root`, with modification times. */
function listFiles(root: string, prefix = ''): Array<{ storagePath: string; mtimeMs: number }> {
  if (!fs.existsSync(root)) return [];
  const files: Array<{ storagePath: string; mtimeMs: number }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(full, relative));
    else if (entry.isFile())
      files.push({ storagePath: relative, mtimeMs: fs.statSync(full).mtimeMs });
  }
  return files;
}

/** Deletes upload files no attachment row references (after the grace period). */
export function removeOrphanedFiles(
  deps: Pick<AppDeps, 'env' | 'db'>,
  now: Date = new Date(),
): number {
  const candidates = listFiles(dataPaths(deps.env.dataDir).uploads).filter(
    (file) => now.getTime() - file.mtimeMs > ORPHAN_GRACE_MS,
  );
  const referenced = referencedStoragePaths(
    deps.db.orm,
    candidates.map((file) => file.storagePath),
  );
  const orphans = candidates
    .map((file) => file.storagePath)
    .filter((storagePath) => !referenced.has(storagePath));
  removeAttachmentFiles(deps.env.dataDir, orphans);
  return orphans.length;
}

/** Trash older than 30 days (rows, then files) and upload files nothing references. */
export function runTrashPurge(deps: Pick<AppDeps, 'env' | 'db'>, now: Date = new Date()) {
  const result = purgeTrash(deps, now);
  removeAttachmentFiles(deps.env.dataDir, result.storagePaths);
  const orphanedFiles = removeOrphanedFiles(deps, now);
  return { purged: result.purged, files: result.storagePaths.length, orphanedFiles };
}

/** Pending uploads nobody attached within 24 hours. */
export function runPendingUploadPurge(deps: Pick<AppDeps, 'env' | 'db'>, now: Date = new Date()) {
  const result = purgePendingUploads(
    deps,
    new Date(now.getTime() - PENDING_UPLOAD_TTL_HOURS * HOUR_MS),
  );
  removeAttachmentFiles(deps.env.dataDir, result.storagePaths);
  return { count: result.count };
}

/**
 * Purge jobs (owner: core module): trash older than 30 days and orphaned files (daily 03:15),
 * pending uploads older than 24 h (hourly), expired sessions and verifications (daily 04:00).
 */
export const purgeJobs: JobDefinition[] = [
  {
    name: 'purge-trash',
    schedule: '15 3 * * *',
    run(deps) {
      deps.logger.info(runTrashPurge(deps), 'trash purged');
    },
  },
  {
    name: 'purge-pending-uploads',
    schedule: '5 * * * *',
    run(deps) {
      const result = runPendingUploadPurge(deps);
      if (result.count > 0) deps.logger.info(result, 'pending uploads purged');
    },
  },
  {
    name: 'purge-expired-auth',
    schedule: '0 4 * * *',
    run(deps) {
      deps.logger.info(purgeExpiredAuthRows(deps), 'expired sessions and codes purged');
    },
  },
];
