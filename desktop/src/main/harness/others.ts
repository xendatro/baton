import type { HarnessEvent, RunResult } from './types';
import { cliAdapter, errorEventMessage, eventMessage, flag, num, str, type CliSpec } from './cli';
import { batonToolTouches, resultText } from './touches';

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

function addUsage(result: RunResult, usage: unknown) {
  const value = (usage ?? {}) as Record<string, unknown>;
  result.tokensIn += num(value.input_tokens) + num(value.inputTokens) + num(value.prompt_tokens);
  result.tokensOut +=
    num(value.output_tokens) + num(value.outputTokens) + num(value.completion_tokens);
  result.costUsd += num(value.cost_usd) + num(value.cost);
}

/**
 * Codex's workspace-write sandbox with network access: `sandbox_workspace_write.network_access`
 * is a key of Codex's config.toml (`[sandbox_workspace_write] network_access = true`), set per
 * run with `-c` (BAT#30). Without it the sandbox blocks all network, so npm, pip or a git
 * fetch fail.
 */
export const CODEX_WORKSPACE_NETWORK = 'sandbox_workspace_write.network_access=true';

/**
 * Codex: `codex exec --json -` (prompt on stdin), `codex exec resume <thread> …`. Checked against
 * `codex exec --help` of codex-cli 0.147: `--sandbox read-only|workspace-write|danger-full-access`,
 * `--dangerously-bypass-approvals-and-sandbox`, `-c key=value`. `--full-auto` (older CLIs'
 * shorthand for the workspace-write sandbox) isn't listed any more, and passing nothing leaves
 * Codex in whatever sandbox the user's config gives (read-only by default), so "Full auto" passes
 * `--sandbox workspace-write` when the help lists it and `--full-auto` only on CLIs that still
 * have it.
 */
export const codexSpec: CliSpec = {
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
      label: 'Full auto (workspace-write sandbox)',
      description:
        'Codex’s workspace-write sandbox: edits files and runs commands in the project folder, with network access turned on (so npm, pip and git can download and push). It blocks writing anywhere outside the project folder and the temp folder (your home folder, other repositories, global installs); commands that need that fail instead of asking. Choose “No sandbox” for jobs that need more.',
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
      label: 'No sandbox, no approvals (full access)',
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
    } else if (help.includes('--sandbox') && help.includes('workspace-write')) {
      args.push('--sandbox', 'workspace-write', '-c', CODEX_WORKSPACE_NETWORK);
    } else if (help.includes('--full-auto')) {
      args.push('--full-auto', '-c', CODEX_WORKSPACE_NETWORK);
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
      } else if (itemType === 'mcp_tool_call' && event.type === 'item.completed') {
        const output = (item.result ?? {}) as Record<string, unknown>;
        const touched = batonToolTouches({
          name: str(item.tool) ?? str(item.name) ?? '',
          server: str(item.server),
          input: item.arguments,
          output:
            resultText(output.content) ??
            (output.structured_content ? JSON.stringify(output.structured_content) : null),
          failed: item.status === 'failed' || Boolean(item.error),
        });
        for (const ref of touched) emit({ type: 'touched', item: ref });
      }
    }
    if (event.type === 'turn.completed') addUsage(result, event.usage);
    if (event.type === 'turn.failed' || event.type === 'error') {
      const message = eventMessage(event);
      if (message) emit({ type: 'output', text: message });
    }
  },
  // Codex's own errors: the stream failing (`error`) or the turn failing (`turn.failed`). Items
  // (agent messages, command output, file changes) are the agent's work and never count.
  harnessError(event) {
    if (event.type === 'turn.failed') return eventMessage(event) ?? 'The turn failed';
    return errorEventMessage(event);
  },
};
export const codexAdapter = cliAdapter(codexSpec);

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
  harnessError(event) {
    if (event.type === 'result' && event.status === 'error') return eventMessage(event) ?? 'error';
    return errorEventMessage(event);
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
  harnessError(event) {
    if (event.type === 'result' && (event.is_error === true || event.subtype === 'error')) {
      return str(event.result) ?? eventMessage(event) ?? 'error';
    }
    return errorEventMessage(event);
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
      addUsage(result, (part.tokens as Record<string, unknown> | undefined) ?? event.tokens);
      result.costUsd += num(part.cost);
    }
  },
  harnessError(event) {
    if (event.type !== 'error') return null;
    const data = ((event.error as { data?: unknown } | undefined)?.data ?? {}) as {
      message?: unknown;
    };
    return str(data.message) ?? eventMessage(event) ?? 'error';
  },
});
