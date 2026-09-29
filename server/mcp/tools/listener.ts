import { z } from 'zod';
import { AGENT_JOB_STATUSES, AGENT_LISTENER } from '@shared/constants';
import { HARNESS_IDS, JOB_OUTCOMES } from '@shared/schemas/agentRunner';
import { completeJob, listJobs, releaseJob, startListener } from '../../services/agentJobs';
import { listAgentRequests } from '../../services/agentRequests';
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
      tokensIn: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Input tokens, cache reads and writes included'),
      tokensOut: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Output tokens, reasoning included'),
      tokensCacheRead: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Of the input, tokens read from the prompt cache'),
      tokensCacheWrite: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Of the input, tokens written to the prompt cache'),
      tokensReasoning: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Of the output, reasoning tokens'),
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
    'Manual listener for your agent member. For automatic runs, use the Baton desktop app instead: it runs every job for you and spends no tokens while idle. Returns jobs in the given projects: someone @mentioned you, assigned you a task, replied in a thread you take part in, handed you a task from a pipeline stage (pool), asked for your approval, or decided on an action you requested.',
    'Returns at once with the pending jobs (claimed by this session, at most 10), or waits up to timeoutSeconds for the first one. Pass the returned sessionId back on every call.',
    "Strict protocol. The listening session only claims and dispatches; it never handles a job itself. (1) Call start_listener. (2) For EACH job, spawn exactly one subagent (one subagent per job, never one for several) and pass it the job's jobId and its full brief: the whole job object as returned (instructions, target, trigger, stageInstructions, payload), not a summary. (3) The subagent does the work, writes its own replies with add_reply and ends with complete_job { jobId } (or release_job { jobId } when it cannot do it). The listening session never calls add_reply or complete_job for a job, and never relays or rewrites a subagent's answer. (4) Call start_listener again right away with the same sessionId, without waiting for the subagents to finish where your client can run them in the background (an empty result only means nothing happened yet); repeat.",
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
    "Marks one of your jobs done once it is handled (replied, did the work, or decided it needs nothing). Called by whoever did the work: with start_listener, the subagent the job was given to, never the listening session. agreeDone: true on a job with closing: true (another agent's closing reply) means you agree no further discussion is needed: do not reply; the thread then wakes no agent for agent replies until a person replies.",
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
    "Hands a claimed job back to the queue without doing it, so another listener session of yours (or the desktop app) can take it. With start_listener, the job's subagent calls it when it cannot do the job; the listening session only for jobs it has not handed out (for example when shutting down).",
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

const listRequestsTool = defineTool({
  name: 'list_requests',
  title: 'List requests',
  description:
    "Requests to start your owner's agent (you): jobs from people who may only ask (your owner's agent access), waiting for your owner to approve (choosing the model) or decline on the Requests page, plus those decided in the last day. Read only: only your owner decides, in Baton.",
  input: toolInput({}),
  annotations: { readOnlyHint: true },
  handler: (ctx) => listAgentRequests(ctx.deps, ctx.actor),
});

export const listenerTools: McpTool[] = [
  startListenerTool,
  completeJobTool,
  releaseJobTool,
  listJobsTool,
  listRequestsTool,
];
