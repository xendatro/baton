import { and, eq, inArray } from 'drizzle-orm';
import type { AgentNotificationLevel, NotificationType } from '@shared/constants';
import { DEFAULT_CHAIN, type Chain } from '@shared/schemas/agentRunner';
import {
  ACCOUNT_NOTIFICATIONS,
  PROJECT_NOTIFY_KIND_TYPES,
  PROJECT_NOTIFY_KINDS,
  updateMyProjectSettingsInputSchema,
  updateMyTeamSettingsInputSchema,
  type MyProjectSettings,
  type MyTeamSettings,
  type ProjectNotifications,
  type UpdateMyProjectSettingsInput,
  type UpdateMyTeamSettingsInput,
} from '@shared/schemas/projectSettings';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { personActor } from './agents';
import { emitAfterCommit } from './events';
import { requireProject } from './projects';
import { requireTeam } from './teams';

/**
 * Your settings for one project (BAT-29): notification overrides (`project_member_settings`) and
 * your agent's default model chain there (`agent_project_mapping.chain`, the same rows Settings
 * → Automatic agents lists as "Projects with their own default"). Personal: anyone who can see the project has their own, and
 * an agent's key reads and writes its owner's. Whatever is unset uses the account's settings.
 */

/** Types that "Mentions & assignments only" lets through. */
const MENTION_TYPES: ReadonlySet<NotificationType> = new Set([
  'mention',
  'role_mention',
  'assigned',
  // Someone asks to start your agent: addressed to you like a mention.
  'agent_request',
]);

/** The notification type's per-kind switch, or null for types that have none. */
function kindOf(type: NotificationType) {
  return (
    PROJECT_NOTIFY_KINDS.find((kind) => PROJECT_NOTIFY_KIND_TYPES[kind].includes(type)) ?? null
  );
}

/**
 * Does a person with these notifications (a project's override, else the account's) hear about a
 * notification of `type`? `always` (an agent's sign-off request) gets through everything.
 */
export function wantsNotification(
  prefs: ProjectNotifications | null,
  type: NotificationType,
  always = false,
): boolean {
  if (always) return true;
  const { level, kinds } = prefs ?? ACCOUNT_NOTIFICATIONS;
  if (level === 'none') return false;
  if (level === 'mentions') return MENTION_TYPES.has(type);
  const kind = kindOf(type);
  return kind === null || kinds[kind];
}

interface ProjectPrefs {
  notifications: ProjectNotifications | null;
  agentNotifications: AgentNotificationLevel | null;
}

/** The notification overrides of `userIds` in a project (people without one are absent). */
export function projectNotificationPrefs(
  db: DbExecutor,
  projectId: string,
  userIds: readonly string[],
): Map<string, ProjectPrefs> {
  if (userIds.length === 0) return new Map();
  return new Map(
    db
      .select({
        userId: s.projectMemberSettings.userId,
        notifications: s.projectMemberSettings.notifications,
        agentNotifications: s.projectMemberSettings.agentNotifications,
      })
      .from(s.projectMemberSettings)
      .where(
        and(
          eq(s.projectMemberSettings.projectId, projectId),
          inArray(s.projectMemberSettings.userId, [...new Set(userIds)]),
        ),
      )
      .all()
      .map(({ userId, ...prefs }) => [userId, prefs]),
  );
}

/** The notification overrides of `userIds` in a team (BAT-34; people without one are absent). */
export function teamNotificationPrefs(
  db: DbExecutor,
  teamId: string,
  userIds: readonly string[],
): Map<string, ProjectPrefs> {
  if (userIds.length === 0) return new Map();
  return new Map(
    db
      .select({
        userId: s.teamMemberSettings.userId,
        notifications: s.teamMemberSettings.notifications,
        agentNotifications: s.teamMemberSettings.agentNotifications,
      })
      .from(s.teamMemberSettings)
      .where(
        and(
          eq(s.teamMemberSettings.teamId, teamId),
          inArray(s.teamMemberSettings.userId, [...new Set(userIds)]),
        ),
      )
      .all()
      .map(({ userId, ...prefs }) => [userId, prefs]),
  );
}

/**
 * Each person's effective notification overrides for something in `teamId` (and `projectId`, if
 * any): per part, the project's override, else the team's (BAT-34). Null parts use the account's
 * settings; people with neither override are absent.
 */
export function notificationPrefs(
  db: DbExecutor,
  teamId: string,
  projectId: string | null,
  userIds: readonly string[],
): Map<string, ProjectPrefs> {
  const project = projectId
    ? projectNotificationPrefs(db, projectId, userIds)
    : new Map<string, ProjectPrefs>();
  const team = teamNotificationPrefs(db, teamId, userIds);
  const resolved = new Map<string, ProjectPrefs>();
  for (const userId of new Set([...project.keys(), ...team.keys()])) {
    const own = project.get(userId);
    const inherited = team.get(userId);
    resolved.set(userId, {
      notifications: own?.notifications ?? inherited?.notifications ?? null,
      agentNotifications: own?.agentNotifications ?? inherited?.agentNotifications ?? null,
    });
  }
  return resolved;
}

/** The account's `agent_notifications` level. */
function accountAgentLevel(db: DbExecutor, userId: string): AgentNotificationLevel {
  return (
    db.select({ level: s.user.agentNotifications }).from(s.user).where(eq(s.user.id, userId)).get()
      ?.level ?? 'needs_me'
  );
}

/**
 * How much of their agent's activity reaches `ownerId` in a project (null: team-level): the
 * project's override, else the team's (BAT-34), else the account's `agent_notifications`. The
 * team is looked up from the project when not given; with neither, the account's level.
 */
export function agentNotificationLevel(
  db: DbExecutor,
  ownerId: string,
  projectId: string | null,
  teamId: string | null = null,
): AgentNotificationLevel {
  const team =
    teamId ??
    (projectId
      ? (db
          .select({ teamId: s.project.teamId })
          .from(s.project)
          .where(eq(s.project.id, projectId))
          .get()?.teamId ?? null)
      : null);
  const override = team
    ? notificationPrefs(db, team, projectId, [ownerId]).get(ownerId)?.agentNotifications
    : null;
  return override ?? accountAgentLevel(db, ownerId);
}

// ---------------------------------------------------------------------------------------------
// GET|PUT /api/projects/:projectId/my-settings
// ---------------------------------------------------------------------------------------------

/** The person behind the actor, who must be able to see the (live) project. */
function requirePersonInProject(deps: AppDeps, actor: Actor, projectId: string): Actor {
  const person = personActor(actor);
  requireProject(deps.db.orm, person, projectId);
  return person;
}

function readSettings(db: DbExecutor, userId: string, projectId: string): MyProjectSettings {
  const prefs = projectNotificationPrefs(db, projectId, [userId]).get(userId);
  const teamId = db
    .select({ teamId: s.project.teamId })
    .from(s.project)
    .where(eq(s.project.id, projectId))
    .get()?.teamId;
  // "Use my defaults" here means the team's override (BAT-34), else the account's settings.
  const team = teamId ? teamNotificationPrefs(db, teamId, [userId]).get(userId) : undefined;
  const mapping = db
    .select({ chain: s.agentProjectMapping.chain })
    .from(s.agentProjectMapping)
    .where(
      and(eq(s.agentProjectMapping.userId, userId), eq(s.agentProjectMapping.projectId, projectId)),
    )
    .get();
  const defaults = db
    .select({ defaultMapping: s.agentSettings.defaultMapping })
    .from(s.agentSettings)
    .where(eq(s.agentSettings.userId, userId))
    .get()?.defaultMapping;
  return {
    projectId,
    notifications: prefs?.notifications ?? null,
    agentNotifications: prefs?.agentNotifications ?? null,
    models: { chain: mapping?.chain ?? [] },
    defaults: {
      notifications: team?.notifications ?? ACCOUNT_NOTIFICATIONS,
      agentNotifications: team?.agentNotifications ?? accountAgentLevel(db, userId),
      models: { chain: defaults?.chain ?? DEFAULT_CHAIN },
    },
    inherited: {
      notifications: team?.notifications ? 'team' : 'account',
      agentNotifications: team?.agentNotifications ? 'team' : 'account',
    },
  };
}

export function getMyProjectSettings(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
): MyProjectSettings {
  const person = requirePersonInProject(deps, actor, projectId);
  return readSettings(deps.db.orm, person.userId, projectId);
}

/** Replaces the parts of your settings given (null: back to your defaults). */
export function updateMyProjectSettings(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  rawInput: UpdateMyProjectSettingsInput,
): MyProjectSettings {
  const input = updateMyProjectSettingsInputSchema.parse(rawInput);
  const person = requirePersonInProject(deps, actor, projectId);
  const userId = person.userId;
  const { orm } = deps.db;

  // An empty chain: back to the account default (the row's legacy `levels` stay).
  const chain: Chain | null | undefined = input.models
    ? input.models.chain.length > 0
      ? input.models.chain
      : null
    : undefined;

  deps.db.write((tx) => {
    const now = new Date();
    if (input.notifications !== undefined || input.agentNotifications !== undefined) {
      const patch = {
        ...(input.notifications !== undefined ? { notifications: input.notifications } : {}),
        ...(input.agentNotifications !== undefined
          ? { agentNotifications: input.agentNotifications }
          : {}),
      };
      tx.insert(s.projectMemberSettings)
        .values({ userId, projectId, ...patch, updatedAt: now })
        .onConflictDoUpdate({
          target: [s.projectMemberSettings.userId, s.projectMemberSettings.projectId],
          set: { ...patch, updatedAt: now },
        })
        .run();
      // Nothing overridden any more: the row goes, as if never set.
      const row = tx
        .select()
        .from(s.projectMemberSettings)
        .where(
          and(
            eq(s.projectMemberSettings.userId, userId),
            eq(s.projectMemberSettings.projectId, projectId),
          ),
        )
        .get();
      if (row && row.notifications === null && row.agentNotifications === null) {
        tx.delete(s.projectMemberSettings)
          .where(
            and(
              eq(s.projectMemberSettings.userId, userId),
              eq(s.projectMemberSettings.projectId, projectId),
            ),
          )
          .run();
      }
    }
    if (chain !== undefined) {
      tx.insert(s.agentProjectMapping)
        .values({ userId, projectId, chain, updatedAt: now })
        .onConflictDoUpdate({
          target: [s.agentProjectMapping.userId, s.agentProjectMapping.projectId],
          set: { chain, updatedAt: now },
        })
        .run();
    }
    // Personal: your other tabs refresh (settings and models are under `account`).
    emitAfterCommit(tx, {
      type: 'me.updated',
      teamId: null,
      entityType: 'user',
      entityId: userId,
      actorId: actor.userId,
      userId,
    });
  });
  return readSettings(orm, userId, projectId);
}

// ---------------------------------------------------------------------------------------------
// GET|PUT /api/teams/:teamId/my-settings (BAT-34)
// ---------------------------------------------------------------------------------------------

/** The person behind the actor, who must be a member of the (live) team. */
function requirePersonInTeam(deps: AppDeps, actor: Actor, teamId: string): Actor {
  const person = personActor(actor);
  requireTeam(deps.db.orm, person, teamId);
  return person;
}

function readTeamSettings(db: DbExecutor, userId: string, teamId: string): MyTeamSettings {
  const prefs = teamNotificationPrefs(db, teamId, [userId]).get(userId);
  return {
    teamId,
    notifications: prefs?.notifications ?? null,
    agentNotifications: prefs?.agentNotifications ?? null,
    defaults: {
      notifications: ACCOUNT_NOTIFICATIONS,
      agentNotifications: accountAgentLevel(db, userId),
    },
  };
}

export function getMyTeamSettings(deps: AppDeps, actor: Actor, teamId: string): MyTeamSettings {
  const person = requirePersonInTeam(deps, actor, teamId);
  return readTeamSettings(deps.db.orm, person.userId, teamId);
}

/** Replaces the parts of your team settings given (null: back to your defaults). */
export function updateMyTeamSettings(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  rawInput: UpdateMyTeamSettingsInput,
): MyTeamSettings {
  const input = updateMyTeamSettingsInputSchema.parse(rawInput);
  const person = requirePersonInTeam(deps, actor, teamId);
  const userId = person.userId;
  const mine = and(
    eq(s.teamMemberSettings.userId, userId),
    eq(s.teamMemberSettings.teamId, teamId),
  );
  if (input.notifications !== undefined || input.agentNotifications !== undefined) {
    deps.db.write((tx) => {
      const now = new Date();
      const patch = {
        ...(input.notifications !== undefined ? { notifications: input.notifications } : {}),
        ...(input.agentNotifications !== undefined
          ? { agentNotifications: input.agentNotifications }
          : {}),
      };
      tx.insert(s.teamMemberSettings)
        .values({ userId, teamId, ...patch, updatedAt: now })
        .onConflictDoUpdate({
          target: [s.teamMemberSettings.userId, s.teamMemberSettings.teamId],
          set: { ...patch, updatedAt: now },
        })
        .run();
      // Nothing overridden any more: the row goes, as if never set.
      const row = tx.select().from(s.teamMemberSettings).where(mine).get();
      if (row && row.notifications === null && row.agentNotifications === null) {
        tx.delete(s.teamMemberSettings).where(mine).run();
      }
      // Personal: your other tabs refresh (settings are under `account`).
      emitAfterCommit(tx, {
        type: 'me.updated',
        teamId: null,
        entityType: 'user',
        entityId: userId,
        actorId: actor.userId,
        userId,
      });
    });
  }
  return readTeamSettings(deps.db.orm, userId, teamId);
}
