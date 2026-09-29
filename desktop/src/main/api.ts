import { z } from 'zod';
import {
  agentStatsSchema,
  jobBriefSchema,
  jobSourcesSchema,
  modelMappingsSchema,
  runnerStateSchema,
  type FinishJobInput,
  type HarnessSessionInput,
  type JobSources,
  type ModelMappings,
  type RegisterRunnerInput,
  type RunnerHeartbeatInput,
} from '@shared/schemas/agentRunner';

/**
 * The Baton REST API as the desktop app uses it (BAT-24), with the person's API key: the runner
 * endpoints, the owner's settings and stats, and `/api/me` for their teams and projects.
 */

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A job as `jobs/next` hands it out (the listener's job context). */
export const runnerJobSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  closing: z.boolean(),
  triggeredBy: z.string().nullable().optional(),
  project: z.object({ id: z.string(), ref: z.string(), name: z.string() }).nullable(),
  target: z.object({
    type: z.string(),
    /** The item's id (jobs about the same item share a session, BAT#31). */
    id: z.string().optional(),
    ref: z.string().nullable(),
    title: z.string().nullable(),
    url: z.string().nullable(),
  }),
  trigger: z
    .object({
      body: z.string(),
      replyId: z.string().optional(),
      author: z.object({ username: z.string().nullable() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  /** What the job asks, in words (for a job merged into a running session). */
  instructions: z.string().optional(),
  createdAt: z.string(),
});
export type RunnerJob = z.infer<typeof runnerJobSchema>;

export const meSchema = z.object({
  user: z.object({ id: z.string(), username: z.string().nullable(), name: z.string() }),
  teams: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      projects: z.array(
        z.object({
          id: z.string(),
          key: z.string(),
          name: z.string(),
        }),
      ),
    }),
  ),
});
export type Me = z.infer<typeof meSchema>;

const projectSchema = z.object({
  id: z.string(),
  repoUrl: z.string().nullable().optional(),
});

export class BatonApi {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  get mcpUrl(): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/mcp`;
  }

  get key(): string {
    return this.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        res.status,
        error?.code ?? 'error',
        error?.message ?? `Baton answered ${res.status}`,
      );
    }
    return schema.parse(payload);
  }

  me() {
    return this.request('GET', '/api/me', meSchema);
  }

  project(projectId: string) {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}`, projectSchema);
  }

  register(input: RegisterRunnerInput) {
    return this.request('POST', '/api/agent/runners', runnerStateSchema, input);
  }

  heartbeat(runnerId: string, input: RunnerHeartbeatInput) {
    return this.request(
      'POST',
      `/api/agent/runners/${runnerId}/heartbeat`,
      runnerStateSchema,
      input,
    );
  }

  nextJobs(runnerId: string, wait: number, signal?: AbortSignal) {
    return this.request(
      'POST',
      `/api/agent/runners/${runnerId}/jobs/next?wait=${wait}`,
      z.object({ jobs: z.array(runnerJobSchema) }),
      {},
      signal,
    );
  }

  brief(jobId: string, runnerId: string) {
    return this.request('GET', `/api/agent/jobs/${jobId}/brief?runner=${runnerId}`, jobBriefSchema);
  }

  setSession(jobId: string, input: HarnessSessionInput) {
    return this.request(
      'PUT',
      `/api/agent/jobs/${jobId}/session`,
      z.object({ ok: z.literal(true) }),
      input,
    );
  }

  finish(jobId: string, mode: 'complete' | 'release', input: FinishJobInput) {
    return this.request(
      'POST',
      `/api/agent/jobs/${jobId}/${mode}`,
      runnerJobSchema.partial(),
      input,
    );
  }

  waiting() {
    return this.request(
      'GET',
      '/api/me/agent/waiting',
      z.object({ jobs: z.array(runnerJobSchema) }),
    );
  }

  decide(jobId: string, decision: 'approve' | 'dismiss') {
    return this.request('POST', `/api/me/agent/jobs/${jobId}/${decision}`, z.unknown());
  }

  jobSources() {
    return this.request('GET', '/api/me/agent/job-sources', jobSourcesSchema);
  }

  setJobSources(input: JobSources) {
    return this.request('PUT', '/api/me/agent/job-sources', jobSourcesSchema, input);
  }

  models() {
    return this.request('GET', '/api/me/agent/models', modelMappingsSchema);
  }

  setModels(input: ModelMappings) {
    return this.request('PUT', '/api/me/agent/models', modelMappingsSchema, input);
  }

  stats(days: number) {
    return this.request('GET', `/api/me/agent/stats?days=${days}`, agentStatsSchema);
  }

  pauseEverywhere() {
    return this.request('POST', '/api/me/agent/pause', z.unknown());
  }
}
