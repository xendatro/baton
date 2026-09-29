import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  agentAccessSchema,
  agentRequestSchema,
  agentRequestsSchema,
  itemAgentRequestsSchema,
  projectAgentAccessSchema,
  teamAgentAccessSchema,
  type AgentAccessRules,
  type AgentRequest,
  type SetProjectAgentAccessInput,
} from '@shared/schemas/agentAccess';
import { modelOptionsSchema, type ChainEntry } from '@shared/schemas/agentRunner';
import { z } from 'zod';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Agent access on the web: requests to start your agent (the Requests page, the sidebar badge,
 * inline cards in a conversation), who can start it (Settings → Automatic agents, a project's
 * Your settings), and what your computers can run (every model picker).
 */

const enc = encodeURIComponent;

/** Your requests: open ones first (oldest first), then those decided in the last day. */
export function useAgentRequests() {
  return useQuery({
    queryKey: queryKeys.account.agentRequests(),
    queryFn: ({ signal }) =>
      api.get('/api/me/agent/requests', { schema: agentRequestsSchema, signal }),
    select: (data) => data.requests,
  });
}

/** How many requests wait for you (the sidebar badge). */
export function usePendingRequestCount(): number {
  const requests = useAgentRequests();
  return requests.data?.filter((request) => request.status === 'pending').length ?? 0;
}

/**
 * Requests about one task or issue: `mine` (your agent's, for inline Approve / Decline) and
 * `waiting` (whose agents wait for their owner's OK, or were declined). For the conversation view.
 */
export function useAgentRequestsFor(item: { type: 'task' | 'issue'; id: string } | null) {
  return useQuery({
    queryKey: queryKeys.agentRequestsFor(item?.type ?? 'task', item?.id ?? ''),
    queryFn: ({ signal }) =>
      api.get('/api/agent-requests', {
        query: { itemType: item?.type ?? 'task', itemId: item?.id ?? '' },
        schema: itemAgentRequestsSchema,
        signal,
      }),
    enabled: item !== null,
  });
}

function useInvalidateRequests() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.account.agentRequests() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agentRequestsFor() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
  };
}

export function useApproveRequest() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: ({ jobId, model }: { jobId: string; model: ChainEntry | null }) =>
      api.post(`/api/me/agent/requests/${enc(jobId)}/approve`, model ? { model } : {}, {
        schema: agentRequestSchema,
      }),
    onSettled: invalidate,
    meta: { suppressErrorToast: true },
  });
}

export function useDeclineRequest() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: ({ jobId, reason }: { jobId: string; reason?: string }) =>
      api.post(`/api/me/agent/requests/${enc(jobId)}/decline`, reason ? { reason } : {}, {
        schema: agentRequestSchema,
      }),
    onSettled: invalidate,
    meta: { suppressErrorToast: true },
  });
}

export function useDecideRequests() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (input: { jobIds: string[]; decision: 'approve' | 'decline'; reason?: string }) =>
      api.post('/api/me/agent/requests/bulk', input, {
        schema: z.object({ requests: z.array(agentRequestSchema), skipped: z.array(z.string()) }),
      }),
    onSettled: invalidate,
    meta: { suppressErrorToast: true },
  });
}

/** What your computers can run (the union of what your desktop apps report). */
export function useModelOptions() {
  return useQuery({
    queryKey: queryKeys.account.agentModelOptions(),
    queryFn: ({ signal }) =>
      api.get('/api/me/agent/model-options', { schema: modelOptionsSchema, signal }),
  });
}

/** Your team defaults of who can start your agent. */
export function useAgentAccess() {
  return useQuery({
    queryKey: queryKeys.account.agentAccess(),
    queryFn: ({ signal }) => api.get('/api/me/agent/access', { schema: agentAccessSchema, signal }),
    select: (data) => data.teams,
  });
}

export function useSetTeamAgentAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, rules }: { teamId: string; rules: AgentAccessRules }) =>
      api.put(
        `/api/me/agent/access/teams/${enc(teamId)}`,
        { rules },
        { schema: teamAgentAccessSchema },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.account.agentAccess() });
    },
    meta: { suppressErrorToast: true },
  });
}

export function useProjectAgentAccess(projectId: string) {
  return useQuery({
    queryKey: queryKeys.account.projectAgentAccess(projectId),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/me/agent-access`, {
        schema: projectAgentAccessSchema,
        signal,
      }),
  });
}

export function useSetProjectAgentAccess(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetProjectAgentAccessInput) =>
      api.put(`/api/projects/${enc(projectId)}/me/agent-access`, input, {
        schema: projectAgentAccessSchema,
      }),
    onSuccess: (data) =>
      queryClient.setQueryData(queryKeys.account.projectAgentAccess(projectId), data),
    meta: { suppressErrorToast: true },
  });
}

export type { AgentRequest };
