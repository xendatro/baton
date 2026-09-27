/**
 * Whether a harness's own MCP servers already reach the app's Baton server (BAT-24): the listing
 * of `<cli> mcp list` mentions the same host and `/mcp` path. Then the app adds nothing; else it
 * adds its own server (with its key) next to the user's, never replacing them.
 */
export function mcpListReaches(listing: string, mcpUrl: string): boolean {
  let target: URL;
  try {
    target = new URL(mcpUrl);
  } catch {
    return false;
  }
  const host = target.host.toLowerCase().replace(/^www\./, '');
  for (const match of listing.matchAll(/https?:\/\/[^\s)'"]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (
        url.host.toLowerCase().replace(/^www\./, '') === host &&
        url.pathname.replace(/\/+$/, '') === target.pathname.replace(/\/+$/, '')
      ) {
        return true;
      }
    } catch {
      // Not a URL after all.
    }
  }
  return false;
}
