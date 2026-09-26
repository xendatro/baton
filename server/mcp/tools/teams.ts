import { z } from 'zod';
import { LIMITS } from '@shared/constants';
import { PERMISSION_INFO, PERMISSIONS, normalizePermissions } from '@shared/permissions';
import { emojiSchema, hexColorSchema, teamSlugSchema } from '@shared/schemas/common';
import {
  INVITE_EXPIRY_OPTIONS,
  inviteCodeSchema,
  roleNameSchema,
  teamDescriptionSchema,
  teamNameSchema,
  type Invite,
  type Member,
  type Role,
  type TeamDetail,
} from '@shared/schemas/teams';
import type { AppDeps } from '../../context';
import { errors } from '../../lib/errors';
import { appPaths } from '../../lib/urls';
import {
  acceptInvite,
  createInvite,
  listInvites,
  previewInvite,
  revokeInvite,
} from '../../services/invites';
import {
  assignRole,
  leaveTeam,
  listMembers,
  removeMember,
  unassignRole,
} from '../../services/members';
import { resolveRole, resolveTeam, resolveUser } from '../../services/refs';
import { createRole, deleteRole, listRoles, reorderRoles, updateRole } from '../../services/roles';
import {
  createTeam,
  deleteTeam,
  getTeamOverview,
  listDeletedTeams,
  listTeams,
  restoreTeam,
  transferOwnership,
  updateTeam,
} from '../../services/teams';
import { toAbsolute } from '../util';
import { defineTool, toolInput, type McpTool, type ToolContext } from './define';

/**
 * Team MCP tools (SPEC §5.1 [teams]): teams, members, roles and invite links, plus the owner-only
 * actions the web app offers (transfer ownership, delete and restore a team) and joining with an
 * invite code. Handlers resolve refs and call services only.
 */

const teamRef = z.string().min(1).describe('Team: its slug (e.g. "acme") or id');
const userRef = z.string().min(1).describe('Member: their username (with or without @) or user id');
const roleRef = z.string().min(1).describe('Role: its slug (as in @&slug), exact name, or id');
const permissionList = z
  .array(z.enum(PERMISSIONS))
  .max(PERMISSIONS.length)
  .describe(
    `Permission names. Available: ${PERMISSIONS.map((p) => `${p} (${PERMISSION_INFO[p].label})`).join(', ')}`,
  );

// ---------------------------------------------------------------------------------------------
// Output shaping: every entity carries a `ref` and an absolute `url`.
// ---------------------------------------------------------------------------------------------

function teamOut(deps: AppDeps, team: TeamDetail) {
  return { ...team, ref: team.slug, url: toAbsolute(deps, appPaths.team(team.slug)) };
}

function roleOut(deps: AppDeps, teamSlug: string, role: Role) {
  return {
    ...role,
    ref: role.isEveryone ? '@everyone' : `@&${role.slug}`,
    url: toAbsolute(deps, appPaths.role(teamSlug, role.id)),
  };
}

function memberOut(member: Member) {
  return { ...member, ref: `@${member.user.username}` };
}

function inviteOut(deps: AppDeps, invite: Invite) {
  return { ...invite, ref: invite.code, url: toAbsolute(deps, invite.url) };
}

function team(ctx: ToolContext, ref: string) {
  return resolveTeam(ctx.deps, ctx.actor, ref).team;
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

const listTeamsTool = defineTool({
  name: 'list_teams',
  title: 'List teams',
  description:
    'The teams you belong to (name, slug, description, owner, member count). Use a team slug as the "team" argument of other tools.',
  input: toolInput({}),
  annotations: { readOnlyHint: true },
  handler: (ctx) => ({
    teams: listTeams(ctx.deps, ctx.actor).items.map((item) => teamOut(ctx.deps, item)),
  }),
});

const getTeamTool = defineTool({
  name: 'get_team',
  title: 'Get team',
  description:
    'Everything about a team: details, your effective permissions, its projects (with open task and issue counts) and its roles (highest first, with permissions and member counts).',
  input: toolInput({ team: teamRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { team: row, membership } = resolveTeam(ctx.deps, ctx.actor, input.team);
    const overview = getTeamOverview(ctx.deps, ctx.actor, row.id);
    return {
      team: teamOut(ctx.deps, overview.team),
      you: { isOwner: membership.isOwner, permissions: membership.permissions },
      projects: overview.projects.map((project) => ({
        ...project,
        ref: `${row.slug}/${project.key}`,
        url: toAbsolute(ctx.deps, appPaths.project(row.slug, project.key)),
      })),
      roles: listRoles(ctx.deps, ctx.actor, row.id).items.map((role) =>
        roleOut(ctx.deps, row.slug, role),
      ),
    };
  },
});

const createTeamTool = defineTool({
  name: 'create_team',
  title: 'Create team',
  description:
    'Creates a team you own, seeded with the @everyone role (default permissions) and an Admin role. Invite people with create_invite.',
  input: toolInput({
    name: teamNameSchema.describe(`Team name (1–${LIMITS.teamName.max} characters)`),
    slug: teamSlugSchema
      .optional()
      .describe(
        'URL slug (lowercase letters, digits, single dashes). Derived from the name if omitted',
      ),
    description: teamDescriptionSchema.optional().describe('Short description'),
    icon: emojiSchema.optional().describe('A single emoji used as the team icon'),
    color: hexColorSchema.optional().describe('Accent color like #6366f1'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => teamOut(ctx.deps, createTeam(ctx.deps, ctx.actor, input)),
});

const updateTeamTool = defineTool({
  name: 'update_team',
  title: 'Update team',
  description:
    "Edits a team's name, URL slug, description, icon or color (needs Manage team). Only the fields you pass change.",
  input: toolInput({
    team: teamRef,
    name: teamNameSchema.optional().describe('New name'),
    slug: teamSlugSchema.optional().describe('New URL slug (old /t/<slug> links stop working)'),
    description: teamDescriptionSchema.optional().describe('New description ("" to clear)'),
    icon: emojiSchema.nullable().optional().describe('New emoji icon, or null to remove it'),
    color: hexColorSchema.optional().describe('New accent color like #6366f1'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, { team: ref, ...changes }) =>
    teamOut(ctx.deps, updateTeam(ctx.deps, ctx.actor, team(ctx, ref).id, changes)),
});

const transferOwnershipTool = defineTool({
  name: 'transfer_team_ownership',
  title: 'Transfer team ownership',
  description:
    'Makes another member the owner of a team (owner only; you stay a member). Pass the team slug again as "confirm" to show you mean it.',
  input: toolInput({
    team: teamRef,
    user: userRef,
    confirm: z.string().describe('The team slug, typed again to confirm'),
  }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const row = team(ctx, input.team);
    if (input.confirm.trim().toLowerCase() !== row.slug) {
      throw errors.validation(`Pass confirm: "${row.slug}" to transfer ownership`);
    }
    const target = resolveUser(ctx.deps, ctx.actor, input.user, { teamId: row.id });
    return teamOut(ctx.deps, transferOwnership(ctx.deps, ctx.actor, row.id, { userId: target.id }));
  },
});

const deleteTeamTool = defineTool({
  name: 'delete_team',
  title: 'Delete team',
  description:
    'Moves a team, with all its projects, issues and tasks, to Trash (owner only). It can be restored with restore_team for 30 days, then it is purged. Pass the team slug again as "confirm".',
  input: toolInput({
    team: teamRef,
    confirm: z.string().describe('The team slug, typed again to confirm'),
  }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const row = team(ctx, input.team);
    if (input.confirm.trim().toLowerCase() !== row.slug) {
      throw errors.validation(`Pass confirm: "${row.slug}" to delete the team`);
    }
    return deleteTeam(ctx.deps, ctx.actor, row.id);
  },
});

const listDeletedTeamsTool = defineTool({
  name: 'list_deleted_teams',
  title: 'List deleted teams',
  description: 'Teams you own that are in Trash, with the date each will be purged.',
  input: toolInput({}),
  annotations: { readOnlyHint: true },
  handler: (ctx) => listDeletedTeams(ctx.deps, ctx.actor),
});

const restoreTeamTool = defineTool({
  name: 'restore_team',
  title: 'Restore team',
  description:
    'Restores a team you own from Trash. If another team took its slug meanwhile, it gets a numbered one (e.g. acme-2).',
  input: toolInput({
    team: z.string().min(1).describe('Deleted team: its slug or id (see list_deleted_teams)'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const ref = input.team.trim();
    const deleted = listDeletedTeams(ctx.deps, ctx.actor).items.filter(
      (item) => item.id === ref || item.slug === ref.toLowerCase(),
    );
    const [match] = deleted;
    if (!match) throw errors.notFound('Deleted team');
    if (deleted.length > 1) {
      throw errors.validation('Several deleted teams have that slug: pass the team id', {
        candidates: deleted.map((item) => item.id),
      });
    }
    return teamOut(ctx.deps, restoreTeam(ctx.deps, ctx.actor, match.id));
  },
});

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

const listMembersTool = defineTool({
  name: 'list_members',
  title: 'List members',
  description:
    'Members of a team with their roles (highest first), join date and whether they own the team.',
  input: toolInput({ team: teamRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => ({
    members: listMembers(ctx.deps, ctx.actor, team(ctx, input.team).id).items.map(memberOut),
  }),
});

const removeMemberTool = defineTool({
  name: 'remove_member',
  title: 'Remove member',
  description:
    'Removes someone from a team (needs Manage members; never the owner; only administrators can remove members who have Administrator). To remove yourself use leave_team.',
  input: toolInput({ team: teamRef, user: userRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const row = team(ctx, input.team);
    const target = resolveUser(ctx.deps, ctx.actor, input.user, { teamId: row.id });
    return removeMember(ctx.deps, ctx.actor, row.id, target.id);
  },
});

const leaveTeamTool = defineTool({
  name: 'leave_team',
  title: 'Leave team',
  description:
    'Leaves a team. The owner cannot leave: transfer ownership or delete the team first.',
  input: toolInput({ team: teamRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => leaveTeam(ctx.deps, ctx.actor, team(ctx, input.team).id),
});

function roleChange(ctx: ToolContext, input: { team: string; user: string; role: string }) {
  const row = team(ctx, input.team);
  const target = resolveUser(ctx.deps, ctx.actor, input.user, { teamId: row.id });
  const role = resolveRole(ctx.deps.db.orm, row.id, input.role);
  return { teamId: row.id, userId: target.id, roleId: role.id };
}

const assignRoleTool = defineTool({
  name: 'assign_role',
  title: 'Assign role',
  description:
    'Gives a member a role (needs Manage members; without Administrator you can only grant roles whose permissions you have).',
  input: toolInput({ team: teamRef, user: userRef, role: roleRef }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    const { teamId, userId, roleId } = roleChange(ctx, input);
    return memberOut(assignRole(ctx.deps, ctx.actor, teamId, userId, roleId));
  },
});

const unassignRoleTool = defineTool({
  name: 'unassign_role',
  title: 'Unassign role',
  description: 'Takes a role away from a member (same rules as assign_role).',
  input: toolInput({ team: teamRef, user: userRef, role: roleRef }),
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: (ctx, input) => {
    const { teamId, userId, roleId } = roleChange(ctx, input);
    return memberOut(unassignRole(ctx.deps, ctx.actor, teamId, userId, roleId));
  },
});

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

const listRolesTool = defineTool({
  name: 'list_roles',
  title: 'List roles',
  description:
    "A team's roles, highest first (@everyone last), with color, mentionable flag, permissions and member counts. Members' permissions are the union of their roles and @everyone.",
  input: toolInput({ team: teamRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const row = team(ctx, input.team);
    return {
      roles: listRoles(ctx.deps, ctx.actor, row.id).items.map((role) =>
        roleOut(ctx.deps, row.slug, role),
      ),
    };
  },
});

const createRoleTool = defineTool({
  name: 'create_role',
  title: 'Create role',
  description:
    'Creates a role at the bottom of the list (just above @everyone). Needs Manage roles; without Administrator you can only grant permissions you have.',
  input: toolInput({
    team: teamRef,
    name: roleNameSchema.describe(`Role name (1–${LIMITS.roleName.max} characters)`),
    color: hexColorSchema.nullable().optional().describe('Color like #3b82f6, or null for none'),
    mentionable: z
      .boolean()
      .optional()
      .describe('Whether everyone can @&mention the role (default false)'),
    permissions: permissionList.optional(),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, { team: ref, ...input }) => {
    const row = team(ctx, ref);
    return roleOut(ctx.deps, row.slug, createRole(ctx.deps, ctx.actor, row.id, input));
  },
});

const updateRoleTool = defineTool({
  name: 'update_role',
  title: 'Update role',
  description:
    'Edits a role: name, color, mentionable, and permissions (replace them with "permissions", or change some with "addPermissions"/"removePermissions"). @everyone only accepts permission changes. Needs Manage roles, within your own permissions.',
  input: toolInput({
    team: teamRef,
    role: roleRef,
    name: roleNameSchema.optional().describe('New name (the @&slug follows it)'),
    color: hexColorSchema.nullable().optional().describe('New color, or null to remove it'),
    mentionable: z.boolean().optional().describe('Whether everyone can @&mention the role'),
    permissions: permissionList.optional().describe('Replaces all permissions of the role'),
    addPermissions: permissionList.optional().describe('Permissions to add'),
    removePermissions: permissionList.optional().describe('Permissions to remove'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const row = team(ctx, input.team);
    const role = resolveRole(ctx.deps.db.orm, row.id, input.role);
    let permissions = input.permissions;
    if (input.addPermissions || input.removePermissions) {
      const base = new Set(permissions ?? role.permissions);
      for (const permission of input.addPermissions ?? []) base.add(permission);
      for (const permission of input.removePermissions ?? []) base.delete(permission);
      permissions = normalizePermissions(base);
    }
    const updated = updateRole(ctx.deps, ctx.actor, row.id, role.id, {
      name: input.name,
      color: input.color,
      mentionable: input.mentionable,
      permissions,
    });
    return roleOut(ctx.deps, row.slug, updated);
  },
});

const deleteRoleTool = defineTool({
  name: 'delete_role',
  title: 'Delete role',
  description:
    'Deletes a role: members lose it and tasks assigned to it lose that assignee. @everyone cannot be deleted.',
  input: toolInput({ team: teamRef, role: roleRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const row = team(ctx, input.team);
    const role = resolveRole(ctx.deps.db.orm, row.id, input.role);
    return deleteRole(ctx.deps, ctx.actor, row.id, role.id);
  },
});

const reorderRolesTool = defineTool({
  name: 'reorder_roles',
  title: 'Reorder roles',
  description:
    "Sets the order of the roles, highest first (a member's name shows in the color of their highest colored role). List every role except @everyone exactly once. Without Administrator, roles you cannot manage must keep their place.",
  input: toolInput({
    team: teamRef,
    roles: z.array(roleRef).min(1).max(250).describe('Every role except @everyone, highest first'),
  }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    const row = team(ctx, input.team);
    const roleIds = input.roles.map((ref) => resolveRole(ctx.deps.db.orm, row.id, ref).id);
    return {
      roles: reorderRoles(ctx.deps, ctx.actor, row.id, { roleIds }).items.map((role) =>
        roleOut(ctx.deps, row.slug, role),
      ),
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------------

const createInviteTool = defineTool({
  name: 'create_invite',
  title: 'Create invite link',
  description:
    'Creates an invite link (needs Create invites). Share the returned url; anyone signed in to Baton can join with it until it expires or runs out of uses.',
  input: toolInput({
    team: teamRef,
    expiresIn: z
      .enum(INVITE_EXPIRY_OPTIONS)
      .default('7d')
      .describe('How long the link works: 30m, 1h, 6h, 12h, 1d, 7d or never (default 7d)'),
    maxUses: z
      .number()
      .int()
      .min(LIMITS.inviteMaxUses.min)
      .max(LIMITS.inviteMaxUses.max)
      .nullable()
      .default(null)
      .describe('How many people can join with it, or null for unlimited (default)'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, { team: ref, ...input }) =>
    inviteOut(ctx.deps, createInvite(ctx.deps, ctx.actor, team(ctx, ref).id, input)),
});

const listInvitesTool = defineTool({
  name: 'list_invites',
  title: 'List invite links',
  description:
    "A team's invite links that haven't been revoked, newest first, with uses, expiry, creator and status. You see your own; Manage invites shows everyone's.",
  input: toolInput({ team: teamRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => ({
    invites: listInvites(ctx.deps, ctx.actor, team(ctx, input.team).id).items.map((invite) =>
      inviteOut(ctx.deps, invite),
    ),
  }),
});

const revokeInviteTool = defineTool({
  name: 'revoke_invite',
  title: 'Revoke invite link',
  description:
    "Revokes an invite link so nobody else can join with it (your own, or anyone's with Manage invites).",
  input: toolInput({
    team: teamRef,
    invite: z.string().min(1).describe('The invite code (as in /join/<code>) or invite id'),
  }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) =>
    revokeInvite(ctx.deps, ctx.actor, team(ctx, input.team).id, input.invite),
});

/** Accepts a code or a full `/join/<code>` URL. */
const inviteCodeInput = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .trim()
      .replace(/^.*\/join\//, '')
      .replace(/[/?#].*$/, ''),
  )
  .pipe(inviteCodeSchema)
  .describe('Invite code, or the whole invite URL (…/join/<code>)');

const getInviteTool = defineTool({
  name: 'get_invite',
  title: 'Preview invite link',
  description:
    'Shows which team an invite link is for (name, description, member count, who invited you) and whether you are already a member.',
  input: toolInput({ code: inviteCodeInput }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const preview = previewInvite(ctx.deps, ctx.actor, input.code);
    return {
      ...preview,
      url: toAbsolute(ctx.deps, `/join/${preview.code}`),
      teamUrl: toAbsolute(ctx.deps, appPaths.team(preview.team.slug)),
    };
  },
});

const joinTeamTool = defineTool({
  name: 'join_team',
  title: 'Join team',
  description: 'Joins a team with an invite link. Does nothing if you are already a member.',
  input: toolInput({ code: inviteCodeInput }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    const result = acceptInvite(ctx.deps, ctx.actor, input.code);
    return {
      ...result,
      team: {
        ...result.team,
        ref: result.team.slug,
        url: toAbsolute(ctx.deps, appPaths.team(result.team.slug)),
      },
    };
  },
});

export const teamsTools: McpTool[] = [
  listTeamsTool,
  getTeamTool,
  createTeamTool,
  updateTeamTool,
  transferOwnershipTool,
  deleteTeamTool,
  listDeletedTeamsTool,
  restoreTeamTool,
  listMembersTool,
  removeMemberTool,
  leaveTeamTool,
  assignRoleTool,
  unassignRoleTool,
  listRolesTool,
  createRoleTool,
  updateRoleTool,
  deleteRoleTool,
  reorderRolesTool,
  createInviteTool,
  listInvitesTool,
  revokeInviteTool,
  getInviteTool,
  joinTeamTool,
];
