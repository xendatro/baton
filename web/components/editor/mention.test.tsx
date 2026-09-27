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

const claude: MentionAgent = { name: 'Claude', handle: 'claude', keys: ['Ethan’s MSI'] };
const cursor: MentionAgent = { name: 'Cursor', handle: 'cursor', keys: ['Caden’s laptop'] };

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function sourceHook(agents: readonly MentionAgent[]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  for (const q of ['', 'c']) {
    client.setQueryData(queryKeys.teams.mentionables('team1', q), {
      users: [{ id: 'u1', username: 'caden', name: 'Caden', image: null }],
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

describe('agent mentions (BAT-12)', () => {
  it('matches agents by handle or name', () => {
    expect(toAgentMentionItems([claude, cursor], '').map((item) => item.id)).toEqual([
      'claude',
      'cursor',
    ]);
    expect(toAgentMentionItems([claude, cursor], 'CLA')).toEqual([
      expect.objectContaining({ kind: 'user', id: 'claude', group: 'Agents', agent: claude }),
    ]);
    expect(toAgentMentionItems([claude], 'bob')).toEqual([]);
  });

  it('lists the thread’s agents above the team’s people', async () => {
    const { result } = sourceHook([claude]);
    const items = await result.current!('c', new AbortController().signal);
    expect(items.map((item) => `${item.group}:${item.id}`)).toEqual([
      'Agents:claude',
      'People:caden',
    ]);
  });

  it('picks up agents that arrive after the editor was built, without a new source', async () => {
    const { result, rerender } = sourceHook([]);
    const first = result.current;
    expect((await first!('', new AbortController().signal)).map((item) => item.id)).toEqual([
      'caden',
    ]);
    rerender({ list: [claude] });
    expect(result.current).toBe(first);
    expect((await first!('', new AbortController().signal)).map((item) => item.id)).toEqual([
      'claude',
      'caden',
    ]);
  });

  it('inserts a picked agent as plain @handle markdown', () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ slashCommands: false }),
      content: '',
      contentType: 'markdown',
    });
    editors.push(editor);
    const [item] = toAgentMentionItems([claude], 'cl') as [MentionItem];
    const end = editor.state.doc.content.size - 1;
    const suggestion = createMention(null).options.suggestion;
    suggestion.command?.({ editor, range: { from: end, to: end }, props: item });
    expect(normalizeMarkdown(editor.getMarkdown())).toBe('@claude');
    const doc: JSONContent = editor.getJSON();
    const mention = doc.content?.[0]?.content?.find((node) => node.type === 'mention');
    expect(mention?.attrs).toEqual(expect.objectContaining({ id: 'claude', kind: 'user' }));
  });
});
