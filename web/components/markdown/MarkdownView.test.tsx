import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@web/lib/queryKeys';
import { MarkdownView } from './MarkdownView';

function renderMarkdown(markdown: string, teamId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(queryKeys.teams.mentionLookup('team1', 'alice|design'), {
    users: [{ id: 'u1', username: 'alice', name: 'Alice Doe', image: null }],
    roles: [{ id: 'r1', slug: 'design', name: 'Design', color: '#ec4899' }],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<MarkdownView markdown={markdown} teamId={teamId} />, { wrapper });
}

describe('MarkdownView sanitization', () => {
  it('never renders raw HTML: scripts and event handlers are stripped', () => {
    const { container } = renderMarkdown(
      'Hello <script>window.pwned = true</script> <img src="x" onerror="alert(1)"> <b onclick="x()">bold</b>\n\n<iframe src="https://evil.example"></iframe>',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it('drops javascript: links and data: images', () => {
    const { container } = renderMarkdown(
      '[click](javascript:alert(1)) ![x](data:image/svg+xml;base64,PHN2Zz4=)',
    );
    const link = screen.getByText('click').closest('a');
    expect(link?.getAttribute('href') ?? '').not.toMatch(/javascript/i);
    for (const image of container.querySelectorAll('img')) {
      expect(image.getAttribute('src') ?? '').not.toMatch(/^data:/);
    }
  });
});

describe('MarkdownView rendering', () => {
  it('renders headings below the page’s h1 and section h2s, keeping their look (UX-15)', () => {
    renderMarkdown(
      ['# Web App', '## Setup', '### Details', '#### Deep', '###### Deepest'].join('\n\n'),
    );
    const levels = screen
      .getAllByRole('heading')
      .map((heading) => [heading.textContent, heading.tagName, heading.className]);
    expect(levels).toEqual([
      ['Web App', 'H3', 'md-h1'],
      ['Setup', 'H4', 'md-h2'],
      ['Details', 'H5', 'md-h3'],
      ['Deep', 'H6', 'md-h4'],
      ['Deepest', 'H6', 'md-h6'],
    ]);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('opens external links in a new tab without an opener', () => {
    renderMarkdown('[docs](https://example.com) and [board](/t/acme/p/WEB/tasks)');
    const external = screen.getByRole('link', { name: 'docs' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    const internal = screen.getByRole('link', { name: 'board' });
    expect(internal).toHaveAttribute('href', '/t/acme/p/WEB/tasks');
    expect(internal).not.toHaveAttribute('target');
  });

  it('renders read-only task checkboxes', () => {
    renderMarkdown('- [x] done\n- [ ] todo');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    for (const box of boxes) expect(box).toBeDisabled();
  });

  it('renders mentions as chips resolved against the team', () => {
    const { container } = renderMarkdown('Hi @alice, @&design and @everyone', 'team1');
    expect(container.querySelector('.mention')?.textContent).toBe('@alice');
    expect(screen.getByTitle('Role: Design')).toHaveTextContent('@Design');
    expect(screen.getByTitle('Role: everyone')).toHaveTextContent('@everyone');
  });

  // Regression (WEB-11): ids were prefixed twice, so footnote links pointed nowhere.
  it('links footnote references and back-references to their targets', () => {
    const { container } = renderMarkdown('Text[^1]\n\n[^1]: Note');
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      const target = decodeURIComponent(link.getAttribute('href') ?? '').slice(1);
      expect(container.querySelector(`[id="${target}"]`), target).not.toBeNull();
    }
  });

  it('leaves mentions in code and emails alone', () => {
    const { container } = renderMarkdown('`@alice` and bob@example.com');
    expect(container.querySelector('.mention')).toBeNull();
  });

  it('highlights fenced code with a known language', () => {
    const { container } = renderMarkdown('```ts\nconst a = 1;\n```');
    expect(container.querySelector('code.hljs, code.language-ts')).not.toBeNull();
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });
});
