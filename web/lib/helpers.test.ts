import { describe, expect, it } from 'vitest';
import { passwordStrength } from '@web/components/auth/passwordStrength';
import { buildCrumbs, titleParts } from '@web/components/layout/breadcrumbs';
import { testMe } from '@web/test/mockApi';
import { safeNext } from './auth';
import {
  daysUntil,
  formatBytes,
  formatDueDate,
  formatRelative,
  hueFromString,
  initials,
} from './format';
import { findMentions, formatMention, mentionAtStart, nextMentionStart } from './mentions';
import { formatTitle } from './title';

describe('mentions', () => {
  it('finds user, role and everyone mentions but not emails', () => {
    expect(
      findMentions('Hi @Alice, @&design-team and @everyone; mail bob@example.com').map(
        ({ kind, id }) => `${kind}:${id}`,
      ),
    ).toEqual(['user:alice', 'role:design-team', 'role:everyone']);
  });

  it('rejects names that are too short or too long', () => {
    expect(findMentions('@ab')).toEqual([]);
    expect(findMentions(`@${'a'.repeat(33)}`)).toEqual([]);
  });

  it('reads an agent member’s username as one mention', () => {
    expect(
      findMentions('ask @ethan-ai, @Caden-AI and @ethan-bob').map(({ id, raw }) => [id, raw]),
    ).toEqual([
      ['ethan-ai', '@ethan-ai'],
      ['caden-ai', '@Caden-AI'],
      ['ethan', '@ethan'],
    ]);
    expect(findMentions('@ethan-aix @ethan-ai.')).toMatchObject([
      { id: 'ethan' },
      { id: 'ethan-ai' },
    ]);
    expect(mentionAtStart(`@${'a'.repeat(32)}-ai rest`)).toMatchObject({
      kind: 'user',
      id: `${'a'.repeat(32)}-ai`,
    });
    expect(findMentions('@ab-ai')).toEqual([]);
  });

  it('finds every mention after nextMentionStart used the shared pattern', () => {
    expect(nextMentionStart('Please look @ada-ai')).toBe(12);
    expect(findMentions('Please look @ada-ai').map(({ id }) => id)).toEqual(['ada-ai']);
  });

  it('matches at the start of a markdown source and formats back', () => {
    expect(mentionAtStart('@&ops rest')).toMatchObject({ kind: 'role', id: 'ops', raw: '@&ops' });
    expect(mentionAtStart('hello @ops')).toBeNull();
    expect(formatMention('role', 'ops')).toBe('@&ops');
    expect(formatMention('role', 'everyone')).toBe('@everyone');
    expect(formatMention('user', 'ada')).toBe('@ada');
  });
});

describe('format', () => {
  const now = new Date(2026, 8, 24, 12, 0, 0);

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });

  it('formats relative times', () => {
    expect(formatRelative(new Date(now.getTime() - 10_000), now)).toBe('just now');
    expect(formatRelative(new Date(now.getTime() - 4 * 60_000), now)).toBe('4m ago');
    expect(formatRelative(new Date(now.getTime() - 3 * 3_600_000), now)).toBe('3h ago');
    expect(formatRelative(new Date(2026, 1, 3), now)).toBe('Feb 3');
    expect(formatRelative(new Date(2024, 1, 3), now)).toBe('Feb 3, 2024');
  });

  it('formats due dates relative to today', () => {
    expect(formatDueDate('2026-09-24', now)).toBe('Today');
    expect(formatDueDate('2026-09-25', now)).toBe('Tomorrow');
    expect(formatDueDate('2026-09-23', now)).toBe('Yesterday');
    expect(daysUntil('2026-09-20', now)).toBe(-4);
  });

  it('derives initials and a stable hue', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('grace')).toBe('G');
    expect(initials('', 'zed')).toBe('ZE');
    expect(hueFromString('u1')).toBe(hueFromString('u1'));
  });
});

describe('safeNext', () => {
  it('only allows same-origin app paths', () => {
    expect(safeNext('/t/acme?x=1')).toBe('/t/acme?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext(null)).toBe('/');
    // Regression (WEB-5): URL parsers strip tabs and newlines, so these used to reach the
    // router as external URLs and crash the page.
    for (const value of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/ /x']) {
      expect(safeNext(value)).toBe('/');
    }
    expect(safeNext(decodeURIComponent('%2F%09%2Fevil.example'))).toBe('/');
    expect(safeNext('/%5Cevil.example')).toBe('/%5Cevil.example');
    expect(safeNext('/t/acme/p/API/tasks?view=list#top')).toBe('/t/acme/p/API/tasks?view=list#top');
  });
});

describe('breadcrumbs and titles', () => {
  const me = testMe();

  it('names teams and projects from me', () => {
    const crumbs = buildCrumbs('/t/acme/p/web/tasks/12', me);
    expect(crumbs).toEqual([
      { label: 'Acme', to: '/t/acme' },
      { label: 'Web app', to: '/t/acme/p/web' },
      { label: 'Tasks', to: '/t/acme/p/web/tasks' },
      { label: 'WEB-12' },
    ]);
    expect(titleParts(crumbs, '/t/acme/p/web/tasks/12')).toEqual(['WEB-12', 'Web app']);
    expect(formatTitle(titleParts(crumbs, '/t/acme/p/web/tasks/12'))).toBe(
      'WEB-12 · Web app · Baton',
    );
  });

  it('covers settings, issues and top-level pages', () => {
    expect(buildCrumbs('/t/acme/settings/roles/r1', me).map((crumb) => crumb.label)).toEqual([
      'Acme',
      'Settings',
      'Roles',
      'Edit role',
    ]);
    expect(buildCrumbs('/t/acme/p/WEB/issues/new', me).at(-1)).toEqual({ label: 'New issue' });
    expect(buildCrumbs('/settings/api-keys', me).at(-1)).toEqual({ label: 'API keys' });
    expect(titleParts(buildCrumbs('/inbox', me), '/inbox')).toEqual(['Inbox']);
    expect(titleParts(buildCrumbs('/t/acme', me), '/t/acme')).toEqual(['Acme']);
  });

  it('falls back to the URL for unknown teams', () => {
    expect(buildCrumbs('/t/other', undefined)).toEqual([{ label: 'other' }]);
  });
});

describe('passwordStrength', () => {
  it('scores length, variety and common passwords', () => {
    expect(passwordStrength('short').score).toBe(0);
    expect(passwordStrength('password123').score).toBe(1);
    expect(passwordStrength('abcdefgh').score).toBe(1);
    expect(passwordStrength('Abcdefgh1').score).toBe(2);
    expect(passwordStrength('Tr0ub4dor&3xyz!').score).toBe(4);
  });
});
