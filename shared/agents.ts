/**
 * Agents (BAT-6): the MCP client behind an API key, named from its `initialize` handshake
 * (`clientInfo`). Writes through the key read "Claude via Ethan's MSI", and `@claude` in a reply
 * reaches Claude agents that took part in that task or issue.
 */

export const AGENT_NAME_MAX = 32;

/** Well-known clients, matched against `clientInfo.name` / `title` (e.g. `claude-code`). */
const KNOWN_AGENTS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /claude/i, name: 'Claude' },
  { pattern: /codex/i, name: 'Codex' },
  { pattern: /cursor/i, name: 'Cursor' },
  { pattern: /gemini/i, name: 'Gemini' },
  { pattern: /copilot|visual studio code|vscode/i, name: 'Copilot' },
  { pattern: /windsurf|codeium/i, name: 'Windsurf' },
];

/** The display name of an MCP client ("Claude" for `claude-code`), or null when it has none. */
export function agentNameFromClient(clientInfo: {
  name?: unknown;
  title?: unknown;
}): string | null {
  const raw = [clientInfo.title, clientInfo.name]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of raw) {
    const known = KNOWN_AGENTS.find((agent) => agent.pattern.test(value));
    if (known) return known.name;
  }
  const first = raw[0];
  if (!first) return null;
  const printable = [...first].filter((char) => char >= ' ' && char !== '\u007f').join('');
  const cleaned = printable.slice(0, AGENT_NAME_MAX).trim();
  return cleaned || null;
}

/** The @handle that mentions an agent: its name in lowercase letters and digits (`@claude`). */
export function agentHandle(agentName: string): string {
  return agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
}
