import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { THEMES, type Theme } from '@shared/constants';

/**
 * Light / dark / system theme. The choice lives in localStorage (and, once signed in, the user's
 * profile). web/public/theme-init.js applies the stored theme before first paint using the same
 * storage key and class; keep the two in sync.
 */
export const THEME_STORAGE_KEY = 'baton-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

/** Saves a theme choice to the user's profile. Registered by the account module. */
export type ThemePersister = (theme: Theme) => void | Promise<void>;

const persisters = new Set<ThemePersister>();

/**
 * Registers a callback that saves theme changes made through `setTheme` to the user's profile
 * (the account module owns that endpoint). Returns the unregister function.
 */
export function registerThemePersister(persist: ThemePersister): () => void {
  persisters.add(persist);
  return () => {
    persisters.delete(persist);
  };
}

/** Hook form of `registerThemePersister`, active while the calling component is mounted. */
export function useThemePersister(persist: ThemePersister): void {
  const latest = useRef(persist);
  useEffect(() => {
    latest.current = persist;
  });
  useEffect(() => registerThemePersister((theme) => latest.current(theme)), []);
}

/** Stores and applies a theme locally, without saving it to the profile. */
export function applyStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode): the theme still applies for this page view.
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
}

/** Stores, applies and saves a theme to the profile, notifying every `useTheme` consumer. */
export function setTheme(theme: Theme): void {
  applyStoredTheme(theme);
  for (const persist of persisters) void Promise.resolve(persist(theme)).catch(() => undefined);
}

function hasStoredTheme(): boolean {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Keeps the local theme in step with the profile: a device with no saved choice adopts the
 * profile's theme, and later profile changes (made on another device) are applied here. The
 * local choice otherwise wins, so a profile that is not saved yet never overrides it.
 */
export function useSyncProfileTheme(profileTheme: Theme | undefined): void {
  const previous = useRef<Theme | undefined>(undefined);
  useEffect(() => {
    if (profileTheme === undefined) return;
    const last = previous.current;
    previous.current = profileTheme;
    if (last === undefined ? !hasStoredTheme() : last !== profileTheme) {
      if (getStoredTheme() !== profileTheme) applyStoredTheme(profileTheme);
    }
  }, [profileTheme]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media = window.matchMedia(DARK_QUERY);
  const onSystemChange = () => {
    if (getStoredTheme() === 'system') {
      applyTheme('system');
      listener();
    }
  };
  media.addEventListener('change', onSystemChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', onSystemChange);
  };
}

export interface UseTheme {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

export function useTheme(): UseTheme {
  const theme = useSyncExternalStore(subscribe, getStoredTheme, (): Theme => 'system');
  const resolvedTheme = useSyncExternalStore(
    subscribe,
    () => resolveTheme(getStoredTheme()),
    (): 'light' | 'dark' => 'light',
  );
  return { theme, resolvedTheme, setTheme: useCallback((next: Theme) => setTheme(next), []) };
}
