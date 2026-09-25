import type { AttachmentParentType } from '@shared/constants';
import { attachmentSchema, type Attachment } from '@shared/schemas/core';
import { ApiError, uploadFile } from '@web/lib/api';
import { formatBytes } from '@web/lib/format';

/** Raster image types the server renders inline (never SVG). */
const INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export function isInlineImage(file: { type: string }): boolean {
  return INLINE_IMAGE_TYPES.has(file.type);
}

export interface UploadAttachmentOptions {
  teamId: string;
  /** Defaults to `pending`: the upload is attached to an item when that item is saved. */
  parentType?: AttachmentParentType;
  parentId?: string;
  /** Rejects larger files before uploading (the server enforces it too). */
  maxUploadMb?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** `POST /api/attachments` (multipart) with progress. */
export function uploadAttachment(
  file: File,
  options: UploadAttachmentOptions,
): Promise<Attachment> {
  const { teamId, parentType = 'pending', parentId, maxUploadMb, onProgress, signal } = options;
  if (maxUploadMb !== undefined && file.size > maxUploadMb * 1024 * 1024) {
    return Promise.reject(
      new ApiError(
        'payload_too_large',
        413,
        `“${file.name}” is ${formatBytes(file.size)}; the limit is ${maxUploadMb} MB.`,
      ),
    );
  }
  return uploadFile('/api/attachments', file, {
    fields: { teamId, parentType, parentId },
    schema: attachmentSchema,
    onProgress,
    signal,
  });
}
