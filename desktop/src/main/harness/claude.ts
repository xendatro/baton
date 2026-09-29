import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessAdapter, HarnessEvent, PermissionMode, RunOptions, RunResult } from './types';
import { capture, num, parseJsonLine, spawnLines, str, which } from './process';
import { usageLimitOf } from './usageLimits';
import { mcpListReaches } from './mcpList';
import { batonToolTouches, resultText } from './touches';

/**
 * Claude Code (`claude -p`), checked against its `--help` (2.1.x): stream-json output with
 * `--verbose`, `--model` (aliases like opus / sonnet / haiku always mean the latest), `--effort`,
 * `--resume <session>`, `--permission-mode`, `--mcp-config` (added to the user's own servers,
 * never replacing them) and `--permission-prompt-tool` for approvals through the app.
 *
 * BAT#31: when the help lists them, the prompt goes in as stream-json on stdin
 * (`--input-format stream-json --replay-user-messages`) and stdin stays open, so a new message
 * can be written while the session works. Claude Code takes it in after the current tool call,
 * as typing into an interactive session does (checked with 2.1.282: the message is replayed on
 * stdout right after the running tool's result, then the turn goes on with it). Stdin is closed
 * once a result has come and every message written was replayed (taken in), which ends the run.
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

/** One user message of `--input-format stream-json`. */
export function userMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  })}\n`;
}

/** Where a streaming session's messages go (the process's stdin). */
export interface ClaudeInput {
  write(text: string): boolean;
  end(): void;
}

/** After a result with messages not taken in yet, how long to wait before closing stdin anyway. */
const IDLE_CLOSE_MS = 120_000;

/**
 * One Claude Code run: reads its stream-json output into the result and, with streaming input,
 * writes the prompt and later messages and closes stdin when the session is done (BAT#31).
 * Out of usage only from Claude Code's own errors (an error result, an assistant message marked
 * as an error, a rejected rate-limit event, or stderr of a run without a successful result),
 * never from what the agent writes or reads (BAT#30).
 */
export class ClaudeSession {
  readonly result: RunResult;
  private lastText = '';
  /** Of the last result: null until one came. */
  private lastResultOk: boolean | null = null;
  private readonly harnessErrors: string[] = [];
  private readonly stderr: string[] = [];
  private rateLimitResetAt: number | null = null;
  /** Messages written and not replayed yet, oldest first (the prompt first). */
  private readonly unacked: Array<{ text: string; prompt: boolean }> = [];
  private input: ClaudeInput | null = null;
  private closed = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly tools = new Map<string, { name: string; input: unknown }>();

  constructor(
    private readonly onEvent: (event: HarnessEvent) => void,
    resumeId: string | null,
    private readonly idleMs = IDLE_CLOSE_MS,
  ) {
    this.result = {
      outcome: 'failed',
      sessionId: resumeId,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 0,
      resetAt: null,
      error: null,
    };
  }

  /** Streaming input: writes the prompt and keeps `input` open for `send`. */
  start(input: ClaudeInput, prompt: string): void {
    this.input = input;
    if (input.write(userMessage(prompt))) this.unacked.push({ text: prompt, prompt: true });
    else this.closed = true;
  }

  /** A new message for the running session; false when it can't take one any more. */
  send(text: string): boolean {
    if (!this.input || this.closed) return false;
    if (!this.input.write(userMessage(text))) {
      this.closed = true;
      return false;
    }
    this.unacked.push({ text, prompt: false });
    this.clearIdle();
    return true;
  }

  /** Closes stdin: the session ends after what it is doing. */
  close(): void {
    this.clearIdle();
    if (this.closed || !this.input) return;
    this.closed = true;
    this.input.end();
  }

  private clearIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  line(line: string, stream: 'stdout' | 'stderr'): void {
    const event = parseJsonLine(line);
    if (!event) {
      if (!line.trim()) return;
      if (stream === 'stderr') {
        this.stderr.push(line);
        if (this.stderr.length > 50) this.stderr.shift();
        this.onEvent({ type: 'log', text: line });
        return;
      }
      this.onEvent({ type: 'output', text: line });
      return;
    }
    const sessionId = str(event.session_id);
    if (sessionId && sessionId !== this.result.sessionId) {
      this.result.sessionId = sessionId;
      this.onEvent({ type: 'session', sessionId });
    }
    if (event.type === 'user') this.onUser(event);
    if (event.type === 'assistant') this.onAssistant(event);
    if (event.type === 'rate_limit_event') {
      const info = (event.rate_limit_info ?? {}) as { status?: unknown; resetsAt?: unknown };
      if (info.status === 'rejected') {
        const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;
        if (resetsAt) this.rateLimitResetAt = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
        this.harnessErrors.push(
          `Claude usage limit reached${resetsAt ? `|${String(resetsAt)}` : ''}`,
        );
      }
    }
    if (event.type === 'result') this.onResult(event);
  }

  private onUser(event: Record<string, unknown>) {
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (event.isReplay === true) {
      // A message we wrote, taken into the session.
      const text = resultText(content) ?? '';
      const index = this.unacked.findIndex((item) => item.text === text);
      const [taken] = index >= 0 ? this.unacked.splice(index, 1) : [];
      if (taken && !taken.prompt) this.onEvent({ type: 'delivered' });
      return;
    }
    for (const block of Array.isArray(content) ? content : []) {
      const item = block as { type?: string; tool_use_id?: string; content?: unknown };
      if (item.type !== 'tool_result' || !item.tool_use_id) continue;
      const call = this.tools.get(item.tool_use_id);
      if (!call) continue;
      this.tools.delete(item.tool_use_id);
      for (const ref of batonToolTouches({
        name: call.name,
        input: call.input,
        output: resultText(item.content),
        failed: (block as { is_error?: unknown }).is_error === true,
      })) {
        this.onEvent({ type: 'touched', item: ref });
      }
    }
  }

  private onAssistant(event: Record<string, unknown>) {
    const content = (event.message as { content?: unknown } | undefined)?.content;
    const texts: string[] = [];
    for (const block of Array.isArray(content) ? content : []) {
      const item = block as { type?: string; text?: string; name?: string; id?: string };
      if (item.type === 'text' && item.text) {
        texts.push(item.text);
        this.lastText = item.text;
        this.onEvent({ type: 'output', text: item.text });
      }
      if (item.type === 'tool_use' && item.name) {
        if (item.id) {
          this.tools.set(item.id, {
            name: item.name,
            input: (block as { input?: unknown }).input,
          });
        }
        this.onEvent({ type: 'status', text: `→ ${item.name}` });
      }
    }
    // Claude Code's own API errors (e.g. `rate_limit`) come as an assistant message marked so.
    const error = str(event.error);
    if (error) this.harnessErrors.push(texts.join('\n') || error);
  }

  private onResult(event: Record<string, unknown>) {
    const usage = (event.usage ?? {}) as Record<string, unknown>;
    this.result.tokensIn =
      num(usage.input_tokens) +
      num(usage.cache_creation_input_tokens) +
      num(usage.cache_read_input_tokens);
    this.result.tokensOut = num(usage.output_tokens);
    this.result.costUsd = num(event.total_cost_usd);
    const message = str(event.result) ?? '';
    if (event.is_error === true) {
      this.lastResultOk = false;
      this.harnessErrors.push(message || str(event.subtype) || 'Claude Code reported an error');
    } else {
      this.lastResultOk = true;
    }
    // The result repeats the last message; show it only when it's new.
    if (message && message.trim() !== this.lastText.trim()) {
      this.onEvent({ type: 'output', text: message });
    }
    if (!this.input || this.closed) return;
    // A result means the prompt was read, replayed or not.
    for (let index = this.unacked.length - 1; index >= 0; index -= 1) {
      if (this.unacked[index]?.prompt) this.unacked.splice(index, 1);
    }
    // Done unless a message written meanwhile is still to be taken in (it starts the next turn).
    if (this.unacked.length === 0) this.close();
    else {
      this.clearIdle();
      this.idle = setTimeout(() => this.close(), this.idleMs);
      this.idle.unref?.();
    }
  }

  finish(code: number | null, aborted: boolean): RunResult {
    this.clearIdle();
    this.closed = true;
    const { result } = this;
    const succeeded = this.lastResultOk === true;
    const usage = usageLimitOf({ succeeded, errors: this.harnessErrors, stderr: this.stderr });
    if (aborted) result.outcome = 'killed';
    else if (succeeded) result.outcome = 'done';
    else if (usage.limited) result.outcome = 'out_of_usage';
    else result.outcome = 'failed';
    result.resetAt =
      result.outcome === 'out_of_usage' ? (usage.resetAt ?? this.rateLimitResetAt) : null;
    result.error =
      result.outcome === 'done' || result.outcome === 'killed'
        ? null
        : (usage.message ??
          this.harnessErrors.at(-1) ??
          this.stderr.at(-1) ??
          `Claude Code exited with code ${String(code)} without a result`);
    return result;
  }
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
      const streaming = text.includes('--input-format') && text.includes('--replay-user-messages');
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (streaming) args.push('--input-format', 'stream-json', '--replay-user-messages');
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

      const session = new ClaudeSession(options.onEvent, options.resumeId);
      const run = spawnLines(command(), args, {
        cwd: options.cwd,
        stdin: streaming ? null : options.prompt,
        keepStdinOpen: streaming,
        signal: options.signal,
        onLine: (line, stream) => session.line(line, stream),
      });
      if (streaming) {
        session.start(run, options.prompt);
        options.attach?.({ send: (message) => session.send(message) });
      }
      const code = await run.exit;
      const result = session.finish(code, options.signal.aborted);
      result.durationMs = Date.now() - started;
      return result;
    },
  };
}
