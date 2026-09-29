import { useQuery } from '@tanstack/react-query';
import {
  HARNESS_LABELS,
  itemAgentRunsSchema,
  modelOptionsSchema,
  type HarnessId,
  type RanWith,
} from '@shared/schemas/agentRunner';
import { isAgentUsername } from '@shared/principals';
import { api } from '@web/lib/api';
import { findMentions } from '@web/lib/mentions';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Direct model choice (difficulty was removed, 2026-09-29): the models a requester or a stage can
 * suggest, and the model each agent run on an item actually used.
 */

const enc = encodeURIComponent;

/** Does the text @-mention an agent member (`@ethan-ai`)? Then a model can be suggested. */
export function mentionsAgent(text: string): boolean {
  return findMentions(text).some(
    (mention) => mention.kind === 'user' && isAgentUsername(mention.id),
  );
}

/** A run's model: "Claude Code · claude-opus-4 · high" (a default model or effort left out). */
export function ranWithText(ran: Pick<RanWith, 'harness' | 'model' | 'effort'>): string {
  return [HARNESS_LABELS[ran.harness as HarnessId] ?? ran.harness, ran.model, ran.effort]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Models known to the computers of the project's team's agents (`machines` left out): what a
 * requester or a stage may suggest. Only a suggestion: each owner's agent runs it when one of
 * their computers has it.
 */
export function useSuggestableModels(projectId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.projects.suggestableModels(projectId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId ?? '')}/suggestable-models`, {
        schema: modelOptionsSchema,
        signal,
      }),
    enabled: Boolean(projectId) && enabled,
    staleTime: 5 * 60_000,
  });
}

/** The agent runs about a task or issue, newest first, each with the model it ran with. */
export function useItemAgentRuns(item: { type: 'task' | 'issue'; id: string }) {
  return useQuery({
    queryKey: queryKeys.agentRunsFor(item.type, item.id),
    queryFn: ({ signal }) =>
      api.get('/api/agent-runs', {
        query: { itemType: item.type, itemId: item.id },
        schema: itemAgentRunsSchema,
        signal,
      }),
    select: (data) => data.runs,
    // Owners hear about their own jobs live; everyone else sees a running job finish by polling.
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === 'claimed') ? 30_000 : false,
  });
}
