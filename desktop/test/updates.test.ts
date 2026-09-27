import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.3.0' }, shell: {} }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }));

const { isNewer } = await import('../src/main/updates');

describe('isNewer', () => {
  it('compares x.y.z versions, ignoring a tag prefix', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true);
    expect(isNewer('desktop-v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.2.9', '0.3.0')).toBe(false);
  });
});
