import type { AgentRequest } from '@shared/schemas/agentAccess';
import type { ModelOptions } from '@shared/schemas/agentRunner';

/** A request to start Ethan's agent, from Caden (agent access), for web tests. */
export function requestFixture(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    jobId: 'job-1',
    kind: 'mention',
    status: 'pending',
    agent: { id: 'agent-ethan', username: 'ethan-ai', name: 'Ethan AI' },
    owner: { id: 'ethan', username: 'ethan', name: 'Ethan' },
    requester: { id: 'caden', username: 'caden', name: 'Caden', image: null },
    question: 'Can I reply to Caden’s message here?',
    summary: 'Reply to Caden’s message on BAT-40',
    project: { id: 'p1', ref: 'baton/BAT', name: 'Baton' },
    target: {
      type: 'task',
      id: 't40',
      ref: 'BAT-40',
      title: 'Export is slow',
      path: '/t/baton/p/BAT/tasks/40',
    },
    message: {
      replyId: 'r1',
      body: '@ethan-ai can you profile the CSV writer?',
      path: '/t/baton/p/BAT/tasks/40#reply-r1',
    },
    stage: null,
    suggestedChain: [{ harness: 'claude', model: 'opus', effort: 'high' }],
    suggestedSource: 'account default',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    reason: null,
    modelOverride: null,
    ...overrides,
  };
}

/** Ethan's computers: Claude Code (opus, sonnet; efforts low…max) and Codex (gpt-5). */
export const MODEL_OPTIONS: ModelOptions = {
  harnesses: [
    {
      id: 'claude',
      online: true,
      machines: ['MSI'],
      reported: true,
      models: [
        { id: 'opus', label: null, efforts: [], online: true },
        { id: 'sonnet', label: null, efforts: [], online: true },
      ],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'codex',
      online: true,
      machines: ['MSI'],
      reported: true,
      models: [
        {
          id: 'gpt-5',
          label: 'GPT-5',
          efforts: ['minimal', 'low', 'medium', 'high'],
          online: true,
        },
      ],
      efforts: ['minimal', 'low', 'medium', 'high'],
    },
  ],
};
