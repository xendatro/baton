import type { HarnessEvent, RunResult } from './types';
import { cliAdapter, flag, num, str } from './cli';

/**
 * Codex, Gemini CLI, Cursor CLI and opencode (BAT-24). Not installed on the machine the app was
 * written on, so every flag is checked against the CLI's own `--help` at run time; the JSON
 * events read are the documented ones of each CLI's headless mode.
 */

function text(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => (typeof part === 'string' ? part : str((part as { text?: unknown }).text)))
      .filter(Boolean);
    return parts.length ? parts.join('') : null;
  }
  return null;
}

/**
 * Adds a usage report. `tokensIn` counts all input (cache included) and `tokensOut` all output
 * (reasoning included), like Codex's own `input_tokens` / `output_tokens`; the cache and reasoning
 * counts break them down (BAT#25).
 */
function addUsage(result: RunResult, usage: unknown) {
  const value = (usage ?? {}) as Record<string, unknown>;
  result.tokensIn += num(value.input_tokens) + num(value.inputTokens) + num(value.prompt_tokens);
  result.tokensOut +=
    num(value.output_tokens) + num(value.outputTokens) + num(value.completion_tokens);
  result.cacheReadTokens =
    (result.cacheReadTokens ?? 0) +
    num(value.cached_input_tokens) +
    num(value.cache_read_input_tokens) +
    num(value.cached);
  result.reasoningTokens = (result.reasoningTokens ?? 0) + num(value.reasoning_output_tokens);
  result.costUsd += num(value.cost_usd) + num(value.cost);
}

/** opencode's `tokens { input, output, reasoning, cache: { read, write } }`: separate counts. */
function addOpencodeUsage(result: RunResult, tokens: unknown) {
  const value = (tokens ?? {}) as Record<string, unknown>;
  const cache = (value.cache ?? {}) as Record<string, unknown>;
  const read = num(cache.read);
  const write = num(cache.write);
  result.tokensIn += num(value.input) + read + write;
  result.tokensOut += num(value.output) + num(value.reasoning);
  result.cacheReadTokens = (result.cacheReadTokens ?? 0) + read;
  result.cacheWriteTokens = (result.cacheWriteTokens ?? 0) + write;
  result.reasoningTokens = (result.reasoningTokens ?? 0) + num(value.reasoning);
}

/** Codex: `codex exec --json -` (prompt on stdin), `codex exec resume <thread> …`. */
export const codexAdapter = cliAdapter({
  id: 'codex',
  label: 'Codex',
  headless: 'codex exec',
  commands: ['codex'],
  helpArgs: ['exec', '--help'],
  mcpListArgs: ['mcp', 'list'],
  aliases: [],
  modes: [
    {
      id: 'full-auto',
      label: 'Full auto (workspace write)',
      description: 'Edits files and runs commands inside the project folder, in Codex’s sandbox.',
      unattended: true,
    },
    {
      id: 'read-only',
      label: 'Read only',
      description: 'Reads files and runs read-only commands; it can’t change anything.',
      unattended: true,
    },
    {
      id: 'bypass',
      label: 'No sandbox, no approvals',
      description:
        'Everything runs without asking or sandboxing. Only for machines where that is safe.',
      unattended: true,
    },
  ],
  build({ help, options, hasBaton }) {
    const json =
      help.includes('--experimental-json') && !help.includes('--json')
        ? '--experimental-json'
        : '--json';
    const args = ['exec'];
    if (options.resumeId) args.push('resume', options.resumeId);
    args.push(json);
    if (options.model) args.push(...flag(help, '--model', options.model));
    if (options.effort) args.push('-c', `model_reasoning_effort="${options.effort}"`);
    if (options.permissionMode === 'bypass') {
      args.push(...flag(help, '--dangerously-bypass-approvals-and-sandbox'));
    } else if (options.permissionMode === 'read-only') {
      args.push(...flag(help, '--sandbox', 'read-only'));
    } else {
      args.push(...flag(help, '--full-auto'));
    }
    args.push(...flag(help, '--skip-git-repo-check'));
    const env: NodeJS.ProcessEnv = {};
    if (options.mcp && !hasBaton) {
      args.push('-c', `mcp_servers.baton_app.url="${options.mcp.url}"`);
      args.push('-c', 'mcp_servers.baton_app.bearer_token_env_var="BATON_API_KEY"');
      env.BATON_API_KEY = options.mcp.apiKey;
    }
    args.push('-');
    return { args, stdin: options.prompt, env };
  },
  parse(event, result, emit) {
    if (event.type === 'thread.started') {
      const id = str(event.thread_id);
      if (id) emit({ type: 'session', sessionId: id });
    }
    if (event.type === 'item.completed' || event.type === 'item.started') {
      const item = (event.item ?? {}) as Record<string, unknown>;
      const itemType = str(item.type) ?? str(item.item_type);
      if (itemType === 'agent_message' && event.type === 'item.completed') {
        const message = text(item.text);
        if (message) emit({ type: 'output', text: message });
      } else if (itemType === 'command_execution' && event.type === 'item.started') {
        emit({ type: 'status', text: `→ ${str(item.command) ?? 'command'}` });
      }
    }
    if (event.type === 'turn.completed') addUsage(result, event.usage);
    if (event.type === 'turn.failed' || event.type === 'error') {
      const message =
        str((event.error as { message?: unknown } | undefined)?.message) ?? str(event.message);
      if (message) emit({ type: 'output', text: message });
    }
  },
});

/** Gemini CLI: prompt on stdin, `--output-format stream-json` when available. */
export const geminiAdapter = cliAdapter({
  id: 'gemini',
  label: 'Gemini CLI',
  headless: 'gemini (prompt on stdin)',
  commands: ['gemini'],
  helpArgs: ['--help'],
  mcpListArgs: ['mcp', 'list'],
  aliases: [],
  modes: [
    {
      id: 'auto_edit',
      label: 'Auto-accept edits',
      description:
        'File edits are accepted; other tools still need approval (denied when nobody is there).',
      unattended: true,
    },
    {
      id: 'yolo',
      label: 'YOLO',
      description: 'Every tool call is accepted. Only for machines where that is safe.',
      unattended: true,
    },
  ],
  build({ help, options }) {
    const args: string[] = [];
    if (help.includes('stream-json')) args.push('--output-format', 'stream-json');
    if (options.model) args.push(...flag(help, '--model', options.model));
    if (options.resumeId) args.push(...flag(help, '--resume', options.resumeId));
    if (help.includes('--approval-mode'))
      args.push('--approval-mode', options.permissionMode || 'auto_edit');
    else if (options.permissionMode === 'yolo') args.push(...flag(help, '--yolo'));
    return { args, stdin: options.prompt };
  },
  parse(event, result, emit) {
    const id = str(event.session_id) ?? str(event.sessionId);
    if (id) emit({ type: 'session', sessionId: id });
    if (event.type === 'message' && event.role !== 'user') {
      const message = text(event.content);
      if (message) emit({ type: 'output', text: message });
    }
    if (event.type === 'tool_use')
      emit({ type: 'status', text: `→ ${str(event.tool_name) ?? 'tool'}` });
    if (event.type === 'result')
      addUsage(result, (event.stats as Record<string, unknown> | undefined) ?? event.usage);
  },
});

/** Cursor CLI: `cursor-agent -p "<prompt>" --output-format stream-json`. */
export const cursorAdapter = cliAdapter({
  id: 'cursor',
  label: 'Cursor CLI',
  headless: 'cursor-agent -p',
  commands: ['cursor-agent', 'agent'],
  helpArgs: ['--help'],
  aliases: [],
  modes: [
    {
      id: 'force',
      label: 'Allow commands (--force)',
      description: 'Runs commands without asking. Only for machines where that is safe.',
      unattended: true,
    },
    {
      id: 'default',
      label: 'Default',
      description: 'Cursor’s own rules; commands that would need approval are refused.',
      unattended: true,
    },
  ],
  build({ help, options, promptArg }) {
    const args = ['-p', promptArg, '--output-format', 'stream-json'];
    if (options.model) args.push(...flag(help, '--model', options.model));
    if (options.resumeId) args.push(...flag(help, '--resume', options.resumeId));
    if (options.permissionMode === 'force') args.push(...flag(help, '--force'));
    return { args, stdin: null };
  },
  parse(event, result, emit) {
    const id = str(event.session_id) ?? str(event.chatId);
    if (id) emit({ type: 'session', sessionId: id });
    if (event.type === 'assistant') {
      const message = text((event.message as { content?: unknown } | undefined)?.content);
      if (message) emit({ type: 'output', text: message });
    }
    if (event.type === 'result') {
      addUsage(result, event.usage);
      const message = str(event.result);
      if (message) emit({ type: 'output', text: message } satisfies HarnessEvent);
    }
  },
});

/** opencode: `opencode run "<prompt>" --format json`. */
export const opencodeAdapter = cliAdapter({
  id: 'opencode',
  label: 'opencode',
  headless: 'opencode run',
  commands: ['opencode'],
  helpArgs: ['run', '--help'],
  mcpListArgs: ['mcp', 'list'],
  aliases: [],
  modes: [
    {
      id: 'default',
      label: 'opencode’s permission config',
      description:
        'Whatever your opencode config allows; set tools to “allow” for unattended runs.',
      unattended: true,
    },
  ],
  build({ help, options, promptArg }) {
    const args = ['run', promptArg];
    if (help.includes('--format')) args.push('--format', 'json');
    if (options.model) args.push(...flag(help, '--model', options.model));
    if (options.resumeId) args.push(...flag(help, '--session', options.resumeId));
    return { args, stdin: null };
  },
  parse(event, result, emit) {
    const id = str(event.sessionID) ?? str(event.session_id);
    if (id) emit({ type: 'session', sessionId: id });
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === 'text' || part.type === 'text') {
      const message = str(part.text) ?? str(event.text);
      if (message) emit({ type: 'output', text: message });
    }
    if (event.type === 'step_finish' || part.type === 'step-finish') {
      const tokens = (part.tokens as Record<string, unknown> | undefined) ?? event.tokens;
      if (tokens && typeof tokens === 'object' && 'input' in tokens) {
        addOpencodeUsage(result, tokens);
      } else {
        addUsage(result, tokens);
      }
      result.costUsd += num(part.cost);
    }
  },
});
