import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GithubReadme as GithubReadmeData } from '@shared/schemas/github';
import type { Project } from '@shared/schemas/projects';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { mockApi, testMe } from '@web/test/mockApi';
import { GithubReadme } from './GithubReadme';

afterEach(() => {
  vi.unstubAllGlobals();
});

const tree = [
  { path: 'docs/README.md', name: 'README.md' },
  { path: 'docs/guide/start.md', name: 'start.md' },
];

function readmeOf(path: string, content: string): GithubReadmeData {
  return {
    repo: 'acme/docs',
    ref: 'main',
    htmlUrl: 'https://github.com/acme/docs/tree/main/docs',
    tree,
    doc: { path, content, htmlUrl: `https://github.com/acme/docs/blob/main/${path}` },
    truncated: false,
  };
}

const project = {
  id: 'p1',
  teamId: 't1',
  readmeSource: {
    kind: 'github',
    installationId: 'i1',
    repo: 'acme/docs',
    ref: null,
    type: 'folder',
    path: 'docs',
    entry: null,
  },
} as unknown as Project;

describe('GithubReadme', () => {
  it('shows the folder as a tree and keeps relative links and images inside it', async () => {
    const user = userEvent.setup();
    mockApi({
      '/api/me': testMe(),
      '/api/projects/p1/readme/github': ({ url }: { url: URL }) => {
        const path = url.searchParams.get('path');
        return new Response(
          JSON.stringify(
            path === 'docs/guide/start.md'
              ? readmeOf(path, '# Start here')
              : readmeOf(
                  'docs/README.md',
                  '# Docs\n\nRead [the guide](guide/start.md), the [code](../src/app.ts).\n\n![Logo](img/logo.png)',
                ),
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/t/acme/p/DOC']}>
            <GithubReadme project={project} canEdit onChangeSource={() => undefined} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const pages = await screen.findByRole('navigation', { name: 'README pages' });
    expect(within(pages).getByRole('link', { name: 'README' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(pages).getByRole('button', { name: 'guide' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await screen.findByRole('link', { name: 'the guide' })).toHaveAttribute(
      'href',
      '/t/acme/p/DOC?doc=docs%2Fguide%2Fstart.md',
    );
    expect(screen.getByRole('link', { name: 'code' })).toHaveAttribute(
      'href',
      'https://github.com/acme/docs/blob/main/src/app.ts',
    );
    expect(screen.getByRole('button', { name: 'Open image: Logo' })).toHaveAttribute(
      'src',
      '/api/projects/p1/readme/github/image?path=docs%2Fimg%2Flogo.png',
    );

    await user.click(screen.getByRole('link', { name: 'the guide' }));
    expect(await screen.findByText('Start here')).toBeInTheDocument();
    expect(within(pages).getByRole('link', { name: 'start' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
