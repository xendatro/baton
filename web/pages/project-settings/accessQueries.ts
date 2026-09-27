import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { okResponseSchema } from '@shared/schemas/common';
import {
  projectPermissionsResponseSchema,
  projectRoleListResponseSchema,
  projectRoleSchema,
  type CreateProjectRoleInput,
  type OverrideSubjectType,
  type SetPermissionOverrideInput,
  type UpdateProjectRoleInput,
} from '@shared/schemas/projectAccess';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Project access (design §3): project roles and permission overrides of one project. */

const enc = encodeURIComponent;
const base = (projectId: string) => `/api/projects/${enc(projectId)}`;

export function useProjectRoles(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projects.roles(projectId),
    queryFn: ({ signal }) =>
      api.get(`${base(projectId)}/roles`, { schema: projectRoleListResponseSchema, signal }),
    select: (data) => data.items,
  });
}

export function useProjectPermissions(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projects.permissions(projectId),
    queryFn: ({ signal }) =>
      api.get(`${base(projectId)}/permissions`, {
        schema: projectPermissionsResponseSchema,
        signal,
      }),
  });
}

/** After any access change: roles, overrides and the viewer's own permissions (`me`). */
function refresh(queryClient: QueryClient, projectId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.roles(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.permissions(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
  ]);
}

function useAccessMutation<Input, Output>(
  projectId: string,
  mutationFn: (input: Input) => Promise<Output>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => refresh(queryClient, projectId),
    meta: { suppressErrorToast: true },
  });
}

export function useCreateProjectRole(projectId: string) {
  return useAccessMutation(projectId, (input: CreateProjectRoleInput) =>
    api.post(`${base(projectId)}/roles`, input, { schema: projectRoleSchema }),
  );
}

export function useUpdateProjectRole(projectId: string) {
  return useAccessMutation(
    projectId,
    ({ id, input }: { id: string; input: UpdateProjectRoleInput }) =>
      api.patch(`${base(projectId)}/roles/${enc(id)}`, input, { schema: projectRoleSchema }),
  );
}

export function useDeleteProjectRole(projectId: string) {
  return useAccessMutation(projectId, (id: string) =>
    api.delete(`${base(projectId)}/roles/${enc(id)}`, { schema: okResponseSchema }),
  );
}

export function useReorderProjectRoles(projectId: string) {
  return useAccessMutation(projectId, (roleIds: string[]) =>
    api.put(
      `${base(projectId)}/roles/order`,
      { roleIds },
      { schema: projectRoleListResponseSchema },
    ),
  );
}

export function useSetProjectRoleMember(projectId: string) {
  return useAccessMutation(
    projectId,
    ({ roleId, userId, assign }: { roleId: string; userId: string; assign: boolean }) => {
      const url = `${base(projectId)}/roles/${enc(roleId)}/members/${enc(userId)}`;
      return assign
        ? api.put(url, undefined, { schema: projectRoleSchema })
        : api.delete(url, { schema: projectRoleSchema });
    },
  );
}

export function useSetPermissionOverride(projectId: string) {
  return useAccessMutation(projectId, (input: SetPermissionOverrideInput) =>
    api.put(`${base(projectId)}/permissions/overrides`, input, {
      schema: projectPermissionsResponseSchema,
    }),
  );
}

export function useRemovePermissionOverride(projectId: string) {
  return useAccessMutation(
    projectId,
    ({ subjectType, subjectId }: { subjectType: OverrideSubjectType; subjectId: string }) =>
      api.delete(`${base(projectId)}/permissions/overrides/${subjectType}/${enc(subjectId)}`, {
        schema: projectPermissionsResponseSchema,
      }),
  );
}
