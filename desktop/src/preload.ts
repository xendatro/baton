import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge between the window and the main process (BAT-24): named calls only, no Node APIs
 * in the page (context isolation, sandbox).
 */

const calls = [
  'state',
  'signIn',
  'signOut',
  'harnesses',
  'projects',
  'pickFolder',
  'setScratch',
  'unmap',
  'checkRepo',
  'setPermissionMode',
  'models',
  'setDefaultChain',
  'jobSources',
  'setJobSources',
  'waiting',
  'decide',
  'stats',
  'kill',
  'pauseHere',
  'pauseEverywhere',
  'setMachineName',
  'finishSetup',
  'testRun',
  'openExternal',
] as const;

const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const name of calls) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(name, ...args);
}

contextBridge.exposeInMainWorld('baton', {
  ...api,
  on(channel: 'runner' | 'output' | 'state' | 'error', listener: (payload: unknown) => void) {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
