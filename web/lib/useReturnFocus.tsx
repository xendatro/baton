import { useRef, type ReactNode } from 'react';
import { CaptureFocus } from './CaptureFocus';
import type { ReturnTarget } from './returnFocus';

/**
 * Where focus goes back to when a modal closes. Radix dialogs return focus to their
 * `<DialogTrigger>`, but most of the app's dialogs are opened through controlled state (shell
 * actions, page buttons, hotkeys) with no trigger, so focus fell to `<body>` on close and keyboard
 * and screen-reader users were sent back to the top of the page (WCAG 2.4.3).
 *
 * The dialog wrappers render `capture` inside their content: it remembers the element that had
 * focus when the content first rendered (before anything inside it autofocuses), and
 * `onCloseAutoFocus` puts focus back there. A dialog opened from a menu item remembers the menu's
 * trigger instead, since the item goes away with the menu. A dialog opened from another dialog
 * that closes at the same time (a palette command opening "New task") falls back to where that
 * dialog would have returned. When nothing remembered is still on the page (e.g. the row was
 * deleted), Radix's default applies. A caller's own `onCloseAutoFocus` runs first and can take
 * over by calling `preventDefault()`.
 */
export function useReturnFocus(onCloseAutoFocus: ((event: Event) => void) | undefined): {
  capture: ReactNode;
  onCloseAutoFocus: (event: Event) => void;
} {
  const returnTo = useRef<ReturnTarget | null>(null);
  return {
    capture: (
      <CaptureFocus
        onCapture={(target) => {
          returnTo.current = target;
        }}
      />
    ),
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      const target = returnTo.current;
      returnTo.current = null;
      if (event.defaultPrevented || !target) return;
      const element = [target.element, target.fallback].find((item) => item?.isConnected);
      if (!element) return;
      event.preventDefault();
      element.focus({ preventScroll: true });
    },
  };
}
