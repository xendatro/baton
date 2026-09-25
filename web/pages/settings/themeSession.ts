/**
 * Which sign-in has already settled its theme. On the first load of a new session the web app
 * adopts the theme saved in the profile (see AccountShellExtension); once the user picks a theme
 * in that session, or it was adopted, the local choice wins. Stored per browser in localStorage.
 */
const THEME_SESSION_KEY = 'baton-theme-session';

export function readThemeSession(): string | null {
  try {
    return localStorage.getItem(THEME_SESSION_KEY);
  } catch {
    return null;
  }
}

export function markThemeSession(sessionId: string): void {
  try {
    localStorage.setItem(THEME_SESSION_KEY, sessionId);
  } catch {
    // Storage unavailable: the profile theme is simply adopted again on the next load.
  }
}
