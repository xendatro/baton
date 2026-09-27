import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';
import type { DesktopUpdate } from '@shared/desktopBridge';

/**
 * Updates of the desktop app itself (the web app inside it updates with the server). Windows
 * (the installer) and Linux (the AppImage) download a new release from GitHub in the background
 * and install it on "Restart to update" or the next quit (electron-updater, reading the
 * `latest.yml` / `latest-linux.yml` the release workflow publishes). macOS builds aren't signed, and
 * macOS only lets signed apps replace themselves, so there the app checks the latest release and
 * offers its download instead. Checks run shortly after start and every few hours.
 */

const REPO = 'xendatro/baton';
const RELEASES = `https://github.com/${REPO}/releases`;
const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 4 * 60 * 60 * 1000;

/** `1.2.3` > `1.2.0`? (plain x.y.z versions, as the app uses) */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (value: string) =>
    value
      .replace(/^[^0-9]*/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** A release tag's version: `desktop-v0.3.1` → `0.3.1` ("" without a tag). */
export function releaseVersion(tag: string | undefined): string {
  return (tag ?? '')
    .trim()
    .replace(/^desktop-v/, '')
    .replace(/^v/, '');
}

/** Can this build replace itself? (packaged Windows installer, or a Linux AppImage) */
function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE);
  return false;
}

function downloadUrl(): string {
  const file =
    process.platform === 'darwin'
      ? 'Baton.dmg'
      : process.platform === 'win32'
        ? 'Baton-Setup.exe'
        : 'Baton.AppImage';
  return `${RELEASES}/latest/download/${file}`;
}

export class Updates {
  private current: DesktopUpdate = {
    status: 'idle',
    version: null,
    latest: null,
    progress: null,
    error: null,
    manual: !canSelfUpdate(),
  };
  private timer: NodeJS.Timeout | null = null;
  private wired = false;

  constructor(
    private readonly onChange: (update: DesktopUpdate) => void,
    /** Called right before the app quits to install (so closing to the tray doesn't stop it). */
    private readonly beforeInstall: () => void,
  ) {}

  get state(): DesktopUpdate {
    return this.current;
  }

  start(): void {
    if (!app.isPackaged) return;
    setTimeout(() => void this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check(), EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private set(patch: Partial<DesktopUpdate>): void {
    this.current = { ...this.current, ...patch };
    this.onChange(this.current);
  }

  async check(): Promise<DesktopUpdate> {
    if (!app.isPackaged) {
      this.set({ status: 'latest', error: null });
      return this.current;
    }
    // A downloaded update stays ready; don't start over.
    if (this.current.status === 'ready' || this.current.status === 'downloading') {
      return this.current;
    }
    this.set({ status: 'checking', error: null });
    try {
      if (canSelfUpdate()) await this.checkWithUpdater();
      else await this.checkReleases();
    } catch (cause) {
      this.set({
        status: 'error',
        error:
          cause instanceof Error
            ? (cause.message.split('\n')[0] ?? 'Update check failed')
            : String(cause),
      });
    }
    return this.current;
  }

  /** Windows / Linux: electron-updater downloads in the background. */
  private async checkWithUpdater(): Promise<void> {
    const { autoUpdater } = electronUpdater;
    if (!this.wired) {
      this.wired = true;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-available', (info) =>
        this.set({
          status: 'downloading',
          version: info.version,
          latest: info.version,
          progress: 0,
        }),
      );
      autoUpdater.on('update-not-available', (info) =>
        this.set({
          status: 'latest',
          version: null,
          latest: info.version || app.getVersion(),
          progress: null,
        }),
      );
      autoUpdater.on('download-progress', (progress) =>
        this.set({ status: 'downloading', progress: Math.round(progress.percent) }),
      );
      autoUpdater.on('update-downloaded', (info) =>
        this.set({ status: 'ready', version: info.version, latest: info.version, progress: 100 }),
      );
      autoUpdater.on('error', (error) =>
        this.set({ status: 'error', error: error.message.split('\n')[0] ?? 'Update failed' }),
      );
    }
    await autoUpdater.checkForUpdates();
  }

  /** macOS (and unpackaged Linux): compare with the latest GitHub release, offer its download. */
  private async checkReleases(): Promise<void> {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Baton-desktop' },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = (await response.json()) as { tag_name?: string };
    const version = releaseVersion(release.tag_name);
    if (version && isNewer(version, app.getVersion())) {
      this.set({ status: 'available', version, latest: version });
    } else {
      this.set({ status: 'latest', version: null, latest: version || app.getVersion() });
    }
  }

  /** Restart into the downloaded update, or open the new version's download. */
  install(): void {
    if (this.current.status === 'ready' && canSelfUpdate()) {
      this.beforeInstall();
      // Silent install on Windows, then relaunch.
      electronUpdater.autoUpdater.quitAndInstall(true, true);
      return;
    }
    if (this.current.status === 'available') void shell.openExternal(downloadUrl());
  }
}
