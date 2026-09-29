import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Spawning harness CLIs portably. On Windows, npm-installed CLIs are `.cmd` shims that only run
 * through a shell, so the prompt always goes in on stdin (never on the command line, where quoting
 * breaks) and a kill takes the whole process tree down.
 */

const run = promisify(execFile);
const isWindows = process.platform === 'win32';

/** The absolute path of a command on PATH, or null. */
export async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await run(isWindows ? 'where' : 'which', [command], { windowsHide: true });
    return (
      stdout
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim() ?? null
    );
  } catch {
    return null;
  }
}

/** Output of a quick command (`--version`, `--help`), or null when it fails. */
export async function capture(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      shell: isWindows,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    const text = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    return text.trim() ? text : null;
  }
}

export interface SpawnedRun {
  /** Resolves with the exit code (null when killed by a signal). */
  exit: Promise<number | null>;
  /** Writes to stdin while it is open (`keepStdinOpen`); false once it is closed. */
  write(text: string): boolean;
  /** Closes stdin (the harness finishes once it has read everything). */
  end(): void;
}

/**
 * Runs `command args` in `cwd`, writing `stdin` then closing it (or keeping it open for more with
 * `keepStdinOpen`), and calls `onLine` for each line of stdout and stderr. Aborting `signal` kills
 * the process tree.
 */
export function spawnLines(
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdin: string | null;
    /** Leave stdin open after `stdin` (write more with `write`, close with `end`). */
    keepStdinOpen?: boolean;
    env?: NodeJS.ProcessEnv;
    signal: AbortSignal;
    onLine: (line: string, stream: 'stdout' | 'stderr') => void;
  },
): SpawnedRun {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: isWindows,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const buffers = { stdout: '', stderr: '' };
  const feed = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    buffers[stream] += chunk.toString('utf8');
    const lines = buffers[stream].split(/\r?\n/);
    buffers[stream] = lines.pop() ?? '';
    for (const line of lines) options.onLine(line, stream);
  };
  child.stdout.on('data', feed('stdout'));
  child.stderr.on('data', feed('stderr'));
  const kill = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5_000).unref();
    }
  };
  if (options.signal.aborted) kill();
  else options.signal.addEventListener('abort', kill, { once: true });
  let stdinOpen = true;
  child.stdin.on('error', () => {
    stdinOpen = false;
  });
  const write = (text: string): boolean => {
    if (!stdinOpen || !child.stdin.writable) return false;
    child.stdin.write(text);
    return true;
  };
  const end = () => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin.end();
  };
  if (options.stdin !== null) write(options.stdin);
  if (!options.keepStdinOpen) end();
  const exit = new Promise<number | null>((resolve) => {
    child.on('error', (error) => {
      options.onLine(`Couldn’t start ${command}: ${error.message}`, 'stderr');
      resolve(1);
    });
    child.on('close', (code) => {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (buffers[stream]) options.onLine(buffers[stream], stream);
      }
      stdinOpen = false;
      options.signal.removeEventListener('abort', kill);
      resolve(code);
    });
  });
  return { exit, write, end };
}

/** A JSON object from a line of output, or null. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
