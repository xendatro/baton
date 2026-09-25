import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { API_KEY, INVITE_CODE_LENGTH } from '@shared/constants';
import type { LiveEvent } from '@shared/events';
import { createLogger } from '../logger';
import { decodeCursor, encodeCursor, timeIdCursorSchema } from './cursor';
import { AppError, errors } from './errors';
import { createEventBus, liveEvent } from './eventBus';
import { newId } from './ids';
import {
  generateApiKey,
  generateInviteCode,
  hashApiKey,
  isApiKeyFormat,
  randomBase62,
  sha256Hex,
} from './security';
import { parseInput } from './validate';

describe('ids', () => {
  it('creates sortable ULIDs', () => {
    const ids = Array.from({ length: 50 }, () => newId());
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('security', () => {
  it('generates bat_ keys whose hash and prefix match', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^bat_[0-9A-Za-z]{40}$/);
    expect(isApiKeyFormat(key)).toBe(true);
    expect(prefix).toBe(key.slice(API_KEY.prefix.length, API_KEY.prefix.length + 8));
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateApiKey().key).not.toBe(key);
  });

  it('recognises malformed keys', () => {
    expect(isApiKeyFormat('bat_short')).toBe(false);
    expect(isApiKeyFormat(`xyz_${'a'.repeat(40)}`)).toBe(false);
    expect(isApiKeyFormat(`bat_${'a'.repeat(39)}!`)).toBe(false);
  });

  it('produces base62 strings of the requested length', () => {
    expect(generateInviteCode()).toMatch(new RegExp(`^[0-9A-Za-z]{${INVITE_CODE_LENGTH}}$`));
    const sample = randomBase62(6200);
    expect(sample).toHaveLength(6200);
    // Every symbol should show up in a sample this large.
    expect(new Set(sample).size).toBe(62);
  });

  it('hashes with SHA-256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('errors', () => {
  it('builds error envelopes with default statuses', () => {
    const error = errors.notFound('Task');
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(404);
    expect(error.toJSON()).toEqual({ error: { code: 'not_found', message: 'Task not found' } });
    expect(errors.usernameRequired().status).toBe(403);
    expect(errors.payloadTooLarge().status).toBe(413);
  });
});

describe('parseInput', () => {
  it('returns parsed data or throws validation_failed with issues', () => {
    const schema = z.object({ a: z.object({ b: z.number() }) });
    expect(parseInput(schema, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
    try {
      parseInput(schema, { a: { b: 'x' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('validation_failed');
      expect(appError.message).toMatch(/^a\.b: /);
      expect(appError.details).toEqual({
        issues: [{ path: 'a.b', message: expect.any(String) as unknown }],
      });
    }
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const cursor = encodeCursor([1700000000000, '01HZX']);
    expect(decodeCursor(cursor, timeIdCursorSchema)).toEqual([1700000000000, '01HZX']);
    expect(() => decodeCursor('%%%', timeIdCursorSchema)).toThrow('Invalid cursor');
    expect(() => decodeCursor(encodeCursor(['x']), timeIdCursorSchema)).toThrow('Invalid cursor');
  });
});

describe('event bus', () => {
  const logger = createLogger({ logLevel: 'silent' });
  const event: LiveEvent = liveEvent({
    type: 'task.updated',
    teamId: 't1',
    projectId: 'p1',
    entityType: 'task',
    entityId: 'k1',
    actorId: 'u1',
  });

  it('delivers events to subscribers until they unsubscribe', () => {
    const bus = createEventBus(logger);
    const received: LiveEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));
    expect(bus.listenerCount).toBe(1);
    bus.emit(event);
    unsubscribe();
    bus.emit(event);
    expect(received).toEqual([event]);
    expect(bus.listenerCount).toBe(0);
    expect(new Date(event.at).getTime()).not.toBeNaN();
  });

  it('isolates failing listeners', () => {
    const bus = createEventBus(logger);
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('listener bug');
    });
    bus.subscribe(good);
    expect(() => bus.emit(event)).not.toThrow();
    expect(good).toHaveBeenCalledWith(event);
  });
});
