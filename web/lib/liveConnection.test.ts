import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '@web/test/mockApi';
import {
  coalesceQueryKeys,
  connectLiveEvents,
  LIVE_INVALIDATION_DELAY_MS,
  reconnectDelay,
  subscribeLiveEvents,
} from './live';
import { queryKeys } from './queryKeys';

const event = {
  type: 'task.updated',
  teamId: 't1',
  projectId: 'p1',
  entityType: 'task',
  entityId: 'task1',
  actorId: 'u2',
  at: '2026-09-24T10:00:00.000Z',
};

let client: QueryClient;
let close: () => void = () => undefined;
let states: string[];

function connect() {
  states = [];
  close = connectLiveEvents({
    queryClient: client,
    createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    onStateChange: (state) => states.push(state),
  });
  return FakeEventSource.instances.at(-1) as FakeEventSource;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  client = new QueryClient();
});

afterEach(() => {
  close();
  vi.useRealTimers();
});

describe('reconnectDelay', () => {
  it('doubles from 1 s up to 30 s with jitter', () => {
    expect(reconnectDelay(0, () => 0.5)).toBe(1000);
    expect(reconnectDelay(3, () => 0.5)).toBe(8000);
    expect(reconnectDelay(10, () => 0.5)).toBe(30_000);
    expect(reconnectDelay(0, () => 0)).toBe(800);
    expect(reconnectDelay(0, () => 1)).toBe(1200);
  });
});

describe('connectLiveEvents', () => {
  it('invalidates queries and notifies listeners for valid events only', () => {
    const source = connect();
    expect(source.url).toBe('/api/events');
    const listener = vi.fn();
    const unsubscribe = subscribeLiveEvents(listener);
    const tasks = queryKeys.tasks.list('p1');
    client.setQueryData(tasks, []);

    source.open();
    source.emit(event);
    source.emit({ type: 'nope' });
    source.onmessage?.(new MessageEvent('message', { data: 'not json' }));

    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LIVE_INVALIDATION_DELAY_MS);
    expect(client.getQueryState(tasks)?.isInvalidated).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.updated' }));
    unsubscribe();
  });

  it('lets the browser retry network blips, and reconnects with backoff when the stream closes', () => {
    const first = connect();
    first.open();
    first.fail(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(states.at(-1)).toBe('reconnecting');

    first.fail(true);
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(1300);
    expect(FakeEventSource.instances).toHaveLength(2);

    const second = FakeEventSource.instances[1] as FakeEventSource;
    second.fail(true);
    vi.advanceTimersByTime(1500);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('refreshes everything after reconnecting, since events may have been missed', () => {
    const first = connect();
    first.open();
    const me = queryKeys.me();
    client.setQueryData(me, {});
    first.fail(true);
    vi.advanceTimersByTime(1300);
    expect(client.getQueryState(me)?.isInvalidated).toBe(false);
    const second = FakeEventSource.instances[1] as FakeEventSource;
    second.open();
    expect(client.getQueryState(me)?.isInvalidated).toBe(true);
    expect(states.at(-1)).toBe('open');
  });

  it('batches the invalidations of a burst of events, so each query refetches once (PERF-02)', () => {
    const source = connect();
    source.open();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    // One task write: its own event and the audit row's, both of which refresh the dashboard.
    source.emit(event);
    source.emit({ ...event, type: 'activity.created', entityType: 'activity', entityId: 'a1' });
    source.emit({ ...event, entityId: 'task2' });
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LIVE_INVALIDATION_DELAY_MS);
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(JSON.stringify(queryKeys.work.all()));
    // Covered by work.all(): not invalidated a second time.
    expect(keys).not.toContain(JSON.stringify(queryKeys.work.dashboard()));
  });

  it('stops reconnecting once closed', () => {
    const source = connect();
    source.fail(true);
    close();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('coalesceQueryKeys', () => {
  it('drops duplicates and keys under another key of the batch', () => {
    expect(
      coalesceQueryKeys([
        ['work', 'dashboard'],
        ['tasks', 'p1'],
        ['work'],
        ['tasks', 'p1'],
        ['tasks', 'p10'],
        ['replies', { type: 'task', id: 't1' }],
        ['replies', { type: 'task', id: 't1' }],
      ]),
    ).toEqual([
      ['tasks', 'p1'],
      ['work'],
      ['tasks', 'p10'],
      ['replies', { type: 'task', id: 't1' }],
    ]);
  });
});
