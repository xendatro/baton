import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { createQueryClient } from '@web/lib/queryClient';

/**
 * Test harness for the settings pages (imported by their *.test.tsx files only): the page at
 * `path` inside a memory router, a fresh query client and a toaster, so tests can assert toasts
 * and navigation.
 */
export function renderSettingsPage(
  element: ReactElement,
  options: { path?: string; initialEntry?: string } = {},
) {
  const path = options.path ?? '/settings/page';
  const router = createMemoryRouter(
    [
      { path, element },
      { path: '/login', element: <h1>Log in</h1> },
      { path: '*', element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: [options.initialEntry ?? path] },
  );
  const queryClient = createQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}

/** Parses the JSON body of a mocked `fetch` call. */
export function jsonBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

/** The URL a mocked `fetch` was called with, as a string. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
