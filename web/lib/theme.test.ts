import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThemeExports from './theme';

type ThemeModule = typeof ThemeExports;

/** A fresh copy of the module, so its persister registry and unsaved choice start empty. */
async function loadTheme(): Promise<ThemeModule> {
  vi.resetModules();
  return import('./theme');
}

describe('theme persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('saves a choice through every registered persister', async () => {
    const theme = await loadTheme();
    const persist = vi.fn();
    const unregister = theme.registerThemePersister(persist);
    theme.setTheme('dark');
    expect(persist).toHaveBeenCalledExactlyOnceWith('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    unregister();
    theme.setTheme('light');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  // The account module's persister is a lazily loaded shell extension: a theme picked before it
  // mounts used to stay local only, so the next load adopted the profile theme over it.
  it('hands a choice made before any persister registered to the first one, once', async () => {
    const theme = await loadTheme();
    theme.setTheme('dark');
    expect(theme.getStoredTheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    const order: string[] = [];
    const first = vi.fn((value: string) => {
      order.push(`persist:${value}`);
    });
    theme.registerThemePersister(first);
    order.push('registered');
    // Called synchronously, so it can mark the session before later effects of the same render.
    expect(order).toEqual(['persist:dark', 'registered']);

    const second = vi.fn();
    theme.registerThemePersister(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps only the latest unsaved choice', async () => {
    const theme = await loadTheme();
    theme.setTheme('dark');
    theme.setTheme('light');
    const persist = vi.fn();
    theme.registerThemePersister(persist);
    expect(persist).toHaveBeenCalledExactlyOnceWith('light');
  });

  it('ignores persisters that fail', async () => {
    const theme = await loadTheme();
    theme.registerThemePersister(() => {
      throw new Error('offline');
    });
    theme.registerThemePersister(() => Promise.reject(new Error('offline')));
    expect(() => theme.setTheme('dark')).not.toThrow();
    expect(theme.getStoredTheme()).toBe('dark');
  });
});
