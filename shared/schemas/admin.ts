import { z } from 'zod';
import { ACTIVITY_ENTITY_TYPES, ACTOR_SOURCES, TRASHABLE_TYPES } from '../constants';
import { cursorPaginationSchema, paginatedSchema } from './common';
import { trashItemSchema, userSummarySchema } from './core';

/**
 * Wire contracts of the admin module (docs/API.md → Feature endpoints → Admin): the team Trash
 * page and the audit log's filter facets. The trash items themselves and the audit-log entries
 * use the core schemas (`trashItemSchema`, `activityEntrySchema`).
 */

// ---------------------------------------------------------------------------------------------
// Trash: GET /api/teams/:teamId/trash, POST /api/trash/restore
// ---------------------------------------------------------------------------------------------

/** Types listed in a team's Trash (deleted teams are listed for their owner in account settings). */
export const TEAM_TRASH_TYPES = [
  'project',
  'issue',
  'task',
  'reply',
  'attachment',
] as const satisfies ReadonlyArray<(typeof TRASHABLE_TYPES)[number]>;
export type TeamTrashType = (typeof TEAM_TRASH_TYPES)[number];

export const trashListQuerySchema = cursorPaginationSchema.extend({
  /** Only items of this type. */
  type: z.enum(TEAM_TRASH_TYPES).optional(),
});
export type TrashListQuery = z.infer<typeof trashListQuerySchema>;

/** A page of a team's Trash, most recently deleted first. */
export const trashPageSchema = paginatedSchema(trashItemSchema);
export type TrashPage = z.infer<typeof trashPageSchema>;

export const restoreTrashResponseSchema = z.object({
  ok: z.literal(true),
  type: z.enum(TRASHABLE_TYPES),
  id: z.string(),
  /** App URL of the restored item (or of the page showing it); null when it can't be opened. */
  url: z.string().nullable(),
});
export type RestoreTrashResponse = z.infer<typeof restoreTrashResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Audit log facets: GET /api/teams/:teamId/audit-log/facets
// ---------------------------------------------------------------------------------------------

export const auditLogKeyFacetSchema = z.object({
  keyId: z.string(),
  /** The key's name as last recorded in the log. */
  keyName: z.string(),
  /** The key's owner (null for deleted accounts). */
  user: userSummarySchema.nullable(),
});
export type AuditLogKeyFacet = z.infer<typeof auditLogKeyFacetSchema>;

export const auditLogProjectFacetSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  /** True while the project is in Trash. */
  deleted: z.boolean(),
});
export type AuditLogProjectFacet = z.infer<typeof auditLogProjectFacetSchema>;

/** The values present in a team's audit log, for its filter menus. */
export const auditLogFacetsSchema = z.object({
  /** People who acted in the team (current and former members), by display name. */
  actors: z.array(userSummarySchema),
  sources: z.array(z.enum(ACTOR_SOURCES)),
  /** API keys actions went through, most recently used first. */
  keys: z.array(auditLogKeyFacetSchema),
  entityTypes: z.array(z.enum(ACTIVITY_ENTITY_TYPES)),
  /** Distinct actions, sorted. */
  actions: z.array(z.string()),
  /** Projects the log mentions (purged projects are left out), by name. */
  projects: z.array(auditLogProjectFacetSchema),
});
export type AuditLogFacets = z.infer<typeof auditLogFacetsSchema>;
