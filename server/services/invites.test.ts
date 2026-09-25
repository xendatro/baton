import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { apiErrorSchema } from '@shared/schemas/common';
import {
  acceptInviteResponseSchema,
  inviteListResponseSchema,
  invitePreviewSchema,
  inviteSchema,
} from '@shared/schemas/teams';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { getMembership } from './access';
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite } from './invites';
import { deleteTeam } from './teams';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let manager: UserRow;
let guest: UserRow;
let team: CreatedTeam;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive' });
  member = createUser(ctx.db, { username: 'mia' });
  manager = createUser(ctx.db, { username: 'max' });
  guest = createUser(ctx.db, { username: 'gus' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme', name: 'Acme' });
  const invitesRole = createRole(ctx.db, {
    teamId: team.team.id,
    name: 'Recruiter',
    permissions: ['MANAGE_INVITES'],
  });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  addMember(ctx.db, { teamId: team.team.id, userId: manager.id, roleIds: [invitesRole.id] });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

async function errorOf(res: Response) {
  return apiErrorSchema.parse(await res.json()).error;
}

describe('creating and listing invites', () => {
  it('creates a link with expiry and max uses (Create invites is an @everyone default)', async () => {
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const before = Date.now();
    const res = await ctx.app.request(
      `/api/teams/${team.team.id}/invites`,
      json('POST', { expiresIn: '1h', maxUses: 5 }, bearer(key)),
    );
    expect(res.status).toBe(201);
    const invite = inviteSchema.parse(await res.json());
    expect(invite.code).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(invite).toMatchObject({
      url: `/join/${invite.code}`,
      maxUses: 5,
      uses: 0,
      status: 'active',
      createdBy: { username: 'mia' },
    });
    const expires = new Date(invite.expiresAt ?? 0).getTime() - before;
    expect(expires).toBeGreaterThan(59 * 60_000);
    expect(expires).toBeLessThanOrEqual(61 * 60_000);
    const audit = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'invite.created'))
      .get();
    expect(audit?.meta).toMatchObject({ code: invite.code, maxUses: 5 });
    expect(events.some((event) => event.type === 'invite.changed')).toBe(true);

    const never = createInvite(ctx.deps, actorOf(member), team.team.id, {
      expiresIn: 'never',
      maxUses: null,
    });
    expect(never.expiresAt).toBeNull();
    expect(never.maxUses).toBeNull();
  });

  it('refuses members without Create invites, and bad input', async () => {
    ctx.db.orm
      .update(s.role)
      .set({ permissions: [] })
      .where(eq(s.role.id, team.everyoneRole.id))
      .run();
    expect(() =>
      createInvite(ctx.deps, actorOf(member), team.team.id, { expiresIn: '7d', maxUses: null }),
    ).toThrow(/permission to create invites/);
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    const res = await ctx.app.request(
      `/api/teams/${team.team.id}/invites`,
      json('POST', { expiresIn: '2y', maxUses: 0 }, bearer(key)),
    );
    expect(res.status).toBe(400);
  });

  it('lists your own invites, or everyone’s with Manage invites; revoked ones are hidden', async () => {
    const mine = createInvite(ctx.deps, actorOf(member), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    const theirs = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    expect(listInvites(ctx.deps, actorOf(member), team.team.id).items.map((i) => i.id)).toEqual([
      mine.id,
    ]);
    const { key } = createApiKey(ctx.db, { userId: manager.id });
    const res = await ctx.app.request(`/api/teams/${team.team.id}/invites`, {
      headers: bearer(key),
    });
    expect(inviteListResponseSchema.parse(await res.json()).items.map((i) => i.id)).toEqual([
      theirs.id,
      mine.id,
    ]);

    revokeInvite(ctx.deps, actorOf(manager), team.team.id, theirs.code);
    expect(listInvites(ctx.deps, actorOf(owner), team.team.id).items.map((i) => i.id)).toEqual([
      mine.id,
    ]);
  });

  it('marks expired and used-up invites', () => {
    const invite = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '7d',
      maxUses: 1,
    });
    acceptInvite(ctx.deps, actorOf(guest), invite.code);
    const expired = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '1h',
      maxUses: null,
    });
    const later = new Date(Date.now() + 2 * 60 * 60_000);
    const statuses = new Map(
      listInvites(ctx.deps, actorOf(owner), team.team.id, later).items.map((i) => [i.id, i.status]),
    );
    expect(statuses.get(invite.id)).toBe('used_up');
    expect(statuses.get(expired.id)).toBe('expired');
  });
});

describe('revoking invites', () => {
  it('lets creators revoke their own and Manage invites revoke anyone’s', async () => {
    const own = createInvite(ctx.deps, actorOf(member), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    const other = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    expect(() => revokeInvite(ctx.deps, actorOf(member), team.team.id, other.id)).toThrow(
      /Invite not found/,
    );
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const res = await ctx.app.request(`/api/teams/${team.team.id}/invites/${own.id}`, {
      method: 'DELETE',
      headers: bearer(key),
    });
    expect(res.status).toBe(200);
    revokeInvite(ctx.deps, actorOf(manager), team.team.id, other.id);
    expect(
      ctx.db.orm.select().from(s.activity).where(eq(s.activity.action, 'invite.revoked')).all(),
    ).toHaveLength(2);
    // Revoked twice → gone.
    expect(() => revokeInvite(ctx.deps, actorOf(manager), team.team.id, other.id)).toThrow(
      /Invite not found/,
    );
  });
});

describe('joining with an invite', () => {
  it('previews the team, then joins it once (idempotent afterwards)', async () => {
    const invite = createInvite(ctx.deps, actorOf(member), team.team.id, {
      expiresIn: '7d',
      maxUses: 10,
    });
    const { key } = createApiKey(ctx.db, { userId: guest.id });
    const preview = invitePreviewSchema.parse(
      await (await ctx.app.request(`/api/invites/${invite.code}`, { headers: bearer(key) })).json(),
    );
    expect(preview).toMatchObject({
      team: { name: 'Acme', slug: 'acme', memberCount: 3 },
      inviter: { username: 'mia' },
      alreadyMember: false,
    });

    const res = await ctx.app.request(
      `/api/invites/${invite.code}/accept`,
      json('POST', {}, bearer(key)),
    );
    expect(acceptInviteResponseSchema.parse(await res.json())).toEqual({
      team: { id: team.team.id, slug: 'acme', name: 'Acme' },
      alreadyMember: false,
    });
    expect(getMembership(ctx.db.orm, team.team.id, guest.id)).not.toBeNull();
    const joined = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'member.joined'))
      .get();
    expect(joined).toMatchObject({
      actorId: guest.id,
      entityType: 'member',
      entityId: guest.id,
      meta: { username: 'gus', inviteCode: invite.code, invitedBy: 'mia' },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['member.joined', 'invite.changed']),
    );

    const again = acceptInvite(ctx.deps, actorOf(guest), invite.code);
    expect(again.alreadyMember).toBe(true);
    const row = ctx.db.orm.select().from(s.invite).where(eq(s.invite.id, invite.id)).get();
    expect(row?.uses).toBe(1);
    expect(previewInvite(ctx.deps, actorOf(guest), invite.code).alreadyMember).toBe(true);
  });

  it('admits exactly as many people as the link allows', () => {
    const invite = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '7d',
      maxUses: 1,
    });
    acceptInvite(ctx.deps, actorOf(guest), invite.code);
    const late = createUser(ctx.db);
    expect(() => acceptInvite(ctx.deps, actorOf(late), invite.code)).toThrow(/maximum number/);
    expect(getMembership(ctx.db.orm, team.team.id, late.id)).toBeNull();
    // Existing members can still open it.
    expect(acceptInvite(ctx.deps, actorOf(guest), invite.code).alreadyMember).toBe(true);
  });

  it('explains why a link no longer works', async () => {
    const { key } = createApiKey(ctx.db, { userId: guest.id });
    const reasonOf = async (code: string) => {
      const res = await ctx.app.request(`/api/invites/${code}`, { headers: bearer(key) });
      expect(res.status).toBe(404);
      return ((await errorOf(res)).details as { reason: string }).reason;
    };
    expect(await reasonOf('abcdefghij')).toBe('invalid');

    const revoked = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    revokeInvite(ctx.deps, actorOf(owner), team.team.id, revoked.id);
    expect(await reasonOf(revoked.code)).toBe('revoked');

    const expired = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '30m',
      maxUses: null,
    });
    ctx.db.orm
      .update(s.invite)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(s.invite.id, expired.id))
      .run();
    expect(await reasonOf(expired.code)).toBe('expired');
    const accept = await ctx.app.request(
      `/api/invites/${expired.code}/accept`,
      json('POST', {}, bearer(key)),
    );
    expect(((await errorOf(accept)).details as { reason: string }).reason).toBe('expired');

    const usedUp = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '7d',
      maxUses: 1,
    });
    ctx.db.orm.update(s.invite).set({ uses: 1 }).where(eq(s.invite.id, usedUp.id)).run();
    expect(await reasonOf(usedUp.code)).toBe('used_up');

    const live = createInvite(ctx.deps, actorOf(owner), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    deleteTeam(ctx.deps, actorOf(owner), team.team.id);
    expect(await reasonOf(live.code)).toBe('invalid');

    // Malformed codes are a validation error.
    const bad = await ctx.app.request('/api/invites/short', { headers: bearer(key) });
    expect(bad.status).toBe(400);
  });
});
