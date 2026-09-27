/**
 * Where the Baton desktop app is downloaded (BAT-24): the latest GitHub release of the repository,
 * built by .github/workflows/desktop-release.yml with fixed file names.
 */

const RELEASES = 'https://github.com/xendatro/baton/releases';

export type DesktopPlatform = 'windows' | 'mac' | 'linux';

export const DESKTOP_DOWNLOADS: Record<
  DesktopPlatform,
  { label: string; file: string; url: string; note: string }
> = {
  windows: {
    label: 'Windows',
    file: 'Baton-Setup.exe',
    url: `${RELEASES}/latest/download/Baton-Setup.exe`,
    note: 'Not code-signed yet: if SmartScreen warns, choose More info → Run anyway.',
  },
  mac: {
    label: 'macOS',
    file: 'Baton.dmg',
    url: `${RELEASES}/latest/download/Baton.dmg`,
    note: 'Not signed yet: the first time, right-click Baton in Applications and choose Open.',
  },
  linux: {
    label: 'Linux',
    file: 'Baton.AppImage',
    url: `${RELEASES}/latest/download/Baton.AppImage`,
    note: 'Make it executable (chmod +x Baton.AppImage), then run it.',
  },
};

export const DESKTOP_RELEASES_URL = `${RELEASES}/latest`;

/** The visitor's platform, from the browser. */
export function detectPlatform(userAgent: string = navigator.userAgent): DesktopPlatform {
  if (/windows/i.test(userAgent)) return 'windows';
  if (/mac os|macintosh/i.test(userAgent)) return 'mac';
  return 'linux';
}
