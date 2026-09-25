/**
 * Copy-paste setup for connecting agents to Baton's MCP endpoint with an API key (SPEC §1.2).
 * `origin` is the address the user reaches Baton at, so the snippets work as pasted.
 */

export const KEY_ENV_VAR = 'BATON_API_KEY';

export function mcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

/** Claude Code: one command that registers Baton as an HTTP MCP server. */
export function claudeCodeCommand(origin: string, key: string): string {
  return `claude mcp add --transport http baton ${mcpUrl(origin)} --header "Authorization: Bearer ${key}"`;
}

/** Codex: the server entry for `~/.codex/config.toml` (the key comes from the environment). */
export function codexConfig(origin: string): string {
  return [
    '# ~/.codex/config.toml',
    '[mcp_servers.baton]',
    `url = "${mcpUrl(origin)}"`,
    `bearer_token_env_var = "${KEY_ENV_VAR}"`,
  ].join('\n');
}

/** The shell line that provides the key to Codex (add it to your shell profile). */
export function codexExport(key: string): string {
  return `export ${KEY_ENV_VAR}="${key}"`;
}

/** Any script: the REST API takes the same key. */
export function curlExample(origin: string, key: string): string {
  return `curl -H "Authorization: Bearer ${key}" ${origin.replace(/\/+$/, '')}/api/me`;
}
