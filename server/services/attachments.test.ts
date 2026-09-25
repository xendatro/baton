import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@shared/schemas/common';
import {
  attachmentListResponseSchema,
  attachmentSchema,
  type Attachment,
} from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { sha256Hex } from '../lib/security';
import {
  addMember,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  attachmentFilePath,
  attachToParent,
  getAttachmentWithContent,
  restoreAttachment,
  sanitizeFilename,
  sniffType,
  uploadAttachmentContent,
} from './attachments';
import { createReply } from './replies';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let memberKey: string;

const actorOf = (u: { id: string }): Actor => ({ userId: u.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext({ env: { MAX_UPLOAD_MB: '1', TEAM_STORAGE_QUOTA_MB: '2' } });
  owner = createUser(ctx.db);
  member = createUser(ctx.db);
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  memberKey = createApiKey(ctx.db, { userId: member.id }).key;
});

afterEach(() => {
  ctx.close();
});

function upload(
  bytes: Uint8Array,
  filename: string,
  fields: Record<string, string> = {},
  key = memberKey,
): Promise<Response> {
  const form = new FormData();
  form.set('file', new File([bytes], filename));
  form.set('teamId', team.team.id);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return Promise.resolve(
    ctx.app.request('/api/attachments', { method: 'POST', headers: bearer(key), body: form }),
  );
}

async function uploaded(res: Response): Promise<Attachment> {
  expect(res.status).toBe(201);
  return attachmentSchema.parse(await res.json());
}

describe('file helpers', () => {
  it('sanitizes filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('a<b>:c|d?.txt')).toBe('a_b__c_d_.txt');
    expect(sanitizeFilename('\u0000\u001f.hidden')).toBe('__.hidden');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('trailing. . ')).toBe('trailing');
    const long = sanitizeFilename(`${'é'.repeat(300)}.png`);
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(255);
    expect(long.endsWith('.png')).toBe(true);
  });

  it('sniffs types from content and never trusts image names alone', async () => {
    expect(await sniffType(PNG, 'x.bin')).toEqual({ mimeType: 'image/png', isImage: true });
    expect(await sniffType(Buffer.from('<html></html>'), 'fake.png')).toEqual({
      mimeType: 'application/octet-stream',
      isImage: false,
    });
    expect(await sniffType(SVG, 'logo.svg')).toMatchObject({ isImage: false });
    expect(await sniffType(Buffer.from('# hi'), 'notes.md')).toEqual({
      mimeType: 'text/markdown',
      isImage: false,
    });
  });
});

describe('upload', () => {
  it('stores a pending upload with hash, sniffed type and path, visible only to the uploader', async () => {
    const attachment = await uploaded(await upload(PNG, 'dot.png'));
    expect(attachment).toMatchObject({
      teamId: team.team.id,
      parentType: 'pending',
      parentId: null,
      filename: 'dot.png',
      mimeType: 'image/png',
      size: PNG.length,
      isImage: true,
      uploader: { id: member.id },
    });
    expect(attachment.url).toBe(`/api/attachments/${attachment.id}/dot.png`);
    const row = ctx.db.orm
      .select()
      .from(s.attachment)
      .where(eq(s.attachment.id, attachment.id))
      .get();
    expect(row?.sha256).toBe(sha256Hex(PNG));
    expect(row?.storagePath).toMatch(new RegExp(`^\\d{4}/\\d{2}/${attachment.id}$`));
    expect(fs.readFileSync(attachmentFilePath(ctx.dataDir, row?.storagePath ?? ''))).toEqual(PNG);

    const own = await ctx.app.request(attachment.url, { headers: bearer(memberKey) });
    expect(own.status).toBe(200);
    const ownerKey = createApiKey(ctx.db, { userId: owner.id }).key;
    expect((await ctx.app.request(attachment.url, { headers: bearer(ownerKey) })).status).toBe(404);
  });

  it('enforces MAX_UPLOAD_MB and the team quota', async () => {
    const tooBig = await upload(new Uint8Array(1024 * 1024 + 1), 'big.bin');
    expect(tooBig.status).toBe(413);
    expect(apiErrorSchema.parse(await tooBig.json()).error.code).toBe('payload_too_large');

    const chunk = new Uint8Array(900 * 1024);
    await uploaded(await upload(chunk, 'a.bin'));
    await uploaded(await upload(chunk, 'b.bin'));
    const overQuota = await upload(chunk, 'c.bin');
    expect(overQuota.status).toBe(413);
    expect(apiErrorSchema.parse(await overQuota.json()).error.message).toMatch(/storage/);
    // Nothing was left on disk for the refused upload.
    expect(ctx.db.orm.select().from(s.attachment).all()).toHaveLength(2);
  });

  it('validates the multipart form', async () => {
    const noFile = await ctx.app.request('/api/attachments', {
      method: 'POST',
      headers: bearer(memberKey),
      body: new FormData(),
    });
    expect(noFile.status).toBe(400);
    const badParent = await upload(PNG, 'x.png', { parentType: 'task' });
    expect(badParent.status).toBe(400);
    const avatar = await upload(PNG, 'x.png', { parentType: 'user_avatar', parentId: member.id });
    expect(avatar.status).toBe(400);
  });

  it('attaches directly to a parent the uploader may edit', async () => {
    const own = createTask(ctx.db, { project: project.project, authorId: member.id });
    const attachment = await uploaded(
      await upload(Buffer.from('hello'), 'hello.txt', { parentType: 'task', parentId: own.id }),
    );
    expect(attachment).toMatchObject({
      parentType: 'task',
      parentId: own.id,
      mimeType: 'text/plain',
    });

    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    const denied = await upload(Buffer.from('x'), 'x.txt', {
      parentType: 'issue',
      parentId: issue.id,
    });
    expect(denied.status).toBe(403);

    const list = attachmentListResponseSchema.parse(
      await (
        await ctx.app.request(`/api/attachments?parentType=task&parentId=${own.id}`, {
          headers: bearer(memberKey),
        })
      ).json(),
    );
    expect(list.items.map((a) => a.id)).toEqual([attachment.id]);
  });

  it('accepts base64 and text content (MCP helper)', async () => {
    const fromBase64 = await uploadAttachmentContent(ctx.deps, actorOf(member), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'dot.png',
      contentBase64: PNG.toString('base64'),
    });
    expect(fromBase64).toMatchObject({ mimeType: 'image/png', size: PNG.length });
    const fromText = await uploadAttachmentContent(ctx.deps, actorOf(member), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'notes.md',
      text: '# Notes',
    });
    expect(fromText.size).toBe(7);
    await expect(
      uploadAttachmentContent(ctx.deps, actorOf(member), {
        teamId: team.team.id,
        parentType: 'pending',
        filename: 'x',
        contentBase64: 'not base64!',
      }),
    ).rejects.toThrow(/base64/);
  });
});

describe('download', () => {
  it('serves raster images inline and everything else (SVG included) as attachment', async () => {
    const task = createTask(ctx.db, { project: project.project, authorId: member.id });
    const fields = { parentType: 'task', parentId: task.id };
    const png = await uploaded(await upload(PNG, 'dot.png', fields));
    const svg = await uploaded(await upload(SVG, 'logo.svg', fields));
    const html = await uploaded(await upload(Buffer.from('<h1>x</h1>'), 'page.html', fields));

    const pngRes = await ctx.app.request(png.url, { headers: bearer(memberKey) });
    expect(pngRes.headers.get('content-type')).toBe('image/png');
    expect(pngRes.headers.get('content-disposition')).toMatch(/^inline; filename="dot.png"/);
    expect(pngRes.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await pngRes.arrayBuffer())).toEqual(PNG);
    const etag = pngRes.headers.get('etag') ?? '';
    const cached = await ctx.app.request(png.url, {
      headers: { ...bearer(memberKey), 'If-None-Match': etag },
    });
    expect(cached.status).toBe(304);

    // Regression (SEC-7): executable types were served as text/javascript, text/css or
    // text/html from our own origin, which CSP 'self' would let a <script src> load.
    const js = await uploaded(await upload(Buffer.from('alert(1)'), 'x.js', fields));
    const css = await uploaded(await upload(Buffer.from('body{}'), 'x.css', fields));
    expect(pngRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    for (const item of [svg, html, js, css]) {
      const res = await ctx.app.request(item.url, { headers: bearer(memberKey) });
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(item.isImage).toBe(false);
    }
    expect([svg, html, js, css].map((item) => item.mimeType)).toEqual([
      'image/svg+xml',
      'text/html',
      'text/javascript',
      'text/css',
    ]);
  });

  it('encodes non-ASCII filenames', async () => {
    const task = createTask(ctx.db, { project: project.project, authorId: member.id });
    const file = await uploaded(
      await upload(Buffer.from('x'), 'résumé "final".txt', {
        parentType: 'task',
        parentId: task.id,
      }),
    );
    const res = await ctx.app.request(file.url, { headers: bearer(memberKey) });
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="r_sum_ _final_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20_final_.txt`,
    );
  });

  it('denies other teams and anonymous requests', async () => {
    const task = createTask(ctx.db, { project: project.project, authorId: member.id });
    const file = await uploaded(
      await upload(PNG, 'dot.png', { parentType: 'task', parentId: task.id }),
    );
    const outsider = createApiKey(ctx.db, { userId: createUser(ctx.db).id });
    expect((await ctx.app.request(file.url, { headers: bearer(outsider.key) })).status).toBe(404);
    expect((await ctx.app.request(file.url)).status).toBe(401);
    const list = await ctx.app.request(`/api/attachments?parentType=task&parentId=${task.id}`, {
      headers: bearer(outsider.key),
    });
    expect(list.status).toBe(404);
  });
});

// Regression (SEC-6): files of Trash items stayed downloadable by every member.
describe('files of deleted items', () => {
  it('are hidden from members who may not see the Trash item', async () => {
    const ownerKey = createApiKey(ctx.db, { userId: owner.id }).key;
    const issue = createIssue(ctx.db, { project: project.project, authorId: member.id });
    const file = await uploaded(
      await upload(Buffer.from('secret contents'), 'secret.txt', {
        parentType: 'issue',
        parentId: issue.id,
      }),
    );
    const other = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: other.id });
    const otherKey = createApiKey(ctx.db, { userId: other.id }).key;
    expect((await ctx.app.request(file.url, { headers: bearer(otherKey) })).status).toBe(200);

    ctx.db.orm.update(s.issue).set({ deletedAt: new Date() }).where(eq(s.issue.id, issue.id)).run();
    expect((await ctx.app.request(file.url, { headers: bearer(otherKey) })).status).toBe(404);
    expect(() => getAttachmentWithContent(ctx.deps, actorOf(other), file.id)).toThrow(/not found/);
    // The author and MANAGE_TRASH (the owner) can still open it, as they can see the Trash item.
    expect((await ctx.app.request(file.url, { headers: bearer(memberKey) })).status).toBe(200);
    expect((await ctx.app.request(file.url, { headers: bearer(ownerKey) })).status).toBe(200);
  });

  it('covers deleted replies and deleted projects', async () => {
    const task = createTask(ctx.db, { project: project.project, authorId: member.id });
    const pending = await uploaded(await upload(Buffer.from('log'), 'log.txt'));
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: 'see file',
      attachmentIds: [pending.id],
    });
    const other = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: other.id });
    const read = () => getAttachmentWithContent(ctx.deps, actorOf(other), pending.id);
    expect(read().text).toBe('log');

    ctx.db.orm.update(s.reply).set({ deletedAt: new Date() }).where(eq(s.reply.id, reply.id)).run();
    expect(read).toThrow(/not found/);
    ctx.db.orm.update(s.reply).set({ deletedAt: null }).where(eq(s.reply.id, reply.id)).run();
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, project.project.id))
      .run();
    expect(read).toThrow(/not found/);
  });
});

describe('attach, delete and restore', () => {
  it('attaches only the actor’s own pending uploads in the same team', async () => {
    const mine = await uploaded(await upload(PNG, 'a.png'));
    const ownerKey = createApiKey(ctx.db, { userId: owner.id }).key;
    const theirs = await uploaded(await upload(PNG, 'b.png', {}, ownerKey));
    const task = createTask(ctx.db, { project: project.project });

    expect(() =>
      createReply(ctx.deps, actorOf(member), {
        parentType: 'task',
        parentId: task.id,
        body: 'with files',
        attachmentIds: [mine.id, theirs.id],
      }),
    ).toThrow(/pending uploads/);
    // The failed write left everything untouched.
    expect(ctx.db.orm.select().from(s.reply).all()).toEqual([]);

    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: 'with a file',
      attachmentIds: [mine.id],
    });
    expect(reply.attachments.map((a) => a.id)).toEqual([mine.id]);
    expect(reply.attachments[0]).toMatchObject({ parentType: 'reply', parentId: reply.id });
    // Already attached: can't be claimed again.
    expect(() =>
      ctx.db.write((tx) =>
        attachToParent(tx, actorOf(member), [mine.id], {
          type: 'task',
          id: task.id,
          teamId: team.team.id,
        }),
      ),
    ).toThrow(/pending uploads/);
  });

  it('soft-deletes for the uploader or DELETE_ANY_CONTENT, restores for the uploader', async () => {
    const task = createTask(ctx.db, { project: project.project, authorId: member.id });
    const file = await uploaded(
      await upload(PNG, 'dot.png', { parentType: 'task', parentId: task.id }),
    );
    const other = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: other.id });
    const otherKey = createApiKey(ctx.db, { userId: other.id }).key;
    const denied = await ctx.app.request(`/api/attachments/${file.id}`, {
      method: 'DELETE',
      headers: bearer(otherKey),
    });
    expect(denied.status).toBe(403);

    const ownerKey = createApiKey(ctx.db, { userId: owner.id }).key;
    const deleted = await ctx.app.request(`/api/attachments/${file.id}`, {
      method: 'DELETE',
      headers: bearer(ownerKey),
    });
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await ctx.app.request(file.url, { headers: bearer(memberKey) })).status).toBe(404);
    const row = ctx.db.orm.select().from(s.attachment).where(eq(s.attachment.id, file.id)).get();
    expect(row?.deletedById).toBe(owner.id);

    expect(() => restoreAttachment(ctx.deps, actorOf(other), file.id)).toThrow(/own files/);
    restoreAttachment(ctx.deps, actorOf(member), file.id);
    expect((await ctx.app.request(file.url, { headers: bearer(memberKey) })).status).toBe(200);
    const actions = ctx.db.orm
      .select({ action: s.activity.action })
      .from(s.activity)
      .where(eq(s.activity.entityId, file.id))
      .all()
      .map((r) => r.action);
    expect(actions).toEqual(['attachment.uploaded', 'attachment.deleted', 'attachment.restored']);
  });
});
