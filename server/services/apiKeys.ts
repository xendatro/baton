import { and, count, desc, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { LIMITS } from '@shared/constants';
import type {
  ApiKey,
  ApiKeyListResponse,
  CreateApiKeyInput,
  CreateApiKeyResponse,
} from '@shared/schemas/core';
import type { Actor, ActorKey, AppDeps } from '../context';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { generateApiKey, hashApiKey, isApiKeyFormat } from '../lib/security';
import { recordActivity } from './activity';

/**
 * Personal API keys (SPEC §1.2): `bat_` + 40 base62 characters, shown once; only the SHA-256
 * hash is stored. Agents and scripts act as the key's owner "via" the key. Creating and revoking
 * keys is web-only (not exposed over MCP) and lands in the owner's security log.
 */

type ApiKeyRow = typeof s.apiKey.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `lastUsedAt` is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60 * 1000;

export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The actor's keys, newest first (revoked and expired keys included, for the settings list). */
export function listApiKeys(deps: AppDeps, actor: Actor): ApiKeyListResponse {
  const rows = deps.db.orm
    .select()
    .from(s.apiKey)
    .where(eq(s.apiKey.userId, actor.userId))
    .orderBy(desc(s.apiKey.createdAt), desc(s.apiKey.id))
    .all();
  return { apiKeys: rows.map(toApiKey) };
}

/** Creates a key. The plaintext key is returned only here. */
export function createApiKey(
  deps: AppDeps,
  actor: Actor,
  input: CreateApiKeyInput,
): CreateApiKeyResponse {
  const generated = generateApiKey();
  const now = new Date();
  const row = deps.db.write((tx) => {
    const active = tx
      .select({ value: count() })
      .from(s.apiKey)
      .where(
        and(
          eq(s.apiKey.userId, actor.userId),
          isNull(s.apiKey.revokedAt),
          or(isNull(s.apiKey.expiresAt), gt(s.apiKey.expiresAt, now)),
        ),
      )
      .get();
    if ((active?.value ?? 0) >= LIMITS.apiKeysPerUser) {
      throw errors.conflict(
        `You can have at most ${LIMITS.apiKeysPerUser} active API keys. Revoke one first.`,
      );
    }
    const created = tx
      .insert(s.apiKey)
      .values({
        userId: actor.userId,
        name: input.name,
        prefix: generated.prefix,
        hash: generated.hash,
        expiresAt: input.expiresInDays
          ? new Date(now.getTime() + input.expiresInDays * DAY_MS)
          : null,
        createdAt: now,
      })
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'api_key',
      entityId: created.id,
      action: 'api_key.created',
      meta: {
        name: created.name,
        prefix: created.prefix,
        expiresAt: created.expiresAt?.toISOString() ?? null,
      },
    });
    return created;
  });
  return { key: generated.key, apiKey: toApiKey(row) };
}

/** Revokes one of the actor's keys (idempotent). Other users' keys are `not_found`. */
export function revokeApiKey(deps: AppDeps, actor: Actor, id: string): { ok: true } {
  const row = deps.db.orm
    .select()
    .from(s.apiKey)
    .where(and(eq(s.apiKey.id, id), eq(s.apiKey.userId, actor.userId)))
    .get();
  if (!row) throw errors.notFound('API key');
  if (row.revokedAt) return { ok: true };
  deps.db.write((tx) => {
    tx.update(s.apiKey).set({ revokedAt: new Date() }).where(eq(s.apiKey.id, id)).run();
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'api_key',
      entityId: id,
      action: 'api_key.revoked',
      meta: { name: row.name, prefix: row.prefix },
    });
  });
  return { ok: true };
}

export interface AuthenticatedKey {
  userId: string;
  key: ActorKey;
}

/**
 * Authenticates a presented `bat_…` key. Unknown, malformed, revoked and expired keys all return
 * null (the caller answers 401). `lastUsedAt` is refreshed at most once a minute.
 */
export function authenticateApiKey(
  deps: Pick<AppDeps, 'db'>,
  presented: string,
  now: Date = new Date(),
): AuthenticatedKey | null {
  if (!isApiKeyFormat(presented)) return null;
  const { orm } = deps.db;
  const row = orm
    .select()
    .from(s.apiKey)
    .where(eq(s.apiKey.hash, hashApiKey(presented)))
    .get();
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) {
    return null;
  }
  const staleBefore = new Date(now.getTime() - LAST_USED_RESOLUTION_MS);
  if (!row.lastUsedAt || row.lastUsedAt < staleBefore) {
    // A single conditional UPDATE: concurrent requests cannot write it twice per minute.
    orm
      .update(s.apiKey)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(s.apiKey.id, row.id),
          or(isNull(s.apiKey.lastUsedAt), lt(s.apiKey.lastUsedAt, staleBefore)),
        ),
      )
      .run();
  }
  const key: ActorKey = { id: row.id, name: row.name };
  if (row.agentName) key.agentName = row.agentName;
  return { userId: row.userId, key };
}

/**
 * Remembers which agent uses a key, from an MCP `initialize` (BAT-6). Not audited: it describes
 * the client, like `lastUsedAt`, and changes only when a different agent connects.
 */
export function recordKeyAgent(deps: Pick<AppDeps, 'db'>, keyId: string, agentName: string): void {
  deps.db.orm
    .update(s.apiKey)
    .set({ agentName })
    .where(
      and(
        eq(s.apiKey.id, keyId),
        or(isNull(s.apiKey.agentName), ne(s.apiKey.agentName, agentName)),
      ),
    )
    .run();
}
