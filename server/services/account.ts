import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import type {
  AccountSession,
  ChangePasswordInput,
  ConnectionsResponse,
  DeleteAccountInput,
  LinkedAccount,
  OwnedTeamsConflict,
  PasswordResponse,
  ProfileResponse,
  RevokeSessionsResponse,
  SessionListResponse,
  SetPasswordInput,
  SocialProvider,
  UpdateProfileInput,
} from '@shared/schemas/account';
import { AVATAR_MAX_BYTES, SOCIAL_PROVIDERS } from '@shared/schemas/account';
import { usernameSchema, type OkResponse } from '@shared/schemas/common';
import { parseUserAgent } from '@shared/userAgent';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { diffFields } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { sha256Hex } from '../lib/security';
import { attachmentPath } from '../lib/urls';
import { recordActivity } from './activity';
import {
  attachmentFilePath,
  removeAttachmentFiles,
  sanitizeFilename,
  sniffType,
} from './attachments';
import { emitAfterCommit } from './events';

/**
 * The signed-in user's own account (SPEC §1.1, §1.2): profile (display name, username, theme),
 * avatar, password, sessions, linked sign-in methods and account deletion. Everything lands in the
 * user's security log (account-level `activity` rows, team null) in the same transaction as the
 * change, and profile changes reach the user's other tabs and teammates as live events.
 *
 * Passwords are hashed and checked with Better Auth's own password functions (`auth.$context`),
 * but written here, so the audit row shares the transaction and "sign out other sessions" can keep
 * the current session (see docs/DECISIONS.md).
 */

type UserRow = typeof s.user.$inferSelect;
type SessionRow = typeof s.session.$inferSelect;

/** Better Auth's provider id of email + password sign-in. */
const CREDENTIAL_PROVIDER = 'credential';

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

export function toProfile(user: UserRow): ProfileResponse {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    username: user.username,
    displayUsername: user.displayUsername,
    name: user.name,
    image: user.image,
    theme: user.theme,
  };
}

function loadUser(db: DbExecutor, userId: string): UserRow {
  const user = db.select().from(s.user).where(eq(s.user.id, userId)).get();
  if (!user) throw errors.unauthorized();
  return user;
}

/** Tells the user's other tabs (and teammates, whose member lists show the name) to refetch. */
function emitProfileChanged(tx: Tx, userId: string): void {
  emitAfterCommit(tx, {
    type: 'me.updated',
    teamId: null,
    entityType: 'user',
    entityId: userId,
    actorId: userId,
    userId,
  });
  const teamIds = tx
    .select({ teamId: s.teamMember.teamId })
    .from(s.teamMember)
    .where(eq(s.teamMember.userId, userId))
    .all()
    .map((row) => row.teamId);
  for (const teamId of teamIds) {
    emitAfterCommit(tx, {
      type: 'member.updated',
      teamId,
      entityType: 'member',
      entityId: userId,
      actorId: userId,
    });
  }
}

/** The caller's profile, as in `GET /api/me`. */
export function getProfile(deps: AppDeps, actor: Actor): ProfileResponse {
  return toProfile(loadUser(deps.db.orm, actor.userId));
}

/**
 * Changes the display name, username and/or theme (`PATCH /api/me`, MCP `update_profile`).
 * Usernames follow the sign-up rules and must be free; the typed case is kept as the display
 * username. Unchanged fields write nothing; any change is one `user.profile_updated` row.
 */
export function updateProfile(
  deps: AppDeps,
  actor: Actor,
  input: UpdateProfileInput,
): ProfileResponse {
  const before = loadUser(deps.db.orm, actor.userId);
  const next: Partial<Pick<UserRow, 'name' | 'username' | 'displayUsername' | 'theme'>> = {};
  if (input.name !== undefined) next.name = input.name;
  if (input.theme !== undefined) next.theme = input.theme;
  let newUsername: string | null = null;
  if (input.username !== undefined) {
    const parsed = usernameSchema.safeParse(input.username);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid username';
      throw fieldError('username', message);
    }
    newUsername = parsed.data;
    next.username = parsed.data;
    next.displayUsername = input.username;
  }

  const changes = diffFields(before, next);
  if (Object.keys(changes).length === 0) return toProfile(before);
  // The display username only differs from the username in case: log it only when it is the
  // sole change ("ada" → "Ada"), since a username change already says it all.
  if (changes.username) delete changes.displayUsername;

  const updated = deps.db.write((tx) => {
    if (newUsername !== null && newUsername !== before.username) {
      const taken = tx
        .select({ id: s.user.id })
        .from(s.user)
        .where(and(eq(s.user.username, newUsername), ne(s.user.id, actor.userId)))
        .get();
      if (taken) {
        throw errors.conflict(`@${newUsername} is taken`, {
          issues: [{ path: 'username', message: `@${newUsername} is taken` }],
        });
      }
    }
    const row = tx
      .update(s.user)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(s.user.id, actor.userId))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.profile_updated',
      changes,
    });
    emitProfileChanged(tx, actor.userId);
    return row;
  });
  return toProfile(updated);
}

// ---------------------------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------------------------

export interface AvatarUpload {
  filename: string;
  bytes: Uint8Array;
}

/** The user's live avatar uploads (normally one). */
function avatarRows(db: DbExecutor, userId: string) {
  return db
    .select({ id: s.attachment.id, storagePath: s.attachment.storagePath })
    .from(s.attachment)
    .where(
      and(
        eq(s.attachment.parentType, 'user_avatar'),
        eq(s.attachment.parentId, userId),
        eq(s.attachment.uploaderId, userId),
      ),
    )
    .all();
}

/** Deletes avatar rows and returns their files, which the caller removes after the commit. */
function deleteAvatarRows(tx: Tx, userId: string): string[] {
  const rows = avatarRows(tx, userId);
  if (rows.length > 0) {
    tx.delete(s.attachment)
      .where(
        inArray(
          s.attachment.id,
          rows.map((row) => row.id),
        ),
      )
      .run();
  }
  return rows.map((row) => row.storagePath);
}

/**
 * Stores a new avatar (PNG, JPEG, GIF or WebP, recognised by its bytes; at most 5 MB) as a
 * `user_avatar` attachment and points the profile image at it. The previous avatar file is
 * removed; avatars never go to Trash (they belong to no team).
 */
export async function setAvatar(
  deps: AppDeps,
  actor: Actor,
  upload: AvatarUpload,
): Promise<ProfileResponse> {
  const maxBytes = Math.min(AVATAR_MAX_BYTES, deps.env.maxUploadMb * 1024 * 1024);
  if (upload.bytes.byteLength === 0) throw errors.validation('The file is empty');
  if (upload.bytes.byteLength > maxBytes) {
    throw errors.payloadTooLarge(`Avatars can be at most ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
  const filename = sanitizeFilename(upload.filename);
  const { mimeType, isImage } = await sniffType(upload.bytes, filename);
  if (!isImage) throw errors.validation('Use a PNG, JPEG, GIF or WebP image');

  const id = newId();
  const now = new Date();
  const storagePath = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    id,
  ].join('/');
  const file = attachmentFilePath(deps.env.dataDir, storagePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, upload.bytes, { flag: 'wx' });

  let result: { user: UserRow; previousFiles: string[] };
  try {
    result = deps.db.write((tx) => {
      loadUser(tx, actor.userId);
      const previousFiles = deleteAvatarRows(tx, actor.userId);
      tx.insert(s.attachment)
        .values({
          id,
          teamId: null,
          uploaderId: actor.userId,
          viaKeyId: actor.key?.id ?? null,
          parentType: 'user_avatar',
          parentId: actor.userId,
          filename,
          mimeType,
          size: upload.bytes.byteLength,
          sha256: sha256Hex(upload.bytes),
          storagePath,
          createdAt: now,
        })
        .run();
      const user = tx
        .update(s.user)
        .set({ image: attachmentPath(id, filename), updatedAt: now })
        .where(eq(s.user.id, actor.userId))
        .returning()
        .get();
      recordActivity(tx, actor, {
        teamId: null,
        entityType: 'user',
        entityId: actor.userId,
        action: 'user.avatar_changed',
        meta: { filename, size: upload.bytes.byteLength, mimeType },
      });
      emitProfileChanged(tx, actor.userId);
      return { user, previousFiles };
    });
  } catch (error) {
    removeAttachmentFiles(deps.env.dataDir, [storagePath]);
    throw error;
  }
  removeAttachmentFiles(deps.env.dataDir, result.previousFiles);
  return toProfile(result.user);
}

/** `setAvatar` for MCP: the image as base64 (standard or URL-safe alphabet). */
export function setAvatarFromBase64(
  deps: AppDeps,
  actor: Actor,
  input: { filename: string; contentBase64: string },
): Promise<ProfileResponse> {
  const normalized = input.contentBase64.replace(/\s+/g, '').replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(normalized)) {
    throw errors.validation('contentBase64 is not valid base64');
  }
  const encoding = /[-_]/.test(normalized) ? 'base64url' : 'base64';
  return setAvatar(deps, actor, {
    filename: input.filename,
    bytes: new Uint8Array(Buffer.from(normalized, encoding)),
  });
}

/** Removes the avatar (uploaded or from an OAuth profile); initials are shown instead. */
export function removeAvatar(deps: AppDeps, actor: Actor): ProfileResponse {
  const current = loadUser(deps.db.orm, actor.userId);
  if (current.image === null && avatarRows(deps.db.orm, actor.userId).length === 0) {
    return toProfile(current);
  }
  const result = deps.db.write((tx) => {
    const removedFiles = deleteAvatarRows(tx, actor.userId);
    const user = tx
      .update(s.user)
      .set({ image: null, updatedAt: new Date() })
      .where(eq(s.user.id, actor.userId))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.avatar_removed',
    });
    emitProfileChanged(tx, actor.userId);
    return { user, removedFiles };
  });
  removeAttachmentFiles(deps.env.dataDir, result.removedFiles);
  return toProfile(result.user);
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export interface SessionContext {
  /** The web session making the request (never revoked by "sign out other sessions"). */
  currentSessionId: string | null;
}

function toAccountSession(row: SessionRow, currentSessionId: string | null): AccountSession {
  const parsed = parseUserAgent(row.userAgent);
  return {
    id: row.id,
    current: row.id === currentSessionId,
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: (row.updatedAt > row.createdAt ? row.updatedAt : row.createdAt).toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Unexpired sessions: the current one first, then the most recently active. */
export function listSessions(
  deps: AppDeps,
  actor: Actor,
  context: SessionContext,
): SessionListResponse {
  const rows = deps.db.orm
    .select()
    .from(s.session)
    .where(and(eq(s.session.userId, actor.userId), gt(s.session.expiresAt, new Date())))
    .orderBy(desc(s.session.updatedAt), desc(s.session.createdAt))
    .all();
  const items = rows.map((row) => toAccountSession(row, context.currentSessionId));
  items.sort((a, b) => Number(b.current) - Number(a.current));
  return { items };
}

function sessionMeta(row: SessionRow): Record<string, unknown> {
  const parsed = parseUserAgent(row.userAgent);
  return { browser: parsed.browser, os: parsed.os, ip: row.ipAddress };
}

/** Signs one of the user's other sessions out. The current session signs out instead. */
export function revokeSession(
  deps: AppDeps,
  actor: Actor,
  input: SessionContext & { sessionId: string },
): OkResponse {
  const row = deps.db.orm
    .select()
    .from(s.session)
    .where(and(eq(s.session.id, input.sessionId), eq(s.session.userId, actor.userId)))
    .get();
  if (!row) throw errors.notFound('Session');
  if (row.id === input.currentSessionId) {
    throw errors.validation('This is the session you are using. Sign out instead.');
  }
  deps.db.write((tx) => {
    tx.delete(s.session).where(eq(s.session.id, row.id)).run();
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.session_revoked',
      meta: sessionMeta(row),
    });
  });
  return { ok: true };
}

/** Deletes every session of the user except the current one; returns how many. */
function deleteOtherSessions(tx: Tx, userId: string, currentSessionId: string | null): number {
  return tx
    .delete(s.session)
    .where(
      and(
        eq(s.session.userId, userId),
        currentSessionId ? ne(s.session.id, currentSessionId) : undefined,
      ),
    )
    .run().changes;
}

/** "Sign out other sessions": every session but the current one. */
export function revokeOtherSessions(
  deps: AppDeps,
  actor: Actor,
  context: SessionContext,
): RevokeSessionsResponse {
  const revoked = deps.db.write((tx) => {
    const count = deleteOtherSessions(tx, actor.userId, context.currentSessionId);
    if (count > 0) {
      recordActivity(tx, actor, {
        teamId: null,
        entityType: 'user',
        entityId: actor.userId,
        action: 'user.sessions_revoked',
        meta: { count },
      });
    }
    return count;
  });
  return { revoked };
}

// ---------------------------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------------------------

function credentialAccount(db: DbExecutor, userId: string) {
  return db
    .select()
    .from(s.account)
    .where(and(eq(s.account.userId, userId), eq(s.account.providerId, CREDENTIAL_PROVIDER)))
    .get();
}

function fieldError(field: string, message: string) {
  return errors.validation(message, { issues: [{ path: field, message }] });
}

/** Changes the password after checking the current one; optionally signs out other sessions. */
export async function changePassword(
  deps: AppDeps,
  actor: Actor,
  input: ChangePasswordInput & SessionContext,
): Promise<PasswordResponse> {
  const account = credentialAccount(deps.db.orm, actor.userId);
  if (!account?.password) {
    throw errors.validation("You don't have a password yet. Set one instead.");
  }
  const { password } = await deps.auth.$context;
  if (!(await password.verify({ hash: account.password, password: input.currentPassword }))) {
    throw fieldError('currentPassword', 'That isn’t your current password');
  }
  if (input.newPassword === input.currentPassword) {
    throw fieldError('newPassword', 'Choose a password different from the current one');
  }
  const hash = await password.hash(input.newPassword);
  const revokedSessions = deps.db.write((tx) => {
    tx.update(s.account)
      .set({ password: hash, updatedAt: new Date() })
      .where(eq(s.account.id, account.id))
      .run();
    const revoked = input.revokeOtherSessions
      ? deleteOtherSessions(tx, actor.userId, input.currentSessionId)
      : 0;
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.password_changed',
      meta: { revokedSessions: revoked },
    });
    return revoked;
  });
  return { ok: true, revokedSessions };
}

/** Adds email + password sign-in to an account that has none (OAuth sign-ups). */
export async function setPassword(
  deps: AppDeps,
  actor: Actor,
  input: SetPasswordInput & SessionContext,
): Promise<PasswordResponse> {
  if (credentialAccount(deps.db.orm, actor.userId)?.password) {
    throw errors.conflict('You already have a password. Change it instead.');
  }
  const { password } = await deps.auth.$context;
  const hash = await password.hash(input.newPassword);
  const revokedSessions = deps.db.write((tx) => {
    const now = new Date();
    const existing = credentialAccount(tx, actor.userId);
    if (existing?.password) {
      throw errors.conflict('You already have a password. Change it instead.');
    }
    if (existing) {
      tx.update(s.account)
        .set({ password: hash, updatedAt: now })
        .where(eq(s.account.id, existing.id))
        .run();
    } else {
      tx.insert(s.account)
        .values({
          id: newId(),
          accountId: actor.userId,
          providerId: CREDENTIAL_PROVIDER,
          userId: actor.userId,
          password: hash,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    const revoked = input.revokeOtherSessions
      ? deleteOtherSessions(tx, actor.userId, input.currentSessionId)
      : 0;
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.password_set',
      meta: { revokedSessions: revoked },
    });
    return revoked;
  });
  return { ok: true, revokedSessions };
}

// ---------------------------------------------------------------------------------------------
// Sign-in methods
// ---------------------------------------------------------------------------------------------

type AccountRow = typeof s.account.$inferSelect;

function isSocialProvider(value: string): value is SocialProvider {
  return (SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

/** The `email` claim of a Google ID token (verified by Better Auth when the account was linked). */
export function emailFromIdToken(idToken: string | null): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims === 'object' && claims !== null && 'email' in claims) {
      return typeof claims.email === 'string' ? claims.email : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** How long to wait for a provider's profile API before showing the account without a label. */
const PROVIDER_TIMEOUT_MS = 3000;

/** The GitHub login of a linked account, read with its stored access token. */
async function githubLogin(accessToken: string | null): Promise<string | null> {
  if (!accessToken) return null;
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Baton',
    },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (typeof body === 'object' && body !== null && 'login' in body) {
    return typeof body.login === 'string' ? `@${body.login}` : null;
  }
  return null;
}

async function accountLabel(
  deps: AppDeps,
  row: AccountRow,
  provider: SocialProvider,
): Promise<string | null> {
  if (provider === 'google') return emailFromIdToken(row.idToken);
  try {
    return await githubLogin(row.accessToken);
  } catch (error) {
    deps.logger.warn({ err: error, provider }, 'could not read the linked GitHub profile');
    return null;
  }
}

/** Password sign-in and linked Google/GitHub identities, for the connections page. */
export async function getConnections(deps: AppDeps, actor: Actor): Promise<ConnectionsResponse> {
  const rows = deps.db.orm
    .select()
    .from(s.account)
    .where(eq(s.account.userId, actor.userId))
    .orderBy(asc(s.account.createdAt))
    .all();
  const accounts: LinkedAccount[] = await Promise.all(
    rows.flatMap((row) => {
      const provider = row.providerId;
      if (!isSocialProvider(provider)) return [];
      return [
        accountLabel(deps, row, provider).then((label): LinkedAccount => ({
          id: row.id,
          provider,
          accountId: row.accountId,
          label,
          connectedAt: row.createdAt.toISOString(),
        })),
      ];
    }),
  );
  return {
    hasPassword: rows.some((row) => row.providerId === CREDENTIAL_PROVIDER && row.password),
    accounts,
  };
}

/**
 * Disconnects a linked Google or GitHub account. Never the last way to sign in: an account with
 * no password and one linked identity must set a password or link another first.
 */
export function disconnectAccount(
  deps: AppDeps,
  actor: Actor,
  input: { provider: SocialProvider },
): OkResponse {
  deps.db.write((tx) => {
    const rows = tx.select().from(s.account).where(eq(s.account.userId, actor.userId)).all();
    const target = rows.find((row) => row.providerId === input.provider);
    if (!target) throw errors.notFound('Connected account');
    const methods = rows.filter(
      (row) => row.providerId !== CREDENTIAL_PROVIDER || row.password,
    ).length;
    if (methods <= 1) {
      throw errors.conflict(
        'This is your only way to sign in. Set a password or connect another account first.',
      );
    }
    tx.delete(s.account).where(eq(s.account.id, target.id)).run();
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.account_unlinked',
      meta: { provider: input.provider },
    });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------------------------

/** Teams the user owns, deleted ones included (until they are purged they still have an owner). */
function ownedTeams(db: DbExecutor, userId: string): OwnedTeamsConflict['teams'] {
  return db
    .select({
      id: s.team.id,
      name: s.team.name,
      slug: s.team.slug,
      deletedAt: s.team.deletedAt,
    })
    .from(s.team)
    .where(eq(s.team.ownerId, userId))
    .orderBy(asc(s.team.name))
    .all()
    .map((team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      deleted: team.deletedAt !== null,
    }));
}

function ownedTeamsMessage(teams: OwnedTeamsConflict['teams']): string {
  const names = teams.map((team) => team.name);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
  const deleted = teams.some((team) => team.deleted);
  return (
    `You own ${list}. Transfer ownership or delete ${teams.length === 1 ? 'it' : 'them'} first` +
    (deleted ? ' (teams in Trash count until they are purged 30 days after deletion).' : '.')
  );
}

/**
 * Deletes the account: blocked while the user owns any team (Trash included). Requires the
 * password, or for accounts without one the username typed out. Sessions, API keys, linked
 * accounts, memberships (with their roles), subscriptions, notifications, avatar and pending
 * uploads go with the user; everything they wrote stays and shows a "deleted user". Each team
 * they belonged to records `member.account_deleted`; the security log keeps `user.deleted`.
 */
export async function deleteAccount(
  deps: AppDeps,
  actor: Actor,
  input: DeleteAccountInput,
): Promise<OkResponse> {
  const { orm } = deps.db;
  const user = loadUser(orm, actor.userId);
  const owned = ownedTeams(orm, actor.userId);
  if (owned.length > 0) {
    throw errors.conflict(ownedTeamsMessage(owned), { teams: owned } satisfies OwnedTeamsConflict);
  }

  const credential = credentialAccount(orm, actor.userId);
  if (credential?.password) {
    if (!input.password) throw fieldError('password', 'Enter your password');
    const { password } = await deps.auth.$context;
    if (!(await password.verify({ hash: credential.password, password: input.password }))) {
      throw fieldError('password', 'That isn’t your password');
    }
  } else if (input.confirmUsername?.toLowerCase() !== user.username?.toLowerCase()) {
    throw fieldError('confirmUsername', 'Type your username to confirm');
  }

  const files = deps.db.write((tx) => {
    // Re-checked under the write lock: a team could have been created meanwhile.
    const stillOwned = ownedTeams(tx, actor.userId);
    if (stillOwned.length > 0) {
      throw errors.conflict(ownedTeamsMessage(stillOwned), {
        teams: stillOwned,
      } satisfies OwnedTeamsConflict);
    }
    const snapshot = { username: user.username, name: user.name };
    const memberships = tx
      .select({ teamId: s.teamMember.teamId })
      .from(s.teamMember)
      .where(eq(s.teamMember.userId, actor.userId))
      .all();
    for (const { teamId } of memberships) {
      recordActivity(tx, actor, {
        teamId,
        entityType: 'member',
        entityId: actor.userId,
        action: 'member.account_deleted',
        meta: snapshot,
      });
      emitAfterCommit(tx, {
        type: 'member.left',
        teamId,
        entityType: 'member',
        entityId: actor.userId,
        actorId: actor.userId,
      });
    }

    // Personal files: the avatar and uploads never attached to anything.
    const personal = tx
      .select({ id: s.attachment.id, storagePath: s.attachment.storagePath })
      .from(s.attachment)
      .where(
        and(
          eq(s.attachment.uploaderId, actor.userId),
          inArray(s.attachment.parentType, ['user_avatar', 'pending']),
        ),
      )
      .all();
    if (personal.length > 0) {
      tx.delete(s.attachment)
        .where(
          inArray(
            s.attachment.id,
            personal.map((row) => row.id),
          ),
        )
        .run();
    }

    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.deleted',
      meta: { ...snapshot, teams: memberships.length },
    });
    // Cascades: sessions, accounts, API keys, memberships, member roles, task assignments,
    // subscriptions, notifications. Author/actor references become null ("deleted user").
    tx.delete(s.user).where(eq(s.user.id, actor.userId)).run();
    return personal.map((row) => row.storagePath);
  });
  removeAttachmentFiles(deps.env.dataDir, files);
  return { ok: true };
}
