import { describe, expect, it } from 'vitest';
import {
  cursorPaginationSchema,
  dueDateSchema,
  emojiSchema,
  hexColorSchema,
  projectKeySchema,
  teamSlugSchema,
  usernameSchema,
} from './common';
import {
  markNotificationsReadInputSchema,
  searchQuerySchema,
  uploadAttachmentFieldsSchema,
} from './core';

describe('usernameSchema', () => {
  it('normalises to lowercase and accepts [a-z0-9_]', () => {
    expect(usernameSchema.parse('  Ethan_42 ')).toBe('ethan_42');
  });

  it.each(['ab', 'a'.repeat(33), 'has-dash', 'dot.ted', 'émile', 'admin', 'Everyone', 'me'])(
    'rejects %j',
    (value) => {
      expect(usernameSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('identifier schemas', () => {
  it('validates project keys and uppercases them', () => {
    expect(projectKeySchema.parse('bat')).toBe('BAT');
    expect(projectKeySchema.parse('W3B')).toBe('W3B');
    for (const bad of ['B', '1AB', 'TOOLONG', 'A-B']) {
      expect(projectKeySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('validates team slugs', () => {
    expect(teamSlugSchema.parse('Acme-Labs')).toBe('acme-labs');
    for (const bad of ['a', '-acme', 'acme-', 'ac--me', 'ac_me']) {
      expect(teamSlugSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('validates and lowercases hex colors', () => {
    expect(hexColorSchema.parse('#6366F1')).toBe('#6366f1');
    expect(hexColorSchema.safeParse('#fff').success).toBe(false);
    expect(hexColorSchema.safeParse('6366f1').success).toBe(false);
  });
});

describe('emojiSchema', () => {
  it.each(['🚀', '👍🏽', '👨‍👩‍👧', '🇳🇱', '❤️', '#️⃣'])('accepts %s', (value) => {
    expect(emojiSchema.safeParse(value).success).toBe(true);
  });

  it.each(['', 'a', 'rocket', '12', '🚀 launch'])('rejects %j', (value) => {
    expect(emojiSchema.safeParse(value).success).toBe(false);
  });
});

describe('dueDateSchema', () => {
  it('accepts real calendar dates only', () => {
    expect(dueDateSchema.safeParse('2026-02-28').success).toBe(true);
    expect(dueDateSchema.safeParse('2028-02-29').success).toBe(true);
    expect(dueDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(dueDateSchema.safeParse('2026-13-01').success).toBe(false);
    expect(dueDateSchema.safeParse('2026-1-01').success).toBe(false);
  });
});

describe('cursorPaginationSchema', () => {
  it('coerces limit from the query string with a default', () => {
    expect(cursorPaginationSchema.parse({})).toEqual({ limit: 50 });
    expect(cursorPaginationSchema.parse({ limit: '10', cursor: 'abc' })).toEqual({
      limit: 10,
      cursor: 'abc',
    });
    expect(cursorPaginationSchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});

describe('core request schemas', () => {
  it('requires exactly one of ids / all when marking notifications read', () => {
    expect(markNotificationsReadInputSchema.safeParse({ all: true }).success).toBe(true);
    expect(markNotificationsReadInputSchema.safeParse({ ids: ['01HZX'] }).success).toBe(true);
    expect(markNotificationsReadInputSchema.safeParse({}).success).toBe(false);
    expect(markNotificationsReadInputSchema.safeParse({ ids: ['a'], all: true }).success).toBe(
      false,
    );
    // BAT-15: an item (task or issue) instead.
    const item = { type: 'task', id: '01HZX' };
    expect(markNotificationsReadInputSchema.safeParse({ item }).success).toBe(true);
    expect(markNotificationsReadInputSchema.safeParse({ item, all: true }).success).toBe(false);
    expect(
      markNotificationsReadInputSchema.safeParse({ item: { type: 'reply', id: '01HZX' } }).success,
    ).toBe(false);
  });

  it('parses search types', () => {
    expect(searchQuerySchema.parse({ q: 'login' }).types).toEqual(['task', 'issue', 'reply']);
    expect(searchQuerySchema.parse({ q: 'login', types: 'issue,task' }).types).toEqual([
      'task',
      'issue',
    ]);
    expect(searchQuerySchema.safeParse({ q: 'login', types: 'issue,team' }).success).toBe(false);
  });

  it('requires parentId for non-pending uploads', () => {
    expect(uploadAttachmentFieldsSchema.parse({ teamId: 't1' }).parentType).toBe('pending');
    expect(
      uploadAttachmentFieldsSchema.safeParse({ teamId: 't1', parentType: 'task' }).success,
    ).toBe(false);
    expect(
      uploadAttachmentFieldsSchema.safeParse({ teamId: 't1', parentType: 'task', parentId: 'x1' })
        .success,
    ).toBe(true);
  });
});
