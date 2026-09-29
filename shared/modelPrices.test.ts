import { describe, expect, it } from 'vitest';
import { canonicalModel, estimateCost, modelPrice } from './modelPrices';

describe('model prices (BAT#25)', () => {
  it('writes one model one way', () => {
    expect(canonicalModel(' GPT-6-Sol ')).toBe('gpt-6-sol');
    expect(canonicalModel('openai/gpt-5')).toBe('gpt-5');
    expect(canonicalModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(canonicalModel('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(canonicalModel('')).toBe('');
  });

  it('estimates at API prices, and knows when it can’t', () => {
    expect(modelPrice('gpt-6-sol')).toBeNull();
    expect(estimateCost('gpt-6-sol', counts(1_000_000, 0, 0, 0))).toBeNull();
    // Claude: cache reads at 0.1×, writes at 1.25× the input price.
    expect(
      estimateCost('claude-sonnet-4-5', counts(1_000_000, 500_000, 100_000, 10_000)),
    ).toBeCloseTo(0.4 * 3 + 0.5 * 0.3 + 0.1 * 3.75 + 0.01 * 15, 6);
  });
});

function counts(
  tokensIn: number,
  tokensCacheRead: number,
  tokensCacheWrite: number,
  tokensOut: number,
) {
  return { tokensIn, tokensCacheRead, tokensCacheWrite, tokensOut };
}
