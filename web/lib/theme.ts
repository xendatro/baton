import { useCallback, useSyncExternalStore } from 'react';
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

/** Persists and applies a theme, notifying every `useTheme` consumer. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode): the theme still applies for this page view.
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
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
