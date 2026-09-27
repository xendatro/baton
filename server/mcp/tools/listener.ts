import { z } from 'zod';
import { AGENT_JOB_STATUSES, AGENT_LISTENER } from '@shared/constants';
import { completeJob, listJobs, releaseJob, startListener } from '../../services/agentJobs';
import { defineTool, toolInput, type McpTool } from './define';

/**
 * The agent listener (docs/design/agents-and-pipelines.md §4): `start_listener` hands out the
 * agent member's jobs (mentions, assignments, thread replies, pool hand-offs, approvals, action
 * results) for the projects it listens to; `complete_job`, `release_job` and `list_jobs` manage
 * them. Documented additions to SPEC §5.1 (DECISIONS 2026-09-27 listener C).
 */

const jobId = z.string().min(1).describe('Job id (jobId from start_listener or list_jobs)');

const startListenerTool = defineTool({
  name: 'start_listener',
  title: 'Start listener',
  description: [
    'Listens for work for your agent member in the given projects and returns jobs: someone @mentioned you, assigned you a task, replied in a thread you take part in, handed you a task from a pipeline stage (pool), asked for your approval, or decided on an action you requested.',
    'Returns at once with the pending jobs (claimed by this session, at most 10), or waits up to timeoutSeconds for the first one. Pass the returned sessionId back on every call.',
    "Loop: call start_listener; for each job spawn a subagent that follows the job's instructions and calls complete_job (or release_job); call start_listener again right away (an empty result just means nothing happened yet).",
    "Claimed jobs stay yours until you complete or release them; if your listener stops calling for 90 s, they go back to the queue for another session. Projects you don't listen to keep their jobs until a listener for them runs.",
    'Done handshake: a reply with add_reply { closing: true } means "no further discussion needed". A job from another agent\'s closing reply has closing: true; if you agree, call complete_job { agreeDone: true } without replying.',
  ].join(' '),
  input: toolInput({
    projects: z
      .array(z.string().min(1))
      .min(1)
      .max(AGENT_LISTENER.maxProjects)
      .describe('Projects to listen to: KEY, team-slug/KEY or ids (required)'),
    timeoutSeconds: z
      .number()
      .int()
      .min(0)
      .max(AGENT_LISTENER.maxWaitSeconds)
      .default(AGENT_LISTENER.defaultWaitSeconds)
      .describe(
        `Longest wait in seconds when no job is pending (default ${AGENT_LISTENER.defaultWaitSeconds}, max ${AGENT_LISTENER.maxWaitSeconds}); 0 only checks`,
      ),
    sessionId: z
      .string()
      .optional()
      .describe('sessionId returned by your previous start_listener call; omit on the first call'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => startListener(ctx.deps, ctx.actor, input, ctx.signal),
});

const completeJobTool = defineTool({
  name: 'complete_job',
  title: 'Complete job',
  description:
    "Marks one of your jobs done once you handled it (replied, did the work, or decided it needs nothing). agreeDone: true on a job with closing: true (another agent's closing reply) means you agree no further discussion is needed: do not reply; the thread then wakes no agent for agent replies until a person replies.",
  input: toolInput({
    jobId,
    agreeDone: z
      .boolean()
      .optional()
      .describe('Only for closing jobs: agree that nothing more is needed (instead of replying)'),
  }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => completeJob(ctx.deps, ctx.actor, input),
});

const releaseJobTool = defineTool({
  name: 'release_job',
  title: 'Release job',
  description:
    'Hands a claimed job back to the queue without doing it, so another listener session of yours can take it (for example when you are shutting down).',
  input: toolInput({ jobId }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => releaseJob(ctx.deps, ctx.actor, input),
});

const listJobsTool = defineTool({
  name: 'list_jobs',
  title: 'List jobs',
  description:
    "Your agent member's jobs, newest first (at most 50), with the same context start_listener returns, and how many are pending. Use start_listener to claim them.",
  input: toolInput({
    status: z.enum(AGENT_JOB_STATUSES).optional().describe('Only jobs with this status'),
    limit: z.number().int().min(1).max(50).default(20).describe('Maximum jobs (1–50)'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => listJobs(ctx.deps, ctx.actor, input),
});

export const listenerTools: McpTool[] = [
  startListenerTool,
  completeJobTool,
  releaseJobTool,
  listJobsTool,
];
