import { z } from 'zod';
import { AGENT_JOB_STATUSES, AGENT_LISTENER } from '@shared/constants';
import { HARNESS_IDS, JOB_OUTCOMES } from '@shared/schemas/agentRunner';
import { completeJob, listJobs, releaseJob, startListener } from '../../services/agentJobs';
import { recordJobUsage } from '../../services/agentRunner';
import { defineTool, toolInput, type McpTool } from './define';

/**
 * The agent listener (docs/design/agents-and-pipelines.md §4): `start_listener` hands out the
 * agent member's jobs (mentions, assignments, thread replies, pool hand-offs, approvals, action
 * results) for the projects it listens to; `complete_job`, `release_job` and `list_jobs` manage
 * them. Documented additions to SPEC §5.1 (DECISIONS 2026-09-27 listener C).
 */

const jobId = z.string().min(1).describe('Job id (jobId from start_listener or list_jobs)');

const usageField = z
  .array(
    toolInput({
      harness: z.enum(HARNESS_IDS).describe('Harness that ran it'),
      model: z.string().max(100).optional().describe('Model (alias or id)'),
      effort: z.string().max(40).optional().describe('Effort level'),
      tokensIn: z.number().int().nonnegative().optional().describe('Input tokens'),
      tokensOut: z.number().int().nonnegative().optional().describe('Output tokens'),
      costUsd: z.number().nonnegative().optional().describe('Cost in US dollars'),
      durationMs: z.number().int().nonnegative().optional().describe('Run time in milliseconds'),
      outcome: z.enum(JOB_OUTCOMES).describe('How the run ended'),
    }),
  )
  .max(8)
  .optional()
  .describe('What running the job cost, per harness run (shown in your agent stats); optional');

const startListenerTool = defineTool({
  name: 'start_listener',
  title: 'Start listener',
  description: [
    'Manual listener for your agent member (the Baton desktop app does this automatically, with no tokens spent while idle). Returns jobs in the given projects: someone @mentioned you, assigned you a task, replied in a thread you take part in, handed you a task from a pipeline stage (pool), asked for your approval, or decided on an action you requested.',
    'Returns at once with the pending jobs (claimed by this session, at most 10), or waits up to timeoutSeconds for the first one. Pass the returned sessionId back on every call.',
    "Protocol, exactly: (1) call start_listener; (2) for EACH job, spawn one subagent and give it the job (never do the work inline in the listening session, which must stay free to listen); the subagent follows the job's instructions and ends with complete_job { jobId } (or release_job { jobId } when it cannot do it); (3) call start_listener again right away with the same sessionId (an empty result only means nothing happened yet); repeat.",
    "Claimed jobs stay yours until you complete or release them; if your listener stops calling for 90 s, they go back to the queue. Projects you don't listen to keep their jobs until a listener or the desktop app for them runs.",
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
    usage: usageField,
  }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    recordJobUsage(ctx.deps, ctx.actor, input.jobId, input.usage);
    return completeJob(ctx.deps, ctx.actor, {
      jobId: input.jobId,
      ...(input.agreeDone !== undefined ? { agreeDone: input.agreeDone } : {}),
    });
  },
});

const releaseJobTool = defineTool({
  name: 'release_job',
  title: 'Release job',
  description:
    'Hands a claimed job back to the queue without doing it, so another listener session of yours can take it (for example when you are shutting down).',
  input: toolInput({ jobId, usage: usageField }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    recordJobUsage(ctx.deps, ctx.actor, input.jobId, input.usage);
    return releaseJob(ctx.deps, ctx.actor, { jobId: input.jobId });
  },
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
