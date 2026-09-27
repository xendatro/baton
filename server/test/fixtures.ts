import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_PROJECT_COLOR, DEFAULT_STATUSES, DEFAULT_TEAM_COLOR } from '@shared/constants';
import { ADMIN_ROLE_SEED, TEAM_ROLE_SEEDS, type Permission } from '@shared/permissions';
import type { Actor, ActorKey } from '../context';
import type { Database } from '../db';
import * as s from '../db/schema';
import { newId } from '../lib/ids';
import { generateApiKey } from '../lib/security';
import { ensureAgent, findAgentId } from '../services/agents';
import { seedStatusColumns } from '../services/pipelines';

/**
 * Test data factories. They insert rows directly (bypassing services) using the same seeds the
 * services use (TEAM_ROLE_SEEDS, DEFAULT_STATUSES), so tests can set up state in one line.
 *
 * Agent members (agents A): `createUser` makes no agent; `createApiKey` (and `createAgent`)
 * create the owner's agent, which joins the owner's teams, and from then on `createTeam` and
 * `addMember` add the agent along with its owner, as the services do.
 */

export type UserRow = typeof s.user.$inferSelect;
export type TeamRow = typeof s.team.$inferSelect;
export type RoleRow = typeof s.role.$inferSelect;
export type ProjectRow = typeof s.project.$inferSelect;
export type StatusRow = typeof s.status.$inferSelect;
export type ApiKeyRow = typeof s.apiKey.$inferSelect;

let sequence = 0;
const nextSequence = () => ++sequence;

export interface CreateUserOptions {
  /** Defaults to `user<n>`; pass null for an OAuth user who has not chosen one yet. */
  username?: string | null;
  email?: string;
  name?: string;
  emailVerified?: boolean;
  image?: string | null;
}

/** A user with a verified email and a username. */
export function createUser(db: Database, options: CreateUserOptions = {}): UserRow {
  const n = nextSequence();
  const username = options.username === undefined ? `user${n}` : options.username;
  const now = new Date();
  return db.orm
    .insert(s.user)
    .values({
      id: newId(),
      name: options.name ?? `User ${n}`,
      email: options.email ?? `user${n}@example.test`,
      emailVerified: options.emailVerified ?? true,
      image: options.image ?? null,
      username,
      displayUsername: username,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Adds an email + password credential account (Better Auth's `credential` provider). */
export async function addPassword(db: Database, userId: string, password: string): Promise<void> {
  const hashed = await hashPassword(password);
  const now = new Date();
  db.orm
    .insert(s.account)
    .values({
      id: newId(),
      accountId: userId,
      providerId: 'credential',
      userId,
      password: hashed,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

export interface CreatedTeam {
  team: TeamRow;
  everyoneRole: RoleRow;
  adminRole: RoleRow;
}

export interface CreateTeamOptions {
  ownerId: string;
  name?: string;
  slug?: string;
  icon?: string | null;
  color?: string;
  /**
   * "Agents need human sign-off for destructive actions" (design §6; on by default, like real
   * teams). Tests of what an agent's key deletes, rather than of sign-off, pass false.
   */
  agentSignoff?: boolean;
}

/**
 * Switches a team's agent sign-off (design §6) on or off, for tests of what an agent's key does
 * with destructive actions rather than of the sign-off itself.
 */
export function setAgentSignoff(db: Database, teamId: string, enabled: boolean): void {
  db.orm.update(s.team).set({ agentSignoff: enabled }).where(eq(s.team.id, teamId)).run();
}

/** A team with the seeded `@everyone` and Admin roles; the owner is a member. */
export function createTeam(db: Database, options: CreateTeamOptions): CreatedTeam {
  const n = nextSequence();
  return db.write((tx) => {
    const team = tx
      .insert(s.team)
      .values({
        name: options.name ?? `Team ${n}`,
        slug: options.slug ?? `team-${n}`,
        icon: options.icon ?? null,
        color: options.color ?? DEFAULT_TEAM_COLOR,
        ownerId: options.ownerId,
        ...(options.agentSignoff === undefined ? {} : { agentSignoff: options.agentSignoff }),
      })
      .returning()
      .get();
    tx.insert(s.teamMember).values({ teamId: team.id, userId: options.ownerId }).run();
    const agentId = findAgentId(tx, options.ownerId);
    if (agentId) tx.insert(s.teamMember).values({ teamId: team.id, userId: agentId }).run();
    const [everyoneRole, adminRole] = TEAM_ROLE_SEEDS.map((seed) =>
      tx
        .insert(s.role)
        .values({
          teamId: team.id,
          name: seed.name,
          slug: seed.slug,
          color: seed.color,
          position: seed.position,
          permissions: [...seed.permissions],
          mentionable: seed.mentionable,
          isEveryone: seed.isEveryone,
        })
        .returning()
        .get(),
    );
    if (!everyoneRole || !adminRole)
      throw new Error('TEAM_ROLE_SEEDS must seed @everyone and Admin');
    return { team, everyoneRole, adminRole };
  });
}

export interface CreateRoleOptions {
  teamId: string;
  name?: string;
  slug?: string;
  color?: string | null;
  position?: number;
  permissions?: Permission[];
  mentionable?: boolean;
}

export function createRole(db: Database, options: CreateRoleOptions): RoleRow {
  const n = nextSequence();
  return db.orm
    .insert(s.role)
    .values({
      teamId: options.teamId,
      name: options.name ?? `Role ${n}`,
      slug: options.slug ?? `role-${n}`,
      color: options.color ?? null,
      position: options.position ?? n + 1,
      permissions: options.permissions ?? [],
      mentionable: options.mentionable ?? true,
    })
    .returning()
    .get();
}

/**
 * Adds `userId` to the team, optionally with roles (`@everyone` is implicit). Their agent member
 * (if created yet) joins too, without roles.
 */
export function addMember(
  db: Database,
  options: { teamId: string; userId: string; roleIds?: string[] },
): void {
  db.write((tx) => {
    // An agent may already be here: it joins with its owner.
    tx.insert(s.teamMember)
      .values({ teamId: options.teamId, userId: options.userId })
      .onConflictDoNothing()
      .run();
    const agentId = findAgentId(tx, options.userId);
    if (agentId) {
      tx.insert(s.teamMember)
        .values({ teamId: options.teamId, userId: agentId })
        .onConflictDoNothing()
        .run();
    }
    for (const roleId of options.roleIds ?? []) {
      tx.insert(s.memberRole)
        .values({ teamId: options.teamId, userId: options.userId, roleId })
        .run();
    }
  });
}

export interface CreatedProject {
  project: ProjectRow;
  /** In position order: Open (default), Done. */
  statuses: StatusRow[];
}

export interface CreateProjectOptions {
  teamId: string;
  createdById?: string | null;
  name?: string;
  key?: string;
  description?: string;
}

/** A project with the default statuses (Open — default, Done). */
export function createProject(db: Database, options: CreateProjectOptions): CreatedProject {
  const n = nextSequence();
  return db.write((tx) => {
    const project = tx
      .insert(s.project)
      .values({
        teamId: options.teamId,
        name: options.name ?? `Project ${n}`,
        key: options.key ?? `P${n}`.slice(0, 6),
        description: options.description ?? '',
        color: DEFAULT_PROJECT_COLOR,
        createdById: options.createdById ?? null,
      })
      .returning()
      .get();
    const statuses = DEFAULT_STATUSES.map((seed, position) =>
      tx
        .insert(s.status)
        .values({ projectId: project.id, ...seedStatusColumns(seed), position })
        .returning()
        .get(),
    );
    return { project, statuses };
  });
}

export interface CreatedApiKey {
  /** Plaintext `bat_…` key for Authorization headers. */
  key: string;
  apiKey: ApiKeyRow;
}

/**
 * The user's agent member (agents A): created on first use, joining the user's teams. Its row is
 * what a request with one of the user's API keys acts as.
 */
export function createAgent(db: Database, ownerId: string): UserRow {
  const id = ensureAgent(db, ownerId);
  const row = db.orm.select().from(s.user).where(eq(s.user.id, id)).get();
  if (!row) throw new Error('agent not created');
  return row;
}

/**
 * Gives `ownerId`'s agent member (created if needed) the roles its owner has in each of the
 * owner's teams, plus the Admin role in teams the owner owns, so the owner's API keys act with
 * the owner's permissions (except owner-only actions: agents never own teams). Agents start with
 * `@everyone` only, so tests of keys doing privileged things call this after setting up teams.
 */
export function giveAgentOwnerRoles(db: Database, ownerId: string): UserRow {
  const agent = createAgent(db, ownerId);
  db.write((tx) => {
    const memberships = tx
      .select({ teamId: s.teamMember.teamId, teamOwnerId: s.team.ownerId })
      .from(s.teamMember)
      .innerJoin(s.team, eq(s.team.id, s.teamMember.teamId))
      .where(eq(s.teamMember.userId, ownerId))
      .all();
    for (const { teamId, teamOwnerId } of memberships) {
      tx.insert(s.teamMember).values({ teamId, userId: agent.id }).onConflictDoNothing().run();
      const roleIds = tx
        .select({ roleId: s.memberRole.roleId })
        .from(s.memberRole)
        .where(and(eq(s.memberRole.teamId, teamId), eq(s.memberRole.userId, ownerId)))
        .all()
        .map((row) => row.roleId);
      if (teamOwnerId === ownerId) {
        const admin = tx
          .select({ id: s.role.id })
          .from(s.role)
          .where(and(eq(s.role.teamId, teamId), eq(s.role.slug, ADMIN_ROLE_SEED.slug)))
          .get();
        if (admin) roleIds.push(admin.id);
      }
      for (const roleId of roleIds) {
        tx.insert(s.memberRole)
          .values({ teamId, userId: agent.id, roleId })
          .onConflictDoNothing()
          .run();
      }
    }
  });
  return agent;
}

/**
 * Grants `roleId` to `userId` and, when they have one in the team, to their agent member, so the
 * user's API keys (which act as the agent, capped by the user) get the role's permissions too.
 */
export function giveRoleWithAgent(
  db: Database,
  options: { teamId: string; userId: string; roleId: string },
): void {
  db.write((tx) => {
    const agentId = findAgentId(tx, options.userId);
    for (const userId of agentId ? [options.userId, agentId] : [options.userId]) {
      const member = tx
        .select({ userId: s.teamMember.userId })
        .from(s.teamMember)
        .where(and(eq(s.teamMember.teamId, options.teamId), eq(s.teamMember.userId, userId)))
        .get();
      if (!member) continue;
      tx.insert(s.memberRole)
        .values({ teamId: options.teamId, userId, roleId: options.roleId })
        .onConflictDoNothing()
        .run();
    }
  });
}

/**
 * What a request with one of `ownerId`'s API keys acts as (agents A): their agent member, via
 * the key. For tests that call services or register MCP tools directly.
 */
export function agentActor(
  db: Database,
  ownerId: string,
  key: ActorKey,
  source: 'mcp' | 'api' = 'mcp',
): Actor {
  return { userId: ensureAgent(db, ownerId), ownerId, source, key };
}

/** An API key of `userId`; creates their agent member too (which the key acts as). */
export function createApiKey(
  db: Database,
  options: { userId: string; name?: string; expiresAt?: Date | null; revokedAt?: Date | null },
): CreatedApiKey {
  ensureAgent(db, options.userId);
  const generated = generateApiKey();
  const apiKey = db.orm
    .insert(s.apiKey)
    .values({
      userId: options.userId,
      name: options.name ?? 'Test key',
      prefix: generated.prefix,
      hash: generated.hash,
      expiresAt: options.expiresAt ?? null,
      revokedAt: options.revokedAt ?? null,
    })
    .returning()
    .get();
  return { key: generated.key, apiKey };
}

export type IssueRow = typeof s.issue.$inferSelect;
export type TaskRow = typeof s.task.$inferSelect;

export interface CreateItemOptions {
  project: ProjectRow;
  authorId?: string | null;
  title?: string;
  body?: string;
}

/** Hands out the project's next issue or task number (like the services do). */
function nextNumber(db: Database, projectId: string, kind: 'issue' | 'task'): number {
  const column = kind === 'issue' ? s.project.issueSeq : s.project.taskSeq;
  const updated = db.orm
    .update(s.project)
    .set(kind === 'issue' ? { issueSeq: sql`${column} + 1` } : { taskSeq: sql`${column} + 1` })
    .where(eq(s.project.id, projectId))
    .returning({ issueSeq: s.project.issueSeq, taskSeq: s.project.taskSeq })
    .get();
  if (!updated) throw new Error('project not found');
  return kind === 'issue' ? updated.issueSeq : updated.taskSeq;
}

/** An issue (`KEY#n`) in the project. */
export function createIssue(db: Database, options: CreateItemOptions): IssueRow {
  const n = nextSequence();
  return db.orm
    .insert(s.issue)
    .values({
      projectId: options.project.id,
      teamId: options.project.teamId,
      number: nextNumber(db, options.project.id, 'issue'),
      title: options.title ?? `Issue ${n}`,
      body: options.body ?? '',
      authorId: options.authorId ?? null,
    })
    .returning()
    .get();
}

/** A task (`KEY-n`) in the project's default status. */
export function createTask(
  db: Database,
  options: CreateItemOptions & { statusId?: string },
): TaskRow {
  const n = nextSequence();
  const status = db.orm
    .select({ id: s.status.id, blocksDependents: s.status.blocksDependents })
    .from(s.status)
    .where(
      options.statusId
        ? eq(s.status.id, options.statusId)
        : and(eq(s.status.projectId, options.project.id), eq(s.status.isDefault, true)),
    )
    .get();
  const statusId = status?.id;
  if (!statusId) throw new Error('project has no default status');
  return db.orm
    .insert(s.task)
    .values({
      projectId: options.project.id,
      teamId: options.project.teamId,
      number: nextNumber(db, options.project.id, 'task'),
      title: options.title ?? `Task ${n}`,
      description: options.body ?? '',
      statusId,
      position: `a${n}`,
      authorId: options.authorId ?? null,
      // Completed while in a stage that doesn't block its dependents (as the tasks service does).
      completedAt: status.blocksDependents ? null : new Date(),
    })
    .returning()
    .get();
}
