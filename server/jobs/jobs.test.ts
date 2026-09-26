import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_RETENTION_COUNT } from '@shared/constants';
import { dataPaths } from '../lib/paths';
import { createTestContext, createUser, type TestContext } from '../test/helpers';
import { runBackup } from './backups';
import { allJobs, startJobs } from './index';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('runBackup', () => {
  it('writes a readable VACUUM INTO snapshot named by date', () => {
    const user = createUser(ctx.db);
    const { file } = runBackup(ctx.deps, new Date(2026, 8, 24, 3, 30));
    expect(path.basename(file)).toBe('baton-20260924.db');
    const snapshot = new SqliteDatabase(file, { readonly: true });
    try {
      expect(snapshot.prepare('select id from user').all()).toEqual([{ id: user.id }]);
    } finally {
      snapshot.close();
    }
  });

  it('replaces a same-day snapshot and keeps only the newest snapshots', () => {
    const { backups } = dataPaths(ctx.dataDir);
    for (let day = 1; day <= BACKUP_RETENTION_COUNT + 2; day += 1) {
      fs.writeFileSync(path.join(backups, `baton-202601${String(day).padStart(2, '0')}.db`), 'old');
    }
    fs.writeFileSync(path.join(backups, 'notes.txt'), 'keep me');

    const result = runBackup(ctx.deps, new Date(2026, 1, 1));
    runBackup(ctx.deps, new Date(2026, 1, 1)); // same day again: replaced, not failing

    const snapshots = fs.readdirSync(backups).filter((name) => name.endsWith('.db'));
    expect(snapshots).toHaveLength(BACKUP_RETENTION_COUNT);
    expect(snapshots).toContain('baton-20260201.db');
    expect(snapshots).not.toContain('baton-20260101.db');
    expect(result.removed).toContain('baton-20260101.db');
    expect(fs.existsSync(path.join(backups, 'notes.txt'))).toBe(true);
  });

  it('mirrors upload files that are not yet backed up', () => {
    const { uploads, backupUploads } = dataPaths(ctx.dataDir);
    fs.mkdirSync(path.join(uploads, 'ab'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'ab', 'file1'), 'one');
    expect(runBackup(ctx.deps).mirroredFiles).toBe(1);
    fs.writeFileSync(path.join(uploads, 'ab', 'file2'), 'two');
    expect(runBackup(ctx.deps).mirroredFiles).toBe(1);
    expect(fs.readFileSync(path.join(backupUploads, 'ab', 'file2'), 'utf8')).toBe('two');
  });

  describe('pruning the uploads mirror (OPS-01)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const start = new Date(2026, 8, 1, 3, 30);
    const dayAfter = (days: number) => new Date(start.getTime() + days * DAY);

    /** A stored file and its attachment row, like an upload. */
    function storeFile(storagePath: string) {
      const { uploads } = dataPaths(ctx.dataDir);
      const file = path.join(uploads, ...storagePath.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, storagePath);
      const user = createUser(ctx.db);
      const id = storagePath.split('/').at(-1) ?? storagePath;
      ctx.db.sqlite
        .prepare(
          `INSERT INTO attachment (id, team_id, uploader_id, parent_type, filename, mime_type, size,
             sha256, storage_path, created_at)
           VALUES (?, NULL, ?, 'user_avatar', 'a.png', 'image/png', 1, 'x', ?, ?)`,
        )
        .run(id, user.id, storagePath, Date.now());
      return id;
    }

    /** What the app does when a file goes for good (avatar replaced, Trash purged). */
    function deleteFile(id: string, storagePath: string) {
      ctx.db.sqlite.prepare('DELETE FROM attachment WHERE id = ?').run(id);
      fs.rmSync(path.join(dataPaths(ctx.dataDir).uploads, ...storagePath.split('/')));
    }

    const mirrored = (storagePath: string) =>
      fs.existsSync(path.join(dataPaths(ctx.dataDir).backupUploads, ...storagePath.split('/')));

    it('drops a deleted file once no retained snapshot references it', () => {
      const avatar = '2026/09/01AVATAR';
      const id = storeFile(avatar);
      expect(runBackup(ctx.deps, start).mirroredFiles).toBe(1);
      deleteFile(id, avatar);

      // Still needed: the snapshot of day 0 references it.
      for (let day = 1; day < BACKUP_RETENTION_COUNT; day += 1) {
        expect(runBackup(ctx.deps, dayAfter(day)).pruned).toEqual({ removedFiles: 0 });
        expect(mirrored(avatar)).toBe(true);
      }
      // Day 0's snapshot leaves the 14 kept: the file goes too, with its empty folders.
      const result = runBackup(ctx.deps, dayAfter(BACKUP_RETENTION_COUNT));
      expect(result.removed).toEqual(['baton-20260901.db']);
      expect(result.pruned).toEqual({ removedFiles: 1 });
      expect(mirrored(avatar)).toBe(false);
      expect(fs.readdirSync(dataPaths(ctx.dataDir).backupUploads)).toEqual([]);
    });

    it('keeps files that uploads/ still has or a pre-deploy snapshot references', () => {
      const pending = '2026/09/01PENDING';
      const released = '2026/09/01RELEASED';
      storeFile(pending);
      const releasedId = storeFile(released);
      runBackup(ctx.deps, start);
      const preDeploy = path.join(dataPaths(ctx.dataDir).backups, 'pre-deploy');
      fs.mkdirSync(preDeploy, { recursive: true });
      ctx.db.sqlite.prepare('VACUUM INTO ?').run(path.join(preDeploy, 'baton-release1.db'));
      deleteFile(releasedId, released);
      // Only the attachment row goes: the file stays in uploads/ (e.g. before a purge).
      ctx.db.sqlite.prepare('DELETE FROM attachment WHERE storage_path = ?').run(pending);

      for (let day = 1; day <= BACKUP_RETENTION_COUNT + 1; day += 1)
        runBackup(ctx.deps, dayAfter(day));
      expect(mirrored(pending)).toBe(true);
      expect(mirrored(released)).toBe(true);

      fs.rmSync(preDeploy, { recursive: true });
      expect(runBackup(ctx.deps, dayAfter(BACKUP_RETENTION_COUNT + 2)).pruned).toEqual({
        removedFiles: 1,
      });
      expect(mirrored(released)).toBe(false);
      expect(mirrored(pending)).toBe(true);
    });

    it('removes nothing when a snapshot cannot be read', () => {
      const stray = path.join(dataPaths(ctx.dataDir).backupUploads, 'old', 'file');
      fs.mkdirSync(path.dirname(stray), { recursive: true });
      fs.writeFileSync(stray, 'x');
      fs.writeFileSync(path.join(dataPaths(ctx.dataDir).backups, 'baton-20260101.db'), 'garbage');
      expect(runBackup(ctx.deps, start).pruned).toEqual({
        skipped: 'unreadable snapshot baton-20260101.db',
      });
      expect(fs.existsSync(stray)).toBe(true);
    });
  });
});

describe('job registry', () => {
  it('has unique job names with valid schedules and stops cleanly', () => {
    const names = allJobs.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('backup');
    const scheduler = startJobs(ctx.deps);
    scheduler.stop();
  });
});
