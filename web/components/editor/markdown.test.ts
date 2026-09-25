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

  // Regression (WEB-3): text was HTML-escaped and every *, _, [ and ~ was backslash-escaped.
  it.each([
    ['ampersands and comparisons', 'Tom & Jerry, R&D and a < b > c'],
    ['identifiers and arithmetic', 'user_id and file_name.ts, 2 * 3'],
    ['brackets that are not links', 'array[0] and map[key]'],
    ['backslashes', 'C:\\Users\\ethan'],
    ['markdown-looking text that must stay text', 'a \\*b\\* and \\_c\\_ and \\`d\\`'],
    ['an HTML-looking word', 'Use Array\\<string> here'],
    ['an escaped entity', 'write \\&copy; for ©'],
    [
      'escaped block markers',
      '1\\. not a list\n\n\\# not a heading\n\n\\- not a bullet\n\n\\> not a quote',
    ],
  ])('keeps %s natural', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('decodes entities instead of writing them out', () => {
    expect(roundTrip('x &copy; y &mdash; z &#8364;')).toBe('x © y — z €');
    expect(roundTrip('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(roundTrip('`&copy;` stays code')).toBe('`&copy;` stays code');
  });

  it('skips empty paragraphs instead of writing &nbsp;', () => {
    const editor = createEditor('Hello');
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Use Array<string> & R&D' }] },
        { type: 'paragraph' },
      ],
    });
    expect(normalizeMarkdown(editor.getMarkdown())).toBe('Use Array\\<string> & R&D');
  });

  // Regression (WEB-4): marks around mentions and links on mentions were dropped.
  it.each([
    ['bold mention', '**@alice** here'],
    ['italic around a mention', '*hi @alice*'],
    ['bold role mention', '**and role @&design**'],
    ['link whose text is a mention', '[@alice](https://example.com)'],
  ])('keeps the %s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(roundTrip(roundTrip(markdown))).toBe(markdown);
  });

  it('writes a bolded line with a mention as valid markdown', () => {
    const editor = createEditor('and role @&design');
    editor.commands.selectAll();
    editor.commands.toggleBold();
    expect(normalizeMarkdown(editor.getMarkdown())).toBe('**and role @&design**');
  });

  // Regression (WEB-8): raw HTML was dropped, footnotes turned into links.
  it.each([
    ['inline HTML', 'Press <kbd>Ctrl</kbd> + <kbd>K</kbd>'],
    ['an HTML comment', 'a <!-- note --> b'],
    ['an HTML block', '<details><summary>More</summary>\n\nhidden\n\n</details>'],
    ['footnotes', 'Text[^1] and more[^note].\n\n[^1]: Note\n\n[^note]: Another note'],
  ])('keeps %s verbatim', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(roundTrip(roundTrip(markdown))).toBe(markdown);
  });

  it('still reads <br> in table cells as line breaks', () => {
    const table = '| A        |\n| -------- |\n| x<br>y   |';
    const doc = JSON.stringify(createEditor(table).getJSON());
    expect(doc).toContain('"hardBreak"');
    expect(doc).not.toContain('rawInline');
  });

  // Regression (WEB-2): a pipe in a cell was written unescaped and broke the table.
  it('escapes pipes in table cells, in text and in code', () => {
    const once = roundTrip('| A | B |\n| --- | --- |\n| x\\|y | `a\\|b` |');
    expect(once).toBe('| A    | B      |\n| ---- | ------ |\n| x\\|y | `a\\|b` |');
    expect(roundTrip(once)).toBe(once);
    const cells = JSON.stringify(createEditor(once).getJSON());
    expect(cells).toContain('"text":"x|y"');
    expect(cells).toContain('"text":"a|b"');
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
