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
} from 'electron';
import type { Chain, HarnessId, JobSources } from '@shared/schemas/agentRunner';
import { BatonApi } from './api';
import { ConfigStore, type SecretBox } from './config';
import { checkRepo } from './git';
import { createAdapters } from './harness';
import { describeToolCall, PermissionServer } from './permissions';
import { Runner, type RunnerStore } from './runner';

/**
 * The Baton desktop app's main process (BAT-24): one window (setup guide, HUD, waiting jobs,
 * projects & folders, models, stats), a tray icon (online, pause, jobs running), the runner, and
 * the local permission server for Allow / Deny pop-ups.
 */

const TRAY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAApUlEQVR4nM3WsQ3AIAxEUaZLm/0HyBxJlSISxmf7DgfJrf8TDYzzuEbntMazgNsZGcALpyCKcAiijruIHfElQhJ/D4KQxVEEFWCdCIAe926BAgjGTcCu+AdRAhTidUAxXgMQ4nkAKZ4DEONxADkeAwjiU8AUoYy7AFF8CRgIgBWHXkNyHAKYCHb8118yNsJseAAGYrkfAWQh0N4IAIWE9mUA1GkHPMu/8VXh9ISnAAAAAElFTkSuQmCC';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let runner: Runner | null = null;
let api: BatonApi | null = null;
let permissions: PermissionServer | null = null;
const adapters = createAdapters();

const secrets: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
};

let config: ConfigStore;
const scratchRoot = () => path.join(app.getPath('userData'), 'scratch');

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

function send(channel: string, payload: unknown) {
  window?.webContents.send(channel, payload);
}

function state() {
  const cfg = config.get();
  return {
    signedIn: api !== null,
    serverUrl: cfg.serverUrl,
    machineName: cfg.machineName,
    setupDone: cfg.setupDone,
    pausedHere: cfg.pausedHere,
    folders: cfg.folders,
    permissionModes: cfg.permissionModes,
    runner: runner?.snapshot() ?? null,
  };
}

function updateTray() {
  if (!tray) return;
  const snapshot = runner?.snapshot();
  const running = snapshot?.jobs.length ?? 0;
  const status = snapshot?.status ?? 'stopped';
  const label =
    status === 'online'
      ? running > 0
        ? `Online — ${running} running`
        : 'Online — waiting for jobs'
      : status === 'paused'
        ? 'Paused'
        : status === 'offline'
          ? 'Offline'
          : 'Not running';
  tray.setToolTip(`Baton: ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      {
        label: config.get().pausedHere ? 'Resume on this machine' : 'Pause on this machine',
        click: () => setPausedHere(!config.get().pausedHere),
      },
      { label: 'Open Baton', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function setPausedHere(paused: boolean) {
  config.update({ pausedHere: paused });
  updateTray();
  send('state', state());
}

function showWindow() {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Baton',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.removeMenu();
  void window.loadFile(path.join(__dirname, 'index.html'));
  // Development: BATON_DESKTOP_SCREENSHOT=<file.png> saves the window once loaded, then quits.
  const screenshot = process.env.BATON_DESKTOP_SCREENSHOT;
  if (screenshot) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void window?.webContents.capturePage().then((image) => {
          writeFileSync(screenshot, image.toPNG());
          quitting = true;
          app.quit();
        });
      }, 2_500);
    });
  }
  window.on('close', (event) => {
    // Closing the window keeps the app (and its runner) in the tray.
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
}

let quitting = false;

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

async function connect(): Promise<void> {
  const key = config.apiKey();
  runner?.stop();
  runner = null;
  api = null;
  if (!key) return;
  api = new BatonApi(config.get().serverUrl, key);
  runner = new Runner(api, adapters, store(), permissions);
  runner.on('change', (snapshot) => {
    send('runner', snapshot);
    updateTray();
  });
  runner.on('output', (payload) => send('output', payload));
  await runner.start();
}

function registerIpc() {
  ipcMain.handle('state', () => state());

  ipcMain.handle('signIn', async (_event, serverUrl: string, key: string) => {
    const candidate = new BatonApi(serverUrl.trim().replace(/\/+$/, ''), key.trim());
    const me = await candidate.me();
    config.update({ serverUrl: candidate.baseUrl });
    config.setApiKey(key.trim());
    await connect();
    return { name: me.user.name, username: me.user.username };
  });

  ipcMain.handle('signOut', () => {
    config.setApiKey(null);
    runner?.stop();
    runner = null;
    api = null;
    return state();
  });

  ipcMain.handle('harnesses', async () => {
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

  ipcMain.handle('projects', async () => {
    if (!api) return [];
    const me = await api.me();
    return me.teams.flatMap((team) =>
      team.projects.map((project) => ({
        id: project.id,
        ref: `${team.slug}/${project.key}`,
        name: project.name,
        team: team.name,
        folder: config.get().folders[project.id] ?? null,
      })),
    );
  });

  ipcMain.handle('pickFolder', async (_event, projectId: string, label: string) => {
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    config.update({ folders: { ...config.get().folders, [projectId]: { path: folder, label } } });
    await runner?.refresh();
    const repoUrl = api ? (await api.project(projectId).catch(() => null))?.repoUrl : null;
    return checkRepo(folder, repoUrl);
  });

  ipcMain.handle('setScratch', async (_event, projectId: string, label: string) => {
    config.update({ folders: { ...config.get().folders, [projectId]: { path: null, label } } });
    await runner?.refresh();
    return state();
  });

  ipcMain.handle('unmap', async (_event, projectId: string) => {
    const folders = { ...config.get().folders };
    delete folders[projectId];
    config.update({ folders });
    await runner?.refresh();
    return state();
  });

  ipcMain.handle('checkRepo', async (_event, projectId: string) => {
    const folder = config.get().folders[projectId]?.path;
    if (!folder || !api) return null;
    const repoUrl = (await api.project(projectId).catch(() => null))?.repoUrl;
    return checkRepo(folder, repoUrl);
  });

  ipcMain.handle('setPermissionMode', (_event, harness: HarnessId, mode: string) => {
    config.update({ permissionModes: { ...config.get().permissionModes, [harness]: mode } });
    return state();
  });

  ipcMain.handle('models', () => api?.models() ?? null);
  ipcMain.handle('setDefaultChain', async (_event, chain: Chain) => {
    if (!api) return null;
    const current = await api.models();
    return api.setModels({ ...current, default: { ...current.default, chain } });
  });

  ipcMain.handle('jobSources', () => api?.jobSources() ?? null);
  ipcMain.handle('setJobSources', (_event, sources: JobSources) => api?.setJobSources(sources));

  ipcMain.handle('waiting', () => api?.waiting() ?? { jobs: [] });
  ipcMain.handle('decide', (_event, jobId: string, decision: 'approve' | 'dismiss') =>
    api?.decide(jobId, decision),
  );

  ipcMain.handle('stats', (_event, days: number) => api?.stats(days) ?? null);
  ipcMain.handle('kill', (_event, jobId: string) => runner?.kill(jobId));
  ipcMain.handle('pauseHere', (_event, paused: boolean) => {
    setPausedHere(paused);
    return state();
  });
  ipcMain.handle('pauseEverywhere', async () => {
    await api?.pauseEverywhere();
    await runner?.refresh();
    return state();
  });

  ipcMain.handle('setMachineName', async (_event, name: string) => {
    config.update({ machineName: name.trim() || config.get().machineName });
    await runner?.refresh();
    return state();
  });

  ipcMain.handle('finishSetup', () => {
    config.update({ setupDone: true });
    return state();
  });

  /** A test run: the harness in a scratch folder, asked to check it can reach Baton. */
  ipcMain.handle('testRun', async (_event, harness: HarnessId) => {
    const adapter = adapters.get(harness);
    if (!adapter || !api) return { ok: false, output: 'Sign in first.' };
    const cwd = path.join(scratchRoot(), 'test');
    mkdirSync(cwd, { recursive: true });
    const lines: string[] = [];
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
        if (event.type !== 'session') {
          lines.push(event.text);
          send('output', { jobId: 'test', text: event.text });
        }
      },
    });
    return { ok: result.outcome === 'done', output: lines.join('\n'), outcome: result.outcome };
  });

  ipcMain.handle('openExternal', (_event, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
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
    tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`));
    tray.on('click', () => showWindow());
    updateTray();
    showWindow();
    await connect().catch((error: unknown) => send('error', String(error)));
    updateTray();
  });
}
