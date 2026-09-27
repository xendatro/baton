import type { HarnessId } from './schemas/agentRunner';

/**
 * The bridge between the Baton web app and the desktop app it runs inside (BAT-26): the Electron
 * window loads the real web app, and its preload script exposes `window.batonDesktop` (only to
 * the configured Baton server's origin). The web app shows its Desktop pages when it exists.
 * Types only: no Node or DOM code here.
 */

export type DesktopRunnerStatus = 'stopped' | 'connecting' | 'online' | 'paused' | 'offline';

export interface DesktopJob {
  jobId: string;
  ref: string | null;
  title: string | null;
  url: string | null;
  project: string | null;
  kind: string;
  harness: HarnessId | null;
  model: string;
  startedAt: number;
  /** starting | running | blocked (on an Allow / Deny prompt) | waiting-usage | finishing. */
  state: string;
  note: string | null;
  output: string[];
}

export interface DesktopFolder {
  /** Absolute path, or null for the app's scratch folder of the project. */
  path: string | null;
  label: string;
}

export interface DesktopState {
  version: string;
  /** The agent key is set: this computer runs the owner's agent's jobs. */
  connected: boolean;
  machineName: string;
  pausedHere: boolean;
  folders: Record<string, DesktopFolder>;
  /** Harnesses whose test run succeeded here (optional: older apps). */
  testedHarnesses?: string[];
  /** Updates of the app itself (optional: apps before 0.3.0 can't update themselves). */
  update?: DesktopUpdate;
  permissionModes: Partial<Record<HarnessId, string>>;
  runner: {
    status: DesktopRunnerStatus;
    statusText: string | null;
    runnerId: string | null;
    waitingCount: number;
    jobs: DesktopJob[];
  } | null;
}

export interface DesktopHarness {
  id: HarnessId;
  label: string;
  headless: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  models: string[];
  modes: Array<{ id: string; label: string; description: string; unattended: boolean }>;
  /** The permission mode chosen on this computer. */
  mode: string | null;
}

export type DesktopRepoCheck =
  | { state: 'match'; remote: string }
  | { state: 'mismatch'; remote: string; expected: string }
  | { state: 'not-a-repo' }
  | { state: 'no-repo-url' };

export interface DesktopTestResult {
  ok: boolean;
  outcome: string;
  output: string;
}

/** `window.batonDesktop`. */
/**
 * An update of the desktop app. `manual`: this build can't replace itself (macOS, unsigned), so an
 * available update is downloaded from the browser instead of installed in place.
 */
export interface DesktopUpdate {
  status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';
  /** The new version, when there is one. */
  version: string | null;
  /** Download progress in percent while `downloading`. */
  progress: number | null;
  error: string | null;
  manual: boolean;
}

export interface BatonDesktopBridge {
  state(): Promise<DesktopState>;
  /** Runs the agent's jobs on this computer with this API key (created by the web app). */
  connect(apiKey: string): Promise<DesktopState>;
  disconnect(): Promise<DesktopState>;
  harnesses(): Promise<DesktopHarness[]>;
  /** Opens a folder picker; null when cancelled. */
  pickFolder(
    projectId: string,
    label: string,
    repoUrl: string | null,
  ): Promise<DesktopRepoCheck | null>;
  /** "No folder": jobs run in a scratch folder the app creates. */
  useScratch(projectId: string, label: string): Promise<DesktopState>;
  unmap(projectId: string): Promise<DesktopState>;
  checkRepo(projectId: string, repoUrl: string | null): Promise<DesktopRepoCheck | null>;
  setPermissionMode(harness: HarnessId, mode: string): Promise<DesktopState>;
  testRun(harness: HarnessId): Promise<DesktopTestResult>;
  kill(jobId: string): Promise<void>;
  pauseHere(paused: boolean): Promise<DesktopState>;
  setMachineName(name: string): Promise<DesktopState>;
  onState(listener: (state: DesktopState) => void): () => void;
  onOutput(listener: (event: { jobId: string; text: string }) => void): () => void;
  /** Checks for a new version of the app now (optional: apps before 0.3.0). */
  checkForUpdates?(): Promise<DesktopUpdate>;
  /** Restarts into the downloaded update, or opens the new version's download (manual). */
  installUpdate?(): Promise<void>;
}
