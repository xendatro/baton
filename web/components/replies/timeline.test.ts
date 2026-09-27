import { describe, expect, it } from 'vitest';
import type { ActivityEntry, Reply } from '@shared/schemas/core';
import { mergeTimeline } from './mergeTimeline';

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

describe('mergeTimeline', () => {
  const reply = (id: string, createdAt: string): Reply => ({
    id,
    teamId: 't1',
    projectId: 'p1',
    parentType: 'task',
    parentId: 'task1',
    parentReplyId: null,
    body: 'hi',
    author: null,
    via: null,
    attachments: [],
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
  });

  it('interleaves by time and hides duplicated rows', () => {
    const items = mergeTimeline(
      [reply('r1', '2026-09-24T10:05:00.000Z'), reply('r2', '2026-09-24T10:20:00.000Z')],
      [
        entry({ id: 'created', action: 'task.created', createdAt: '2026-09-24T10:00:00.000Z' }),
        entry({
          id: 'moved',
          action: 'task.status_changed',
          createdAt: '2026-09-24T10:10:00.000Z',
        }),
        entry({ id: 'replied', action: 'reply.created', createdAt: '2026-09-24T10:05:00.000Z' }),
      ],
      'task1',
    );
    expect(items.map((item) => (item.kind === 'reply' ? item.reply.id : item.entry.id))).toEqual([
      'r1',
      'moved',
      'r2',
    ]);
  });
});
