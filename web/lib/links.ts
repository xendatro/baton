import { toast } from 'sonner';
import { isDesktopApp } from './desktop';

/**
 * Links for right-click menus: the absolute URL of an app path (the server's own origin, in the
 * browser and in the desktop app alike), copying text, and opening a page in a new tab.
 */

/** `https://baton.example/t/acme/p/API` for `/t/acme/p/API`. */
export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/** Copies `text`, toasting the outcome ("Link copied"). Returns whether it worked. */
export async function copyToClipboard(text: string, what = 'Link'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
    return true;
  } catch {
    toast.error('Couldn’t copy. Select the text and copy it instead.');
    return false;
  }
}

/** Copies the absolute link of an app path. */
export function copyLink(path: string): void {
  void copyToClipboard(absoluteUrl(path));
}

/**
 * Opens an app path in a new browser tab. The desktop app has a single window, so there it opens
 * in that window instead (`navigate`, no reload).
 */
export function openInNewTab(path: string, navigate: (path: string) => void): void {
  if (isDesktopApp()) {
    navigate(path);
    return;
  }
  window.open(absoluteUrl(path), '_blank', 'noopener');
}

/** Whether "Open in new tab" makes sense: not in the desktop app, whose one window is the app. */
export function canOpenNewTab(): boolean {
  return !isDesktopApp();
}
