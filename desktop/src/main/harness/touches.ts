/**
 * BAT#28: the Baton tasks and issues a harness run created or replied in, read from the
 * harness's own tool-call events (a Baton MCP tool's name, input and result), so the runner can
 * link its session to them and a later reply there resumes the session that wrote it.
 */

const CREATES = new Set(['create_task', 'create_task_from_issue', 'create_issue']);
const REPLIES = new Set(['add_reply']);

/** `mcp__baton_app__create_task` → `create_task` (Claude Code names tools `mcp__<server>__<tool>`). */
function toolName(name: string): string {
  const parts = name.split('__');
  return parts.at(-1) ?? name;
}

function serverOf(name: string, server: string | null): string {
  if (server) return server;
  const parts = name.split('__');
  return parts.length >= 3 ? (parts[1] ?? '') : '';
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Text of an MCP tool result: a string, or the text parts of a content array. */
export function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .filter(Boolean);
    return parts.length ? parts.join('') : null;
  }
  return null;
}

/**
 * The items (id or ref) one Baton tool call touched: what `create_task` / `create_issue` /
 * `create_task_from_issue` returned, and the `item` of `add_reply`. Other tools, other MCP servers
 * and failed calls touch nothing.
 */
export function batonToolTouches(call: {
  name: string;
  server?: string | null;
  input: unknown;
  output: string | null;
  failed?: boolean;
}): string[] {
  if (call.failed) return [];
  if (!/baton/i.test(serverOf(call.name, call.server ?? null))) return [];
  const tool = toolName(call.name);
  if (REPLIES.has(tool)) {
    const item = (call.input as { item?: unknown } | null)?.item;
    return typeof item === 'string' && item.trim() ? [item.trim()] : [];
  }
  if (CREATES.has(tool)) {
    const created = parseObject(call.output);
    const id = created?.id ?? created?.ref;
    return typeof id === 'string' && id ? [id] : [];
  }
  return [];
}
