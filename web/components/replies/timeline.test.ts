import { describe, expect, it } from 'vitest';
import type { ActivityEntry, Reply } from '@shared/schemas/core';
import { describeActivity, describeChange } from './describeActivity';
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

function text(parts: ReturnType<typeof describeActivity>): string {
  return parts.map((part) => part.text).join(' ');
}

describe('describeActivity', () => {
  it('describes field changes with human values', () => {
    expect(
      text(describeActivity(entry({ changes: { status: { from: 'Open', to: 'Done' } } }))),
    ).toBe('changed status from Open to Done');
    expect(text(describeChange('dueDate', { from: null, to: '2026-10-01' }))).toBe(
      'set due date to 2026-10-01',
    );
    expect(text(describeChange('dueDate', { from: '2026-10-01', to: null }))).toBe(
      'cleared the due date',
    );
    expect(text(describeChange('description', { from: 'a', to: 'b' }))).toBe(
      'edited the description',
    );
  });

  it('describes list changes as additions and removals', () => {
    expect(text(describeChange('labels', { from: ['Bug'], to: ['Docs', 'Feature'] }))).toBe(
      'added labels Docs, Feature and removed labels Bug',
    );
  });

  it('uses verbs for lifecycle actions', () => {
    expect(text(describeActivity(entry({ action: 'task.claimed' })))).toBe('claimed this task');
    expect(text(describeActivity(entry({ action: 'issue.resolved', entityType: 'issue' })))).toBe(
      'resolved this issue',
    );
    expect(text(describeActivity(entry({ action: 'task.link_added' })))).toBe('link added');
  });
});

describe('mergeTimeline', () => {
  const reply = (id: string, createdAt: string): Reply => ({
    id,
    teamId: 't1',
    projectId: 'p1',
    parentType: 'task',
    parentId: 'task1',
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
