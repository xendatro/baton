import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { LIVE_EVENT_TYPES, type LiveEvent } from '@shared/events';
import { invalidateForEvent, LIVE_INVALIDATIONS } from './live';
import { queryKeys } from './queryKeys';

function event(overrides: Partial<LiveEvent> & Pick<LiveEvent, 'type' | 'entityType'>): LiveEvent {
  return {
    teamId: 'team1',
    projectId: 'proj1',
    entityId: 'e1',
    actorId: 'u1',
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe('LIVE_INVALIDATIONS', () => {
  it('handles every live event type', () => {
    expect(Object.keys(LIVE_INVALIDATIONS).sort()).toEqual([...LIVE_EVENT_TYPES].sort());
    for (const type of LIVE_EVENT_TYPES) {
      const keys = LIVE_INVALIDATIONS[type](
        event({ type, entityType: 'task', parentType: 'task', parentId: 't1' }),
      );
      expect(keys.length, type).toBeGreaterThan(0);
    }
  });

  it('targets the project of task events', () => {
    const keys = LIVE_INVALIDATIONS['task.updated'](
      event({ type: 'task.updated', entityType: 'task' }),
    );
    expect(keys).toContainEqual(queryKeys.tasks.all('proj1'));
    expect(keys).toContainEqual(queryKeys.work.all());
  });

  it('refreshes the issues of a project when its statuses change (CDI-06)', () => {
    // Issue pages list the statuses of the tasks addressing them ("Addressed by").
    const keys = LIVE_INVALIDATIONS['status.changed'](
      event({ type: 'status.changed', entityType: 'status' }),
    );
    expect(keys).toContainEqual(queryKeys.issues.all('proj1'));
    expect(keys).toContainEqual(queryKeys.tasks.all('proj1'));
  });

  it('targets the thread of reply events', () => {
    const keys = LIVE_INVALIDATIONS['reply.created'](
      event({ type: 'reply.created', entityType: 'reply', parentType: 'issue', parentId: 'iss1' }),
    );
    expect(keys).toEqual([queryKeys.replies.list('issue', 'iss1'), queryKeys.issues.all('proj1')]);
  });

  it('refreshes only the thread or item page of reaction changes (BAT-14)', () => {
    const change = (overrides: Partial<LiveEvent> & Pick<LiveEvent, 'entityType'>) =>
      LIVE_INVALIDATIONS['reaction.changed'](event({ type: 'reaction.changed', ...overrides }));
    expect(change({ entityType: 'reply', parentType: 'task', parentId: 't1' })).toEqual([
      queryKeys.replies.list('task', 't1'),
    ]);
    expect(change({ entityType: 'task' })).toEqual([queryKeys.tasks.details('proj1')]);
    expect(change({ entityType: 'issue' })).toEqual([queryKeys.issues.details('proj1')]);
  });

  it('skips team and project keys the event does not carry', () => {
    const keys = LIVE_INVALIDATIONS['invite.changed'](
      event({ type: 'invite.changed', entityType: 'invite', teamId: null }),
    );
    expect(keys).toEqual([]);
  });
});

describe('invalidateForEvent', () => {
  it('invalidates matching queries by prefix only', async () => {
    const client = new QueryClient();
    const taskList = queryKeys.tasks.list('proj1', { status: 'open' });
    const otherProject = queryKeys.tasks.list('proj2');
    client.setQueryData(taskList, []);
    client.setQueryData(otherProject, []);

    await invalidateForEvent(client, event({ type: 'task.created', entityType: 'task' }));

    expect(client.getQueryState(taskList)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherProject)?.isInvalidated).toBe(false);
  });
});
