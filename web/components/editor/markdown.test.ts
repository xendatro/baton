import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from './extensions';
import { normalizeMarkdown } from './markdown';

const editors: Editor[] = [];

function createEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({ slashCommands: false }),
    content: markdown,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

/** Markdown → editor document → markdown, as RichTextEditor emits it. */
function roundTrip(markdown: string): string {
  return normalizeMarkdown(createEditor(markdown).getMarkdown());
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe('editor markdown round-trip', () => {
  it.each([
    ['headings', '# Title\n\n## Section\n\n### Detail'],
    ['inline marks', 'Some **bold**, *italic*, ~~strike~~ and `code`.'],
    ['bullet list with nesting', '- one\n- two\n  - nested'],
    ['ordered list', '1. one\n2. two'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['code block with language', '```ts\nconst a = 1;\n```'],
    ['code block keeps markdown-looking text', '```\n**not bold** @alice [x](y)\n```'],
    ['link', 'See [the docs](https://example.com/docs).'],
    ['bare url', 'Visit https://example.com today.'],
    ['email', 'Mail bob@example.com please.'],
    ['image', '![shot](/api/attachments/01H/shot.png)'],
    ['user, role and everyone mentions', 'Hi @alice and @&design-team, also @everyone.'],
    ['blockquote', '> quoted'],
    ['horizontal rule', 'above\n\n---\n\nbelow'],
  ])('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('writes tables in a canonical GFM form and keeps them stable', () => {
    const once = roundTrip('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(once).toBe('| A   | B   |\n| --- | --- |\n| 1   | 2   |');
    expect(roundTrip(once)).toBe(once);
  });

  it('parses mentions into chips with kind and id', () => {
    const doc: JSONContent = createEditor('Ping @Alice and @&design').getJSON();
    const inline: JSONContent[] = doc.content?.[0]?.content ?? [];
    const mentions = inline.filter((node) => node.type === 'mention');
    expect(mentions.map((node) => node.attrs)).toEqual([
      expect.objectContaining({ id: 'alice', kind: 'user' }),
      expect.objectContaining({ id: 'design', kind: 'role' }),
    ]);
  });

  it('does not treat emails or code as mentions', () => {
    const doc = createEditor('mail bob@example.com and `@alice`').getJSON();
    const types = JSON.stringify(doc);
    expect(types).not.toContain('"mention"');
  });
});

describe('normalizeMarkdown', () => {
  it('collapses autolinks outside code and trims blank lines', () => {
    expect(
      normalizeMarkdown(
        '\n[https://a.io](https://a.io) [bob@x.io](mailto:bob@x.io) `[https://a.io](https://a.io)`\n',
      ),
    ).toBe('https://a.io bob@x.io `[https://a.io](https://a.io)`');
  });

  it('keeps links whose text differs from the target, and fenced code', () => {
    const markdown = '[docs](https://a.io)\n\n```\n[https://a.io](https://a.io)\n```';
    expect(normalizeMarkdown(markdown)).toBe(markdown);
  });
});
