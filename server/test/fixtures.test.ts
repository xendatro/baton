import { verifyPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVERYONE_DEFAULTS } from '@shared/permissions';
import * as s from '../db/schema';
import { hashApiKey } from '../lib/security';
import {
  addMember,
  addPassword,
  createApiKey,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('test factories', () => {
  it('create verified users with unique usernames', () => {
    const a = createUser(ctx.db);
    const b = createUser(ctx.db, { username: 'ethan' });
    const c = createUser(ctx.db, { username: null, emailVerified: false });
    expect(a.emailVerified).toBe(true);
    expect(a.username).not.toBe(b.username);
    expect(b.username).toBe('ethan');
    expect(c).toMatchObject({ username: null, emailVerified: false, theme: 'system' });
  });

  it('store Better Auth compatible password hashes', async () => {
    const user = createUser(ctx.db);
    await addPassword(ctx.db, user.id, 'correct horse battery');
    const account = ctx.db.orm.select().from(s.account).where(eq(s.account.userId, user.id)).get();
    expect(account?.providerId).toBe('credential');
    expect(
      await verifyPassword({ hash: account?.password ?? '', password: 'correct horse battery' }),
    ).toBe(true);
  });

  it('create teams with seeded roles and the owner as member', () => {
    const owner = createUser(ctx.db);
    const { team, everyoneRole, adminRole } = createTeam(ctx.db, {
      ownerId: owner.id,
      slug: 'acme',
    });
    expect(team).toMatchObject({ slug: 'acme', ownerId: owner.id, deletedAt: null });
    expect(everyoneRole).toMatchObject({
      isEveryone: true,
      position: 0,
      permissions: [...EVERYONE_DEFAULTS],
    });
    expect(adminRole).toMatchObject({ name: 'Admin', permissions: ['ADMINISTRATOR'] });
    const members = ctx.db.orm
      .select()
      .from(s.teamMember)
      .where(eq(s.teamMember.teamId, team.id))
      .all();
    expect(members.map((m) => m.userId)).toEqual([owner.id]);
  });

  it('add members with roles', () => {
    const owner = createUser(ctx.db);
    const member = createUser(ctx.db);
    const { team } = createTeam(ctx.db, { ownerId: owner.id });
    const role = createRole(ctx.db, { teamId: team.id, permissions: ['MANAGE_LABELS'] });
    addMember(ctx.db, { teamId: team.id, userId: member.id, roleIds: [role.id] });
    const assigned = ctx.db.orm
      .select()
      .from(s.memberRole)
      .where(and(eq(s.memberRole.teamId, team.id), eq(s.memberRole.userId, member.id)))
      .all();
    expect(assigned.map((r) => r.roleId)).toEqual([role.id]);
  });

  it('create projects with default statuses', () => {
    const owner = createUser(ctx.db);
    const { team } = createTeam(ctx.db, { ownerId: owner.id });
    const { project, statuses } = createProject(ctx.db, {
      teamId: team.id,
      key: 'BAT',
      createdById: owner.id,
    });
    expect(project).toMatchObject({ key: 'BAT', issueSeq: 0, taskSeq: 0 });
    expect(statuses.map((st) => [st.name, st.category, st.isDefault, st.position])).toEqual([
      ['Open', 'open', true, 0],
      ['Done', 'done', false, 1],
    ]);
  });

  it('create API keys stored as hashes', () => {
    const user = createUser(ctx.db);
    const { key, apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Claude on laptop' });
    expect(apiKey.hash).toBe(hashApiKey(key));
    expect(key.startsWith(`bat_${apiKey.prefix}`)).toBe(true);
    expect(apiKey).toMatchObject({ name: 'Claude on laptop', revokedAt: null, lastUsedAt: null });
  });
});
