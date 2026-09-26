/**
 * Return-focus bookkeeping for the dialog wrappers (see `useReturnFocus`): what to refocus when a
 * dialog closes, and the return targets of the dialogs open right now.
 */

export interface ReturnTarget {
  element: HTMLElement | null;
  /** Where the dialog holding `element` returns focus, if `element` goes away with it. */
  fallback: HTMLElement | null;
}

/** Return targets of the open dialogs, oldest first. */
const openDialogs: ReturnTarget[] = [];

/** Registers an open dialog's target until the returned function is called. */
export function trackOpenDialog(target: ReturnTarget): () => void {
  openDialogs.push(target);
  return () => {
    const index = openDialogs.lastIndexOf(target);
    if (index !== -1) openDialogs.splice(index, 1);
  };
}

/** The return target for a dialog opening while `active` has focus. */
export function captureReturnTarget(active: Element | null): ReturnTarget {
  const element = focusReturnTarget(active);
  // Focus inside a dialog means that dialog is the newest open one.
  const inDialog = active?.closest('[role="dialog"],[role="alertdialog"]');
  const outer = inDialog ? openDialogs.at(-1) : undefined;
  return { element, fallback: outer ? (outer.element ?? outer.fallback) : null };
}

/** The element to refocus later for the one focused now (for a menu item, the menu's trigger). */
export function focusReturnTarget(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  const menu = element.closest('[role="menu"]');
  if (menu) {
    // Radix menus are labelled by their trigger.
    const triggerId = menu.getAttribute('aria-labelledby');
    const trigger = triggerId ? document.getElementById(triggerId) : null;
    return trigger instanceof HTMLElement ? trigger : null;
  }
  return element;
}
