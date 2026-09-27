/**
 * Which pages may talk to the desktop app (BAT-26): only the configured Baton server's origin
 * gets `window.batonDesktop`, and every IPC call checks its sender again. OAuth sign-in pages
 * (Google, GitHub) may load in the window; everything else opens in the system browser.
 */

export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** May a frame at `senderUrl` use the desktop bridge? */
export function isAllowedSender(senderUrl: string | undefined | null, serverUrl: string): boolean {
  const sender = originOf(senderUrl);
  return sender !== null && sender === originOf(serverUrl);
}

const SIGN_IN_HOSTS = new Set(['accounts.google.com', 'github.com']);

/** Where a navigation of the main window goes: stay in the app, or the system browser. */
export function navigationTarget(url: string, serverUrl: string): 'app' | 'browser' {
  if (isAllowedSender(url, serverUrl)) return 'app';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:' || parsed.protocol === 'baton-desktop:') return 'app';
    if (parsed.protocol !== 'https:') return 'browser';
    if (parsed.hostname === 'accounts.google.com') return 'app';
    // GitHub's OAuth pages (sign in with GitHub, connect the GitHub App), not the rest of GitHub.
    if (
      SIGN_IN_HOSTS.has(parsed.hostname) &&
      /^\/(login|session|sessions)(\/|$)/.test(parsed.pathname)
    ) {
      return 'app';
    }
  } catch {
    return 'browser';
  }
  return 'browser';
}
