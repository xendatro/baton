import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentActionStatus } from '@shared/constants';
import {
  agentActionListResponseSchema,
  agentActionRequestSchema,
  type AgentActionRequest,
} from '@shared/schemas/agentActions';
import { api } from './api';
import { queryKeys } from './queryKeys';

/**
 * Your agent's sign-off requests (docs/design/agents-and-pipelines.md §6): the inbox shows
 * Approve / Deny on their notifications, Settings → Agent lists the pending ones. The personal
 * `agent_action.changed` live event refreshes both.
 */

export const AGENT_ACTION_LIST_LIMIT = 100;

/** Your agent's requests, newest first (`status` narrows them). */
export function useAgentActionRequests(
  status: AgentActionStatus | 'all' = 'all',
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: queryKeys.account.agentActions({ status }),
    queryFn: ({ signal }) =>
      api.get('/api/agent-actions', {
        query: { status, limit: AGENT_ACTION_LIST_LIMIT },
        schema: agentActionListResponseSchema,
        signal,
      }),
  });
}

export type AgentActionDecision = 'approve' | 'deny';

/** Approves (runs) or denies a request; refreshes the lists and the inbox afterwards. */
export function useDecideAgentAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: AgentActionDecision }) =>
      api.post(`/api/agent-actions/${id}/${decision}`, undefined, {
        schema: agentActionRequestSchema,
      }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.account.agentActions() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
      ]),
  });
}

/** Past-tense words for a settled request. */
export const AGENT_ACTION_STATUS_LABELS: Record<AgentActionStatus, string> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
  failed: 'Failed',
};

/** "Ethan AI wants to delete BAT-12 “Fix login”". */
export function requestSentence(request: Pick<AgentActionRequest, 'agent' | 'summary'>): string {
  return `${request.agent?.name ?? 'Your agent'} wants to ${request.summary}`;
}
