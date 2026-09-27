import { z } from 'zod';
import { LIMITS } from '@shared/constants';
import { PERMISSION_INFO, PROJECT_PERMISSIONS, type Permission } from '@shared/permissions';
import { hexColorSchema } from '@shared/schemas/common';
import {
  overrideSubjectTypeSchema,
  setPermissionOverrideInputSchema,
  type OverrideSubjectType,
  type ProjectPermissionsResponse,
  type ProjectRole,
} from '@shared/schemas/projectAccess';
import { roleNameSchema } from '@shared/schemas/teams';
import { errors } from '../../lib/errors';
import { appPaths } from '../../lib/urls';
import { parseInput } from '../../lib/validate';
import {
  assignProjectRole,
  createProjectRole,
  deleteProjectRole,
  getMemberProjectPermissions,
  getProjectPermissions,
  listProjectRoles,
  projectRolesOf,
  removePermissionOverride,
  setPermissionOverride,
  unassignProjectRole,
  updateProjectRole,
} from '../../services/projectAccess';
import {
  resolveProject,
  resolveRole,
  resolveUser,
  type ResolvedProject,
} from '../../services/refs';
import { toAbsolute } from '../util';
import { defineTool, toolInput, type McpTool, type ToolContext } from './define';

/**
 * Project access MCP tools (docs/design/agents-and-pipelines.md §3; documented additions to SPEC
 * §5.1, DECISIONS 2026-09-27 permissions B): project roles and their members, and per-project
 * permission overrides. Handlers resolve refs and call services only.
 */

const projectRef = z
  .string()
  .min(1)
  .describe('Project: KEY (if unambiguous across your teams), team-slug/KEY, or project id');
const projectRoleRef = z
  .string()
  .min(1)
  .describe('Project role: its slug, exact name (case-insensitive), or id');
const userRef = z.string().min(1).describe('Member: their username (with or without @) or user id');
const permissionList = z
  .array(z.enum(PROJECT_PERMISSIONS as [Permission, ...Permission[]]))
  .max(PROJECT_PERMISSIONS.length)
  .describe(
    `Project-level permission names. Available: ${PROJECT_PERMISSIONS.map((p) => `${p} (${PERMISSION_INFO[p].label})`).join(', ')}`,
  );
const subjectType = overrideSubjectTypeSchema.describe(
  'What the override applies to: a team role ("team_role", e.g. everyone), a project role ("project_role") or a member ("user")',
);
const subjectRef = z
  .string()
  .min(1)
  .describe(
    'The team role (slug, name or id; "everyone" for @everyone), project role (slug, name or id) or member (username or id)',
  );

function project(ctx: ToolContext, ref: string): ResolvedProject {
  return resolveProject(ctx.deps, ctx.actor, ref);
}

function accessUrl(ctx: ToolContext, resolved: ResolvedProject) {
  return toAbsolute(
    ctx.deps,
    appPaths.projectSettings(resolved.team.slug, resolved.project.key, 'access'),
  );
}

function roleOut(ctx: ToolContext, resolved: ResolvedProject, role: ProjectRole) {
  return {
    ...role,
    ref: role.slug,
    members: role.members.map((member) => ({ ...member, ref: `@${member.username}` })),
    url: accessUrl(ctx, resolved),
  };
}

/** A project role by slug, name (case-insensitive) or id. */
function resolveProjectRole(ctx: ToolContext, resolved: ResolvedProject, ref: string) {
  const value = ref.trim();
  const roles = projectRolesOf(ctx.deps.db.orm, resolved.project.id);
  const lower = value.toLowerCase();
  const found =
    roles.find((role) => role.id === value) ??
    roles.find((role) => role.slug === lower) ??
    roles.find((role) => role.name.toLowerCase() === lower);
  if (!found) {
    throw errors.notFoundWith(
      `Project role not found: "${value}". Roles: ${roles.map((role) => role.slug).join(', ') || 'none'}`,
      { ref: value, candidates: roles.map((role) => role.slug) },
    );
  }
  return found;
}

function subjectId(
  ctx: ToolContext,
  resolved: ResolvedProject,
  type: OverrideSubjectType,
  ref: string,
): string {
  switch (type) {
    case 'team_role':
      return resolveRole(ctx.deps.db.orm, resolved.team.id, ref).id;
    case 'project_role':
      return resolveProjectRole(ctx, resolved, ref).id;
    case 'user':
      return resolveUser(ctx.deps, ctx.actor, ref, { teamId: resolved.team.id }).id;
  }
}

function permissionsOut(
  ctx: ToolContext,
  resolved: ResolvedProject,
  result: ProjectPermissionsResponse,
) {
  return { ...result, ref: resolved.project.key, url: accessUrl(ctx, resolved) };
}

const listProjectRolesTool = defineTool({
  name: 'list_project_roles',
  title: 'List project roles',
  description:
    "A project's roles, highest first, with their members (people and agents). Project roles have no permissions of their own; the project's permission overrides for them (get_project_permissions) do.",
  input: toolInput({ project: projectRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    return {
      roles: listProjectRoles(ctx.deps, ctx.actor, resolved.project.id).items.map((role) =>
        roleOut(ctx, resolved, role),
      ),
    };
  },
});

const createProjectRoleTool = defineTool({
  name: 'create_project_role',
  title: 'Create project role',
  description:
    'Creates a project role at the bottom of the list. Needs Manage project access in the project (or Manage projects in the team).',
  input: toolInput({
    project: projectRef,
    name: roleNameSchema.describe(`Role name (1–${LIMITS.roleName.max} characters)`),
    color: hexColorSchema.nullable().optional().describe('Color like #3b82f6, or null for none'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, { project: ref, ...input }) => {
    const resolved = project(ctx, ref);
    return roleOut(
      ctx,
      resolved,
      createProjectRole(ctx.deps, ctx.actor, resolved.project.id, input),
    );
  },
});

const updateProjectRoleTool = defineTool({
  name: 'update_project_role',
  title: 'Update project role',
  description: 'Renames or recolors a project role. Needs Manage project access.',
  input: toolInput({
    project: projectRef,
    role: projectRoleRef,
    name: roleNameSchema.optional().describe('New name (the slug follows it)'),
    color: hexColorSchema.nullable().optional().describe('New color, or null to remove it'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    const role = resolveProjectRole(ctx, resolved, input.role);
    return roleOut(
      ctx,
      resolved,
      updateProjectRole(ctx.deps, ctx.actor, resolved.project.id, role.id, {
        name: input.name,
        color: input.color,
      }),
    );
  },
});

const deleteProjectRoleTool = defineTool({
  name: 'delete_project_role',
  title: 'Delete project role',
  description:
    'Deletes a project role and its permission override; its members lose it. Needs Manage project access, and (without Administrator) every permission its override mentions.',
  input: toolInput({ project: projectRef, role: projectRoleRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    const role = resolveProjectRole(ctx, resolved, input.role);
    return deleteProjectRole(ctx.deps, ctx.actor, resolved.project.id, role.id);
  },
});

const assignProjectRoleTool = defineTool({
  name: 'assign_project_role',
  title: 'Assign project role',
  description:
    'Gives a team member (person or agent) a project role. Needs Manage project access, and (without Administrator) every permission the role’s override mentions.',
  input: toolInput({ project: projectRef, role: projectRoleRef, user: userRef }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    const role = resolveProjectRole(ctx, resolved, input.role);
    const user = resolveUser(ctx.deps, ctx.actor, input.user, { teamId: resolved.team.id });
    return roleOut(
      ctx,
      resolved,
      assignProjectRole(ctx.deps, ctx.actor, resolved.project.id, role.id, user.id),
    );
  },
});

const unassignProjectRoleTool = defineTool({
  name: 'unassign_project_role',
  title: 'Unassign project role',
  description: 'Takes a project role away from a member (same rules as assign_project_role).',
  input: toolInput({ project: projectRef, role: projectRoleRef, user: userRef }),
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    const role = resolveProjectRole(ctx, resolved, input.role);
    const user = resolveUser(ctx.deps, ctx.actor, input.user, { teamId: resolved.team.id });
    return roleOut(
      ctx,
      resolved,
      unassignProjectRole(ctx.deps, ctx.actor, resolved.project.id, role.id, user.id),
    );
  },
});

const getProjectPermissionsTool = defineTool({
  name: 'get_project_permissions',
  title: 'Get project permissions',
  description:
    "A project's permission overrides (team roles, project roles, members), your own effective permissions there and whether you may manage them. With `user`, also that member's effective permissions. Effective permissions: team roles' project-level permissions, then the @everyone override, then role overrides (denies, then allows), then the member's own override; the owner and administrators have everything; agents are capped by their owner.",
  input: toolInput({
    project: projectRef,
    user: userRef.optional().describe('A member whose effective permissions to include'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    const result = permissionsOut(
      ctx,
      resolved,
      getProjectPermissions(ctx.deps, ctx.actor, resolved.project.id),
    );
    if (!input.user) return result;
    const user = resolveUser(ctx.deps, ctx.actor, input.user, { teamId: resolved.team.id });
    return {
      ...result,
      member: {
        ...getMemberProjectPermissions(ctx.deps, ctx.actor, resolved.project.id, user.id),
        ref: `@${user.username ?? user.id}`,
      },
    };
  },
});

const setProjectPermissionOverrideTool = defineTool({
  name: 'set_project_permission_override',
  title: 'Set project permission override',
  description:
    'Sets which project-level permissions a team role, project role or member is allowed or denied in a project (replacing that subject’s override; permissions in neither list are inherited). Deny VIEW_PROJECT to hide the project. Needs Manage project access (or Manage projects in the team); without Administrator you can only change permissions you have in the project.',
  input: toolInput({
    project: projectRef,
    subjectType,
    subject: subjectRef,
    allow: permissionList.describe(
      'Permissions to allow (the rest of the subject’s are inherited)',
    ),
    deny: permissionList.describe('Permissions to deny'),
  }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    const parsed = parseInput(setPermissionOverrideInputSchema, {
      subjectType: input.subjectType,
      subjectId: subjectId(ctx, resolved, input.subjectType, input.subject),
      allow: input.allow,
      deny: input.deny,
    });
    return permissionsOut(
      ctx,
      resolved,
      setPermissionOverride(ctx.deps, ctx.actor, resolved.project.id, parsed),
    );
  },
});

const removeProjectPermissionOverrideTool = defineTool({
  name: 'remove_project_permission_override',
  title: 'Remove project permission override',
  description:
    'Removes the override of a team role, project role or member in a project, so it inherits everything again. Same rules as set_project_permission_override.',
  input: toolInput({ project: projectRef, subjectType, subject: subjectRef }),
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: (ctx, input) => {
    const resolved = project(ctx, input.project);
    const id = subjectId(ctx, resolved, input.subjectType, input.subject);
    return permissionsOut(
      ctx,
      resolved,
      removePermissionOverride(ctx.deps, ctx.actor, resolved.project.id, input.subjectType, id),
    );
  },
});

export const projectAccessTools: McpTool[] = [
  listProjectRolesTool,
  createProjectRoleTool,
  updateProjectRoleTool,
  deleteProjectRoleTool,
  assignProjectRoleTool,
  unassignProjectRoleTool,
  getProjectPermissionsTool,
  setProjectPermissionOverrideTool,
  removeProjectPermissionOverrideTool,
];
