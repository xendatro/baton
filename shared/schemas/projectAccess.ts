import { z } from 'zod';
import { isProjectPermission, PROJECT_PERMISSIONS } from '../permissions';
import { hexColorSchema, idSchema, timestampSchema } from './common';
import { userSummarySchema } from './core';
import { permissionSchema, roleNameSchema } from './teams';

/**
 * Project access (docs/design/agents-and-pipelines.md §3): project roles, per-project permission
 * overrides of team roles, project roles and members, and the viewer's effective permissions.
 */

/** A project-level permission (team-level ones can't be overridden per project). */
export const projectPermissionSchema = permissionSchema.refine(isProjectPermission, {
  message: 'Only project-level permissions can be overridden in a project',
});

// ---------------------------------------------------------------------------------------------
// Project roles
// ---------------------------------------------------------------------------------------------

/** Most roles one project can have. */
export const MAX_PROJECT_ROLES = 100;

export const projectRoleMemberSchema = userSummarySchema.extend({
  /** Agent members (design §1) are marked so the UI can badge them. */
  isAgent: z.boolean(),
});
export type ProjectRoleMember = z.infer<typeof projectRoleMemberSchema>;

export const projectRoleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** Unique per project. */
  slug: z.string(),
  color: z.string().nullable(),
  /** Higher ranks higher. */
  position: z.number().int().nonnegative(),
  /** Current team members holding the role, by username. */
  members: z.array(projectRoleMemberSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/** Highest position first. */
export const projectRoleListResponseSchema = z.object({ items: z.array(projectRoleSchema) });
export type ProjectRoleListResponse = z.infer<typeof projectRoleListResponseSchema>;

export const createProjectRoleInputSchema = z.object({
  name: roleNameSchema,
  color: hexColorSchema.nullable().optional(),
});
export type CreateProjectRoleInput = z.infer<typeof createProjectRoleInputSchema>;

export const updateProjectRoleInputSchema = z.object({
  name: roleNameSchema.optional(),
  color: hexColorSchema.nullable().optional(),
});
export type UpdateProjectRoleInput = z.infer<typeof updateProjectRoleInputSchema>;

export const reorderProjectRolesInputSchema = z.object({
  /** Every role of the project, highest first. */
  roleIds: z.array(idSchema).max(MAX_PROJECT_ROLES),
});
export type ReorderProjectRolesInput = z.infer<typeof reorderProjectRolesInputSchema>;

// ---------------------------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------------------------

export const PERMISSION_OVERRIDE_SUBJECT_TYPES = ['team_role', 'project_role', 'user'] as const;
export const overrideSubjectTypeSchema = z.enum(PERMISSION_OVERRIDE_SUBJECT_TYPES);
export type OverrideSubjectType = z.infer<typeof overrideSubjectTypeSchema>;

const projectPermissionListSchema = z
  .array(projectPermissionSchema)
  .max(PROJECT_PERMISSIONS.length);

export const setPermissionOverrideInputSchema = z
  .object({
    subjectType: overrideSubjectTypeSchema,
    subjectId: idSchema,
    allow: projectPermissionListSchema,
    deny: projectPermissionListSchema,
  })
  .refine((input) => !input.allow.some((permission) => input.deny.includes(permission)), {
    message: 'A permission can’t be both allowed and denied',
    path: ['deny'],
  });
export type SetPermissionOverrideInput = z.infer<typeof setPermissionOverrideInputSchema>;

export const permissionOverrideSchema = z.object({
  subjectType: overrideSubjectTypeSchema,
  subjectId: z.string(),
  /** Role name or `@username`, for display. */
  subjectName: z.string(),
  /** Role color, or null. */
  subjectColor: z.string().nullable(),
  allow: z.array(permissionSchema),
  deny: z.array(permissionSchema),
  updatedAt: timestampSchema,
});
export type PermissionOverride = z.infer<typeof permissionOverrideSchema>;

export const projectPermissionsResponseSchema = z.object({
  projectId: z.string(),
  /** May the viewer manage roles and overrides here? */
  canManage: z.boolean(),
  /** The viewer's effective permissions in the project (team-level + project-level). */
  permissions: z.array(permissionSchema),
  /** Every override of the project: team roles (`@everyone` first), project roles, members. */
  overrides: z.array(permissionOverrideSchema),
});
export type ProjectPermissionsResponse = z.infer<typeof projectPermissionsResponseSchema>;

/** A member's effective permissions in a project (MCP `get_project_permissions { user }`). */
export const memberProjectPermissionsSchema = z.object({
  userId: z.string(),
  canView: z.boolean(),
  permissions: z.array(permissionSchema),
});
export type MemberProjectPermissions = z.infer<typeof memberProjectPermissionsSchema>;
