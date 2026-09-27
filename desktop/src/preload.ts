import { contextBridge, ipcRenderer } from 'electron';
import type { BatonDesktopBridge, DesktopState } from '@shared/desktopBridge';

/**
 * `window.batonDesktop` (BAT-26): the web app's way to reach the desktop app. Exposed only to the
 * Baton server this app is set up for (the main process checks every call's sender again), with
 * named calls only and no Node APIs in the page (context isolation, sandbox).
 */

const serverOrigin =
  process.argv.find((arg) => arg.startsWith('--baton-server='))?.slice('--baton-server='.length) ??
  '';

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(`desktop:${channel}`, ...args) as Promise<T>;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: BatonDesktopBridge = {
  state: () => call('state'),
  connect: (apiKey) => call('connect', apiKey),
  disconnect: () => call('disconnect'),
  harnesses: () => call('harnesses'),
  pickFolder: (projectId, label, repoUrl) => call('pickFolder', projectId, label, repoUrl),
  useScratch: (projectId, label) => call('useScratch', projectId, label),
  unmap: (projectId) => call('unmap', projectId),
  checkRepo: (projectId, repoUrl) => call('checkRepo', projectId, repoUrl),
  setPermissionMode: (harness, mode) => call('setPermissionMode', harness, mode),
  testRun: (harness) => call('testRun', harness),
  kill: (jobId) => call('kill', jobId),
  pauseHere: (paused) => call('pauseHere', paused),
  setMachineName: (name) => call('setMachineName', name),
  onState: (listener) => subscribe<DesktopState>('desktop:state', listener),
  onOutput: (listener) => subscribe<{ jobId: string; text: string }>('desktop:output', listener),
  checkForUpdates: () => call('checkForUpdates'),
  installUpdate: () => call('installUpdate'),
};

if (serverOrigin && window.location.origin === serverOrigin) {
  contextBridge.exposeInMainWorld('batonDesktop', bridge);
}
