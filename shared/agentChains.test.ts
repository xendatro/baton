import { describe, expect, it } from 'vitest';
import { resolveChain, runnableChain } from './agentChains';
import type { Chain } from './schemas/agentRunner';

const levels = [
  { id: 'easy', name: 'Easy', position: 0 },
  { id: 'normal', name: 'Normal', position: 1 },
  { id: 'hard', name: 'Hard', position: 2 },
];
const opus: Chain = [{ harness: 'claude', model: 'opus', effort: 'high' }];
const sonnet: Chain = [{ harness: 'claude', model: 'sonnet', effort: '' }];
const codex: Chain = [{ harness: 'codex', model: '', effort: 'high' }];

describe('resolveChain', () => {
  it('uses the level’s own mapping', () => {
    expect(
      resolveChain({
        levels,
        difficultyId: 'hard',
        project: { levels: { hard: codex } },
        defaults: { chain: opus, levels: {} },
      }),
    ).toEqual({ chain: codex, source: 'Hard' });
  });

  it('falls back to the closest mapped level below, then above', () => {
    const project = { levels: { easy: sonnet, hard: codex } };
    expect(resolveChain({ levels, difficultyId: 'normal', project, defaults: null })).toEqual({
      chain: sonnet,
      source: 'Easy (closest mapped level)',
    });
    expect(
      resolveChain({
        levels,
        difficultyId: 'easy',
        project: { levels: { hard: codex } },
        defaults: null,
      }),
    ).toEqual({ chain: codex, source: 'Hard (closest mapped level)' });
  });

  it('then the account default for a level of that name, then the default chain', () => {
    const defaults = { chain: opus, levels: { hard: codex } };
    expect(resolveChain({ levels, difficultyId: 'hard', project: null, defaults })).toEqual({
      chain: codex,
      source: 'Hard (account default)',
    });
    expect(resolveChain({ levels, difficultyId: 'easy', project: null, defaults })).toEqual({
      chain: opus,
      source: 'account default',
    });
  });

  it('uses the default chain for tasks without a level, and Claude opus without any mapping', () => {
    expect(
      resolveChain({
        levels,
        difficultyId: null,
        project: { levels: { easy: sonnet } },
        defaults: { chain: codex, levels: {} },
      }),
    ).toEqual({ chain: codex, source: 'account default' });
    expect(
      resolveChain({ levels, difficultyId: null, project: null, defaults: null }).chain,
    ).toEqual(opus);
  });
});

describe('runnableChain', () => {
  it('skips harnesses that aren’t installed or are out of usage until later', () => {
    const chain: Chain = [...opus, ...codex, { harness: 'gemini', model: '', effort: '' }];
    expect(runnableChain(chain, new Set(['claude', 'codex']))).toEqual([...opus, ...codex]);
    expect(
      runnableChain(chain, new Set(['claude', 'codex']), new Map([['claude', 2_000]]), 1_000),
    ).toEqual(codex);
    expect(
      runnableChain(chain, new Set(['claude', 'codex']), new Map([['claude', 500]]), 1_000),
    ).toEqual([...opus, ...codex]);
  });
});
