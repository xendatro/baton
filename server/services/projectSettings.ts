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
import { errors } from '../lib/errors';
import { personActor } from './agents';
import { emitAfterCommit } from './events';
import { requireProject } from './projects';

/**
 * Your settings for one project (BAT-29): notification overrides (`project_member_settings`) and
 * your models by the project's difficulty levels (`agent_project_mapping`, the same rows Settings
 * → Automatic agents used to edit). Personal: anyone who can see the project has their own, and
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

function levelIdsOf(db: DbExecutor, projectId: string): Set<string> {
  return new Set(
    db
      .select({ id: s.difficulty.id })
      .from(s.difficulty)
      .where(eq(s.difficulty.projectId, projectId))
      .all()
      .map((row) => row.id),
  );
}

function readSettings(db: DbExecutor, userId: string, projectId: string): MyProjectSettings {
  const prefs = projectNotificationPrefs(db, projectId, [userId]).get(userId);
  const mapping = db
    .select({ levels: s.agentProjectMapping.levels })
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
  // Levels deleted since they were mapped are left out.
  const levelIds = levelIdsOf(db, projectId);
  return {
    projectId,
    notifications: prefs?.notifications ?? null,
    agentNotifications: prefs?.agentNotifications ?? null,
    models: {
      levels: Object.fromEntries(
        Object.entries(mapping?.levels ?? {}).filter(
          ([id, chain]) => levelIds.has(id) && chain.length > 0,
        ),
      ),
    },
    defaults: {
      notifications: ACCOUNT_NOTIFICATIONS,
      agentNotifications: agentNotificationLevel(db, userId, null),
      models: defaults ?? { chain: DEFAULT_CHAIN, levels: {} },
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

  let levels: Record<string, Chain> | undefined;
  if (input.models) {
    levels = Object.fromEntries(
      Object.entries(input.models.levels).filter(([, chain]) => chain.length > 0),
    );
    const known = levelIdsOf(orm, projectId);
    const unknown = Object.keys(levels).filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw errors.validation('Models can only be set for this project’s difficulty levels', {
        levels: unknown,
      });
    }
  }

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
    if (levels) {
      const where = and(
        eq(s.agentProjectMapping.userId, userId),
        eq(s.agentProjectMapping.projectId, projectId),
      );
      if (Object.keys(levels).length === 0) {
        tx.delete(s.agentProjectMapping).where(where).run();
      } else {
        tx.insert(s.agentProjectMapping)
          .values({ userId, projectId, levels, updatedAt: now })
          .onConflictDoUpdate({
            target: [s.agentProjectMapping.userId, s.agentProjectMapping.projectId],
            set: { levels, updatedAt: now },
          })
          .run();
      }
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
