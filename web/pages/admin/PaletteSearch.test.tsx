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
});
