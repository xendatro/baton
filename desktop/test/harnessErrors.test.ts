import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnLines } from '../src/main/harness/process';
import { ClaudeSession, userMessage } from '../src/main/harness/claude';
import { CliRunReader } from '../src/main/harness/cli';
import { CODEX_WORKSPACE_NETWORK, codexSpec } from '../src/main/harness/others';
import type { HarnessEvent, RunOptions } from '../src/main/harness/types';

/**
 * BAT#30: a run is out of usage only from the harness's own error signal, never from what the
 * agent says or reads; BAT#31: Claude Code's streaming input; BAT#28: the Baton items a run
 * touched, from its tool calls. Output is fed line by line, with no processes.
 */

const line = (event: unknown) => JSON.stringify(event);

function codexRun(lines: Array<[unknown, ('stdout' | 'stderr')?]>, code: number) {
  const events: HarnessEvent[] = [];
  const reader = new CliRunReader(codexSpec, null, (event) => events.push(event));
  for (const [value, stream] of lines) {
    reader.line(typeof value === 'string' ? value : line(value), stream ?? 'stdout');
  }
  return { result: reader.finish(code, false), events };
}

const agentSays = (text: string) => ({
  type: 'item.completed',
  item: { id: 'i1', type: 'agent_message', text },
});
const commandPrints = (output: string) => ({
  type: 'item.completed',
  item: { id: 'i2', type: 'command_execution', command: 'npm test', aggregated_output: output },
});

describe('codex: out of usage only from Codex’s own errors', () => {
  it('ignores rate limits the agent writes about or commands print', () => {
    const { result } = codexRun(
      [
        [{ type: 'thread.started', thread_id: 'th-1' }],
        [agentSays('The API has a rate limit of 100 requests; I added a usage limit check.')],
        [commandPrints('Error: 429 Too Many Requests\nresource_exhausted: quota exceeded')],
        ['WARN rate limited upstream, retrying', 'stderr'],
      ],
      0,
    );
    expect(result).toMatchObject({ outcome: 'done', sessionId: 'th-1', resetAt: null });
  });

  it('a failed run with rate limits only in the agent’s content is failed, with Codex’s error', () => {
    const { result } = codexRun(
      [
        [agentSays('Hit a rate limit in the tests, too many requests.')],
        [commandPrints('429 Too Many Requests')],
        [
          {
            type: 'turn.failed',
            error: { message: 'sandbox denied: write outside the workspace' },
          },
        ],
      ],
      1,
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      error: 'sandbox denied: write outside the workspace',
    });
  });

  it('a real usage-limit error from Codex is out of usage, with the reset it names', () => {
    const before = Date.now();
    const { result } = codexRun(
      [
        [agentSays('Working on it')],
        [
          {
            type: 'error',
            message: 'You’ve hit your usage limit. Upgrade or try again in 3 hours.',
          },
        ],
        [{ type: 'turn.failed', error: { message: 'You’ve hit your usage limit.' } }],
      ],
      1,
    );
    expect(result.outcome).toBe('out_of_usage');
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 3 * 3_600_000);
    expect(result.error).toContain('usage limit');
  });

  it('reports the Baton tasks a run created or replied in', () => {
    const { events } = codexRun(
      [
        [
          {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'baton_app',
              tool: 'create_task',
              arguments: { project: 'BAT', title: 'Follow-up' },
              result: { content: [{ type: 'text', text: line({ id: 'task-9', ref: 'BAT-9' }) }] },
              status: 'completed',
            },
          },
        ],
        [
          {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'baton_app',
              tool: 'add_reply',
              arguments: { item: 'BAT-3', body: 'Done' },
              result: { content: [] },
              status: 'completed',
            },
          },
        ],
        [
          {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'github',
              tool: 'create_issue',
              arguments: {},
              result: { content: [{ type: 'text', text: line({ id: 'gh-1' }) }] },
            },
          },
        ],
      ],
      0,
    );
    expect(events.filter((event) => event.type === 'touched')).toEqual([
      { type: 'touched', item: 'task-9' },
      { type: 'touched', item: 'BAT-3' },
    ]);
  });
});

describe('codex: sandbox modes', () => {
  const options = {
    cwd: '/w',
    prompt: 'Do it',
    model: '',
    effort: '',
    resumeId: null,
    permissionMode: 'full-auto',
    mcp: null,
    signal: new AbortController().signal,
    onEvent: () => undefined,
  } satisfies RunOptions;
  const build = (help: string, permissionMode = 'full-auto') =>
    codexSpec.build({
      help,
      options: { ...options, permissionMode },
      promptArg: 'Do it',
      hasBaton: true,
    }).args;

  it('Full auto is the workspace-write sandbox with network access', () => {
    const help =
      '-c, --config <key=value>\n-s, --sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]\n--json\n--skip-git-repo-check';
    const args = build(help);
    expect(args).toEqual(
      expect.arrayContaining(['--sandbox', 'workspace-write', '-c', CODEX_WORKSPACE_NETWORK]),
    );
    expect(args).not.toContain('--full-auto');
    expect(build(help, 'read-only')).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(build(help, 'read-only')).not.toContain(CODEX_WORKSPACE_NETWORK);
  });

  it('uses --full-auto on CLIs that only have it', () => {
    expect(build('--full-auto\n--json')).toEqual(
      expect.arrayContaining(['--full-auto', '-c', CODEX_WORKSPACE_NETWORK]),
    );
  });
});

/** A Claude session fed line by line, with a fake stdin. */
function claude(streaming = true) {
  const events: HarnessEvent[] = [];
  const written: string[] = [];
  const input = { ended: false };
  const session = new ClaudeSession((event) => events.push(event), null, 50);
  if (streaming) {
    session.start(
      {
        write: (text) => {
          if (input.ended) return false;
          written.push(text);
          return true;
        },
        end: () => {
          input.ended = true;
        },
      },
      'Do the job',
    );
  }
  const feed = (value: unknown, stream: 'stdout' | 'stderr' = 'stdout') =>
    session.line(typeof value === 'string' ? value : line(value), stream);
  const replay = (text: string) =>
    feed({
      type: 'user',
      isReplay: true,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  return { session, events, written, input, feed, replay };
}

const success = { type: 'result', subtype: 'success', is_error: false, result: 'Done.' };

describe('claude: out of usage only from Claude Code’s own errors', () => {
  it('ignores rate limits in what the agent writes and in tool results', () => {
    const { session, feed } = claude(false);
    feed({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Added a rate limit: 429 Too Many Requests.' }] },
    });
    feed({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'usage limit reached' }],
      },
    });
    feed('npm WARN rate limited', 'stderr');
    feed(success);
    expect(session.finish(0, false)).toMatchObject({ outcome: 'done', resetAt: null });
  });

  it('a failed run shows Claude Code’s error, not "out of usage", when the limit is only in content', () => {
    const { session, feed } = claude(false);
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'rate limit hit' }] } });
    feed({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
    expect(session.finish(1, false)).toMatchObject({
      outcome: 'failed',
      error: 'error_during_execution',
    });
  });

  it('a usage-limit result, an assistant API error or a rejected rate-limit event is out of usage', () => {
    const one = claude(false);
    one.feed({
      type: 'result',
      is_error: true,
      result: 'Claude AI usage limit reached|1767225600',
    });
    expect(one.session.finish(1, false)).toMatchObject({
      outcome: 'out_of_usage',
      resetAt: 1767225600 * 1000,
    });
    const two = claude(false);
    two.feed({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1790721600 },
    });
    two.feed({
      type: 'assistant',
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'You’ve hit your limit · resets 1am' }] },
    });
    two.feed({ type: 'result', is_error: true, result: 'You’ve hit your limit · resets 1am' });
    expect(two.session.finish(1, false)).toMatchObject({
      outcome: 'out_of_usage',
      resetAt: 1790721600 * 1000,
    });
  });
});

describe('spawnLines with stdin kept open', () => {
  it('writes more after the start and ends when stdin closes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'baton-stdin-'));
    const script = path.join(dir, 'echo.cjs');
    writeFileSync(
      script,
      "require('readline').createInterface({ input: process.stdin }).on('line', (l) => console.log('got ' + l));",
    );
    const lines: string[] = [];
    const run = spawnLines('node', [script], {
      cwd: dir,
      stdin: 'first\n',
      keepStdinOpen: true,
      signal: new AbortController().signal,
      onLine: (text) => lines.push(text),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(run.write('second\n')).toBe(true);
    run.end();
    expect(await run.exit).toBe(0);
    expect(run.write('late\n')).toBe(false);
    expect(lines).toEqual(['got first', 'got second']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('claude: streaming input (BAT#31)', () => {
  it('writes the prompt, takes a message mid-run and closes stdin once everything was taken in', () => {
    const { session, events, written, input, feed, replay } = claude();
    expect(written).toEqual([userMessage('Do the job')]);
    replay('Do the job');
    expect(session.send('Also add tests')).toBe(true);
    expect(written).toHaveLength(2);
    replay('Also add tests');
    expect(events).toContainEqual({ type: 'delivered' });
    expect(events.filter((event) => event.type === 'delivered')).toHaveLength(1);
    feed(success);
    expect(input.ended).toBe(true);
    expect(session.send('Too late')).toBe(false);
    expect(session.finish(0, false).outcome).toBe('done');
  });

  it('closes stdin after the result of a plain run, prompt replayed or not', () => {
    const { input, feed } = claude();
    feed(success);
    expect(input.ended).toBe(true);
  });

  it('keeps stdin open after a result while a message is still to be taken in', async () => {
    const { session, input, feed, replay } = claude();
    replay('Do the job');
    session.send('One more thing');
    feed(success);
    expect(input.ended).toBe(false);
    replay('One more thing');
    feed(success);
    expect(input.ended).toBe(true);
    // Not taken in at all: stdin closes after the idle wait anyway.
    const late = claude();
    late.replay('Do the job');
    late.session.send('Lost');
    late.feed(success);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(late.input.ended).toBe(true);
  });

  it('reports the Baton items its tool calls created or replied in (BAT#28)', () => {
    const { events, feed } = claude(false);
    feed({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu1', name: 'mcp__baton_app__create_task', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'mcp__baton__add_reply', input: { item: 'BAT-4' } },
          { type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    feed({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [{ type: 'text', text: line({ id: 'task-7', ref: 'BAT-7' }) }],
          },
          { type: 'tool_result', tool_use_id: 'tu2', content: '{"id":"reply-1"}' },
          { type: 'tool_result', tool_use_id: 'tu3', content: 'create_task' },
        ],
      },
    });
    expect(events.filter((event) => event.type === 'touched')).toEqual([
      { type: 'touched', item: 'task-7' },
      { type: 'touched', item: 'BAT-4' },
    ]);
  });
});
