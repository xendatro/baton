import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/main/harness/claude';
import type { HarnessEvent } from '../src/main/harness/types';

/**
 * The Claude Code adapter against a fake `claude` on PATH that records its arguments and stdin
 * and prints stream-json the way `claude -p --output-format stream-json --verbose` does.
 */

let dir: string;
let oldPath: string | undefined;

function fakeClaude(script: string) {
  const file = path.join(dir, 'claude');
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--help')) { console.log('--effort <level> --model <model> (e.g. \\'fable\\', \\'opus\\', or \\'sonnet\\')'); process.exit(0); }
if (process.argv.includes('--version')) { console.log('2.1.283 (Claude Code)'); process.exit(0); }
if (process.argv[2] === 'mcp') { console.log('github: https://x - ✓ Connected'); process.exit(0); }
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(path.join('DIR', 'call.json'))}.replace('DIR', __dirname), JSON.stringify({ args: process.argv.slice(2), stdin }));
${script}
`,
  );
  chmodSync(file, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'baton-claude-'));
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
});

afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

const run = async (permissionMode = 'auto', resumeId: string | null = null) => {
  const adapter = claudeAdapter();
  expect(await adapter.detect()).toMatchObject({ installed: true, version: '2.1.283' });
  const events: HarnessEvent[] = [];
  const result = await adapter.run({
    cwd: dir,
    prompt: 'Do the job',
    model: 'opus',
    effort: 'high',
    resumeId,
    permissionMode,
    mcp: {
      url: 'https://baton/mcp',
      apiKey: 'bat_x',
      permissionServer: { url: 'http://127.0.0.1:1/mcp/job', token: 't' },
    },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  const call = JSON.parse(
    (await import('node:fs')).readFileSync(path.join(dir, 'call.json'), 'utf8'),
  ) as { args: string[]; stdin: string };
  return { result, events, call };
};

describe.skipIf(process.platform === 'win32')('claude adapter', () => {
  it('runs claude -p with the model, effort, resume and the Baton MCP, and reads the result', async () => {
    fakeClaude(`
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-42' }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }, { type: 'tool_use', name: 'Bash' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sess-42', total_cost_usd: 0.12, usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 } }));
`);
    const { result, events, call } = await run('auto', 'sess-41');
    expect(call.stdin).toBe('Do the job');
    expect(call.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        'opus',
        '--effort',
        'high',
        '--resume',
        'sess-41',
        '--permission-mode',
        'auto',
        '--mcp-config',
      ]),
    );
    expect(result).toMatchObject({
      outcome: 'done',
      sessionId: 'sess-42',
      tokensIn: 150,
      tokensOut: 20,
      costUsd: 0.12,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'session', sessionId: 'sess-42' },
        { type: 'output', text: 'Working on it' },
        { type: 'status', text: '→ Bash' },
      ]),
    );
  });

  it('asks through the app’s permission tool, and reports running out of usage', async () => {
    fakeClaude(`
console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Claude AI usage limit reached|1767225600', session_id: 's' }));
process.exit(1);
`);
    const { result, call } = await run('app');
    expect(call.args).toEqual(
      expect.arrayContaining(['--permission-prompt-tool', 'mcp__baton_desktop__approve']),
    );
    expect(call.args).not.toContain('--permission-mode');
    expect(result).toMatchObject({ outcome: 'out_of_usage', resetAt: 1767225600 * 1000 });
  });
});
