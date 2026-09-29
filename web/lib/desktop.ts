import { useEffect, useState } from 'react';
import type { BatonDesktopBridge, DesktopState } from '@shared/desktopBridge';

/**
 * The desktop app, when the web app runs inside it (BAT-26): `window.batonDesktop` is there only
 * then (and only on the Baton server's own origin). The Desktop pages and the sidebar's "This
 * computer" section use it; in a browser they point to the download instead.
 */

declare global {
  interface Window {
    batonDesktop?: BatonDesktopBridge;
  }
}

export function desktopBridge(): BatonDesktopBridge | null {
  return typeof window !== 'undefined' ? (window.batonDesktop ?? null) : null;
}

export function isDesktopApp(): boolean {
  return desktopBridge() !== null;
}

/** The desktop app's live state (runner, running jobs, folders), or null outside it. */
export function useDesktopState(): { state: DesktopState | null; loading: boolean } {
  const bridge = desktopBridge();
  const [state, setState] = useState<DesktopState | null>(null);
  const [loading, setLoading] = useState(bridge !== null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.state().then((next) => {
      if (!active) return;
      setState(next);
      setLoading(false);
    });
    const stop = bridge.onState((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);
  return { state, loading };
}

/** When a usage limit resets: "01:00", or "Tue 01:00" when it isn't today (BAT#30). */
export function usageClock(until: number, now: number = Date.now()): string {
  const date = new Date(until);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return date.toLocaleString([], {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3m 12s". */
export function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
