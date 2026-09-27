import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessAdapter, PermissionMode, RunOptions, RunResult } from './types';
import { capture, num, parseJsonLine, spawnLines, str, which } from './process';
import { isOutOfUsage, parseResetAt } from './usageLimits';
import { mcpListReaches } from './mcpList';

/**
 * Claude Code (`claude -p`), checked against its `--help` (2.1.x): stream-json output with
 * `--verbose`, `--model` (aliases like opus / sonnet / haiku always mean the latest), `--effort`,
 * `--resume <session>`, `--permission-mode`, `--mcp-config` (added to the user's own servers,
 * never replacing them) and `--permission-prompt-tool` for approvals through the app.
 */

const PERMISSION_TOOL = 'mcp__baton_desktop__approve';

const MODES: PermissionMode[] = [
  {
    id: 'app',
    label: 'Ask me in the Baton app',
    description:
      'Whatever Claude Code would ask you shows as an Allow / Deny pop-up from the Baton app. Your own permission rules still apply first.',
    unattended: false,
    viaApp: true,
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'File edits are allowed; anything else not allowed by your rules is denied.',
    unattended: true,
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Claude Code’s auto mode decides what is safe to run.',
    unattended: true,
  },
  {
    id: 'dontAsk',
    label: 'Don’t ask',
    description: 'Only what your permission rules allow runs; the rest is denied.',
    unattended: true,
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Everything runs without asking. Only for machines where that is safe.',
    unattended: true,
  },
];

let helpCache: string | null = null;
async function help(command: string): Promise<string> {
  helpCache ??= (await capture(command, ['--help'])) ?? '';
  return helpCache;
}

/**
 * Does Claude Code already reach this Baton server through one of its own MCP servers (any
 * scope)? `claude mcp list` prints `name: url (HTTP) - ✓ Connected` per server.
 */
async function hasBatonMcp(command: string, url: string): Promise<boolean> {
  const listed = await capture(command, ['mcp', 'list'], 30_000);
  return listed !== null && mcpListReaches(listed, url);
}

function writeMcpConfig(servers: Record<string, unknown>): string {
  const file = path.join(os.tmpdir(), `baton-mcp-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return file;
}

export function claudeAdapter(): HarnessAdapter {
  let resolved: string | null = null;
  const command = () => resolved ?? 'claude';
  return {
    id: 'claude',
    label: 'Claude Code',
    headless: 'claude -p',
    async detect() {
      resolved = await which('claude');
      if (!resolved) return { installed: false, path: null, version: null };
      const version = (await capture(resolved, ['--version']))?.trim().split(/\s+/)[0] ?? null;
      return { installed: true, path: resolved, version };
    },
    async listModels() {
      const text = await help(command());
      const quoted = [
        ...(/--model <model>[\s\S]*?\(e\.g\.([^)]*)\)/.exec(text)?.[1] ?? '').matchAll(
          /'([^']+)'/g,
        ),
      ]
        .map((match) => match[1] ?? '')
        .filter((name) => name && !name.includes('-'));
      return [...new Set(['opus', 'sonnet', 'haiku', ...quoted])];
    },
    permissionModes: MODES,
    async run(options: RunOptions): Promise<RunResult> {
      const started = Date.now();
      const text = await help(command());
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (options.model) args.push('--model', options.model);
      if (options.effort && text.includes('--effort')) args.push('--effort', options.effort);
      if (options.resumeId) args.push('--resume', options.resumeId);

      const servers: Record<string, unknown> = {};
      if (options.mcp && !(await hasBatonMcp(command(), options.mcp.url))) {
        // Named apart from a `baton` server the user may have for another Baton server.
        servers.baton_app = {
          type: 'http',
          url: options.mcp.url,
          headers: { Authorization: `Bearer ${options.mcp.apiKey}` },
        };
      }
      if (options.permissionMode === 'app' && options.mcp?.permissionServer) {
        servers.baton_desktop = {
          type: 'http',
          url: options.mcp.permissionServer.url,
          headers: { Authorization: `Bearer ${options.mcp.permissionServer.token}` },
        };
        args.push('--permission-prompt-tool', PERMISSION_TOOL);
      } else if (options.permissionMode && options.permissionMode !== 'app') {
        args.push('--permission-mode', options.permissionMode);
      }
      if (Object.keys(servers).length > 0) args.push('--mcp-config', writeMcpConfig(servers));

      const result: RunResult = {
        outcome: 'failed',
        sessionId: options.resumeId,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        durationMs: 0,
        resetAt: null,
        error: null,
      };
      let sawResult = false;
      let lastText = '';
      let limited = false;
      let lastError: string | null = null;
      const onLine = (line: string, stream: 'stdout' | 'stderr') => {
        const event = parseJsonLine(line);
        if (!event) {
          if (!line.trim()) return;
          if (isOutOfUsage(line)) {
            limited = true;
            result.resetAt = parseResetAt(line) ?? result.resetAt;
          }
          if (stream === 'stderr') lastError = line;
          options.onEvent({ type: 'output', text: line });
          return;
        }
        const sessionId = str(event.session_id);
        if (sessionId && sessionId !== result.sessionId) {
          result.sessionId = sessionId;
          options.onEvent({ type: 'session', sessionId });
        }
        if (event.type === 'assistant') {
          const content = (event.message as { content?: unknown } | undefined)?.content;
          for (const block of Array.isArray(content) ? content : []) {
            const item = block as { type?: string; text?: string; name?: string };
            if (item.type === 'text' && item.text) {
              lastText = item.text;
              options.onEvent({ type: 'output', text: item.text });
            }
            if (item.type === 'tool_use' && item.name) {
              options.onEvent({ type: 'status', text: `→ ${item.name}` });
            }
          }
        }
        if (event.type === 'result') {
          sawResult = true;
          const usage = (event.usage ?? {}) as Record<string, unknown>;
          result.tokensIn =
            num(usage.input_tokens) +
            num(usage.cache_creation_input_tokens) +
            num(usage.cache_read_input_tokens);
          result.tokensOut = num(usage.output_tokens);
          result.costUsd = num(event.total_cost_usd);
          const message = str(event.result) ?? '';
          if (event.is_error === true) {
            lastError = message || str(event.subtype) || 'Claude Code reported an error';
            if (isOutOfUsage(message)) {
              limited = true;
              result.resetAt = parseResetAt(message) ?? result.resetAt;
            }
          } else {
            result.outcome = 'done';
          }
          // The result repeats the last message; show it only when it's new.
          if (message && message.trim() !== lastText.trim()) {
            options.onEvent({ type: 'output', text: message });
          }
        }
      };
      const run = spawnLines(command(), args, {
        cwd: options.cwd,
        stdin: options.prompt,
        signal: options.signal,
        onLine,
      });
      const code = await run.exit;
      result.durationMs = Date.now() - started;
      if (options.signal.aborted) result.outcome = 'killed';
      else if (limited) result.outcome = 'out_of_usage';
      else if (!sawResult || code !== 0)
        result.outcome = result.outcome === 'done' ? 'done' : 'failed';
      result.error = result.outcome === 'done' ? null : lastError;
      return result;
    },
  };
}
