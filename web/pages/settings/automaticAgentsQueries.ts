import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  agentStatsSchema,
  jobSourcesSchema,
  modelMappingsSchema,
  runnerSchema,
  type JobSources,
  type ModelMappings,
} from '@shared/schemas/agentRunner';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Automatic agents (BAT-24) on the web: runners, waiting jobs, job sources, models, stats. */

const enc = encodeURIComponent;

const waitingJobSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  createdAt: z.string(),
  triggeredBy: z.string().nullable(),
  project: z.object({ id: z.string(), ref: z.string(), name: z.string() }).nullable(),
  target: z.object({
    ref: z.string().nullable(),
    title: z.string().nullable(),
    url: z.string().nullable(),
  }),
  trigger: z.object({ body: z.string() }).nullable(),
});
export type WaitingJob = z.infer<typeof waitingJobSchema>;

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
        schema: z.object({ jobs: z.array(waitingJobSchema) }),
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

export function useJobSources() {
  return useQuery({
    queryKey: queryKeys.account.agentJobSources(),
    queryFn: ({ signal }) =>
      api.get('/api/me/agent/job-sources', { schema: jobSourcesSchema, signal }),
  });
}

export function useSetJobSources() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: JobSources) =>
      api.put('/api/me/agent/job-sources', input, { schema: jobSourcesSchema }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.account.agentJobSources(), data),
    meta: { suppressErrorToast: true },
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
