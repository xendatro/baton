import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** BAT-2: the chime and desktop notification for new inbox items. */

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>('granted'));
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

const oscillators = vi.fn();
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume = vi.fn();
  createOscillator() {
    oscillators();
    return {
      type: '',
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: (node: unknown) => node,
    };
  }
}

async function load() {
  vi.resetModules();
  return import('./desktopNotifications');
}

const alert = (onOpen = vi.fn()) => ({
  id: 'n1',
  title: 'Caden replied',
  body: 'BAT-6: Agent identity',
  onOpen,
});

let focused = false;

beforeEach(() => {
  localStorage.clear();
  FakeNotification.instances = [];
  FakeNotification.permission = 'granted';
  oscillators.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  focused = false;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('alert settings', () => {
  it('defaults to sound on, desktop off, and remembers changes on this device', async () => {
    const first = await load();
    expect(first.getAlertPrefs()).toEqual({ desktop: false, sound: true });
    first.setAlertPrefs({ desktop: true, sound: false });
    const reloaded = await load();
    expect(reloaded.getAlertPrefs()).toEqual({ desktop: true, sound: false });
  });

  it('asks the browser for permission only when it hasn’t answered yet', async () => {
    const lib = await load();
    FakeNotification.permission = 'default';
    expect(await lib.requestDesktopPermission()).toBe('granted');
    FakeNotification.permission = 'denied';
    expect(await lib.requestDesktopPermission()).toBe('denied');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('announceInboxItem', () => {
  it('stays quiet in tabs that are not the announcing one', async () => {
    const lib = await load();
    lib.setAlertPrefs({ desktop: true });
    lib.announceInboxItem(alert());
    expect(oscillators).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toEqual([]);
  });

  it('chimes, and shows a desktop notification that opens the item while in the background', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    const lib = await load();
    lib.joinAlertElection();
    expect(lib.isAlertLeader()).toBe(true);
    lib.setAlertPrefs({ desktop: true });
    const onOpen = vi.fn();
    lib.announceInboxItem(alert(onOpen));
    expect(oscillators).toHaveBeenCalledTimes(2);
    const [shown] = FakeNotification.instances;
    expect(shown?.title).toBe('Caden replied');
    expect(shown?.options).toMatchObject({ body: 'BAT-6: Agent identity', tag: 'baton-n1' });
    shown?.onclick?.();
    expect(onOpen).toHaveBeenCalled();
  });

  it('only chimes while Baton is in front, and follows the settings', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    const lib = await load();
    lib.joinAlertElection();
    lib.setAlertPrefs({ desktop: true });
    focused = true;
    lib.announceInboxItem(alert());
    expect(FakeNotification.instances).toEqual([]);
    expect(oscillators).toHaveBeenCalled();

    focused = false;
    oscillators.mockClear();
    lib.setAlertPrefs({ desktop: false, sound: false });
    lib.announceInboxItem(alert());
    expect(oscillators).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toEqual([]);

    lib.setAlertPrefs({ desktop: true });
    FakeNotification.permission = 'denied';
    lib.announceInboxItem(alert());
    expect(FakeNotification.instances).toEqual([]);
  });
});
