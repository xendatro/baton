import { useSyncExternalStore } from 'react';

/**
 * Desktop notifications and the notification sound (BAT-2). Both are per-device settings kept in
 * localStorage, like the browser's own notification permission. With several Baton tabs open,
 * only one of them (the holder of a Web Lock) announces, so a notification pings once.
 */

export interface AlertPrefs {
  /** Show an OS notification for new inbox items (needs the browser's permission too). */
  desktop: boolean;
  /** Play a short chime for new inbox items. */
  sound: boolean;
}

const STORAGE_KEY = 'baton:alerts';
const DEFAULT_PREFS: AlertPrefs = { desktop: false, sound: true };
const listeners = new Set<() => void>();
let cached: AlertPrefs | null = null;

function readPrefs(): AlertPrefs {
  if (cached) return cached;
  let stored: Partial<AlertPrefs> = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AlertPrefs>;
  } catch {
    // Storage blocked or corrupt: defaults.
  }
  cached = {
    desktop: typeof stored.desktop === 'boolean' ? stored.desktop : DEFAULT_PREFS.desktop,
    sound: typeof stored.sound === 'boolean' ? stored.sound : DEFAULT_PREFS.sound,
  };
  return cached;
}

export function getAlertPrefs(): AlertPrefs {
  return readPrefs();
}

export function setAlertPrefs(patch: Partial<AlertPrefs>): void {
  cached = { ...readPrefs(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Not persisted (private mode); still applies to this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The alert settings, kept in sync across components and tabs. */
export function useAlertPrefs(): AlertPrefs {
  return useSyncExternalStore(subscribe, readPrefs, () => DEFAULT_PREFS);
}

export type DesktopPermission = NotificationPermission | 'unsupported';

export function desktopPermission(): DesktopPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Asks for the browser's permission; call it from a click (browsers ignore it otherwise). */
export async function requestDesktopPermission(): Promise<DesktopPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

// ---------------------------------------------------------------------------------------------
// One announcing tab
// ---------------------------------------------------------------------------------------------

let leader = false;
let electing = false;

/**
 * Joins the election for the announcing tab: the first tab to take the lock keeps it until it
 * closes, then the next waiting tab takes over. Without Web Locks every tab announces.
 */
export function joinAlertElection(): void {
  if (electing) return;
  electing = true;
  const locks =
    typeof navigator === 'undefined' ? undefined : (navigator as Partial<Navigator>).locks;
  if (!locks) {
    leader = true;
    return;
  }
  void locks.request(
    'baton:alerts-leader',
    () =>
      new Promise<void>(() => {
        leader = true;
      }),
  );
}

export function isAlertLeader(): boolean {
  return leader;
}

// ---------------------------------------------------------------------------------------------
// Sound and notification
// ---------------------------------------------------------------------------------------------

let audio: AudioContext | null = null;

/** A short two-note chime (synthesized: no audio file to load). */
export function playChime(): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    // Browsers keep audio suspended until the page has been interacted with.
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime + 0.01;
    for (const [index, frequency] of [880, 1318.5].entries()) {
      const at = start + index * 0.12;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.4);
    }
  } catch {
    // No audio on this device.
  }
}

export interface InboxAlert {
  id: string;
  /** "Caden replied". */
  title: string;
  /** "BAT-6: Agent identity". */
  body: string;
  onOpen: () => void;
}

/**
 * Announces a new inbox item in this tab if it is the announcing one: the chime, and an OS
 * notification unless this tab is in front already (its toast shows it). Clicking the
 * notification focuses the tab and opens the item.
 */
export function announceInboxItem(alert: InboxAlert): void {
  if (!leader) return;
  const prefs = readPrefs();
  if (prefs.sound) playChime();
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  if (!prefs.desktop || focused || desktopPermission() !== 'granted') return;
  try {
    const notification = new Notification(alert.title, {
      body: alert.body,
      tag: `baton-${alert.id}`,
      icon: '/favicon.svg',
    });
    notification.onclick = () => {
      window.focus();
      alert.onOpen();
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}
