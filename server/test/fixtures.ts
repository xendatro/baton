import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_PROJECT_COLOR, DEFAULT_STATUSES, DEFAULT_TEAM_COLOR } from '@shared/constants';
import { TEAM_ROLE_SEEDS, type Permission } from '@shared/permissions';
import type { Database } from '../db';
import * as s from '../db/schema';
import { newId } from '../lib/ids';
import { generateApiKey } from '../lib/security';

/**
 * Test data factories. They insert rows directly (bypassing services) using the same seeds the
 * services use (TEAM_ROLE_SEEDS, DEFAULT_STATUSES), so tests can set up state in one line.
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
      })
      .returning()
      .get();
    tx.insert(s.teamMember).values({ teamId: team.id, userId: options.ownerId }).run();
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

/** Adds `userId` to the team, optionally with roles (`@everyone` is implicit). */
export function addMember(
  db: Database,
  options: { teamId: string; userId: string; roleIds?: string[] },
): void {
  db.write((tx) => {
    tx.insert(s.teamMember).values({ teamId: options.teamId, userId: options.userId }).run();
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
        .values({ projectId: project.id, ...seed, position })
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

export function createApiKey(
  db: Database,
  options: { userId: string; name?: string; expiresAt?: Date | null; revokedAt?: Date | null },
): CreatedApiKey {
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
  const statusId =
    options.statusId ??
    db.orm
      .select({ id: s.status.id })
      .from(s.status)
      .where(and(eq(s.status.projectId, options.project.id), eq(s.status.isDefault, true)))
      .get()?.id;
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
    })
    .returning()
    .get();
}
