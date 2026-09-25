import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { okResponseSchema } from '@shared/schemas/common';
import type { MeResponse } from '@shared/schemas/core';
import {
  acceptInviteResponseSchema,
  inviteListResponseSchema,
  invitePreviewSchema,
  inviteSchema,
  memberListResponseSchema,
  memberSchema,
  roleListResponseSchema,
  roleSchema,
  teamDetailSchema,
  teamOverviewSchema,
  type CreateInviteInput,
  type CreateRoleInput,
  type CreateTeamInput,
  type InviteListResponse,
  type Member,
  type MemberListResponse,
  type Role,
  type RoleListResponse,
  type TeamDetail,
  type UpdateRoleInput,
  type UpdateTeamInput,
} from '@shared/schemas/teams';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Data access for the teams module's pages (team home, team settings, join). Queries use the
 * id-based keys of web/lib/queryKeys.ts, which live events (web/lib/live.ts) invalidate.
 */

const teamUrl = (teamId: string) => `/api/teams/${encodeURIComponent(teamId)}`;

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export function useTeam(teamId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.teams.detail(teamId ?? ''),
    queryFn: ({ signal }) => api.get(teamUrl(teamId ?? ''), { schema: teamDetailSchema, signal }),
    enabled: Boolean(teamId),
  });
}

export function useTeamOverview(teamId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.teams.overview(teamId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`${teamUrl(teamId ?? '')}/overview`, { schema: teamOverviewSchema, signal }),
    enabled: Boolean(teamId),
  });
}

export function useMembers(teamId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.teams.members(teamId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`${teamUrl(teamId ?? '')}/members`, { schema: memberListResponseSchema, signal }),
    enabled: Boolean(teamId),
  });
}

export function useRoles(teamId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.teams.roles(teamId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`${teamUrl(teamId ?? '')}/roles`, { schema: roleListResponseSchema, signal }),
    enabled: Boolean(teamId),
  });
}

export function useInvites(teamId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.teams.invites(teamId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`${teamUrl(teamId ?? '')}/invites`, { schema: inviteListResponseSchema, signal }),
    enabled: Boolean(teamId) && enabled,
  });
}

export function useInvitePreview(code: string) {
  return useQuery({
    queryKey: queryKeys.invite(code),
    queryFn: ({ signal }) =>
      api.get(`/api/invites/${encodeURIComponent(code)}`, { schema: invitePreviewSchema, signal }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

/** Refreshes the sidebar (`me`) and everything cached for the team. */
export function refreshTeam(queryClient: QueryClient, teamId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.teams.detail(teamId) }),
  ]);
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTeamInput) =>
      api.post('/api/teams', input, { schema: teamDetailSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
    meta: { suppressErrorToast: true },
  });
}

/**
 * Writes a team's new name, slug, icon and color into the cached `me`, so the sidebar and the
 * URL-to-team lookup follow a rename at once (call it together with navigating to a new slug).
 */
export function patchMeTeam(queryClient: QueryClient, team: TeamDetail): void {
  queryClient.setQueryData<MeResponse>(queryKeys.me(), (me) =>
    me
      ? {
          ...me,
          teams: me.teams.map((entry) =>
            entry.id === team.id
              ? { ...entry, name: team.name, slug: team.slug, icon: team.icon, color: team.color }
              : entry,
          ),
        }
      : me,
  );
}

/**
 * Edits the team. The caller updates `me` (`patchMeTeam`) and the URL when the slug changed,
 * then refreshes with `refreshTeam`.
 */
export function useUpdateTeam(teamId: string) {
  return useMutation({
    mutationFn: (input: UpdateTeamInput) =>
      api.patch(teamUrl(teamId), input, { schema: teamDetailSchema }),
    meta: { suppressErrorToast: true },
  });
}

/** Deletes the team. The caller leaves the team's pages first, then refreshes `me`. */
export function useDeleteTeam(teamId: string) {
  return useMutation({
    mutationFn: () => api.delete(teamUrl(teamId), { schema: okResponseSchema }),
    meta: { suppressErrorToast: true },
  });
}

/**
 * Restores a deleted team (owner) and refreshes `me`. A plain function rather than a hook: the
 * "Undo" toast that calls it outlives the settings page that deleted the team.
 */
export async function restoreTeam(queryClient: QueryClient, teamId: string): Promise<TeamDetail> {
  const team = await api.post(`${teamUrl(teamId)}/restore`, undefined, {
    schema: teamDetailSchema,
  });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.account.deletedTeams() }),
  ]);
  return team;
}

export function useTransferOwnership(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.post(`${teamUrl(teamId)}/transfer`, { userId }, { schema: teamDetailSchema }),
    onSuccess: () => refreshTeam(queryClient, teamId),
    meta: { suppressErrorToast: true },
  });
}

/** Leaves the team. The caller leaves the team's pages first, then refreshes `me`. */
export function useLeaveTeam(teamId: string) {
  return useMutation({
    mutationFn: () => api.post(`${teamUrl(teamId)}/leave`, undefined, { schema: okResponseSchema }),
    meta: { suppressErrorToast: true },
  });
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

export function useRemoveMember(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete(`${teamUrl(teamId)}/members/${encodeURIComponent(userId)}`, {
        schema: okResponseSchema,
      }),
    onSuccess: () => refreshTeam(queryClient, teamId),
    meta: { suppressErrorToast: true },
  });
}

export interface MemberRoleChange {
  userId: string;
  role: Pick<Role, 'id' | 'slug' | 'name' | 'color' | 'position'>;
  assigned: boolean;
}

function applyRoleChange(member: Member, change: MemberRoleChange): Member {
  const without = member.roles.filter((role) => role.id !== change.role.id);
  const roles = change.assigned
    ? [...without, change.role].sort((a, b) => b.position - a.position)
    : without;
  const colored = roles.find((role) => role.color);
  return { ...member, roles, color: colored?.color ?? null };
}

/** Grants or revokes a role, updating the members list optimistically (rolled back on error). */
export function useSetMemberRole(teamId: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.teams.members(teamId);
  return useMutation({
    mutationFn: ({ userId, role, assigned }: MemberRoleChange) =>
      assigned
        ? api.put(`${teamUrl(teamId)}/members/${userId}/roles/${role.id}`, undefined, {
            schema: memberSchema,
          })
        : api.delete(`${teamUrl(teamId)}/members/${userId}/roles/${role.id}`, {
            schema: memberSchema,
          }),
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<MemberListResponse>(key);
      if (previous) {
        queryClient.setQueryData<MemberListResponse>(key, {
          items: previous.items.map((member) =>
            member.user.id === change.userId ? applyRoleChange(member, change) : member,
          ),
        });
      }
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: queryKeys.teams.roles(teamId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
      ]),
  });
}

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

function refreshRoles(queryClient: QueryClient, teamId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.teams.roles(teamId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.teams.members(teamId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
  ]);
}

export function useCreateRole(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) =>
      api.post(`${teamUrl(teamId)}/roles`, input, { schema: roleSchema }),
    onSuccess: () => refreshRoles(queryClient, teamId),
    meta: { suppressErrorToast: true },
  });
}

export function useUpdateRole(teamId: string, roleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateRoleInput) =>
      api.patch(`${teamUrl(teamId)}/roles/${roleId}`, input, { schema: roleSchema }),
    onSuccess: () => refreshRoles(queryClient, teamId),
    meta: { suppressErrorToast: true },
  });
}

export function useDeleteRole(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) =>
      api.delete(`${teamUrl(teamId)}/roles/${roleId}`, { schema: okResponseSchema }),
    onSuccess: () => refreshRoles(queryClient, teamId),
    meta: { suppressErrorToast: true },
  });
}

/** Saves a new role order (every role but `@everyone`, highest first), optimistically. */
export function useReorderRoles(teamId: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.teams.roles(teamId);
  return useMutation({
    mutationFn: (roleIds: string[]) =>
      api.put(`${teamUrl(teamId)}/roles/order`, { roleIds }, { schema: roleListResponseSchema }),
    onMutate: async (roleIds) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<RoleListResponse>(key);
      if (previous) {
        const byId = new Map(previous.items.map((role) => [role.id, role]));
        const everyone = previous.items.filter((role) => role.isEveryone);
        const ordered = roleIds
          .map((id, index) => {
            const role = byId.get(id);
            return role ? { ...role, position: roleIds.length - index } : null;
          })
          .filter((role): role is Role => role !== null);
        queryClient.setQueryData<RoleListResponse>(key, { items: [...ordered, ...everyone] });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onSettled: () => refreshRoles(queryClient, teamId),
  });
}

// ---------------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------------

export function useCreateInvite(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInviteInput) =>
      api.post(`${teamUrl(teamId)}/invites`, input, { schema: inviteSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.teams.invites(teamId) }),
    meta: { suppressErrorToast: true },
  });
}

/** Revokes an invite, removing it from the list optimistically. */
export function useRevokeInvite(teamId: string) {
  const queryClient = useQueryClient();
  const key = queryKeys.teams.invites(teamId);
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.delete(`${teamUrl(teamId)}/invites/${inviteId}`, { schema: okResponseSchema }),
    onMutate: async (inviteId) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InviteListResponse>(key);
      if (previous) {
        queryClient.setQueryData<InviteListResponse>(key, {
          items: previous.items.filter((invite) => invite.id !== inviteId),
        });
      }
      return { previous };
    },
    onError: (_error, _inviteId, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useAcceptInvite(code: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(`/api/invites/${encodeURIComponent(code)}/accept`, undefined, {
        schema: acceptInviteResponseSchema,
      }),
    // The join page then opens the team, which must be in `me` first.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
  });
}
