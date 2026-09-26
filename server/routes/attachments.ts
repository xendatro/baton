import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { listAttachmentsQuerySchema, uploadAttachmentFieldsSchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';
import { parseInput, parseMultipartBody, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { byUser, rateLimit } from '../middleware/rateLimit';
import {
  deleteAttachment,
  getAttachmentFile,
  listAttachments,
  uploadAttachment,
} from '../services/attachments';

/**
 * Attachments: /attachments (upload, list, download, delete).
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const attachmentRoutes = new Hono<AppEnv>();

/** Multipart overhead allowed on top of MAX_UPLOAD_MB (boundaries, part headers, fields). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Rejects oversized upload bodies while they stream in, before anything is buffered. */
const uploadSizeLimit: MiddlewareHandler<AppEnv> = (c, next) =>
  bodyLimit({
    maxSize: c.var.deps.env.maxUploadMb * 1024 * 1024 + MULTIPART_OVERHEAD_BYTES,
    onError: (ctx) =>
      ctx.json(
        errors.payloadTooLarge(`Files can be at most ${c.var.deps.env.maxUploadMb} MB`).toJSON(),
        413,
      ),
  })(c, next);

const UPLOAD_FORMAT_MESSAGE = 'Send the file as multipart/form-data in the "file" field';

attachmentRoutes.post(
  '/attachments',
  rateLimit({ name: 'uploads', key: byUser }),
  uploadSizeLimit,
  async (c) => {
    const actor = requireActor(c);
    const body = await parseMultipartBody(c, UPLOAD_FORMAT_MESSAGE);
    const file = body.file;
    if (!(file instanceof File)) {
      throw errors.validation(UPLOAD_FORMAT_MESSAGE);
    }
    const fields = parseInput(uploadAttachmentFieldsSchema, {
      teamId: body.teamId,
      parentType: body.parentType,
      parentId: body.parentId,
    });
    const attachment = await uploadAttachment(c.var.deps, actor, {
      ...fields,
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return c.json(attachment, 201);
  },
);

attachmentRoutes.get('/attachments', validateQuery(listAttachmentsQuerySchema), (c) => {
  const query = c.req.valid('query');
  return c.json(
    listAttachments(c.var.deps, requireActor(c), { type: query.parentType, id: query.parentId }),
  );
});

/**
 * CSP of a downloaded file: nothing it contains may run or load anything, even if some other bug
 * got it included as a script or stylesheet (the app's own CSP allows 'self').
 */
const DOWNLOAD_CSP = "default-src 'none'; sandbox";

/**
 * Gives file downloads their own CSP. Registered in createApp before the security-headers
 * middleware, so it runs after it and replaces the app-wide policy for these responses.
 */
export const attachmentDownloadHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.req.method === 'GET') c.res.headers.set('Content-Security-Policy', DOWNLOAD_CSP);
};

/** RFC 6266 `Content-Disposition` with an ASCII fallback and the UTF-8 name. */
function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

attachmentRoutes.get(
  '/attachments/:id/:filename',
  validateParams(z.object({ id: idSchema, filename: z.string() })),
  (c) => {
    const { attachment, path, inline } = getAttachmentFile(
      c.var.deps,
      requireActor(c),
      c.req.valid('param').id,
    );
    const etag = `"${attachment.sha256}"`;
    const headers: Record<string, string> = {
      // Raster images render inline; everything else (SVG and HTML included) downloads, as an
      // opaque type so a same-origin <script> or <link rel=stylesheet> can never use it. The
      // real type stays in the attachment's metadata.
      'Content-Type': inline ? attachment.mimeType : 'application/octet-stream',
      'Content-Disposition': contentDisposition(
        inline ? 'inline' : 'attachment',
        attachment.filename,
      ),
      // Content never changes for an id; private because it needs authentication.
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: etag,
    };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    headers['Content-Length'] = String(attachment.size);
    // Node's web stream type is structurally the DOM ReadableStream Hono expects.
    const stream = Readable.toWeb(fs.createReadStream(path)) as ReadableStream<Uint8Array>;
    return c.body(stream, 200, headers);
  },
);

attachmentRoutes.delete('/attachments/:id', validateParams(z.object({ id: idSchema })), (c) =>
  c.json(deleteAttachment(c.var.deps, requireActor(c), c.req.valid('param').id)),
);
