import { describe, expect, it } from 'vitest';
import { resolveJobModel, runnableChain, stepLabel, withFirst } from './agentChains';
import type { Chain, ModelOptions } from './schemas/agentRunner';

const opus: Chain = [{ harness: 'claude', model: 'opus', effort: 'high' }];
const sonnet: Chain = [{ harness: 'claude', model: 'sonnet', effort: '' }];
const codex: Chain = [{ harness: 'codex', model: '', effort: 'high' }];
const sol = { harness: 'codex' as const, model: 'gpt-6-sol', effort: 'high' };
const haiku = { harness: 'claude' as const, model: 'haiku', effort: '' };

/** The owner's computers: Claude Code (opus, sonnet, haiku) and Codex (gpt-6-sol). */
const options: ModelOptions = {
  harnesses: [
    {
      id: 'claude',
      online: true,
      machines: ['Desk'],
      reported: true,
      models: ['opus', 'sonnet', 'haiku'].map((id) => ({
        id,
        label: null,
        efforts: ['low', 'high'],
        online: true,
      })),
      efforts: ['low', 'high'],
    },
    {
      id: 'codex',
      online: true,
      machines: ['Desk'],
      reported: true,
      models: [{ id: 'gpt-6-sol', label: null, efforts: ['high'], online: true }],
      efforts: ['high'],
    },
  ],
};
const claudeOnly: ModelOptions = { harnesses: options.harnesses.slice(0, 1) };

describe('resolveJobModel', () => {
  it('runs the model chosen when approving, exactly', () => {
    expect(
      resolveJobModel({
        override: codex,
        requester: { step: haiku, by: '@caden' },
        project: { chain: sonnet, name: 'API' },
        account: opus,
        options,
      }),
    ).toEqual({
      chain: codex,
      source: 'chosen by your owner when approving the request',
      modelSource: 'approval',
      skipped: [],
    });
  });

  it('takes the requester’s suggestion when a computer has it, the default after it', () => {
    const resolved = resolveJobModel({
      requester: { step: sol, by: '@caden' },
      stage: { step: haiku, stage: 'Planning' },
      project: { chain: sonnet, name: 'API' },
      account: opus,
      options,
    });
    expect(resolved.chain).toEqual([sol, ...sonnet]);
    expect(resolved.modelSource).toBe('requester');
    expect(resolved.source).toBe('suggested by @caden; then your default for API');
  });

  it('skips a suggestion no computer has, then uses the stage’s', () => {
    const resolved = resolveJobModel({
      requester: { step: sol, by: '@caden' },
      stage: { step: haiku, stage: 'Planning' },
      project: { chain: sonnet, name: 'API' },
      account: opus,
      options: claudeOnly,
    });
    expect(resolved.chain).toEqual([haiku, ...sonnet]);
    expect(resolved.modelSource).toBe('stage');
    expect(resolved.skipped).toEqual([
      'suggested by @caden (Codex · gpt-6-sol · high), not used: You don’t have Codex set up on any of your computers',
    ]);
  });

  it('falls back to the project default, then the account default, then Claude opus', () => {
    const unavailable = { step: sol, by: '@caden' };
    expect(
      resolveJobModel({
        requester: unavailable,
        project: { chain: sonnet, name: 'API' },
        account: opus,
        options: claudeOnly,
      }),
    ).toMatchObject({ chain: sonnet, modelSource: 'project', source: 'your default for API' });
    expect(
      resolveJobModel({ project: { chain: [], name: 'API' }, account: codex, options }),
    ).toMatchObject({ chain: codex, modelSource: 'account', source: 'your account default' });
    expect(resolveJobModel({})).toMatchObject({
      chain: [{ harness: 'claude', model: 'opus', effort: 'high' }],
      modelSource: 'account',
    });
  });

  it('takes suggestions as they are when no computer has reported yet', () => {
    expect(
      resolveJobModel({ stage: { step: sol, stage: 'Build' }, account: opus, options: null }),
    ).toMatchObject({ chain: [sol, ...opus], modelSource: 'stage' });
  });
});

describe('withFirst and stepLabel', () => {
  it('puts a step first without repeating it', () => {
    expect(withFirst(opus[0]!, [...sonnet, ...opus])).toEqual([...opus, ...sonnet]);
    expect(stepLabel(sol)).toBe('Codex · gpt-6-sol · high');
    expect(stepLabel({ harness: 'claude', model: '', effort: '' })).toBe('Claude Code');
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
