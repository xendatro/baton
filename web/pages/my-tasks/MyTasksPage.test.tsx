import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@shared/schemas/core';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import MyTasksPage from './MyTasksPage';
import { myTask, renderWorkPage, requestUrl } from './testing';

afterEach(() => {
  vi.unstubAllGlobals();
});

const backend = { id: 'r1', slug: 'backend', name: 'Backend', color: '#3b82f6' };
const api = { id: 'p2', key: 'API', name: 'API', icon: null, color: '#22c55e' };

function meWithTwoProjects(): MeResponse {
  const me = testMe();
  return {
    ...me,
    teams: me.teams.map((team) => ({ ...team, projects: [...team.projects, api] })),
  };
}

const tasks = [
  myTask({ id: 'a', title: 'Fix login', priority: 4, dueDate: '2020-01-01' }),
  myTask({
    id: 'b',
    ref: 'API-3',
    number: 3,
    title: 'Rate limits',
    project: api,
    projectId: 'p2',
    url: '/t/acme/p/API/tasks/3',
    assignment: { direct: false, roles: [backend] },
    blocked: true,
  }),
];

function taskCalls(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls
    .map(([input]) => requestUrl(input))
    .filter((url) => url.startsWith('/api/me/tasks'));
}

describe('MyTasksPage', () => {
  it('groups my tasks by team and project with why each is mine', async () => {
    mockApi({
      '/api/me': meWithTwoProjects(),
      '/api/me/tasks': { items: tasks, total: 2 },
    });
    renderWorkPage(<MyTasksPage />, '/my-tasks');

    expect(await screen.findByText('2 assigned tasks')).toBeInTheDocument();
    const team = screen.getByRole('region', { name: 'Acme' });
    const projects = within(team).getAllByRole('heading', { level: 3 });
    expect(projects.map((heading) => heading.textContent)).toEqual(['API', 'Web app']);

    const rateLimits = screen.getByRole('link', { name: /Rate limits/ });
    expect(rateLimits).toHaveAttribute('href', '/t/acme/p/API/tasks/3');
    expect(rateLimits).toHaveTextContent('via Backend');
    expect(rateLimits).toHaveTextContent('Blocked');
    expect(screen.getByRole('link', { name: /Fix login/ })).toHaveTextContent('(overdue)');
  });

  it('names each status in text on wide screens, not only by icon color (UX-10)', async () => {
    mockApi({
      '/api/me': meWithTwoProjects(),
      '/api/me/tasks': { items: tasks, total: 2 },
    });
    renderWorkPage(<MyTasksPage />, '/my-tasks');
    const row = await screen.findByRole('link', { name: /Fix login/ });
    // A visible (not screen-reader-only) status name in the row's wide-screen layout.
    const names = within(row)
      .getAllByText('Todo')
      .filter((element) => !element.classList.contains('sr-only'))
      .map((element) => element.closest('[class*="sm:inline-flex"]'));
    expect(names.some((element) => element !== null)).toBe(true);
  });

  it('reads filters from the URL and sends them to the API', async () => {
    const fetchMock = mockApi({
      '/api/me': meWithTwoProjects(),
      '/api/me/tasks': { items: [tasks[0]], total: 1 },
    });
    renderWorkPage(
      <MyTasksPage />,
      '/my-tasks',
      '/my-tasks?project=acme/WEB&due=overdue&priority=urgent&sort=due',
    );
    await screen.findByText('1 assigned task');
    const [url] = taskCalls(fetchMock);
    expect(url).toContain('teamId=t1');
    expect(url).toContain('projectId=p1');
    expect(url).toContain('due=overdue');
    expect(url).toContain('priority=urgent');
    expect(url).toContain('sort=due');
    expect(url).toMatch(/today=\d{4}-\d{2}-\d{2}/);
    expect(screen.getByRole('button', { name: 'Due: Overdue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Priority: Urgent' })).toBeInTheDocument();
  });

  it('searches as you type and clears filters', async () => {
    const fetchMock = mockApi({
      '/api/me': meWithTwoProjects(),
      '/api/me/tasks': ({ url }: { url: URL }) =>
        jsonResponse(
          url.searchParams.get('q')
            ? { items: [], total: 0 }
            : { items: tasks, total: tasks.length },
        ),
    });
    const user = userEvent.setup();
    const { router } = renderWorkPage(<MyTasksPage />, '/my-tasks');
    await screen.findByText('2 assigned tasks');

    await user.type(screen.getByRole('searchbox', { name: 'Search my tasks' }), 'nothing');
    expect(await screen.findByText('No tasks match these filters')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?q=nothing');
    expect(taskCalls(fetchMock).some((url) => url.includes('q=nothing'))).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('2 assigned tasks')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: 'Search my tasks' })).toHaveValue(''),
    );
    expect(router.state.location.search).toBe('');
  });

  it('says when nothing is assigned, and when a filtered project is unknown', async () => {
    mockApi({ '/api/me': testMe(), '/api/me/tasks': { items: [], total: 0 } });
    renderWorkPage(<MyTasksPage />, '/my-tasks', '/my-tasks?project=acme/NOPE');
    expect(await screen.findByText('That team or project isn’t available')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Nothing assigned to you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Web app board' })).toHaveAttribute(
      'href',
      '/t/acme/p/WEB/tasks',
    );
  });
});
