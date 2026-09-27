import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importPendingData } from './dataImport';
import { dataPaths, ensureDataDirs, type DataPaths } from './paths';

let root: string;
let paths: DataPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-import-'));
  paths = dataPaths(root);
  ensureDataDirs(paths);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('importPendingData', () => {
  it('does nothing without DATA_DIR/import/baton.db', () => {
    fs.writeFileSync(paths.database, 'current');
    expect(importPendingData(paths)).toBeNull();
    expect(fs.readFileSync(paths.database, 'utf8')).toBe('current');
  });

  it('swaps in the imported database and uploads, keeping what it replaced', () => {
    fs.writeFileSync(paths.database, 'fresh');
    fs.writeFileSync(`${paths.database}-wal`, 'wal');
    fs.writeFileSync(path.join(paths.uploads, 'old.png'), 'old');
    const incoming = path.join(root, 'import');
    fs.mkdirSync(path.join(incoming, 'uploads', 'team'), { recursive: true });
    fs.writeFileSync(path.join(incoming, 'baton.db'), 'from mini');
    fs.writeFileSync(path.join(incoming, 'uploads', 'team', 'a.png'), 'a');

    const replaced = importPendingData(paths, new Date('2026-09-27T12:00:00Z'));
    expect(replaced).toBe(path.join(root, 'replaced-2026-09-27T12-00-00-000Z'));
    expect(fs.readFileSync(paths.database, 'utf8')).toBe('from mini');
    expect(fs.existsSync(`${paths.database}-wal`)).toBe(false);
    expect(fs.readFileSync(path.join(paths.uploads, 'team', 'a.png'), 'utf8')).toBe('a');
    expect(fs.readFileSync(path.join(replaced ?? '', 'baton.db'), 'utf8')).toBe('fresh');
    expect(fs.readFileSync(path.join(replaced ?? '', 'uploads', 'old.png'), 'utf8')).toBe('old');
    expect(fs.existsSync(incoming)).toBe(false);
  });
});
