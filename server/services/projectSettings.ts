import { and, eq, inArray } from 'drizzle-orm';
import type { AgentNotificationLevel, NotificationType } from '@shared/constants';
import { DEFAULT_CHAIN, type Chain } from '@shared/schemas/agentRunner';
import {
  ACCOUNT_NOTIFICATIONS,
  PROJECT_NOTIFY_KIND_TYPES,
  PROJECT_NOTIFY_KINDS,
  updateMyProjectSettingsInputSchema,
  type MyProjectSettings,
  type ProjectNotifications,
  type UpdateMyProjectSettingsInput,
} from '@shared/schemas/projectSettings';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { personActor } from './agents';
import { emitAfterCommit } from './events';
import { requireProject } from './projects';

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

/**
 * How much of their agent's activity reaches `ownerId` in a project (null: team-level): the
 * project's override, else the account's `agent_notifications`.
 */
export function agentNotificationLevel(
  db: DbExecutor,
  ownerId: string,
  projectId: string | null,
): AgentNotificationLevel {
  const override = projectId
    ? projectNotificationPrefs(db, projectId, [ownerId]).get(ownerId)?.agentNotifications
    : null;
  if (override) return override;
  return (
    db.select({ level: s.user.agentNotifications }).from(s.user).where(eq(s.user.id, ownerId)).get()
      ?.level ?? 'needs_me'
  );
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
      notifications: ACCOUNT_NOTIFICATIONS,
      agentNotifications: agentNotificationLevel(db, userId, null),
      models: { chain: defaults?.chain ?? DEFAULT_CHAIN },
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
