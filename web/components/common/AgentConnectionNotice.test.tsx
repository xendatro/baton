import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatonDesktopBridge, DesktopState } from '@shared/desktopBridge';
import type { AgentConnection } from '@shared/schemas/agentRunner';
import { ReplyComposer } from '@web/components/replies/ReplyComposer';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { queryKeys } from '@web/lib/queryKeys';
import { writeReplyDraft } from '@web/lib/replyDrafts';
import { mockApi, testMe, testSession } from '@web/test/mockApi';
import { AgentConnectionNotice, AgentConnectionStatus } from './AgentConnectionNotice';

/** "Your agent isn't connected to this project" with Connect now (desktop and browser). */

function connection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    agent: { id: 'a1', username: 'ada-ai', name: 'Ada AI' },
    project: { id: 'p1', ref: 'acme/WEB', name: 'Web app', repoUrl: 'https://github.com/a/web' },
    paused: false,
    pausedReason: null,
    pausedBy: null,
    agentCanView: true,
    covered: false,
    runners: [],
    listening: false,
    pendingJobs: 2,
    ...overrides,
  };
}

const desktopState: DesktopState = {
  version: '0.4.0',
  connected: true,
  machineName: 'MSI',
  pausedHere: false,
  folders: {},
  permissionModes: {},
  runner: null,
};

function mockBridge(state: DesktopState = desktopState) {
  const bridge = {
    state: vi.fn(() => Promise.resolve(state)),
    connect: vi.fn(() => Promise.resolve(state)),
    disconnect: vi.fn(() => Promise.resolve(state)),
    harnesses: vi.fn(() => Promise.resolve([])),
    pickFolder: vi.fn(() => Promise.resolve({ state: 'match' as const, remote: 'x' })),
    useScratch: vi.fn(() => Promise.resolve(state)),
    unmap: vi.fn(() => Promise.resolve(state)),
    checkRepo: vi.fn(() => Promise.resolve(null)),
    setPermissionMode: vi.fn(() => Promise.resolve(state)),
    testRun: vi.fn(() => Promise.resolve({ ok: true, outcome: 'done', output: '' })),
    kill: vi.fn(() => Promise.resolve()),
    pauseHere: vi.fn(() => Promise.resolve(state)),
    setMachineName: vi.fn(() => Promise.resolve(state)),
    onState: vi.fn(() => () => undefined),
    onOutput: vi.fn(() => () => undefined),
  } satisfies BatonDesktopBridge;
  window.batonDesktop = bridge;
  return bridge;
}

function renderWith(node: ReactNode) {
  const client = createQueryClient();
  client.setQueryData(queryKeys.session(), testSession);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Ada, who may reply in acme/WEB. */
function me() {
  const value = testMe();
  return { ...value, teams: value.teams.map((team) => ({ ...team, permissions: ['REPLY'] })) };
}

afterEach(() => {
  delete window.batonDesktop;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('AgentConnectionNotice', () => {
  it('in a browser, Connect now explains the desktop app and the MCP listener', async () => {
    const user = userEvent.setup();
    mockApi({ '/api/projects/p1/agent-connection': connection() });
    renderWith(<AgentConnectionNotice projectId="p1" />);
    const notice = await screen.findByTestId('agent-connection-notice');
    expect(notice).toHaveTextContent('Your agent isn’t connected to Web app');
    expect(notice).toHaveTextContent('2 jobs waiting for your agent.');
    await user.click(screen.getByRole('button', { name: 'Connect now' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This computer → Folders');
    expect(dialog).toHaveTextContent('start_listener { projects: ["acme/WEB"] }');
    expect(screen.getByRole('link', { name: /Get the desktop app/ })).toHaveAttribute(
      'href',
      '/download',
    );
  });

  it('in the desktop app, Connect now opens the folder picker; No folder uses scratch', async () => {
    const user = userEvent.setup();
    const bridge = mockBridge();
    mockApi({
      '/api/projects/p1/agent-connection': connection({
        runners: [{ id: 'r1', machineName: 'Laptop', online: true, coversProject: false }],
      }),
    });
    renderWith(<AgentConnectionNotice projectId="p1" />);
    expect(await screen.findByTestId('agent-connection-notice')).toHaveTextContent(
      'Baton on Laptop doesn’t take this project’s jobs yet.',
    );
    await user.click(screen.getByRole('button', { name: 'Connect now' }));
    await waitFor(() =>
      expect(bridge.pickFolder).toHaveBeenCalledWith(
        'p1',
        'acme/WEB — Web app',
        'https://github.com/a/web',
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'No folder' }));
    await waitFor(() => expect(bridge.useScratch).toHaveBeenCalledWith('p1', 'acme/WEB — Web app'));
  });

  it('shows nothing when covered, or when the placement says it doesn’t matter', async () => {
    const fetchMock = mockApi({
      '/api/projects/p1/agent-connection': connection({ covered: true }),
    });
    renderWith(
      <>
        <AgentConnectionNotice projectId="p1" />
        <AgentConnectionNotice projectId="p1" when={() => false} />
      </>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('agent-connection-notice')).not.toBeInTheDocument();
  });

  it('offers Resume when you paused your agent', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      '/api/projects/p1/agent-connection': connection({
        paused: true,
        pausedBy: 'owner',
        pausedReason: 'Ada paused this agent.',
      }),
      'PATCH /api/me/agent': { ok: true },
    });
    renderWith(<AgentConnectionNotice projectId="p1" />);
    expect(await screen.findByTestId('agent-connection-notice')).toHaveTextContent(
      'Your agent is paused',
    );
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/me/agent'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });

  it('the settings section says where it runs when connected', async () => {
    mockApi({
      '/api/projects/p1/agent-connection': connection({
        covered: true,
        pendingJobs: 0,
        runners: [{ id: 'r1', machineName: 'MSI', online: true, coversProject: true }],
      }),
    });
    renderWith(<AgentConnectionStatus projectId="p1" />);
    expect(await screen.findByTestId('agent-connection-ok')).toHaveTextContent(
      'Connected: your agent’s jobs here run on Baton on MSI.',
    );
  });
});

describe('ReplyComposer', () => {
  it('warns before sending when the reply mentions your unconnected agent', async () => {
    writeReplyDraft('u1', 'task', 'task1', { body: 'Please look @ada-ai', attachments: [] });
    mockApi({
      '/api/me': me(),
      '/api/tasks/task1/replies': { items: [], nextCursor: null },
      '/api/projects/p1/agent-connection': connection({ pendingJobs: 0 }),
    });
    renderWith(<ReplyComposer parentType="task" parentId="task1" teamId="t1" projectId="p1" />);
    expect(await screen.findByTestId('agent-connection-notice')).toHaveTextContent(
      'Your agent isn’t connected to Web app — AI jobs here won’t run.',
    );
    expect(screen.getByRole('button', { name: 'Connect now' })).toBeInTheDocument();
  });

  it('says nothing without a mention of your agent', async () => {
    writeReplyDraft('u1', 'task', 'task1', { body: 'Please look @bob', attachments: [] });
    const fetchMock = mockApi({
      '/api/me': me(),
      '/api/projects/p1/agent-connection': connection(),
    });
    renderWith(<ReplyComposer parentType="task" parentId="task1" teamId="t1" projectId="p1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('agent-connection-notice')).not.toBeInTheDocument();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('agent-connection');
  });
});
