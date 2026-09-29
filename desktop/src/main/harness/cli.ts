import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessId } from '@shared/schemas/agentRunner';
import type { HarnessAdapter, HarnessEvent, PermissionMode, RunOptions, RunResult } from './types';
import { capture, num, parseJsonLine, spawnLines, str, which } from './process';
import { mcpListReaches } from './mcpList';
import { usageLimitOf } from './usageLimits';

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
  /**
   * The message of a JSON event that is the harness's own error (not the agent's messages, tool
   * or command output, which can say anything), or null. Only these, and stderr of a failed
   * run, can make a run "out of usage" (BAT#30). Default: `{ type: 'error', message }`.
   */
  harnessError?(event: Record<string, unknown>): string | null;
}

/** `{ type: 'error', message | error: { message } }`. */
export function errorEventMessage(event: Record<string, unknown>): string | null {
  if (event.type !== 'error') return null;
  return eventMessage(event) ?? 'error';
}

/** `message`, or `error.message`, or `error` as text. */
export function eventMessage(event: Record<string, unknown>): string | null {
  const error = event.error;
  return (
    str(event.message) ??
    str((error as { message?: unknown } | undefined)?.message) ??
    (typeof error === 'string' ? str(error) : null)
  );
}

/** Stderr lines kept for the error and the usage check. */
const STDERR_LINES = 50;

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

/**
 * Reads one run's output lines into its result: JSON events go to the spec, stderr is the
 * harness's own log. How the run ended is decided from the exit code and the harness's own
 * errors only (BAT#30): exit 0 is done, never out of usage.
 */
export class CliRunReader {
  readonly result: RunResult;
  private readonly harnessErrors: string[] = [];
  private readonly stderr: string[] = [];

  constructor(
    private readonly spec: Pick<CliSpec, 'label' | 'parse' | 'harnessError'>,
    resumeId: string | null,
    private readonly onEvent: (event: HarnessEvent) => void,
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

  private readonly emit = (event: HarnessEvent) => {
    if (event.type === 'session') this.result.sessionId = event.sessionId;
    this.onEvent(event);
  };

  line(line: string, stream: 'stdout' | 'stderr'): void {
    if (!line.trim()) return;
    const event = parseJsonLine(line);
    if (event) {
      this.spec.parse(event, this.result, this.emit);
      const error = (this.spec.harnessError ?? errorEventMessage)(event);
      if (error) this.harnessErrors.push(error);
      return;
    }
    if (stream === 'stderr') {
      this.stderr.push(line);
      if (this.stderr.length > STDERR_LINES) this.stderr.shift();
      this.emit({ type: 'log', text: line });
      return;
    }
    this.emit({ type: 'output', text: line });
  }

  finish(code: number | null, aborted: boolean): RunResult {
    const { result } = this;
    const usage = usageLimitOf({
      succeeded: code === 0,
      errors: this.harnessErrors,
      stderr: this.stderr,
    });
    if (aborted) result.outcome = 'killed';
    else if (code === 0) result.outcome = 'done';
    else if (usage.limited) result.outcome = 'out_of_usage';
    else result.outcome = 'failed';
    result.resetAt = result.outcome === 'out_of_usage' ? usage.resetAt : null;
    result.error =
      result.outcome === 'done' || result.outcome === 'killed'
        ? null
        : (usage.message ??
          this.harnessErrors.at(-1) ??
          this.stderr.at(-1) ??
          `${this.spec.label} exited with code ${String(code)}`);
    return result;
  }
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
      const reader = new CliRunReader(spec, options.resumeId, options.onEvent);
      const run = spawnLines(command(), built.args, {
        cwd: options.cwd,
        stdin: built.stdin,
        env: built.env,
        signal: options.signal,
        onLine: (line, stream) => reader.line(line, stream),
      });
      const code = await run.exit;
      const result = reader.finish(code, options.signal.aborted);
      result.durationMs = Date.now() - started;
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
