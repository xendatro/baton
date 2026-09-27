import { render } from '@testing-library/react';
import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siWindsurf } from 'simple-icons';
import { describe, expect, it } from 'vitest';
import { agentNameFromClient } from '@shared/agents';
import { ActorAvatar, AgentMark } from './AgentAvatar';
import { OPENAI_BLOSSOM } from './openaiLogo';

function mark(agentName: string) {
  const { container } = render(<AgentMark agentName={agentName} />);
  return container.querySelector<HTMLElement>('[data-agent-logo]')!;
}

describe('AgentMark (BAT-8)', () => {
  it.each([
    ['claude-code', siClaude],
    ['codex-mcp-client', OPENAI_BLOSSOM],
    ['cursor-vscode', siCursor],
    ['gemini-cli', siGooglegemini],
    ['GitHub Copilot', siGithubcopilot],
    ['windsurf-client', siWindsurf],
  ])('shows the official logo of %s', (client, logo) => {
    const element = mark(agentNameFromClient({ name: client })!);
    expect(element).toHaveAttribute('data-agent-logo', logo.title);
    expect(element.querySelector('path')).toHaveAttribute('d', logo.path);
    expect([`#${logo.hex.toLowerCase()}`, hexToRgb(logo.hex)]).toContain(
      element.style.backgroundColor.toLowerCase(),
    );
  });

  it('keeps the generic bot for agents it doesn’t know', () => {
    for (const name of ['My Script', 'constructor', 'toString']) {
      const element = mark(name);
      expect(element).toHaveAttribute('data-agent-logo', 'generic');
      expect(element.querySelector('svg.lucide-bot')).not.toBeNull();
    }
  });

  it('keeps the owner’s picture as the badge', () => {
    const { container } = render(
      <ActorAvatar
        user={{ id: 'u1', username: 'ethan', name: 'Ethan', image: null }}
        agentName="Claude"
      />,
    );
    expect(container.querySelector('[data-agent-logo="Claude"]')).not.toBeNull();
    expect(container.firstElementChild).toHaveAttribute('title', 'Claude via Ethan');
    expect(container.textContent).toContain('E');
  });
});

function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex, 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}
