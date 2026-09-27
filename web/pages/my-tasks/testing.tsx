import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { Toaster } from 'sonner';
import type { MyTask } from '@shared/schemas/work';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';

/**
 * Test data and a harness for the work module's web tests (dashboard, My tasks, inbox); imported
 * by *.test.tsx files only.
 */

/**
 * Renders `element` at `initialEntry` (matching `path`, with optional child routes) in a memory
 * router with a toaster, inside the app's tooltip provider.
 */
export function renderWorkPage(
  element: ReactElement,
  path: string,
  initialEntry = path,
  children?: RouteObject[],
) {
  const router = createMemoryRouter(
    [
      { path, element, ...(children ? { children } : {}) },
      { path: '*', element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: [initialEntry] },
  );
  const queryClient = createQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}

/** The URL a mocked `fetch` was called with, as a string. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** A task on the viewer's list (WEB-1 in Acme, assigned to them by name). */
export function myTask(overrides: Partial<MyTask> = {}): MyTask {
  return {
    id: 'task1',
    ref: 'WEB-1',
    number: 1,
    title: 'Fix login',
    projectId: 'p1',
    teamId: 't1',
    status: { id: 's1', name: 'Todo', color: '#6b7280', icon: 'circle' },
    priority: 2,
    dueDate: null,
    labels: [],
    assignees: { users: [], roles: [] },
    claim: null,
    blocked: false,
    replyCount: 0,
    updatedAt: '2026-03-01T10:00:00.000Z',
    team: { id: 't1', slug: 'acme', name: 'Acme', icon: null, color: '#6366f1' },
    project: { id: 'p1', key: 'WEB', name: 'Web app', icon: null, color: '#0ea5e9' },
    url: '/t/acme/p/WEB/tasks/1',
    assignment: { direct: true, roles: [] },
    ...overrides,
  };
}
