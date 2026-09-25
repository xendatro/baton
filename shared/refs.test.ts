import { describe, expect, it } from 'vitest';
import {
  findRefs,
  formatIssueRef,
  formatProjectRef,
  formatTaskRef,
  parseIssueRef,
  parseProjectRef,
  parseRef,
  parseTaskRef,
} from './refs';

describe('parseRef', () => {
  it('parses task refs with and without team', () => {
    expect(parseRef('BAT-12')).toEqual({
      kind: 'task',
      teamSlug: null,
      projectKey: 'BAT',
      number: 12,
    });
    expect(parseRef('acme-labs/BAT-12')).toEqual({
      kind: 'task',
      teamSlug: 'acme-labs',
      projectKey: 'BAT',
      number: 12,
    });
  });

  it('parses issue refs', () => {
    expect(parseRef('BAT#51')).toEqual({
      kind: 'issue',
      teamSlug: null,
      projectKey: 'BAT',
      number: 51,
    });
    expect(parseRef('acme/WEB2#1')).toEqual({
      kind: 'issue',
      teamSlug: 'acme',
      projectKey: 'WEB2',
      number: 1,
    });
  });

  it('parses project refs', () => {
    expect(parseRef('BAT')).toEqual({ kind: 'project', teamSlug: null, projectKey: 'BAT' });
    expect(parseRef('acme/BAT')).toEqual({ kind: 'project', teamSlug: 'acme', projectKey: 'BAT' });
  });

  it('is case-insensitive and normalises case', () => {
    expect(parseRef('Acme/bat-7')).toEqual({
      kind: 'task',
      teamSlug: 'acme',
      projectKey: 'BAT',
      number: 7,
    });
    expect(parseRef('  bat#3 ')).toMatchObject({ kind: 'issue', projectKey: 'BAT', number: 3 });
  });

  it.each([
    '',
    'B',
    'TOOLONGKEY-1',
    '1BAT-2',
    'BAT-0',
    'BAT-',
    'BAT#',
    'BAT-1-2',
    'BAT_1',
    'a/BAT-1',
    '-acme/BAT-1',
    'acme--x/BAT-1',
    'acme/BAT-1/x',
    'BAT-1234567890',
  ])('rejects %j', (input) => {
    expect(parseRef(input)).toBeNull();
  });

  it('has kind-specific parsers', () => {
    expect(parseTaskRef('BAT-1')).not.toBeNull();
    expect(parseTaskRef('BAT#1')).toBeNull();
    expect(parseIssueRef('BAT#1')).not.toBeNull();
    expect(parseIssueRef('BAT-1')).toBeNull();
    expect(parseProjectRef('BAT')).not.toBeNull();
    expect(parseProjectRef('BAT-1')).toBeNull();
  });
});

describe('format*Ref', () => {
  it('formats refs and round-trips through parseRef', () => {
    expect(formatTaskRef('BAT', 12)).toBe('BAT-12');
    expect(formatTaskRef('BAT', 12, 'acme')).toBe('acme/BAT-12');
    expect(formatIssueRef('BAT', 51)).toBe('BAT#51');
    expect(formatIssueRef('BAT', 51, 'acme')).toBe('acme/BAT#51');
    expect(formatProjectRef('BAT', 'acme')).toBe('acme/BAT');
    expect(formatProjectRef('BAT', null)).toBe('BAT');
    expect(parseRef(formatTaskRef('BAT', 12, 'acme'))).toMatchObject({ kind: 'task', number: 12 });
  });
});

describe('findRefs', () => {
  it('finds task and issue refs in prose', () => {
    const matches = findRefs('Fixes BAT-12 and see acme/WEB#3. Also (API-7), not bat-9.');
    expect(matches.map((m) => m.text)).toEqual(['BAT-12', 'acme/WEB#3', 'API-7']);
    expect(matches[0]).toMatchObject({
      index: 6,
      ref: { kind: 'task', projectKey: 'BAT', number: 12 },
    });
    expect(matches[1]?.ref).toMatchObject({ kind: 'issue', teamSlug: 'acme', projectKey: 'WEB' });
  });

  it('ignores refs glued to other words or paths', () => {
    expect(findRefs('xBAT-1 BAT-1x BAT-1-2 /BAT-1 #BAT-1 BAT-01')).toEqual([]);
  });
});
