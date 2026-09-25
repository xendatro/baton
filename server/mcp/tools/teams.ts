import type { McpTool } from './define';

/**
 * Team MCP tools (owner: teams module): list_teams, get_team, create_team, update_team, list_members, remove_member, list_roles, create_role, update_role, delete_role, assign_role, unassign_role, create_invite, list_invites, revoke_invite, leave_team.
 * Declare each with `defineTool`; handlers call services only.
 */
export const teamsTools: McpTool[] = [];
