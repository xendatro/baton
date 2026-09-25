import { describe, expect, it } from 'vitest';
import { change, diffFields, hasChanges } from './diff';
import { excerpt, markdownToPlainText, stripCode } from './markdown';
import { addedMentions, parseMentions } from './mentions';
import { createRateLimiter } from './rateLimit';

describe('parseMentions', () => {
  it('finds users, roles and @everyone, lowercased and deduplicated', () => {
    expect(parseMentions('Hey @Ethan and @mia_2, @ethan again. cc @&Dev-Team @everyone')).toEqual({
      usernames: ['ethan', 'mia_2'],
      roleSlugs: ['dev-team'],
      everyone: true,
    });
  });

  it('ignores code spans, fenced code, emails and paths', () => {
    const body = [
      'Ping `@notme` please',
      '```ts',
      'const x = "@alsonotme";',
      '```',
      'mail ethan@example.com or see a/@b and @real.',
      '~~~',
      '@inside',
      '~~~',
    ].join('\n');
    expect(parseMentions(body)).toEqual({ usernames: ['real'], roleSlugs: [], everyone: false });
  });

  it('treats @&everyone like @everyone', () => {
    expect(parseMentions('@&everyone').everyone).toBe(true);
  });

  it('reports only mentions added by an edit', () => {
    expect(addedMentions('@a @b @&r @everyone', '@a @&r')).toEqual({
      usernames: ['b'],
      roleSlugs: [],
      everyone: true,
    });
    expect(addedMentions('@a', null).usernames).toEqual(['a']);
  });
});

describe('markdown helpers', () => {
  it('flattens markdown to readable text', () => {
    const text = markdownToPlainText(
      '# Title\n\n- [x] **bold** item with [a link](https://x.y)\n> quote `code`\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(text).toContain('Title');
    expect(text).toContain('bold item with a link');
    expect(text).toContain('quote code');
    expect(text).toContain('const a = 1;');
    expect(text).not.toMatch(/[#*>`]|\]\(/);
  });

  it('cuts excerpts at word boundaries', () => {
    expect(excerpt('short')).toBe('short');
    const long = excerpt('word '.repeat(100), 30);
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/wor…$/);
  });

  it('strips code before scanning', () => {
    expect(stripCode('a `b` c\n```\nd\n```\ne')).not.toMatch(/[bd]/);
    expect(stripCode('a ``b ` c`` d `e')).toBe('a   d `e');
  });

  it('drops emphasis markers but keeps intraword and spaced characters', () => {
    expect(markdownToPlainText('**bold**, _it_, ~~gone~~ and `code`')).toBe(
      'bold, it, gone and code',
    );
    expect(markdownToPlainText('user_id and 2 * 3 and a*b')).toBe('user_id and 2 * 3 and a*b');
    expect(markdownToPlainText('\\*literal\\* and a\\|b')).toBe('*literal* and a|b');
    expect(markdownToPlainText('![logo](a.png) <b>x</b> <https://x.y>')).toBe('logo x https://x.y');
  });

  it('cuts excerpts of long bodies without converting all of them', () => {
    const long = excerpt(`${'word '.repeat(50)}${'x'.repeat(100_000)}`, 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
  });

  // Regression (SEC-1): these unterminated constructs used to backtrack quadratically and take
  // seconds each on a 100 KB reply, blocking the event loop while holding the write lock.
  it('runs in linear time on adversarial 100 KB bodies', () => {
    const inputs = [
      '_a '.repeat(33_000),
      '*a '.repeat(33_000),
      '~~a '.repeat(25_000),
      '<a'.repeat(50_000),
      '<http:'.repeat(16_000),
      '[a]('.repeat(25_000),
      '![a]('.repeat(20_000),
      '`'.repeat(50_000) + 'a'.repeat(50_000),
      Array.from({ length: 440 }, (_, i) => `${'`'.repeat(i + 1)}a`).join(''),
      '|---'.repeat(25_000) + 'x',
      '[<*_`'.repeat(20_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      markdownToPlainText(input);
      excerpt(input, 140);
      parseMentions(input);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe('diffFields', () => {
  it('reports only changed fields with formatted, readable values', () => {
    const before = {
      title: 'Old',
      statusId: 's1',
      dueDate: null as string | null,
      labels: ['a', 'b'],
    };
    const statusNames: Record<string, string> = { s1: 'Open', s2: 'Done' };
    const changes = diffFields(
      before,
      { title: 'Old', statusId: 's2', dueDate: '2026-01-31', labels: ['b', 'a'] },
      { statusId: (id) => statusNames[id] },
    );
    expect(changes).toEqual({
      statusId: { from: 'Open', to: 'Done' },
      dueDate: { from: null, to: '2026-01-31' },
    });
  });

  it('ignores keys not present in the update and serialises dates', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    expect(diffFields({ a: 1, b: when }, { b: new Date('2026-01-02T00:00:00Z') })).toEqual({
      b: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' },
    });
    expect(hasChanges(diffFields({ a: 1 }, {}))).toBe(false);
    expect(change(undefined, when)).toEqual({ from: null, to: when.toISOString() });
  });
});

describe('rate limiter (token bucket)', () => {
  const rule = { max: 3, windowMs: 60_000 };

  it('allows a burst of max, then refills continuously', () => {
    const limiter = createRateLimiter();
    const t0 = 1_000_000;
    expect([1, 2, 3].map(() => limiter.consume('k', rule, t0).allowed)).toEqual([true, true, true]);
    const denied = limiter.consume('k', rule, t0);
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 20 });
    // One token refills every 20 s.
    expect(limiter.consume('k', rule, t0 + 19_000).allowed).toBe(false);
    expect(limiter.consume('k', rule, t0 + 40_000).allowed).toBe(true);
  });

  it('keeps buckets independent and sweeps idle ones', () => {
    const limiter = createRateLimiter();
    limiter.consume('a', rule, 0);
    expect(limiter.consume('b', rule, 0).remaining).toBe(2);
    expect(limiter.size).toBe(2);
    // The periodic sweep (every 1000 calls) drops buckets that have refilled completely.
    for (let i = 0; i < 998; i += 1)
      limiter.consume('busy', { max: 5000, windowMs: 60_000 }, 60_000);
    expect(limiter.size).toBe(1);
  });
});
