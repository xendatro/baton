import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UserSummary } from '@shared/schemas/core';
import { ActorAvatar } from './AgentAvatar';
import { UserAvatar } from './UserAvatar';
import { UserName } from './UserName';

const ethan: UserSummary = { id: 'u1', username: 'ethan', name: 'Ethan', image: null };
const ethanAi: UserSummary = {
  id: 'a1',
  username: 'ethan-ai',
  name: 'Ethan AI',
  image: null,
  kind: 'agent',
  agentOwner: ethan,
};
const viaClaude = { keyId: 'k1', keyName: 'MSI', agentName: 'Claude' };

describe('agent members (agents A)', () => {
  it('names an agent author with an AI badge and the key it used in the tooltip', () => {
    const { container } = render(<UserName user={ethanAi} via={viaClaude} avatar="md" />);
    const root = container.firstElementChild!;
    expect(root).toHaveTextContent('Ethan AIAI');
    expect(root).not.toHaveTextContent('via');
    expect(root).toHaveAttribute('title', 'Ethan’s agent · via Claude (MSI key)');
    expect(screen.getByText('AI', { selector: '[data-agent-badge]' })).toBeInTheDocument();
    // The harness's logo, with the owner's picture as the badge.
    const avatar = container.querySelector('[data-agent-member]')!;
    expect(avatar.querySelector('[data-agent-logo="Claude"]')).not.toBeNull();
    expect(avatar).toHaveTextContent('E');
    expect(avatar).toHaveAttribute('title', 'Ethan’s agent · via Claude (MSI key)');
  });

  it('shows the generic agent mark and just the owner when the key is unknown', () => {
    const { container } = render(<UserName user={ethanAi} avatar="md" />);
    expect(container.firstElementChild).toHaveAttribute('title', 'Ethan’s agent');
    expect(container.querySelector('[data-agent-logo="generic"]')).not.toBeNull();
    expect(container.querySelector('svg.lucide-bot')).not.toBeNull();
  });

  it('ActorAvatar: harness logo for agents, owner badge, generic mark without a harness', () => {
    const withVia = render(<ActorAvatar user={ethanAi} agentName="Codex" keyName="Laptop" />);
    expect(withVia.container.querySelector('[data-agent-logo="OpenAI"]')).not.toBeNull();
    expect(withVia.container.firstElementChild).toHaveAttribute(
      'title',
      'Ethan’s agent · via Codex (Laptop key)',
    );
    const bare = render(<ActorAvatar user={ethanAi} />);
    expect(bare.container.querySelector('[data-agent-logo="generic"]')).not.toBeNull();
    expect(bare.container.firstElementChild).toHaveAttribute('title', 'Ethan’s agent');
  });

  it('marks agents wherever an avatar shows, e.g. pickers', () => {
    const { container } = render(<UserAvatar user={ethanAi} size="sm" />);
    expect(container.querySelector('[data-agent-member]')).toHaveAttribute(
      'title',
      'Ethan AI (Ethan’s agent)',
    );
  });

  it('keeps older writes by a person through a key as "Claude via Ethan’s MSI" (BAT-6)', () => {
    const { container } = render(<UserName user={ethan} via={viaClaude} avatar="md" />);
    expect(container.firstElementChild).toHaveTextContent('EClaudeviaEthan’s MSI');
    expect(container.querySelector('[data-agent-badge]')).toBeNull();
    expect(container.querySelector('[data-agent-member]')).toBeNull();
    expect(container.querySelector('[title="Claude via Ethan"]')).not.toBeNull();
  });

  it('keeps people without a key unchanged', () => {
    const { container } = render(<UserName user={ethan} />);
    expect(container.firstElementChild).toHaveTextContent(/^Ethan$/);
    expect(container.querySelector('[data-agent-badge]')).toBeNull();
  });
});
