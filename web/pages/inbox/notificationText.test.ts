import { describe, expect, it } from 'vitest';
import type { Notification } from '@shared/schemas/core';
import { testMe } from '@web/test/mockApi';
import { dayLabel, notificationContext, notificationSentence } from './notificationText';

const ada = { id: 'u2', username: 'ada', name: 'Ada Lovelace', image: null };

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    teamId: 't1',
    type: 'assigned',
    entityType: 'task',
    entityId: 'task1',
    actor: ada,
    viaKeyName: null,
    title: 'WEB-12: Fix login',
    snippet: '',
    url: '/t/acme/p/WEB/tasks/12',
    readAt: null,
    createdAt: '2026-03-10T10:00:00.000Z',
    ...overrides,
  };
}

describe('notification wording', () => {
  it('names the actor, the key and what happened', () => {
    expect(notificationSentence(notification())).toBe('Ada Lovelace assigned you');
    expect(
      notificationSentence(notification({ type: 'reply', viaKeyName: 'Claude on laptop' })),
    ).toBe('Ada Lovelace via Claude on laptop replied');
    expect(notificationSentence(notification({ type: 'mention', actor: null }))).toBe(
      'Someone mentioned you',
    );
  });

  it('finds the team and project from the notification', () => {
    const teams = testMe().teams;
    const context = notificationContext(notification(), teams);
    expect(context.team?.slug).toBe('acme');
    expect(context.project?.key).toBe('WEB');
    expect(notificationContext(notification({ url: '/t/acme' }), teams).project).toBeNull();
    expect(notificationContext(notification({ teamId: 'gone' }), teams)).toEqual({
      team: null,
      project: null,
    });
  });

  it('labels days relative to now', () => {
    const now = new Date(2026, 2, 10, 15, 0);
    const at = (day: number, month = 2, year = 2026) =>
      new Date(year, month, day, 9, 0).toISOString();
    expect(dayLabel(at(10), now)).toBe('Today');
    expect(dayLabel(at(9), now)).toBe('Yesterday');
    expect(dayLabel(at(6), now)).toBe('Friday');
    expect(dayLabel(at(1), now)).toBe('March 1');
    expect(dayLabel(at(20, 11, 2025), now)).toBe('December 20, 2025');
  });
});
