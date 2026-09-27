import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray, isNull, sum } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';
import sharp from 'sharp';
import type { AttachmentParentType } from '@shared/constants';
import { LIMITS } from '@shared/constants';
import type { Permission } from '@shared/permissions';
import type { Attachment, UploadAttachmentFields } from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { dataPaths } from '../lib/paths';
import { sha256Hex } from '../lib/security';
import { attachmentPath } from '../lib/urls';
import {
  canEditContent,
  canRestoreContent,
  hasPermission,
  isOwnContent,
  requireCanDeleteContent,
  requireMember,
  requireProjectAccess,
  requireScopedAccess,
  type Membership,
} from './access';
import { recordActivity } from './activity';
import { selfIdsOf } from './agents';
import { emitAfterCommit } from './events';
import {
  findItem,
  itemResolvers,
  trashedItem,
  trashedProject,
  trashedReply,
  type TrashEntry,
} from './items';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Attachments (SPEC §1.13): files on disk under `DATA_DIR/uploads/yyyy/mm/<id>`, metadata in the
 * `attachment` table. The editor uploads files as `pending`; the feature service that saves the
 * issue, task or reply then claims them with `attachToParent` in its transaction. Pending files
 * nobody claims are purged after 24 hours.
 */

export type AttachmentRow = typeof s.attachment.$inferSelect;

/** Raster images the browser renders inline. Everything else (SVG included) downloads. */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Text-like types whose content `get_attachment` returns to agents. */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'image/svg+xml',
]);

/** Largest file whose text `get_attachment` returns inline. */
const MAX_INLINE_TEXT_BYTES = 256 * 1024;

const FALLBACK_TYPE = 'application/octet-stream';

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

// Control characters, path separators and characters Windows forbids in file names.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/**
 * A filename safe to store and to send in `Content-Disposition`: no directories, control or
 * reserved characters, no leading dots, at most 255 bytes (extension kept), never empty.
 */
export function sanitizeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? '';
  let name = base
    .normalize('NFC')
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!name) name = 'file';
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > LIMITS.filename.max) {
    const extension = path.extname(name).slice(0, 16);
    let stem = name.slice(0, name.length - extension.length);
    while (encoder.encode(stem + extension).length > LIMITS.filename.max) stem = stem.slice(0, -1);
    name = stem + extension;
  }
  return name;
}

/**
 * Text types by extension for files agents commonly attach whose extension `mime-types` doesn't
 * know or maps to something else (`.ts` is MPEG transport stream, `.rs` an XML format). Used only
 * when the content is text.
 */
const SOURCE_TEXT_TYPES: Readonly<Record<string, string>> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.jsx': 'text/javascript',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.rb': 'text/x-ruby',
  '.kt': 'text/x-kotlin',
  '.kts': 'text/x-kotlin',
  '.swift': 'text/x-swift',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
};

export interface SniffedType {
  mimeType: string;
  /** Rendered inline: a raster image recognised by its content, not just its name. */
  isImage: boolean;
}

/** Valid UTF-8 without NUL bytes: text, whatever the file is called. */
function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The text type to store for a text file: by extension, else the name's text type, else plain. */
function textTypeFor(filename: string, byName: string | null): string {
  const known = SOURCE_TEXT_TYPES[path.extname(filename).toLowerCase()];
  if (known) return known;
  return byName && isTextType(byName) ? byName : 'text/plain';
}

/**
 * Determines the stored MIME type from the bytes (magic numbers) first, then whether the content
 * is text (valid UTF-8, no NUL bytes), then the filename's extension. Only content-verified
 * PNG/JPEG/GIF/WebP count as inline images; a name claiming one is never trusted. `text: true`
 * (content sent as text, e.g. MCP `upload_attachment` with `text`) stores a text type directly.
 */
export async function sniffType(
  bytes: Uint8Array,
  filename: string,
  options: { text?: boolean } = {},
): Promise<SniffedType> {
  const byName = mime.lookup(filename) || null;
  const claimsImage = byName !== null && INLINE_IMAGE_TYPES.has(byName);
  if (!options.text) {
    const detected = await fileTypeFromBuffer(bytes);
    if (detected) {
      return { mimeType: detected.mime, isImage: INLINE_IMAGE_TYPES.has(detected.mime) };
    }
  }
  if (!claimsImage && (options.text || isUtf8Text(bytes))) {
    return { mimeType: textTypeFor(filename, byName), isImage: false };
  }
  // A name that claims a raster image without matching bytes is not trusted as one.
  const mimeType = byName && !claimsImage ? byName : FALLBACK_TYPE;
  return { mimeType, isImage: false };
}

export function isInlineImage(mimeType: string): boolean {
  return INLINE_IMAGE_TYPES.has(mimeType);
}

function isTextType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    TEXT_TYPES.has(mimeType) ||
    mimeType.endsWith('+xml') ||
    mimeType.endsWith('+json')
  );
}

/** Absolute path of a stored file. `storagePath` uses forward slashes on every platform. */
export function attachmentFilePath(dataDir: string, storagePath: string): string {
  return path.join(dataPaths(dataDir).uploads, ...storagePath.split('/'));
}

/** Deletes stored files, ignoring ones already gone. */
export function removeAttachmentFiles(dataDir: string, storagePaths: readonly string[]): void {
  for (const storagePath of storagePaths) {
    fs.rmSync(attachmentFilePath(dataDir, storagePath), { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

export function toAttachments(db: DbExecutor, rows: readonly AttachmentRow[]): Attachment[] {
  const users = getUserSummaries(
    db,
    rows.map((row) => row.uploaderId),
  );
  const keys = getViaKeys(
    db,
    rows.map((row) => row.viaKeyId),
  );
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    parentType: row.parentType,
    parentId: row.parentId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    isImage: isInlineImage(row.mimeType),
    url: attachmentPath(row.id, row.filename),
    uploader: row.uploaderId ? (users.get(row.uploaderId) ?? null) : null,
    via: row.viaKeyId ? (keys.get(row.viaKeyId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Non-deleted attachments of several parents of one type, keyed by parent id (oldest first). */
export function attachmentsByParent(
  db: DbExecutor,
  parentType: AttachmentParentType,
  parentIds: readonly string[],
): Map<string, Attachment[]> {
  const grouped = new Map<string, Attachment[]>();
  if (parentIds.length === 0) return grouped;
  const rows = db
    .select()
    .from(s.attachment)
    .where(
      and(
        eq(s.attachment.parentType, parentType),
        inArray(s.attachment.parentId, [...parentIds]),
        isNull(s.attachment.deletedAt),
      ),
    )
    .orderBy(asc(s.attachment.createdAt), asc(s.attachment.id))
    .all();
  for (const attachment of toAttachments(db, rows)) {
    const key = attachment.parentId ?? '';
    grouped.set(key, [...(grouped.get(key) ?? []), attachment]);
  }
  return grouped;
}

// ---------------------------------------------------------------------------------------------
// Parents
// ---------------------------------------------------------------------------------------------

export interface AttachmentParent {
  type: Exclude<AttachmentParentType, 'pending' | 'user_avatar'>;
  id: string;
}

interface ResolvedParent {
  teamId: string;
  projectId: string | null;
  /** Can the member add or remove files on this parent? */
  canEdit(membership: Membership): boolean;
}

/** Resolves an issue, task, reply or project parent (not deleted), or throws not_found. */
function resolveParent(db: DbExecutor, parent: AttachmentParent): ResolvedParent {
  switch (parent.type) {
    case 'issue':
    case 'task': {
      const item = findItem(db, parent.type, parent.id);
      if (!item) throw errors.notFound(parent.type === 'issue' ? 'Issue' : 'Task');
      return {
        teamId: item.teamId,
        projectId: item.projectId,
        canEdit: (m) =>
          canEditContent(m, item.authorId) ||
          (parent.type === 'task' && hasPermission(m, 'UPDATE_TASKS')),
      };
    }
    case 'reply': {
      const reply = db
        .select()
        .from(s.reply)
        .where(and(eq(s.reply.id, parent.id), isNull(s.reply.deletedAt)))
        .get();
      if (!reply || !findItem(db, reply.parentType, reply.parentId)) {
        throw errors.notFound('Reply');
      }
      return {
        teamId: reply.teamId,
        projectId: reply.projectId,
        canEdit: (m) => canEditContent(m, reply.authorId),
      };
    }
    case 'project': {
      const project = db
        .select({ id: s.project.id, teamId: s.project.teamId })
        .from(s.project)
        .where(and(eq(s.project.id, parent.id), isNull(s.project.deletedAt)))
        .get();
      if (!project) throw errors.notFound('Project');
      return {
        teamId: project.teamId,
        projectId: project.id,
        canEdit: (m) => hasPermission(m, 'MANAGE_PROJECTS'),
      };
    }
  }
}

/**
 * A file was added to, removed from or restored to `parentType`/`parentId`, inside that write. It
 * is a write on the issue or task the file belongs to, directly or through a reply: an item's own
 * files move its last activity, and a task renews the actor's claim (any write by the holder
 * renews the lease, SPEC §1.8), exactly like a reply does.
 */
function onParentWrite(
  tx: Tx,
  actor: Actor,
  parentType: AttachmentParentType,
  parentId: string | null,
): void {
  if (!parentId) return;
  if (parentType === 'issue' || parentType === 'task') {
    itemResolvers[parentType].touch(tx, parentId);
    itemResolvers[parentType].onThreadWrite?.(tx, actor, parentId);
    return;
  }
  if (parentType === 'reply') {
    const reply = tx
      .select({ parentType: s.reply.parentType, parentId: s.reply.parentId })
      .from(s.reply)
      .where(eq(s.reply.id, parentId))
      .get();
    if (reply) itemResolvers[reply.parentType].onThreadWrite?.(tx, actor, reply.parentId);
  }
}

/** `/api/attachments/<id>/…` links in markdown (images and files added in an editor). */
const ATTACHMENT_URL = /\/api\/attachments\/([A-Za-z0-9_-]{1,64})\//g;

/**
 * The actor's pending uploads (in the team) that `markdown` links to. Images pasted into an
 * editor upload as `pending` before the text is saved; the feature service attaches them with the
 * text (issue and task bodies, READMEs, replies) so the 24-hour purge of unclaimed uploads never
 * removes an image that is in use. At most `LIMITS.attachmentsPerItem` links are considered.
 */
export function referencedPendingUploads(
  db: DbExecutor,
  actor: Actor,
  teamId: string,
  markdown: string,
): string[] {
  const ids = [...new Set([...markdown.matchAll(ATTACHMENT_URL)].map((match) => match[1] ?? ''))];
  if (ids.length === 0) return [];
  return db
    .select({ id: s.attachment.id })
    .from(s.attachment)
    .where(
      and(
        inArray(s.attachment.id, ids.slice(0, LIMITS.attachmentsPerItem)),
        eq(s.attachment.parentType, 'pending'),
        inArray(s.attachment.uploaderId, selfIdsOf(db, actor)),
        eq(s.attachment.teamId, teamId),
        isNull(s.attachment.deletedAt),
      ),
    )
    .all()
    .map((row) => row.id);
}

/**
 * Claims pending uploads for a parent, inside the feature service's transaction. Only the
 * actor's own pending, non-deleted uploads in the same team qualify (a person's and their agent
 * member's count as one's own); anything else fails the whole write with a validation error.
 * Returns the attached rows.
 */
export function attachToParent(
  tx: Tx,
  actor: Actor,
  attachmentIds: readonly string[],
  parent: AttachmentParent & { teamId: string; projectId?: string | null },
): AttachmentRow[] {
  const ids = [...new Set(attachmentIds)];
  if (ids.length === 0) return [];
  if (ids.length > LIMITS.attachmentsPerItem) {
    throw errors.validation(`At most ${LIMITS.attachmentsPerItem} attachments per item`);
  }
  const rows = tx
    .select()
    .from(s.attachment)
    .where(
      and(
        inArray(s.attachment.id, ids),
        eq(s.attachment.parentType, 'pending'),
        inArray(s.attachment.uploaderId, selfIdsOf(tx, actor)),
        eq(s.attachment.teamId, parent.teamId),
        isNull(s.attachment.deletedAt),
      ),
    )
    .all();
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((row) => row.id));
    throw errors.validation('Some attachments are not your pending uploads in this team', {
      attachmentIds: ids.filter((id) => !found.has(id)),
    });
  }
  const attached = tx
    .update(s.attachment)
    .set({ parentType: parent.type, parentId: parent.id })
    .where(inArray(s.attachment.id, ids))
    .returning()
    .all();
  emitAfterCommit(tx, {
    type: 'attachment.changed',
    teamId: parent.teamId,
    projectId: parent.projectId ?? null,
    entityType: 'attachment',
    entityId: ids[0] ?? parent.id,
    parentType: parent.type,
    parentId: parent.id,
    actorId: actor.userId,
  });
  return attached;
}

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

export interface UploadInput extends UploadAttachmentFields {
  filename: string;
  bytes: Uint8Array;
  /** The content was sent as text: store it with a text type. */
  isText?: boolean | undefined;
}

function teamStorageUsed(db: DbExecutor, teamId: string): number {
  const row = db
    .select({ total: sum(s.attachment.size) })
    .from(s.attachment)
    .where(eq(s.attachment.teamId, teamId))
    .get();
  return Number(row?.total ?? 0);
}

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

const PARENT_NAMES: Readonly<Record<AttachmentParent['type'], string>> = {
  issue: 'Issue',
  task: 'Task',
  reply: 'Reply',
  project: 'Project',
};

/**
 * Permissions that let a member write something a pending upload can end up in (a reply, an
 * issue, a task, a README, or files and text on other people's items).
 */
const PENDING_UPLOAD_PERMISSIONS = [
  'REPLY',
  'CREATE_ISSUES',
  'CREATE_TASKS',
  'UPDATE_TASKS',
  'EDIT_ANY_CONTENT',
  'MANAGE_PROJECTS',
] as const satisfies readonly Permission[];

/**
 * Pending uploads (files added in an editor before the text is saved) need a permission that can
 * create or change content, so a member whose roles grant nothing can't fill the team's storage.
 */
function requireCanUploadPending(membership: Membership): void {
  if (!PENDING_UPLOAD_PERMISSIONS.some((permission) => hasPermission(membership, permission))) {
    throw errors.forbidden("You don't have permission to upload files in this team");
  }
}

/**
 * Most bytes of pending uploads one member may hold in a team: a tenth of the team's storage
 * quota (at least one file of MAX_UPLOAD_MB), so nobody's unsaved uploads can take the whole
 * quota. Pending files are purged after 24 hours or once saved into an item.
 */
export function pendingUploadCapBytes(
  env: Pick<AppDeps['env'], 'maxUploadMb' | 'teamStorageQuotaMb'>,
): number {
  const mb = 1024 * 1024;
  return Math.max(env.maxUploadMb * mb, Math.floor((env.teamStorageQuotaMb * mb) / 10));
}

function pendingBytes(db: DbExecutor, userId: string, teamId: string): number {
  const row = db
    .select({ total: sum(s.attachment.size) })
    .from(s.attachment)
    .where(
      and(
        eq(s.attachment.teamId, teamId),
        eq(s.attachment.uploaderId, userId),
        eq(s.attachment.parentType, 'pending'),
        isNull(s.attachment.deletedAt),
      ),
    )
    .get();
  return Number(row?.total ?? 0);
}

function requirePendingRoom(
  db: DbExecutor,
  actor: Actor,
  teamId: string,
  bytes: number,
  capBytes: number,
): void {
  if (pendingBytes(db, actor.userId, teamId) + bytes > capBytes) {
    throw errors.payloadTooLarge(
      `You have ${formatMb(capBytes)} of unsaved uploads in this team. Save or remove them first; unsaved uploads are deleted after a day.`,
    );
  }
}

/**
 * Stores an uploaded file for a team. Pending by default; with a parent it is attached right away
 * (needs edit rights on the parent). Enforces MAX_UPLOAD_MB and the team storage quota (soft-deleted
 * files count until they are purged).
 */
export async function uploadAttachment(
  deps: AppDeps,
  actor: Actor,
  input: UploadInput,
): Promise<Attachment> {
  const { orm } = deps.db;
  const membership = requireMember(orm, actor, input.teamId);
  if (input.parentType === 'user_avatar') {
    throw errors.validation('Avatars are uploaded from account settings');
  }
  const parent =
    input.parentType === 'pending' || !input.parentId
      ? null
      : { type: input.parentType, id: input.parentId };
  if (parent) {
    const resolved = resolveParent(orm, parent);
    // Another team's item is "not found", exactly like a missing one (never leak existence).
    if (resolved.teamId !== input.teamId) throw errors.notFound(PARENT_NAMES[parent.type]);
    const access = resolved.projectId
      ? requireProjectAccess(orm, actor, resolved.projectId, PARENT_NAMES[parent.type])
      : membership;
    if (!resolved.canEdit(access)) throw errors.forbidden("You can't add files to this item");
  } else {
    requireCanUploadPending(membership);
  }

  const maxBytes = deps.env.maxUploadMb * 1024 * 1024;
  if (input.bytes.byteLength > maxBytes) {
    throw errors.payloadTooLarge(`Files can be at most ${deps.env.maxUploadMb} MB`);
  }
  const quotaBytes = deps.env.teamStorageQuotaMb * 1024 * 1024;
  if (teamStorageUsed(orm, input.teamId) + input.bytes.byteLength > quotaBytes) {
    throw errors.payloadTooLarge(
      `This team has used its ${formatMb(quotaBytes)} of storage. Delete files or ask the owner to raise TEAM_STORAGE_QUOTA_MB.`,
    );
  }
  const pendingCap = pendingUploadCapBytes(deps.env);
  if (!parent) requirePendingRoom(orm, actor, input.teamId, input.bytes.byteLength, pendingCap);

  const id = newId();
  const now = new Date();
  const filename = sanitizeFilename(input.filename);
  const { mimeType } = await sniffType(input.bytes, filename, { text: input.isText === true });
  const storagePath = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    id,
  ].join('/');
  const file = attachmentFilePath(deps.env.dataDir, storagePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, input.bytes, { flag: 'wx' });

  try {
    const row = deps.db.write((tx) => {
      // Re-check the quota under the write lock (concurrent uploads).
      if (teamStorageUsed(tx, input.teamId) + input.bytes.byteLength > quotaBytes) {
        throw errors.payloadTooLarge(`This team has used its ${formatMb(quotaBytes)} of storage.`);
      }
      if (!parent) requirePendingRoom(tx, actor, input.teamId, input.bytes.byteLength, pendingCap);
      const inserted = tx
        .insert(s.attachment)
        .values({
          id,
          teamId: input.teamId,
          uploaderId: actor.userId,
          viaKeyId: actor.key?.id ?? null,
          parentType: parent?.type ?? 'pending',
          parentId: parent?.id ?? null,
          filename,
          mimeType,
          size: input.bytes.byteLength,
          sha256: sha256Hex(input.bytes),
          storagePath,
          createdAt: now,
        })
        .returning()
        .get();
      const projectId = parent ? resolveParent(tx, parent).projectId : null;
      if (parent) onParentWrite(tx, actor, parent.type, parent.id);
      recordActivity(tx, actor, {
        teamId: input.teamId,
        projectId,
        entityType: 'attachment',
        entityId: id,
        action: 'attachment.uploaded',
        meta: { filename, size: inserted.size, mimeType, parentType: inserted.parentType },
      });
      emitAfterCommit(tx, {
        type: 'attachment.changed',
        teamId: input.teamId,
        projectId,
        entityType: 'attachment',
        entityId: id,
        parentType: inserted.parentType,
        parentId: inserted.parentId,
        actorId: actor.userId,
      });
      return inserted;
    });
    const [attachment] = toAttachments(orm, [row]);
    if (!attachment) throw errors.internal();
    return attachment;
  } catch (error) {
    removeAttachmentFiles(deps.env.dataDir, [storagePath]);
    throw error;
  }
}

/** Upload helper for MCP: content as base64 or as text. */
export async function uploadAttachmentContent(
  deps: AppDeps,
  actor: Actor,
  input: UploadAttachmentFields & {
    filename: string;
    contentBase64?: string | undefined;
    text?: string | undefined;
  },
): Promise<Attachment> {
  let bytes: Uint8Array;
  if (input.contentBase64 !== undefined) {
    const normalized = input.contentBase64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(normalized)) {
      throw errors.validation('contentBase64 is not valid base64');
    }
    bytes = Buffer.from(
      normalized,
      normalized.includes('-') || normalized.includes('_') ? 'base64url' : 'base64',
    );
  } else if (input.text !== undefined) {
    bytes = Buffer.from(input.text, 'utf8');
  } else {
    throw errors.validation('Pass either contentBase64 or text');
  }
  return uploadAttachment(deps, actor, {
    teamId: input.teamId,
    parentType: input.parentType,
    parentId: input.parentId,
    filename: input.filename,
    bytes,
    isText: input.text !== undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/**
 * Null when the attachment's parent (reply → issue/task → project) is live. Otherwise the first
 * deleted link of that chain, which is the item in Trash (SPEC §1.12).
 */
function trashedParent(db: DbExecutor, row: AttachmentRow): TrashEntry | null {
  if (!row.parentId) return null;
  switch (row.parentType) {
    case 'pending':
    case 'user_avatar':
      return null;
    case 'issue':
    case 'task':
      return trashedItem(db, row.parentType, row.parentId);
    case 'project':
      return trashedProject(db, row.parentId);
    case 'reply':
      return trashedReply(db, row.parentId);
  }
}

/**
 * An attachment the actor may read: team members see non-deleted files of their team whose
 * parent is live; files of an item in Trash only those who may see that Trash entry (its author,
 * or `MANAGE_TRASH`); pending files only their uploader; avatars (no team) any signed-in user.
 */
function readableAttachment(deps: AppDeps, actor: Actor, id: string): AttachmentRow {
  const { orm } = deps.db;
  const row = orm
    .select()
    .from(s.attachment)
    .where(and(eq(s.attachment.id, id), isNull(s.attachment.deletedAt)))
    .get();
  if (!row) throw errors.notFound('Attachment');
  if (row.teamId === null) {
    if (row.parentType !== 'user_avatar') throw errors.notFound('Attachment');
    return row;
  }
  const membership = requireScopedAccess(
    orm,
    actor,
    row.teamId,
    attachmentProjectId(orm, row),
    'Attachment',
  );
  if (row.parentType === 'pending' && !isOwnContent(membership, row.uploaderId)) {
    throw errors.notFound('Attachment');
  }
  const trashed = trashedParent(orm, row);
  if (trashed && !canRestoreContent(membership, trashed.authorId)) {
    throw errors.notFound('Attachment');
  }
  return row;
}

/**
 * May the member see this attachment's history (per-item history)? The same rules as reading the
 * file, except that the attachment itself may be in Trash (then its uploader or `MANAGE_TRASH`).
 * Purged attachments are left to the team audit log.
 */
export function canSeeAttachmentHistory(
  db: DbExecutor,
  membership: Membership,
  id: string,
): boolean {
  const row = db.select().from(s.attachment).where(eq(s.attachment.id, id)).get();
  if (!row || row.teamId !== membership.teamId) return false;
  if (row.parentType === 'pending') return isOwnContent(membership, row.uploaderId);
  if (row.deletedAt && !canRestoreContent(membership, row.uploaderId)) return false;
  const trashed = trashedParent(db, row);
  return !trashed || canRestoreContent(membership, trashed.authorId);
}

export interface AttachmentFile {
  attachment: AttachmentRow;
  /** Absolute path on disk. */
  path: string;
  /** Rendered inline (raster images); everything else downloads. */
  inline: boolean;
}

/** The file behind `GET /api/attachments/:id/:filename`. */
export function getAttachmentFile(deps: AppDeps, actor: Actor, id: string): AttachmentFile {
  const attachment = readableAttachment(deps, actor, id);
  const file = attachmentFilePath(deps.env.dataDir, attachment.storagePath);
  if (!fs.existsSync(file)) {
    deps.logger.error({ attachmentId: id }, 'attachment file missing on disk');
    throw errors.notFound('Attachment');
  }
  return { attachment, path: file, inline: isInlineImage(attachment.mimeType) };
}

/** Attachments of an issue, task, reply or project (non-deleted, oldest first). */
export function listAttachments(
  deps: AppDeps,
  actor: Actor,
  parent: AttachmentParent,
): { items: Attachment[] } {
  const { orm } = deps.db;
  const resolved = resolveParent(orm, parent);
  requireScopedAccess(orm, actor, resolved.teamId, resolved.projectId, 'Item');
  return { items: attachmentsByParent(orm, parent.type, [parent.id]).get(parent.id) ?? [] };
}

export interface AttachmentWithContent extends Attachment {
  /** Absolute download URL. */
  downloadUrl: string;
  /** UTF-8 content, for text files up to 256 KB. */
  text: string | null;
}

/** MCP `get_attachment`: metadata, absolute URL and, for small text files, the content. */
export function getAttachmentWithContent(
  deps: AppDeps,
  actor: Actor,
  id: string,
): AttachmentWithContent {
  const { attachment, path: file } = getAttachmentFile(deps, actor, id);
  const [summary] = toAttachments(deps.db.orm, [attachment]);
  if (!summary) throw errors.internal();
  return {
    ...summary,
    downloadUrl: `${deps.env.baseUrl}${summary.url}`,
    text: inlineText(attachment, file),
  };
}

/** The copy of an image `get_attachment` shows agents fits these (what vision models take). */
export const AGENT_IMAGE_MAX_SIDE = 1568;
export const AGENT_IMAGE_MAX_BYTES = 1_000_000;

export interface AgentImage {
  /** Base64 bytes, for an MCP `image` content block. */
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
  /** Downscaled or re-encoded to fit `AGENT_IMAGE_MAX_SIDE` / `AGENT_IMAGE_MAX_BYTES`. */
  resized: boolean;
}

/**
 * MCP `get_attachment` for an image: the picture itself, so agents can see screenshots (BAT-5).
 * Images already within the limits go as they are; bigger ones are scaled down (PNG kept when it
 * fits, JPEG otherwise; animations keep their first frame). Null for other files, or when the
 * image can't be decoded.
 */
export async function getAgentImage(
  deps: AppDeps,
  actor: Actor,
  id: string,
): Promise<AgentImage | null> {
  const { attachment, path: file } = getAttachmentFile(deps, actor, id);
  if (!isInlineImage(attachment.mimeType)) return null;
  const mimeType = attachment.mimeType as AgentImage['mimeType'];
  try {
    const bytes = await fs.promises.readFile(file);
    const meta = await sharp(bytes).metadata();
    const width = meta.width;
    const height = meta.height;
    if (bytes.length <= AGENT_IMAGE_MAX_BYTES && Math.max(width, height) <= AGENT_IMAGE_MAX_SIDE) {
      return { data: bytes.toString('base64'), mimeType, width, height, resized: false };
    }
    const attempts: Array<{ side: number; format: 'png' | 'jpeg'; quality: number }> = [
      ...(mimeType === 'image/png'
        ? [{ side: AGENT_IMAGE_MAX_SIDE, format: 'png' as const, quality: 100 }]
        : []),
      { side: AGENT_IMAGE_MAX_SIDE, format: 'jpeg', quality: 82 },
      { side: AGENT_IMAGE_MAX_SIDE, format: 'jpeg', quality: 65 },
      { side: 1024, format: 'jpeg', quality: 65 },
    ];
    for (const attempt of attempts) {
      const resized = sharp(bytes)
        .rotate()
        .resize(attempt.side, attempt.side, { fit: 'inside', withoutEnlargement: true })
        .flatten(attempt.format === 'jpeg' ? { background: '#ffffff' } : false);
      const { data, info } = await (
        attempt.format === 'png'
          ? resized.png({ compressionLevel: 9 })
          : resized.jpeg({ quality: attempt.quality, mozjpeg: true })
      ).toBuffer({ resolveWithObject: true });
      if (data.length <= AGENT_IMAGE_MAX_BYTES) {
        return {
          data: data.toString('base64'),
          mimeType: attempt.format === 'png' ? 'image/png' : 'image/jpeg',
          width: info.width,
          height: info.height,
          resized: true,
        };
      }
    }
    return null;
  } catch (error) {
    deps.logger.warn({ err: error, attachmentId: id }, 'could not prepare image for an agent');
    return null;
  }
}

/**
 * The content of a small text file: a text type, or (for files stored before text detection, or
 * under a binary-looking type) content that is valid UTF-8 without NUL bytes.
 */
function inlineText(attachment: AttachmentRow, file: string): string | null {
  if (attachment.size > MAX_INLINE_TEXT_BYTES || isInlineImage(attachment.mimeType)) return null;
  if (isTextType(attachment.mimeType)) return fs.readFileSync(file, 'utf8');
  const bytes = fs.readFileSync(file);
  return isUtf8Text(bytes) ? bytes.toString('utf8') : null;
}

// ---------------------------------------------------------------------------------------------
// Delete / restore
// ---------------------------------------------------------------------------------------------

function attachmentProjectId(db: DbExecutor, row: AttachmentRow): string | null {
  if (!row.parentId || row.parentType === 'pending' || row.parentType === 'user_avatar')
    return null;
  if (row.parentType === 'project') return row.parentId;
  if (row.parentType === 'reply') {
    return (
      db
        .select({ projectId: s.reply.projectId })
        .from(s.reply)
        .where(eq(s.reply.id, row.parentId))
        .get()?.projectId ?? null
    );
  }
  const table = row.parentType === 'issue' ? s.issue : s.task;
  return (
    db.select({ projectId: table.projectId }).from(table).where(eq(table.id, row.parentId)).get()
      ?.projectId ?? null
  );
}

/** Moves an attachment to Trash (uploader, or `DELETE_ANY_CONTENT`). */
export function deleteAttachment(deps: AppDeps, actor: Actor, id: string): { ok: true } {
  const row = readableAttachment(deps, actor, id);
  if (row.teamId === null) throw errors.notFound('Attachment');
  const membership = requireScopedAccess(
    deps.db.orm,
    actor,
    row.teamId,
    attachmentProjectId(deps.db.orm, row),
    'Attachment',
  );
  requireCanDeleteContent(membership, row.uploaderId);
  const teamId = row.teamId;
  deps.db.write((tx) => {
    tx.update(s.attachment)
      .set({
        deletedAt: new Date(),
        deletedById: actor.userId,
        deletedViaKeyId: actor.key?.id ?? null,
      })
      .where(eq(s.attachment.id, id))
      .run();
    onParentWrite(tx, actor, row.parentType, row.parentId);
    const projectId = attachmentProjectId(tx, row);
    recordActivity(tx, actor, {
      teamId,
      projectId,
      entityType: 'attachment',
      entityId: id,
      action: 'attachment.deleted',
      meta: { filename: row.filename, parentType: row.parentType, parentId: row.parentId },
    });
    emitAfterCommit(tx, {
      type: 'attachment.changed',
      teamId,
      projectId,
      entityType: 'attachment',
      entityId: id,
      parentType: row.parentType,
      parentId: row.parentId,
      actorId: actor.userId,
    });
  });
  return { ok: true };
}

/** Restores an attachment from Trash (uploader, or `MANAGE_TRASH`). */
export function restoreAttachment(deps: AppDeps, actor: Actor, id: string): void {
  const { orm } = deps.db;
  const row = orm.select().from(s.attachment).where(eq(s.attachment.id, id)).get();
  if (!row?.deletedAt || row.teamId === null) throw errors.notFound('Deleted attachment');
  const membership = requireScopedAccess(
    orm,
    actor,
    row.teamId,
    attachmentProjectId(orm, row),
    'Deleted attachment',
  );
  if (!canRestoreContent(membership, row.uploaderId)) {
    throw errors.forbidden('You can only restore your own files');
  }
  const teamId = row.teamId;
  deps.db.write((tx) => {
    tx.update(s.attachment)
      .set({ deletedAt: null, deletedById: null, deletedViaKeyId: null })
      .where(eq(s.attachment.id, id))
      .run();
    onParentWrite(tx, actor, row.parentType, row.parentId);
    const projectId = attachmentProjectId(tx, row);
    recordActivity(tx, actor, {
      teamId,
      projectId,
      entityType: 'attachment',
      entityId: id,
      action: 'attachment.restored',
      meta: { filename: row.filename, parentType: row.parentType, parentId: row.parentId },
    });
    emitAfterCommit(tx, {
      type: 'attachment.changed',
      teamId,
      projectId,
      entityType: 'attachment',
      entityId: id,
      parentType: row.parentType,
      parentId: row.parentId,
      actorId: actor.userId,
    });
  });
}
