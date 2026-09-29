import { describe, expect, it } from 'vitest';
import { isOutOfUsage, parseResetAt, usageLimitOf } from '../src/main/harness/usageLimits';
import { normalizeRepoUrl, sameRepo } from '../src/main/git';

describe('usage limits', () => {
  it('recognises harnesses running out of usage or being rate limited', () => {
    expect(isOutOfUsage('Claude AI usage limit reached|1767225600')).toBe(true);
    expect(isOutOfUsage('Error: 429 Too Many Requests')).toBe(true);
    expect(isOutOfUsage('You exceeded your current quota, please check your plan')).toBe(true);
    expect(isOutOfUsage('RESOURCE_EXHAUSTED: quota')).toBe(true);
    expect(isOutOfUsage('All tests passed')).toBe(false);
  });

  it('reads when the limit resets', () => {
    const now = new Date('2026-09-27T10:00:00').getTime();
    expect(parseResetAt('Claude AI usage limit reached|1767225600', now)).toBe(1767225600 * 1000);
    expect(parseResetAt('Rate limited, try again in 5 minutes', now)).toBe(now + 5 * 60_000);
    expect(parseResetAt('Your limit resets at 5pm', now)).toBe(
      new Date('2026-09-27T17:00:00').getTime(),
    );
    expect(parseResetAt('Your limit resets at 9am', now)).toBe(
      new Date('2026-09-28T09:00:00').getTime(),
    );
    expect(parseResetAt('Usage limit reached', now)).toBeNull();
  });

  it('decides out of usage only for runs that failed, from the harness’s own errors (BAT#30)', () => {
    const now = new Date('2026-09-27T10:00:00').getTime();
    // A run that succeeded never is, whatever its errors said on the way.
    expect(
      usageLimitOf({ succeeded: true, errors: ['429 Too Many Requests'], stderr: [] }, now),
    ).toMatchObject({ limited: false });
    expect(
      usageLimitOf(
        {
          succeeded: false,
          errors: ['You’ve hit your usage limit. Try again in 2 hours.'],
          stderr: [],
        },
        now,
      ),
    ).toEqual({
      limited: true,
      resetAt: now + 2 * 3_600_000,
      message: 'You’ve hit your usage limit. Try again in 2 hours.',
    });
    expect(
      usageLimitOf(
        { succeeded: false, errors: ['sandbox denied: write outside the workspace'], stderr: [] },
        now,
      ),
    ).toMatchObject({ limited: false });
    expect(
      usageLimitOf({ succeeded: false, errors: [], stderr: ['Error: 429 Too Many Requests'] }, now),
    ).toMatchObject({ limited: true, resetAt: null });
  });
});

describe('repository check', () => {
  it('compares https and ssh URLs by host and path', () => {
    expect(normalizeRepoUrl('https://github.com/Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRepoUrl('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
    expect(sameRepo('https://github.com/xendatro/baton', 'git@github.com:xendatro/baton.git')).toBe(
      true,
    );
    expect(sameRepo('https://github.com/xendatro/baton', 'https://github.com/other/baton')).toBe(
      false,
    );
  });
});

describe('mcp listings', () => {
  it('finds an MCP server reaching the same Baton server', async () => {
    const { mcpListReaches } = await import('../src/main/harness/mcpList');
    const listing =
      'github: https://api.github.com/mcp (HTTP) - ✓ Connected\nbaton: https://www.passthebaton.dev/mcp (HTTP) - ✓ Connected';
    expect(mcpListReaches(listing, 'https://passthebaton.dev/mcp')).toBe(true);
    expect(mcpListReaches(listing, 'http://localhost:3000/mcp')).toBe(false);
  });
});
