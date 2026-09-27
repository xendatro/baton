import type { DesktopState } from './desktopBridge';

/**
 * "Baton desktop 0.3.0 (abc1234)" and "Latest: 0.3.1" / "Up to date (latest 0.3.0)" (BAT-31):
 * which build of the desktop app runs here, and the newest release. Shown in the web app's
 * sidebar, on Running agents and in the tray. Older apps send no commit or latest version.
 */
export function desktopVersionText(state: Pick<DesktopState, 'version' | 'commit' | 'update'>): {
  installed: string;
  latest: string | null;
} {
  const commit = state.commit?.trim();
  const installed = `Baton desktop ${state.version}${commit ? ` (${commit})` : ''}`;
  const update = state.update;
  if (!update) return { installed, latest: null };
  const latestVersion = update.latest ?? null;
  if (
    update.status === 'available' ||
    update.status === 'downloading' ||
    update.status === 'ready'
  ) {
    const newest = update.version ?? latestVersion;
    return { installed, latest: newest ? `Latest: ${newest}` : null };
  }
  if (update.status === 'latest') {
    return {
      installed,
      latest: latestVersion ? `Up to date (latest ${latestVersion})` : 'Up to date',
    };
  }
  return { installed, latest: latestVersion ? `Latest: ${latestVersion}` : null };
}
