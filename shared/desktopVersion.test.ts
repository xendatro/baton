import { describe, expect, it } from 'vitest';
import type { DesktopUpdate } from './desktopBridge';
import { desktopVersionText } from './desktopVersion';

const update: DesktopUpdate = {
  status: 'idle',
  version: null,
  progress: null,
  error: null,
  manual: false,
};

describe('desktopVersionText', () => {
  it('shows the version and commit, and the newest release', () => {
    expect(
      desktopVersionText({
        version: '0.3.0',
        commit: 'abc1234',
        update: { ...update, status: 'available', version: '0.3.1', latest: '0.3.1' },
      }),
    ).toEqual({ installed: 'Baton desktop 0.3.0 (abc1234)', latest: 'Latest: 0.3.1' });
    expect(
      desktopVersionText({
        version: '0.3.1',
        commit: 'def5678',
        update: { ...update, status: 'latest', latest: '0.3.1' },
      }).latest,
    ).toBe('Up to date (latest 0.3.1)');
    expect(
      desktopVersionText({
        version: '0.3.0',
        update: { ...update, status: 'checking', latest: '0.3.1' },
      }).latest,
    ).toBe('Latest: 0.3.1');
  });

  it('works with older apps (no commit, no latest version, no updates)', () => {
    expect(desktopVersionText({ version: '0.2.0' })).toEqual({
      installed: 'Baton desktop 0.2.0',
      latest: null,
    });
    expect(
      desktopVersionText({ version: '0.3.0', update: { ...update, status: 'latest' } }),
    ).toEqual({ installed: 'Baton desktop 0.3.0', latest: 'Up to date' });
    expect(
      desktopVersionText({
        version: '0.3.0',
        update: { ...update, status: 'ready', version: '0.3.2' },
      }).latest,
    ).toBe('Latest: 0.3.2');
  });
});
