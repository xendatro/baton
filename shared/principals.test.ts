import { describe, expect, it } from 'vitest';
import {
  agentDisplayName,
  agentUsername,
  isAgentEmail,
  isAgentUsername,
  principalRuleSchema,
} from './principals';
import { usernameInputSchema } from './schemas/account';
import { usernameSchema } from './schemas/common';

describe('agent member names (agents A)', () => {
  it('derives the agent’s username and display name from its owner', () => {
    expect(agentUsername('ethan')).toBe('ethan-ai');
    expect(agentDisplayName('Ethan')).toBe('Ethan AI');
    expect(isAgentUsername('ethan-ai')).toBe(true);
    expect(isAgentUsername('Ethan-AI')).toBe(true);
    expect(isAgentUsername('ethan')).toBe(false);
    expect(isAgentEmail('01ABC@agents.baton.invalid')).toBe(true);
    expect(isAgentEmail('ethan@example.com')).toBe(false);
  });

  it('keeps the -ai suffix out of people’s usernames', () => {
    expect(usernameSchema.safeParse('ethan-ai').success).toBe(false);
    expect(usernameInputSchema.safeParse('Ethan-AI').success).toBe(false);
  });
});

describe('principal rules', () => {
  it('parse with an empty deny list by default', () => {
    expect(principalRuleSchema.parse({ allow: [{ type: 'everyone', scope: 'agents' }] })).toEqual({
      allow: [{ type: 'everyone', scope: 'agents' }],
      deny: [],
    });
  });
});
