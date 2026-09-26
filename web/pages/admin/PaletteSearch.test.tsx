import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchResponse } from '@shared/schemas/core';
import { CommandPalette } from '@web/components/palette/CommandPalette';
import { setPaletteOpen } from '@web/components/palette/registry';
import { createQueryClient } from '@web/lib/queryClient';
import { mockApi, testMe } from '@web/test/mockApi';
import PaletteSearch from './PaletteSearch';

afterEach(() => {
  setPaletteOpen(false);
  vi.unstubAllGlobals();
});

/** The URL a mocked `fetch` was called with. */
function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

const results: SearchResponse = {
  results: [
    {
      entityType: 'task',
      entityId: 'task1',
      teamId: 't1',
      projectId: 'p1',
      ref: 'WEB-12',
      title: 'Login crash on Safari',
      snippet: 'Safari crashes when the form submits',
      url: '/t/acme/p/WEB/tasks/12',
    },
    {
      entityType: 'issue',
      entityId: 'issue1',
      teamId: 't1',
      projectId: 'p1',
      ref: 'WEB#3',
      title: 'App crashes',
      snippet: 'It crashes on start',
      url: '/t/acme/p/WEB/issues/3',
    },
    {
      entityType: 'reply',
      entityId: 'reply1',
      teamId: 't1',
      projectId: 'p1',
      ref: 'WEB#3',
      title: 'App crashes',
      snippet: 'Still crashing for me',
      url: '/t/acme/p/WEB/issues/3#reply-reply1',
    },
  ],
};

describe('palette search', () => {
  it('groups results into Tasks, Issues and Replies from one request and opens replies at their anchor', async () => {
    const fetchMock = mockApi({ '/api/me': testMe(), '/api/search': results });
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <>
              <PaletteSearch />
              <CommandPalette />
            </>
          ),
        },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    setPaletteOpen(true);
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByPlaceholderText('Search or jump to…'), 'crash');

    const task = await within(palette).findByRole('option', { name: /Login crash on Safari/ });
    expect(task).toHaveTextContent('WEB-12');
    expect(task).toHaveTextContent('Web app');
    expect(within(task).getAllByText('crash', { selector: 'mark' }).length).toBeGreaterThan(0);
    expect(within(palette).queryByText('No results.')).toBeNull();
    for (const group of ['Tasks', 'Issues', 'Replies']) {
      expect(within(palette).getByText(group)).toBeInTheDocument();
    }
    const searches = fetchMock.mock.calls.filter(([input]) =>
      urlOf(input).startsWith('/api/search'),
    );
    expect(searches).toHaveLength(1);
    expect(urlOf(searches[0]?.[0] ?? '')).toContain('q=crash');

    // Highlight marks split the text, so match on text content rather than the accessible name.
    const reply = within(palette)
      .getAllByRole('option')
      .find((option) => option.textContent?.includes('Still crashing for me'));
    expect(reply).toBeDefined();
    await user.click(reply as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/acme/p/WEB/issues/3'));
    expect(router.state.location.hash).toBe('#reply-reply1');
  });

  describe('selects the first result once results arrive (UX-01)', () => {
    const boardResults: SearchResponse = {
      results: [
        {
          entityType: 'task',
          entityId: 'task14',
          teamId: 't1',
          projectId: 'p1',
          ref: 'WEB-14',
          title: 'Board columns overflow on small screens',
          snippet: 'The board scrolls',
          url: '/t/acme/p/WEB/tasks/14',
        },
        {
          entityType: 'issue',
          entityId: 'issue7',
          teamId: 't1',
          projectId: 'p1',
          ref: 'WEB#7',
          title: 'Board is slow',
          snippet: 'Dragging lags',
          url: '/t/acme/p/WEB/issues/7',
        },
      ],
    };

    function renderPalette(response: SearchResponse = boardResults) {
      mockApi({ '/api/me': testMe(), '/api/search': response });
      const router = createMemoryRouter(
        [
          {
            path: '*',
            element: (
              <>
                <PaletteSearch />
                <CommandPalette />
              </>
            ),
          },
        ],
        { initialEntries: ['/somewhere'] },
      );
      render(
        <QueryClientProvider client={createQueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      setPaletteOpen(true);
      return { router, user: userEvent.setup() };
    }

    it('moves the selection from a matching command to the first result, and Enter opens it', async () => {
      const { router, user } = renderPalette();
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      // "board" also matches the Dashboard command, which cmdk selects while the search runs.
      await user.type(within(palette).getByPlaceholderText('Search or jump to…'), 'board');
      const task = await within(palette).findByRole('option', { name: /Board columns overflow/ });
      await waitFor(() => expect(task).toHaveAttribute('aria-selected', 'true'));
      await user.keyboard('{Enter}');
      await waitFor(() => expect(router.state.location.pathname).toBe('/t/acme/p/WEB/tasks/14'));
    });

    it('selects a result when no command matches the query', async () => {
      const { router, user } = renderPalette();
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      await user.type(within(palette).getByPlaceholderText('Search or jump to…'), 'overflow');
      const task = await within(palette).findByRole('option', { name: /Board columns overflow/ });
      await waitFor(() => expect(task).toHaveAttribute('aria-selected', 'true'));
      await user.keyboard('{Enter}');
      await waitFor(() => expect(router.state.location.pathname).toBe('/t/acme/p/WEB/tasks/14'));
    });

    it('shows and selects the best-ranked group first, e.g. the issue a ref names (UX-04)', async () => {
      const [task, issue] = boardResults.results;
      const { router, user } = renderPalette({ results: [issue!, task!] });
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      await user.type(within(palette).getByPlaceholderText('Search or jump to…'), 'WEB#7');
      const option = await within(palette).findByRole('option', { name: /Board is slow/ });
      await waitFor(() => expect(option).toHaveAttribute('aria-selected', 'true'));
      const headings = within(palette)
        .getAllByText(/^(Tasks|Issues)$/)
        .map((heading) => heading.textContent);
      expect(headings).toEqual(['Issues', 'Tasks']);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(router.state.location.pathname).toBe('/t/acme/p/WEB/issues/7'));
    });

    it('keeps a command whose full name was typed selected over search results', async () => {
      const { router, user } = renderPalette();
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      await user.type(within(palette).getByPlaceholderText('Search or jump to…'), 'Dashboard');
      await within(palette).findByRole('option', { name: /Board columns overflow/ });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(within(palette).getByRole('option', { name: /^Dashboard/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await user.keyboard('{Enter}');
      await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    });

    it('keeps a selection the viewer moved with the arrow keys', async () => {
      const { user } = renderPalette();
      const palette = await screen.findByRole('dialog', { name: 'Command palette' });
      await user.type(within(palette).getByPlaceholderText('Search or jump to…'), 'board');
      const issue = await within(palette).findByRole('option', { name: /Board is slow/ });
      await waitFor(() =>
        expect(
          within(palette).getByRole('option', { name: /Board columns overflow/ }),
        ).toHaveAttribute('aria-selected', 'true'),
      );
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(issue).toHaveAttribute('aria-selected', 'true'));
      // A re-render with the same results must not move it back.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(issue).toHaveAttribute('aria-selected', 'true');
    });
  });
});
