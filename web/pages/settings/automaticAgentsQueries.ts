import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  agentStatsSchema,
  jobOutputSchema,
  modelFailuresSchema,
  modelMappingsSchema,
  ownerJobsSchema,
  runnerSchema,
  type ModelMappings,
  type OwnerJob,
} from '@shared/schemas/agentRunner';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Automatic agents (BAT-24) on the web: runners, stopped runs, models, stats. */

const enc = encodeURIComponent;

/** A job waiting on you: needs your OK, a stopped run, or cleared (BAT#22, BAT#29). */
export type WaitingJob = OwnerJob;

export function useRunners() {
  return useQuery({
    queryKey: queryKeys.account.agentRunners(),
    queryFn: ({ signal }) =>
      api.get('/api/agent/runners', {
        schema: z.object({ runners: z.array(runnerSchema) }),
        signal,
      }),
    select: (data) => data.runners,
  });
}

export function useWaitingJobs() {
  return useQuery({
    queryKey: queryKeys.account.agentWaiting(),
    queryFn: ({ signal }) =>
      api.get('/api/me/agent/waiting', {
        schema: ownerJobsSchema,
        signal,
      }),
    select: (data) => data.jobs,
  });
}

export function useDecideWaitingJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, decision }: { jobId: string; decision: 'approve' | 'dismiss' }) =>
      api.post(`/api/me/agent/jobs/${enc(jobId)}/${decision}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.account.agentWaiting() }),
  });
}

/** The stored output tail of a job's last run (BAT#23), loaded when `enabled` (a dialog opens). */
export function useJobOutput(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.account.agentJobOutput(jobId),
    queryFn: ({ signal }) =>
      api.get(`/api/me/agent/jobs/${enc(jobId)}/output`, { schema: jobOutputSchema, signal }),
    enabled,
  });
}

/** The latest failed run per harness and model (BAT#23), shown next to chain entries. */
export function useModelFailures() {
  return useQuery({
    queryKey: queryKeys.account.agentModelFailures(),
    queryFn: ({ signal }) =>
      api.get('/api/me/agent/model-failures', { schema: modelFailuresSchema, signal }),
    select: (data) => data.failures,
  });
}

export function useModelMappings() {
  return useQuery({
    queryKey: queryKeys.account.agentModels(),
    queryFn: ({ signal }) =>
      api.get('/api/me/agent/models', { schema: modelMappingsSchema, signal }),
  });
}

export function useSetModelMappings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ModelMappings) =>
      api.put('/api/me/agent/models', input, { schema: modelMappingsSchema }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.account.agentModels(), data),
    meta: { suppressErrorToast: true },
  });
}

export function useAgentStats(days: number) {
  return useQuery({
    queryKey: queryKeys.account.agentStats(days),
    queryFn: ({ signal }) =>
      api.get('/api/me/agent/stats', {
        query: { days: String(days) },
        schema: agentStatsSchema,
        signal,
      }),
  });
}
