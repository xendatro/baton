import { useEffect, useRef } from 'react';
import { registerHotkey, type HotkeyOptions } from '@web/lib/hotkeys';

/**
 * `useHotkey` for a key the app shell also binds (`/` opens the palette there). The most recent
 * registration wins, but on a first page load parents' effects run after their children's, so the
 * shell would register after the page. Registering on the next task makes the page's binding the
 * newest one whichever way the page was reached.
 */
export function useShadowingHotkey(
  keys: string,
  handler: (event: KeyboardEvent) => void,
  options: HotkeyOptions,
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const { description, group, enabled, allowInInputs, allowInDialogs, hidden } = options;
  useEffect(() => {
    let unregister: (() => void) | undefined;
    const timer = setTimeout(() => {
      unregister = registerHotkey(keys, (event) => latest.current(event), {
        description,
        group,
        enabled,
        allowInInputs,
        allowInDialogs,
        hidden,
      });
    }, 0);
    return () => {
      clearTimeout(timer);
      unregister?.();
    };
  }, [keys, description, group, enabled, allowInInputs, allowInDialogs, hidden]);
}
