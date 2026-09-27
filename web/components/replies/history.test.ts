import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@shared/schemas/core';
import { historyEntries } from './history';

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'a1',
    teamId: 't1',
    projectId: 'p1',
    actor: { user: null, via: null, source: 'web' },
    entityType: 'task',
    entityId: 'task1',
    action: 'task.updated',
    changes: {},
    meta: {},
    url: null,
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('historyEntries', () => {
  it('lists changes newest first and leaves replies to the conversation', () => {
    const items = historyEntries([
      entry({ id: 'created', action: 'task.created', createdAt: '2026-09-24T10:00:00.000Z' }),
      entry({ id: 'replied', action: 'reply.created', createdAt: '2026-09-24T10:05:00.000Z' }),
      entry({ id: 'moved', action: 'task.status_changed', createdAt: '2026-09-24T10:10:00.000Z' }),
    ]);
    expect(items.map((item) => item.id)).toEqual(['moved', 'created']);
  });
});
