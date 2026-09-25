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
