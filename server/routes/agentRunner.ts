import { Hono } from 'hono';
import { z } from 'zod';
import {
  agentStatsQuerySchema,
  finishJobInputSchema,
  harnessSessionInputSchema,
  jobBriefQuerySchema,
  jobSourcesSchema,
  modelMappingsSchema,
  registerRunnerInputSchema,
  runnerHeartbeatInputSchema,
  runnerNextQuerySchema,
} from '@shared/schemas/agentRunner';
import { idSchema } from '@shared/schemas/common';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  agentStats,
  approveWaitingJob,
  dismissWaitingJob,
  finishJob,
  getJobSources,
  getModelMappings,
  jobBrief,
  listRunners,
  listWaitingJobs,
  nextRunnerJobs,
  registerRunner,
  runnerHeartbeat,
  setHarnessSession,
  setJobSources,
  setModelMappings,
} from '../services/agentRunner';

/**
 * Automatic agents (BAT-24): the desktop app's runner endpoints (with an API key: register,
 * heartbeat, next jobs, briefs, harness sessions, finishing jobs with usage) and the owner's
 * settings, waiting jobs and stats (web session or their agent's key).
 * Owner: agents module. Paths are relative to /api and declared in full in this file.
 */
export const agentRunnerRoutes = new Hono<AppEnv>();

const runnerParams = validateParams(z.object({ runnerId: idSchema }));
const jobParams = validateParams(z.object({ jobId: idSchema }));

agentRunnerRoutes.post('/agent/runners', validateJson(registerRunnerInputSchema), (c) =>
  c.json(registerRunner(c.var.deps, requireActor(c), c.req.valid('json'))),
);

agentRunnerRoutes.get('/agent/runners', (c) => c.json(listRunners(c.var.deps, requireActor(c))));

agentRunnerRoutes.post(
  '/agent/runners/:runnerId/heartbeat',
  runnerParams,
  validateJson(runnerHeartbeatInputSchema),
  (c) =>
    c.json(
      runnerHeartbeat(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').runnerId,
        c.req.valid('json'),
      ),
    ),
);

agentRunnerRoutes.post(
  '/agent/runners/:runnerId/jobs/next',
  runnerParams,
  validateQuery(runnerNextQuerySchema),
  async (c) =>
    c.json(
      await nextRunnerJobs(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').runnerId,
        c.req.valid('query').wait,
        c.req.raw.signal,
      ),
    ),
);

agentRunnerRoutes.get(
  '/agent/jobs/:jobId/brief',
  jobParams,
  validateQuery(jobBriefQuerySchema),
  (c) =>
    c.json(
      jobBrief(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').jobId,
        c.req.valid('query').runner,
      ),
    ),
);

agentRunnerRoutes.put(
  '/agent/jobs/:jobId/session',
  jobParams,
  validateJson(harnessSessionInputSchema),
  (c) =>
    c.json(
      setHarnessSession(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').jobId,
        c.req.valid('json'),
      ),
    ),
);

for (const mode of ['complete', 'release'] as const) {
  agentRunnerRoutes.post(
    `/agent/jobs/:jobId/${mode}`,
    jobParams,
    validateJson(finishJobInputSchema),
    (c) =>
      c.json(
        finishJob(
          c.var.deps,
          requireActor(c),
          c.req.valid('param').jobId,
          mode,
          c.req.valid('json'),
        ),
      ),
  );
}

agentRunnerRoutes.get('/me/agent/waiting', (c) =>
  c.json(listWaitingJobs(c.var.deps, requireActor(c))),
);

agentRunnerRoutes.post('/me/agent/jobs/:jobId/approve', jobParams, (c) =>
  c.json(approveWaitingJob(c.var.deps, requireActor(c), c.req.valid('param').jobId)),
);

agentRunnerRoutes.post('/me/agent/jobs/:jobId/dismiss', jobParams, (c) =>
  c.json(dismissWaitingJob(c.var.deps, requireActor(c), c.req.valid('param').jobId)),
);

agentRunnerRoutes.get('/me/agent/job-sources', (c) =>
  c.json(getJobSources(c.var.deps, requireActor(c))),
);

agentRunnerRoutes.put('/me/agent/job-sources', validateJson(jobSourcesSchema), (c) =>
  c.json(setJobSources(c.var.deps, requireActor(c), c.req.valid('json'))),
);

agentRunnerRoutes.get('/me/agent/models', (c) =>
  c.json(getModelMappings(c.var.deps, requireActor(c))),
);

agentRunnerRoutes.put('/me/agent/models', validateJson(modelMappingsSchema), (c) =>
  c.json(setModelMappings(c.var.deps, requireActor(c), c.req.valid('json'))),
);

agentRunnerRoutes.get('/me/agent/stats', validateQuery(agentStatsQuerySchema), (c) =>
  c.json(agentStats(c.var.deps, requireActor(c), c.req.valid('query').days)),
);
