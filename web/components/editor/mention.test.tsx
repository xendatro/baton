import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Editor, type JSONContent } from '@tiptap/core';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { queryKeys } from '@web/lib/queryKeys';
import { createEditorExtensions } from './extensions';
import { normalizeMarkdown } from './markdown';
import { createMention, toAgentMentionItems, type MentionAgent, type MentionItem } from './mention';
import { useMentionSource } from './useMentionSource';

const ethan = { id: 'u0', username: 'ethan', name: 'Ethan', image: null };
const caden = { id: 'u1', username: 'caden', name: 'Caden', image: null };
const ethanAi: MentionAgent = {
  user: {
    id: 'a0',
    username: 'ethan-ai',
    name: 'Ethan AI',
    image: null,
    kind: 'agent',
    agentOwner: ethan,
  },
  agentName: 'Claude',
};
const cadenAi: MentionAgent = {
  user: {
    id: 'a1',
    username: 'caden-ai',
    name: 'Caden AI',
    image: null,
    kind: 'agent',
    agentOwner: caden,
  },
  agentName: null,
};

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function sourceHook(agents: readonly MentionAgent[]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  for (const q of ['', 'c']) {
    // Agent members are team members: the team's list has them too.
    client.setQueryData(queryKeys.teams.mentionables('team1', q), {
      users: [caden, ethanAi.user, cadenAi.user],
      roles: [],
    });
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ list }) => useMentionSource('team1', list), {
    wrapper,
    initialProps: { list: agents },
  });
}

describe('agent mentions (BAT-12, agents A)', () => {
  it('matches agent members by username or name', () => {
    expect(toAgentMentionItems([ethanAi, cadenAi], '').map((item) => item.id)).toEqual([
      'ethan-ai',
      'caden-ai',
    ]);
    expect(toAgentMentionItems([ethanAi, cadenAi], 'ETHAN')).toEqual([
      expect.objectContaining({
        kind: 'user',
        id: 'ethan-ai',
        group: 'Agents',
        user: ethanAi.user,
        agent: ethanAi,
      }),
    ]);
    expect(toAgentMentionItems([ethanAi], 'bob')).toEqual([]);
  });

  it('lists the thread’s agents above the team’s people, and only there', async () => {
    const { result } = sourceHook([cadenAi]);
    const items = await result.current!('c', new AbortController().signal);
    expect(items.map((item) => `${item.group}:${item.id}`)).toEqual([
      'Agents:caden-ai',
      'People:caden',
      'People:ethan-ai',
    ]);
  });

  it('picks up agents that arrive after the editor was built, without a new source', async () => {
    const { result, rerender } = sourceHook([]);
    const first = result.current;
    expect((await first!('', new AbortController().signal)).map((item) => item.id)).toEqual([
      'caden',
      'ethan-ai',
      'caden-ai',
    ]);
    rerender({ list: [cadenAi] });
    expect(result.current).toBe(first);
    expect((await first!('', new AbortController().signal)).map((item) => item.id)).toEqual([
      'caden-ai',
      'caden',
      'ethan-ai',
    ]);
  });

  it('inserts a picked agent as a plain @username mention', () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ slashCommands: false }),
      content: '',
      contentType: 'markdown',
    });
    editors.push(editor);
    const [item] = toAgentMentionItems([ethanAi], 'eth') as [MentionItem];
    const end = editor.state.doc.content.size - 1;
    const suggestion = createMention(null).options.suggestion;
    suggestion.command?.({ editor, range: { from: end, to: end }, props: item });
    expect(normalizeMarkdown(editor.getMarkdown())).toBe('@ethan-ai');
    const doc: JSONContent = editor.getJSON();
    const mention = doc.content?.[0]?.content?.find((node) => node.type === 'mention');
    expect(mention?.attrs).toEqual(expect.objectContaining({ id: 'ethan-ai', kind: 'user' }));
    // …and reads back from markdown as the same single mention.
    const reread = new Editor({
      extensions: createEditorExtensions({ slashCommands: false }),
      content: 'hi @ethan-ai and @ethan-bob',
      contentType: 'markdown',
    });
    editors.push(reread);
    const rereadDoc: JSONContent = reread.getJSON();
    const ids = (rereadDoc.content?.[0]?.content ?? [])
      .filter((node) => node.type === 'mention')
      .map((node) => node.attrs?.id as string);
    expect(ids).toEqual(['ethan-ai', 'ethan']);
  });
});
