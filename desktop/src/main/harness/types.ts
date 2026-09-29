import type { HarnessId } from '@shared/schemas/agentRunner';

/**
 * A harness adapter (BAT-24): how the desktop app finds a headless coding agent (Claude Code,
 * Codex, …), which models it offers, and how it runs one job in a folder, resuming an earlier
 * session of the same task when there is one.
 */

export interface DetectResult {
  installed: boolean;
  /** Absolute path of the CLI, when found. */
  path: string | null;
  version: string | null;
}

/** A permission mode the harness offers for headless runs. */
export interface PermissionMode {
  id: string;
  label: string;
  /** Explains what it allows. */
  description: string;
  /** Works with nobody at the keyboard (manual approval doesn't). */
  unattended: boolean;
  /** Approvals are asked through the app (Allow / Deny pop-ups). */
  viaApp?: boolean;
}

/** The Baton MCP server to add when the harness doesn't have one already. */
export interface McpInjection {
  url: string;
  apiKey: string;
  /** Claude only: the app's permission-prompt MCP server (Allow / Deny pop-ups). */
  permissionServer?: { url: string; token: string } | null;
}

export type HarnessEvent =
  | { type: 'output'; text: string }
  /** The harness's own diagnostics on stderr (not the agent's work): shown only if the run fails. */
  | { type: 'log'; text: string }
  | { type: 'session'; sessionId: string }
  | { type: 'status'; text: string }
  /** A message sent with `RunControls.send` was taken into the session (BAT#31). */
  | { type: 'delivered' }
  /**
   * A Baton task or issue the run created or replied in (id or ref, from the harness's own
   * tool-call events), so a later job about it can resume this session (BAT#28).
   */
  | { type: 'touched'; item: string };

/** What a running harness session offers besides being killed. */
export interface RunControls {
  /**
   * Hands the running session a new user message, picked up at its next turn boundary (after
   * the current tool call); a `delivered` event follows once it has. False when the session can't
   * take one any more (it is finishing): run it afterwards instead.
   */
  send(text: string): boolean;
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  /** Alias or id; empty for the harness's default. */
  model: string;
  /** Empty for the harness's default. */
  effort: string;
  resumeId: string | null;
  permissionMode: string;
  mcp: McpInjection | null;
  signal: AbortSignal;
  onEvent: (event: HarnessEvent) => void;
  /**
   * Called once the session runs, by harnesses that take messages mid-run (Claude Code's
   * streaming input); harnesses without it never call it.
   */
  attach?: (controls: RunControls) => void;
}

export type RunOutcome = 'done' | 'failed' | 'out_of_usage' | 'killed' | 'permission_denied';

export interface RunResult {
  outcome: RunOutcome;
  sessionId: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  /** Out of usage: when the harness said it resets (ms since epoch), if it did. */
  resetAt: number | null;
  /**
   * Not done: the harness's own last error (an error event, or stderr of a failed exit), e.g. a
   * sandbox refusal or the usage-limit message.
   */
  error: string | null;
}

export interface HarnessAdapter {
  id: HarnessId;
  label: string;
  /** How the headless mode is started (for the setup guide). */
  headless: string;
  detect(): Promise<DetectResult>;
  /** Aliases and whatever the harness reports about itself; free text is always accepted too. */
  listModels(): Promise<string[]>;
  permissionModes: PermissionMode[];
  run(options: RunOptions): Promise<RunResult>;
}
