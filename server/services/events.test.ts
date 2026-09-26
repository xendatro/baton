import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { liveEventSchema, type LiveEvent } from '@shared/events';
import { queueLiveEvent } from '../db';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createTeam,
  createTestContext,
  createUser,
  signIn,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  emitAfterCommit,
  emitEvent,
  pollUserEvents,
  subscribeUserEvents,
  type LiveEventInput,
} from './events';

let ctx: TestContext;
let alice: UserRow;
let bob: UserRow;
let teamA: string;
let teamB: string;

beforeEach(() => {
  ctx = createTestContext();
  alice = createUser(ctx.db);
  bob = createUser(ctx.db);
  teamA = createTeam(ctx.db, { ownerId: alice.id }).team.id;
  teamB = createTeam(ctx.db, { ownerId: bob.id }).team.id;
});

afterEach(() => {
  ctx.close();
});

const event = (overrides: Partial<LiveEventInput>): LiveEventInput => ({
  type: 'task.updated',
  teamId: teamA,
  projectId: 'p',
  entityType: 'task',
  entityId: 't',
  actorId: alice.id,
  ...overrides,
});

describe('emit after commit', () => {
  it('delivers queued events only after the transaction commits', () => {
    const received: LiveEvent[] = [];
    ctx.deps.events.subscribe((e) => received.push(e));
    ctx.db.write((tx) => {
      emitAfterCommit(tx, event({}));
      expect(received).toEqual([]);
    });
    expect(received).toHaveLength(1);
    expect(liveEventSchema.parse(received[0])).toMatchObject({ type: 'task.updated' });
  });

  it('drops queued events when the transaction rolls back', () => {
    const received: LiveEvent[] = [];
    ctx.deps.events.subscribe((e) => received.push(e));
    expect(() =>
      ctx.db.write((tx) => {
        emitAfterCommit(tx, event({}));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(received).toEqual([]);
  });

  it('refuses to queue outside db.write', () => {
    ctx.db.write((tx) => {
      queueLiveEvent(tx, event({}));
    });
    const escaped = ctx.db.write((tx) => tx);
    expect(() => queueLiveEvent(escaped, event({}))).toThrow(/inside|transaction/);
  });
});

describe('per-user filtering', () => {
  it('delivers team events to members and personal events to their recipient', () => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeUserEvents(ctx.deps, alice.id, (e) => received.push(e));
    emitEvent(ctx.deps, event({ entityId: 'mine' }));
    emitEvent(ctx.deps, event({ teamId: teamB, entityId: 'theirs' }));
    emitEvent(
      ctx.deps,
      event({
        type: 'notification.created',
        entityType: 'notification',
        userId: alice.id,
        entityId: 'n1',
      }),
    );
    emitEvent(
      ctx.deps,
      event({
        type: 'notification.created',
        entityType: 'notification',
        userId: bob.id,
        entityId: 'n2',
      }),
    );
    emitEvent(
      ctx.deps,
      event({
        type: 'activity.created',
        teamId: null,
        entityType: 'activity',
        userId: alice.id,
        entityId: 'a1',
      }),
    );
    unsubscribe();
    emitEvent(ctx.deps, event({ entityId: 'after' }));
    expect(received.map((e) => e.entityId)).toEqual(['mine', 'n1', 'a1']);
  });

  it('refreshes membership on member events', () => {
    const received: LiveEvent[] = [];
    subscribeUserEvents(ctx.deps, alice.id, (e) => received.push(e));
    emitEvent(ctx.deps, event({ teamId: teamB, entityId: 'before' }));
    addMember(ctx.db, { teamId: teamB, userId: alice.id });
    emitEvent(
      ctx.deps,
      event({ type: 'member.joined', teamId: teamB, entityType: 'member', entityId: alice.id }),
    );
    emitEvent(ctx.deps, event({ teamId: teamB, entityId: 'after' }));
    expect(received.map((e) => e.entityId)).toEqual([alice.id, 'after']);
  });
});

describe('GET /api/events (SSE)', () => {
  let server: ServerType | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    server = undefined;
  });

  async function listen(): Promise<string> {
    return new Promise((resolve) => {
      server = serve(
        { fetch: ctx.app.fetch, hostname: '127.0.0.1', port: 0 },
        (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`),
      );
    });
  }

  it('streams the retry hint and the caller’s events, then cleans up on disconnect', async () => {
    const origin = await listen();
    const { key } = createApiKey(ctx.db, { userId: alice.id });
    const baseline = ctx.deps.events.listenerCount;
    const controller = new AbortController();
    const res = await fetch(`${origin}/api/events`, {
      headers: bearer(key),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('retry: 3000');
    // BAT-1: a `ready` event right away lets clients detect a proxy that holds the stream back.
    await readUntil('event: ready');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    await vi.waitFor(() => expect(ctx.deps.events.listenerCount).toBe(baseline + 1));
    emitEvent(ctx.deps, event({ teamId: teamB, entityId: 'hidden' }));
    emitEvent(ctx.deps, event({ entityId: 'visible' }));
    await readUntil('visible');
    const payloads = buffer
      .split('\n\n')
      .filter((block) => !block.includes('event: ready'))
      .flatMap((block) => block.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => liveEventSchema.parse(JSON.parse(line.slice(6))));
    expect(payloads.map((p) => p.entityId)).toEqual(['visible']);

    controller.abort();
    await vi.waitFor(() => expect(ctx.deps.events.listenerCount).toBe(baseline));
  });

  it('requires authentication', async () => {
    const res = await ctx.app.request('/api/events');
    expect(res.status).toBe(401);
  });

  /** Reads the stream to its end and returns everything it sent. */
  async function readToEnd(res: Response): Promise<string> {
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  }

  // Regression (SEC-8): open streams kept delivering events after the credential was revoked.
  it('ends the stream once its API key is revoked', async () => {
    const origin = await listen();
    const { key, apiKey } = createApiKey(ctx.db, { userId: alice.id });
    const baseline = ctx.deps.events.listenerCount;
    const res = await fetch(`${origin}/api/events`, { headers: bearer(key) });
    await vi.waitFor(() => expect(ctx.deps.events.listenerCount).toBe(baseline + 1));

    ctx.db.orm
      .update(s.apiKey)
      .set({ revokedAt: new Date() })
      .where(eq(s.apiKey.id, apiKey.id))
      .run();
    emitEvent(ctx.deps, event({ entityId: 'after-revoke' }));
    expect(await readToEnd(res)).not.toContain('after-revoke');
    await vi.waitFor(() => expect(ctx.deps.events.listenerCount).toBe(baseline));
  });

  it('ends the stream once its session is signed out', async () => {
    const origin = await listen();
    const cookie = await signIn(ctx, alice);
    const baseline = ctx.deps.events.listenerCount;
    const res = await fetch(`${origin}/api/events`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(ctx.deps.events.listenerCount).toBe(baseline + 1));

    ctx.db.orm.delete(s.session).where(eq(s.session.userId, alice.id)).run();
    emitEvent(ctx.deps, event({ entityId: 'after-sign-out' }));
    expect(await readToEnd(res)).not.toContain('after-sign-out');
  });
});

// BAT-1: behind a proxy that buffers streamed responses the SSE stream never delivers, so the
// web app long-polls instead.
describe('GET /api/events/poll (long-poll fallback)', () => {
  const poll = async (key: string, cursor?: string) => {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const res = await ctx.app.request(`/api/events/poll${query}`, { headers: bearer(key) });
    expect(res.status).toBe(200);
    return (await res.json()) as { events: LiveEvent[]; cursor: string; reset: boolean };
  };

  it('starts with a cursor, then returns only the caller’s events after it', async () => {
    const { key } = createApiKey(ctx.db, { userId: alice.id });
    const start = await poll(key);
    expect(start).toMatchObject({ events: [], reset: false });

    emitEvent(ctx.deps, event({ teamId: teamB, entityId: 'hidden' }));
    emitEvent(ctx.deps, event({ entityId: 'first' }));
    emitEvent(ctx.deps, event({ type: 'notification.created', userId: bob.id, entityId: 'bobs' }));
    emitEvent(ctx.deps, event({ entityId: 'second' }));
    const next = await poll(key, start.cursor);
    expect(next.events.map((e) => e.entityId)).toEqual(['first', 'second']);
    expect(next.reset).toBe(false);

    emitEvent(ctx.deps, event({ entityId: 'third' }));
    const after = await poll(key, next.cursor);
    expect(after.events.map((e) => e.entityId)).toEqual(['third']);
  });

  it('waits for the next visible event when there is none yet', async () => {
    const start = ctx.deps.events.since(null).cursor;
    const pending = pollUserEvents(ctx.deps, alice.id, start, { waitMs: 5_000 });
    emitEvent(ctx.deps, event({ teamId: teamB, entityId: 'hidden' }));
    emitEvent(ctx.deps, event({ entityId: 'wake' }));
    const result = await pending;
    expect(result.events.map((e) => e.entityId)).toEqual(['wake']);
  });

  it('answers with no events when the wait runs out or the client goes away', async () => {
    const start = ctx.deps.events.since(null).cursor;
    const baseline = ctx.deps.events.listenerCount;
    expect(await pollUserEvents(ctx.deps, alice.id, start, { waitMs: 10 })).toMatchObject({
      events: [],
      reset: false,
    });
    const controller = new AbortController();
    const pending = pollUserEvents(ctx.deps, alice.id, start, { signal: controller.signal });
    controller.abort();
    expect((await pending).events).toEqual([]);
    expect(ctx.deps.events.listenerCount).toBe(baseline);
  });

  it('flags a reset for a cursor from another server run', async () => {
    const { key } = createApiKey(ctx.db, { userId: alice.id });
    expect(await poll(key, 'deadbeef.3')).toMatchObject({ events: [], reset: true });
  });

  it('requires authentication', async () => {
    const res = await ctx.app.request('/api/events/poll');
    expect(res.status).toBe(401);
  });
});
