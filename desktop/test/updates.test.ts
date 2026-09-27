import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.3.0' }, shell: {} }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }));

const { isNewer, releaseVersion } = await import('../src/main/updates');
const { COMMIT } = await import('../src/main/buildInfo');

describe('releaseVersion', () => {
  it('reads the version from a release tag', () => {
    expect(releaseVersion('desktop-v0.3.1')).toBe('0.3.1');
    expect(releaseVersion('v1.0.0')).toBe('1.0.0');
    expect(releaseVersion(undefined)).toBe('');
  });
});

describe('COMMIT', () => {
  it('is "dev" outside a build (build.mjs bakes in the git commit)', () => {
    expect(COMMIT).toBe('dev');
  });
});

describe('isNewer', () => {
  it('compares x.y.z versions, ignoring a tag prefix', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true);
    expect(isNewer('desktop-v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.2.9', '0.3.0')).toBe(false);
  });
});
