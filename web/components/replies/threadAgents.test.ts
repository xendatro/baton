import { describe, expect, it } from 'vitest';
import type { UserSummary } from '@shared/schemas/core';
import { threadAgents } from './threadAgents';

const ethan: UserSummary = { id: 'u1', username: 'ethan', name: 'Ethan', image: null };
const caden: UserSummary = { id: 'u2', username: 'caden', name: 'Caden', image: null };
const ethanAi: UserSummary = {
  id: 'a1',
  username: 'ethan-ai',
  name: 'Ethan AI',
  image: null,
  kind: 'agent',
  agentOwner: ethan,
};
const cadenAi: UserSummary = {
  id: 'a2',
  username: 'caden-ai',
  name: 'Caden AI',
  image: null,
  kind: 'agent',
  agentOwner: caden,
};

describe('threadAgents (BAT-12, agents A)', () => {
  it('lists each agent member once, in order of first appearance, with its latest harness', () => {
    const agents = threadAgents([
      {
        author: ethanAi,
        via: { keyId: 'k1', keyName: 'MSI', agentName: 'Codex' },
        createdAt: '2026-09-26T10:00:00.000Z',
      },
      { author: caden, via: null, createdAt: '2026-09-26T10:01:00.000Z' },
      {
        author: cadenAi,
        via: { keyId: 'k3', keyName: 'Script' },
        createdAt: '2026-09-26T10:02:00.000Z',
      },
      {
        author: ethanAi,
        via: { keyId: 'k2', keyName: 'Laptop', agentName: 'Claude' },
        createdAt: '2026-09-26T10:03:00.000Z',
      },
      {
        author: ethanAi,
        via: { keyId: 'k4', keyName: 'Script', agentName: null },
        createdAt: '2026-09-26T10:04:00.000Z',
      },
    ]);
    expect(agents).toEqual([
      { user: ethanAi, agentName: 'Claude' },
      { user: cadenAi, agentName: null },
    ]);
  });

  it('takes the newest write’s harness even when it is listed first', () => {
    expect(
      threadAgents([
        {
          author: ethanAi,
          via: { keyId: 'k1', keyName: 'MSI', agentName: 'Cursor' },
          createdAt: '2026-09-26T12:00:00.000Z',
        },
        {
          author: ethanAi,
          via: { keyId: 'k2', keyName: 'Laptop', agentName: 'Claude' },
          createdAt: '2026-09-26T11:00:00.000Z',
        },
      ]),
    ).toEqual([{ user: ethanAi, agentName: 'Cursor' }]);
  });

  it('suggests nobody for people, including their older writes through a key (BAT-6)', () => {
    expect(
      threadAgents([
        { author: ethan, via: { keyId: 'k1', keyName: 'MSI', agentName: 'Claude' } },
        { author: caden, via: null },
        { author: null, via: { keyId: 'k4', keyName: 'Old key', agentName: 'Claude' } },
      ]),
    ).toEqual([]);
  });
});
