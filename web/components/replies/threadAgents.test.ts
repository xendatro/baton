import { describe, expect, it } from 'vitest';
import type { UserSummary } from '@shared/schemas/core';
import { threadAgents } from './threadAgents';

const ethan: UserSummary = { id: 'u1', username: 'ethan', name: 'Ethan', image: null };
const caden: UserSummary = { id: 'u2', username: 'caden', name: 'Caden', image: null };

describe('threadAgents (BAT-12)', () => {
  it('lists each agent once, in order of first appearance, with every key it used', () => {
    const agents = threadAgents([
      { author: ethan, via: { keyId: 'k1', keyName: 'MSI', agentName: 'Codex' } },
      { author: caden, via: null },
      { author: ethan, via: { keyId: 'k2', keyName: 'Laptop', agentName: 'Claude' } },
      { author: ethan, via: { keyId: 'k2', keyName: 'Laptop', agentName: 'Claude' } },
      { author: caden, via: { keyId: 'k3', keyName: 'Desktop', agentName: 'Claude' } },
      { author: null, via: { keyId: 'k4', keyName: 'Old key', agentName: 'Claude' } },
    ]);
    expect(agents).toEqual([
      { name: 'Codex', handle: 'codex', keys: ['Ethan’s MSI'] },
      { name: 'Claude', handle: 'claude', keys: ['Ethan’s Laptop', 'Caden’s Desktop', 'Old key'] },
    ]);
  });

  it('skips keys without a known agent and names that make no mention', () => {
    expect(
      threadAgents([
        { author: ethan, via: { keyId: 'k1', keyName: 'Script' } },
        { author: ethan, via: { keyId: 'k2', keyName: 'Script', agentName: null } },
        { author: ethan, via: { keyId: 'k3', keyName: 'X', agentName: 'AI' } },
        { author: ethan, via: { keyId: 'k4', keyName: 'Y', agentName: 'Everyone' } },
        { author: ethan, via: { keyId: 'k5', keyName: 'Z', agentName: '🤖' } },
      ]),
    ).toEqual([]);
    expect(
      threadAgents([
        { author: ethan, via: { keyId: 'k1', keyName: 'MSI', agentName: 'My Bot 2' } },
      ]),
    ).toEqual([{ name: 'My Bot 2', handle: 'mybot2', keys: ['Ethan’s MSI'] }]);
  });
});
