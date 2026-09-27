import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessId } from '@shared/schemas/agentRunner';
import type { HarnessAdapter, HarnessEvent, PermissionMode, RunOptions, RunResult } from './types';
import { capture, num, parseJsonLine, spawnLines, str, which } from './process';
import { mcpListReaches } from './mcpList';
import { isOutOfUsage, parseResetAt } from './usageLimits';

/**
 * Adapters for CLIs that print JSON lines (Codex, Gemini CLI, Cursor CLI, opencode). Their flags
 * change between versions, so each run reads the CLI's own `--help` first and only passes flags
 * it lists; output that isn't JSON is shown as plain text.
 */

export interface BuildContext {
  /** `--help` of the run command (e.g. `codex exec --help`). */
  help: string;
  options: RunOptions;
  /** The prompt as an argument: the text, or on Windows a pointer to a file holding it. */
  promptArg: string;
  /** Has the Baton MCP server already (the CLI's own config)? */
  hasBaton: boolean;
}

export interface CliSpec {
  id: HarnessId;
  label: string;
  headless: string;
  commands: readonly string[];
  /** Arguments that print the run command's help. */
  helpArgs: readonly string[];
  /** Arguments that list configured MCP servers (to see whether Baton is there). */
  mcpListArgs?: readonly string[];
  aliases: readonly string[];
  modes: PermissionMode[];
  build(context: BuildContext): { args: string[]; stdin: string | null; env?: NodeJS.ProcessEnv };
  /** Reads one JSON event into the result; emits what to show. */
  parse(
    event: Record<string, unknown>,
    result: RunResult,
    emit: (event: HarnessEvent) => void,
  ): void;
}

/**
 * On Windows the shell can't carry a multi-line argument, so the prompt goes into a file and the
 * argument asks the agent to read it.
 */
function promptArgument(prompt: string): string {
  if (process.platform !== 'win32') return prompt;
  const file = path.join(os.tmpdir(), `baton-prompt-${process.pid}-${Date.now()}.md`);
  writeFileSync(file, prompt, { mode: 0o600 });
  return `Read the file ${file} and follow the instructions in it exactly.`;
}

export function cliAdapter(spec: CliSpec): HarnessAdapter {
  let resolved: string | null = null;
  let helpText: string | null = null;
  const command = () => resolved ?? spec.commands[0] ?? spec.id;
  const help = async () => (helpText ??= (await capture(command(), [...spec.helpArgs])) ?? '');
  return {
    id: spec.id,
    label: spec.label,
    headless: spec.headless,
    async detect() {
      for (const name of spec.commands) {
        resolved = await which(name);
        if (resolved) break;
      }
      if (!resolved) return { installed: false, path: null, version: null };
      const version = (await capture(resolved, ['--version']))?.trim().split(/\s+/).pop() ?? null;
      return { installed: true, path: resolved, version };
    },
    async listModels() {
      return [...spec.aliases];
    },
    permissionModes: spec.modes,
    async run(options): Promise<RunResult> {
      const started = Date.now();
      const listed = spec.mcpListArgs
        ? await capture(command(), [...spec.mcpListArgs], 30_000)
        : null;
      const built = spec.build({
        help: await help(),
        options,
        promptArg: promptArgument(options.prompt),
        hasBaton:
          listed !== null && options.mcp !== null && mcpListReaches(listed, options.mcp.url),
      });
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
      let limited = false;
      let lastError: string | null = null;
      const emit = (event: HarnessEvent) => {
        if (event.type === 'session') result.sessionId = event.sessionId;
        options.onEvent(event);
      };
      const run = spawnLines(command(), built.args, {
        cwd: options.cwd,
        stdin: built.stdin,
        env: built.env,
        signal: options.signal,
        onLine: (line, stream) => {
          if (!line.trim()) return;
          if (isOutOfUsage(line)) {
            limited = true;
            result.resetAt = parseResetAt(line) ?? result.resetAt;
          }
          const event = parseJsonLine(line);
          if (event) {
            spec.parse(event, result, emit);
            const error =
              str((event.error as { message?: unknown } | undefined)?.message) ??
              str(event.message);
            if (event.type === 'error' && error) lastError = error;
            return;
          }
          if (stream === 'stderr') lastError = line;
          emit({ type: 'output', text: line });
        },
      });
      const code = await run.exit;
      result.durationMs = Date.now() - started;
      if (options.signal.aborted) result.outcome = 'killed';
      else if (limited) result.outcome = 'out_of_usage';
      else result.outcome = code === 0 ? 'done' : 'failed';
      result.error = result.outcome === 'done' ? null : lastError;
      return result;
    },
  };
}

/** Adds `flag value` only when the help text lists the flag. */
export function flag(help: string, name: string, value?: string): string[] {
  if (!help.includes(name)) return [];
  return value === undefined ? [name] : [name, value];
}

export { num, str };
