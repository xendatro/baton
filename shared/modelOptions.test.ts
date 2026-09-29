import { describe, expect, it } from 'vitest';
import { effortsFor, harnessOptionOf, stepAvailability, stepAvailabilityOf } from './modelOptions';
import type { ModelOptions } from './schemas/agentRunner';

/** Can a chain step run on one of the owner's computers (what their desktop apps report)? */

const options: ModelOptions = {
  harnesses: [
    {
      id: 'codex',
      online: true,
      machines: ['MSI'],
      reported: true,
      models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'], online: true }],
      efforts: ['minimal', 'low', 'medium', 'high'],
    },
    {
      id: 'gemini',
      online: false,
      machines: ['Laptop'],
      reported: false,
      models: [],
      efforts: [],
    },
  ],
};

describe('stepAvailability', () => {
  it('needs the harness, a reported model and one of its efforts', () => {
    expect(stepAvailability(options, { harness: 'codex', model: 'GPT-5', effort: 'high' })).toEqual(
      { available: true, message: null, unverified: false },
    );
    expect(stepAvailability(options, { harness: 'codex', model: '', effort: '' }).available).toBe(
      true,
    );
    expect(
      stepAvailability(options, { harness: 'claude', model: 'opus', effort: '' }),
    ).toMatchObject({
      available: false,
      message: 'You don’t have Claude Code set up on any of your computers',
    });
    expect(
      stepAvailability(options, { harness: 'codex', model: 'gpt-6-sol', effort: '' }).message,
    ).toBe('You don’t have gpt-6-sol set up in Codex on any of your computers');
    expect(
      stepAvailability(options, { harness: 'codex', model: 'gpt-5', effort: 'minimal' }).message,
    ).toMatch(/doesn’t take the effort “minimal”/);
  });

  it('accepts any model of a harness that doesn’t report them, unverified', () => {
    expect(stepAvailability(options, { harness: 'gemini', model: 'pro', effort: '' })).toEqual({
      available: true,
      message: null,
      unverified: true,
    });
    expect(stepAvailabilityOf(undefined, { harness: 'codex', model: 'x', effort: '' })).toBeNull();
    // No desktop app has reported anything: nothing to check against.
    expect(
      stepAvailabilityOf({ harnesses: [] }, { harness: 'codex', model: 'x', effort: '' }),
    ).toBeNull();
  });

  it('offers a model’s own efforts, else the harness’s', () => {
    const codex = harnessOptionOf(options, 'codex');
    expect(effortsFor(codex, 'gpt-5')).toEqual(['low', 'high']);
    expect(effortsFor(codex, '')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(effortsFor(null, '')).toEqual([]);
  });
});
