/**
 * Recovery from failed page chunks. After a deploy, an open tab still has the old index.html and
 * asks for chunk files that no longer exist; a fresh load knows the new names. The page reloads
 * once for that, and a second failure moments later shows an error instead of looping.
 */

const RELOAD_KEY = 'baton:chunk-reload-at';
/** A second chunk failure within this window shows the error instead of reloading in a loop. */
const RELOAD_WINDOW_MS = 30_000;

const CHUNK_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR_PATTERN.test(error.message);
}

/**
 * Reloads the page, unless it already did so for a failed chunk moments ago. Returns whether it
 * reloads. Storage can be unavailable (private mode): then it never reloads automatically.
 */
export function reloadOnceForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
