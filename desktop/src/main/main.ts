import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import type { DesktopState } from '@shared/desktopBridge';
import { desktopVersionText } from '@shared/desktopVersion';
import type { HarnessId } from '@shared/schemas/agentRunner';
import { BatonApi } from './api';
import { COMMIT } from './buildInfo';
import { ConfigStore, type SecretBox } from './config';
import { checkRepo } from './git';
import { createAdapters } from './harness';
import { isAllowedSender, navigationTarget, originOf } from './origin';
import { describeToolCall, PermissionServer } from './permissions';
import { Runner, type RunnerStore } from './runner';
import { Updates } from './updates';

/**
 * The Baton desktop app's main process (BAT-24, BAT-26). The window shows the real Baton web app
 * (you sign in as on the website, every feature is there), in a persistent session. The web
 * app's Desktop pages talk to this process through `window.batonDesktop` (preload.ts), only from
 * the Baton server's origin. Here: the runner (your agent's jobs, in your harness), the tray,
 * Allow / Deny pop-ups for Claude Code's permission prompts, and an offline page.
 */

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let runner: Runner | null = null;
let api: BatonApi | null = null;
let permissions: PermissionServer | null = null;
let quitting = false;
const adapters = createAdapters();
/** Versions already announced with a system notification (once each). */
const announced = new Set<string>();
const updates = new Updates(
  (update) => {
    broadcast();
    const key = `${update.status}:${update.version ?? ''}`;
    if ((update.status === 'ready' || update.status === 'available') && !announced.has(key)) {
      announced.add(key);
      if (Notification.isSupported()) {
        const notice = new Notification({
          title: `Baton ${update.version ?? ''} is available`,
          body:
            update.status === 'ready'
              ? 'Restart Baton to update (it also updates the next time you quit).'
              : 'Click to download the new version.',
        });
        notice.on('click', () => {
          if (update.status === 'available') updates.install();
          else showWindow();
        });
        notice.show();
      }
    }
  },
  () => {
    quitting = true;
    runner?.stop();
    permissions?.stop();
  },
);

const secrets: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
};

let config: ConfigStore;
const scratchRoot = () => path.join(app.getPath('userData'), 'scratch');
const serverUrl = () => config.get().serverUrl;

function store(): RunnerStore {
  return {
    machineId: () => config.get().machineId,
    machineName: () => config.get().machineName,
    projectIds: () => Object.keys(config.get().folders),
    folderFor: (projectId) => config.folderFor(projectId, scratchRoot()),
    permissionMode: (harness, adapter) =>
      config.get().permissionModes[harness] ?? adapter.permissionModes[0]?.id ?? 'default',
    exhaustedUntil: () => config.get().exhaustedUntil,
    setExhausted: (harness, until) =>
      config.update({ exhaustedUntil: { ...config.get().exhaustedUntil, [harness]: until } }),
    pausedHere: () => config.get().pausedHere,
  };
}

function state(): DesktopState {
  const cfg = config.get();
  return {
    version: app.getVersion(),
    commit: COMMIT,
    connected: api !== null,
    machineName: cfg.machineName,
    pausedHere: cfg.pausedHere,
    folders: cfg.folders,
    permissionModes: cfg.permissionModes,
    testedHarnesses: cfg.testedHarnesses ?? [],
    update: updates.state,
    runner: runner?.snapshot() ?? null,
  };
}

function updateMenuItem(): Electron.MenuItemConstructorOptions {
  const update = updates.state;
  if (update.status === 'ready') {
    return {
      label: `Restart to update to ${update.version ?? 'the new version'}`,
      click: () => updates.install(),
    };
  }
  if (update.status === 'available') {
    return { label: `Download Baton ${update.version ?? ''}`, click: () => updates.install() };
  }
  if (update.status === 'downloading') {
    return { label: `Downloading update… ${update.progress ?? 0}%`, enabled: false };
  }
  return {
    label: update.status === 'checking' ? 'Checking for updates…' : 'Check for updates',
    enabled: update.status !== 'checking',
    click: () => void updates.check(),
  };
}

/** "Baton desktop 0.3.0 (abc1234) · Latest: 0.3.1" in the tray menu (BAT-31). */
function versionLabel(): string {
  const { installed, latest } = desktopVersionText({
    version: app.getVersion(),
    commit: COMMIT,
    update: updates.state,
  });
  return latest ? `${installed} · ${latest}` : installed;
}

function broadcast() {
  window?.webContents.send('desktop:state', state());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const snapshot = runner?.snapshot();
  const running = snapshot?.jobs.length ?? 0;
  const status = snapshot?.status ?? 'stopped';
  const label = !api
    ? 'Not set up: open Baton → Desktop'
    : status === 'online'
      ? running > 0
        ? `Online — ${running} running`
        : 'Online — waiting for jobs'
      : status === 'paused'
        ? 'Paused'
        : status === 'offline'
          ? 'Offline'
          : 'Starting';
  tray.setToolTip(`Baton: ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      {
        label: config.get().pausedHere ? 'Resume on this computer' : 'Pause on this computer',
        click: () => setPausedHere(!config.get().pausedHere),
      },
      { label: 'Open Baton', click: () => showWindow() },
      {
        label: 'Running agents',
        click: () => showWindow(`${serverUrl().replace(/\/+$/, '')}/desktop`),
      },
      { type: 'separator' },
      { label: versionLabel(), enabled: false },
      updateMenuItem(),
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function setPausedHere(paused: boolean) {
  config.update({ pausedHere: paused });
  broadcast();
}

function showOffline(error: string | null) {
  const query = new URLSearchParams({ server: serverUrl(), ...(error ? { error } : {}) });
  void window?.loadFile(path.join(__dirname, 'offline.html'), { search: query.toString() });
}

function load(url = serverUrl()) {
  void window?.loadURL(url).catch(() => undefined);
}

/** `baton-desktop://retry` and `baton-desktop://server?url=` from the offline page. */
function handleAppLink(url: string) {
  const link = new URL(url);
  if (link.hostname === 'server') {
    const next = originOf(link.searchParams.get('url'));
    if (next && next !== originOf(serverUrl())) {
      // Another server: another account, so this computer needs setting up again there.
      config.update({ serverUrl: next });
      config.setApiKey(null);
      void connect();
      // The preload reads the server from the window's arguments: open a fresh window.
      const old = window;
      window = null;
      showWindow();
      old?.destroy();
      return;
    }
  }
  load();
}

function showWindow(url?: string) {
  if (window) {
    if (url) load(url);
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 400,
    title: 'Baton',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: 'persist:baton',
      additionalArguments: [`--baton-server=${originOf(serverUrl()) ?? ''}`],
    },
  });
  window.removeMenu();
  const contents = window.webContents;
  // Links to other sites open in the browser; the server's own pages (and sign-in) stay here.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedSender(url, serverUrl())) load(url);
    else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('baton-desktop:')) {
      event.preventDefault();
      handleAppLink(url);
      return;
    }
    if (navigationTarget(url, serverUrl()) === 'browser') {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3: aborted (a new navigation replaced it).
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return;
    showOffline(description || 'The Baton server didn’t answer');
  });
  load(url);
  window.on('close', (event) => {
    // Closing the window keeps the app (and your agent) running in the tray.
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  // Development: BATON_DESKTOP_SCREENSHOT=<file.png> saves the window once loaded, then quits.
  const screenshot = process.env.BATON_DESKTOP_SCREENSHOT;
  if (screenshot) {
    contents.once('did-finish-load', () => {
      setTimeout(
        () => {
          void contents
            .executeJavaScript('typeof window.batonDesktop')
            .then((type: unknown) => process.stdout.write(`bridge: ${String(type)}\n`))
            .catch(() => undefined);
          void contents.capturePage().then((image) => {
            writeFileSync(screenshot, image.toPNG());
            quitting = true;
            app.quit();
          });
        },
        Number(process.env.BATON_DESKTOP_SCREENSHOT_DELAY ?? 4_000),
      );
    });
  }
}

/** Allow / Deny for a tool call Claude Code wants to make (the permission-prompt tool). */
async function askPermission(request: {
  jobId: string;
  tool: string;
  input: Record<string, unknown>;
}) {
  const what = describeToolCall(request.tool, request.input);
  const job = runner?.snapshot().jobs.find((item) => item.jobId === request.jobId);
  runner?.setBlocked(request.jobId, true, what);
  if (Notification.isSupported()) {
    new Notification({
      title: 'Your agent is waiting for your OK',
      body: `${job?.ref ?? 'A job'}: it wants to ${what}`,
    }).show();
  }
  const options = {
    type: 'question' as const,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    title: 'Baton',
    message: `Your agent wants to ${what}`,
    detail: `${job?.ref ?? ''} ${job?.title ?? ''}\n\n${JSON.stringify(request.input, null, 2).slice(0, 1500)}`,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  runner?.setBlocked(request.jobId, false);
  return response === 0;
}

/** Starts (or restarts) the runner with this computer's agent key. */
async function connect(): Promise<void> {
  const key = config.apiKey();
  runner?.stop();
  runner = null;
  api = null;
  if (key) {
    api = new BatonApi(serverUrl(), key);
    runner = new Runner(api, adapters, store(), permissions);
    runner.on('change', () => broadcast());
    runner.on('output', (payload) => window?.webContents.send('desktop:output', payload));
    await runner.start();
  }
  broadcast();
}

/** An IPC handler only the Baton server's own pages may call. */
function handle(channel: string, run: (...args: never[]) => unknown) {
  ipcMain.handle(`desktop:${channel}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isAllowedSender(event.senderFrame?.url, serverUrl())) throw new Error('Not allowed');
    return (run as (...values: unknown[]) => unknown)(...args);
  });
}

function registerIpc() {
  handle('state', () => state());
  handle('connect', async (key: string) => {
    config.setApiKey(String(key).trim());
    await connect();
    return state();
  });
  handle('disconnect', async () => {
    config.setApiKey(null);
    await connect();
    return state();
  });
  handle('harnesses', async () => {
    const list = [];
    for (const adapter of adapters.values()) {
      const detected = await adapter.detect();
      list.push({
        id: adapter.id,
        label: adapter.label,
        headless: adapter.headless,
        ...detected,
        models: detected.installed ? await adapter.listModels() : [],
        modes: adapter.permissionModes,
        mode: config.get().permissionModes[adapter.id] ?? adapter.permissionModes[0]?.id ?? null,
      });
    }
    return list;
  });
  handle('pickFolder', async (projectId: string, label: string, repoUrl: string | null) => {
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    config.update({
      folders: {
        ...config.get().folders,
        [String(projectId)]: { path: folder, label: String(label) },
      },
    });
    await runner?.refresh();
    broadcast();
    return checkRepo(folder, repoUrl);
  });
  handle('useScratch', async (projectId: string, label: string) => {
    config.update({
      folders: {
        ...config.get().folders,
        [String(projectId)]: { path: null, label: String(label) },
      },
    });
    await runner?.refresh();
    broadcast();
    return state();
  });
  handle('unmap', async (projectId: string) => {
    const folders = { ...config.get().folders };
    delete folders[String(projectId)];
    config.update({ folders });
    await runner?.refresh();
    broadcast();
    return state();
  });
  handle('checkRepo', async (projectId: string, repoUrl: string | null) => {
    const folder = config.get().folders[String(projectId)]?.path;
    return folder ? checkRepo(folder, repoUrl) : null;
  });
  handle('setPermissionMode', (harness: HarnessId, mode: string) => {
    config.update({
      permissionModes: { ...config.get().permissionModes, [harness]: String(mode) },
    });
    broadcast();
    return state();
  });
  handle('testRun', async (harness: HarnessId) => {
    const adapter = adapters.get(harness);
    if (!adapter || !api) {
      return {
        ok: false,
        outcome: 'failed',
        output: 'Connect this computer first: Set up this computer → “Run my agent here”.',
      };
    }
    const cwd = path.join(scratchRoot(), 'test');
    mkdirSync(cwd, { recursive: true });
    const lines: string[] = [];
    const logs: string[] = [];
    const result = await adapter.run({
      cwd,
      prompt:
        'This is a test run from the Baton desktop app. Call the Baton MCP tool `whoami` and reply with one line: "Baton works: @<your username>". Do nothing else.',
      model: '',
      effort: '',
      resumeId: null,
      permissionMode:
        config.get().permissionModes[harness] ?? adapter.permissionModes[0]?.id ?? 'default',
      mcp: {
        url: api.mcpUrl,
        apiKey: api.key,
        permissionServer: permissions
          ? { url: permissions.urlFor('test'), token: permissions.token }
          : null,
      },
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === 'session') return;
        // The harness's own log lines (e.g. Codex's model-cache warnings) only matter on failure.
        if (event.type === 'log') {
          logs.push(event.text);
          return;
        }
        lines.push(event.text);
        window?.webContents.send('desktop:output', { jobId: 'test', text: event.text });
      },
    });
    const ok = result.outcome === 'done';
    if (ok) {
      const tested = new Set(config.get().testedHarnesses ?? []);
      tested.add(harness);
      config.update({ testedHarnesses: [...tested] });
      broadcast();
    }
    const output = ok ? lines : [...lines, ...(logs.length ? ['', 'Harness log:', ...logs] : [])];
    return { ok, outcome: result.outcome, output: output.join('\n') };
  });
  handle('kill', (jobId: string) => runner?.kill(String(jobId)));
  handle('checkForUpdates', () => updates.check());
  handle('installUpdate', () => updates.install());
  handle('pauseHere', (paused: boolean) => {
    setPausedHere(Boolean(paused));
    return state();
  });
  handle('setMachineName', async (name: string) => {
    config.update({ machineName: String(name).trim() || config.get().machineName });
    await runner?.refresh();
    broadcast();
    return state();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
    runner?.stop();
    permissions?.stop();
  });
  app.on('window-all-closed', () => {
    // Stays in the tray.
  });
  void app.whenReady().then(async () => {
    config = new ConfigStore(app.getPath('userData'), secrets);
    permissions = new PermissionServer(askPermission);
    await permissions.start();
    registerIpc();
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.on('click', () => showWindow());
    showWindow();
    await connect().catch(() => undefined);
    updateTray();
    updates.start();
  });
}
