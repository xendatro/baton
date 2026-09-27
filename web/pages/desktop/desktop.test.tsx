import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatonDesktopBridge, DesktopState } from '@shared/desktopBridge';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import DesktopAgentsPage from './DesktopAgentsPage';
import DesktopFoldersPage from './DesktopFoldersPage';
import DesktopSetupPage from './DesktopSetupPage';

/** The desktop app's pages inside the web app (BAT-26), with a mocked `window.batonDesktop`. */

const baseState: DesktopState = {
  version: '0.1.0',
  connected: true,
  machineName: 'MSI',
  pausedHere: false,
  folders: {},
  permissionModes: {},
  runner: {
    status: 'online',
    statusText: null,
    runnerId: 'r1',
    waitingCount: 0,
    jobs: [
      {
        jobId: 'job-1',
        ref: 'baton/BAT-24',
        title: 'Desktop app',
        url: 'https://baton/t/baton/p/BAT/tasks/24',
        project: 'baton/BAT',
        kind: 'mention',
        harness: 'claude',
        model: 'opus',
        startedAt: Date.now() - 65_000,
        state: 'running',
        note: null,
        output: ['Reading the task', '→ Bash'],
      },
    ],
  },
};

function mockBridge(state: DesktopState = baseState) {
  const bridge = {
    state: vi.fn(() => Promise.resolve(state)),
    connect: vi.fn(() => Promise.resolve({ ...state, connected: true })),
    disconnect: vi.fn(() => Promise.resolve(state)),
    harnesses: vi.fn(() => Promise.resolve([])),
    pickFolder: vi.fn(() =>
      Promise.resolve({ state: 'match' as const, remote: 'git@github.com:x/y' }),
    ),
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

function renderPage(page: ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipProvider>
        <MemoryRouter>{page}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  delete window.batonDesktop;
  vi.unstubAllGlobals();
});

describe('desktop pages', () => {
  it('outside the desktop app, point to the download', () => {
    mockApi({ '/api/me': testMe() });
    renderPage(<DesktopAgentsPage />);
    expect(screen.getByText('This page is part of the desktop app')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get the desktop app/ })).toHaveAttribute(
      'href',
      '/download',
    );
  });

  it('show running agents with their output, and Kill', async () => {
    const user = userEvent.setup();
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent': {
        agent: { id: 'a', username: 'ada-ai', name: 'Ada AI', image: null },
        pausedAt: null,
        notifications: 'needs_me',
      },
    });
    const bridge = mockBridge();
    renderPage(<DesktopAgentsPage />);
    const job = await screen.findByRole('listitem', { name: /baton\/BAT-24 Desktop app/ });
    expect(job).toHaveTextContent('Claude Code · opus');
    expect(screen.getByLabelText('Live output')).toHaveTextContent('Reading the task');
    await user.click(screen.getByRole('button', { name: 'Kill' }));
    expect(bridge.kill).toHaveBeenCalledWith('job-1');
    await user.click(screen.getByRole('switch', { name: 'Pause on this computer' }));
    expect(bridge.pauseHere).toHaveBeenCalledWith(true);
  });

  it('set up this computer with a key made for it, signed in as you', async () => {
    const user = userEvent.setup();
    mockApi({
      '/api/me': testMe(),
      'POST /api/me/api-keys': () =>
        jsonResponse({
          key: 'bat_created',
          apiKey: {
            id: 'k1',
            name: 'Desktop · MSI',
            prefix: 'bat_cre',
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
        }),
    });
    const bridge = mockBridge({ ...baseState, connected: false, runner: null });
    renderPage(<DesktopSetupPage />);
    await user.click(await screen.findByRole('button', { name: 'Run my agent here' }));
    await waitFor(() => expect(bridge.connect).toHaveBeenCalledWith('bat_created'));
  });

  it('map a project to a folder, with the repository check', async () => {
    const user = userEvent.setup();
    const me = testMe();
    mockApi({
      '/api/me': me,
      [`/api/projects/${me.teams[0]?.projects[0]?.id ?? ''}`]: {
        repoUrl: 'https://github.com/x/y',
      },
    });
    const bridge = mockBridge();
    renderPage(<DesktopFoldersPage />);
    await user.click(
      (await screen.findAllByRole('button', { name: 'Choose folder' }))[0] as HTMLElement,
    );
    await waitFor(() => expect(bridge.pickFolder).toHaveBeenCalled());
    expect(bridge.pickFolder).toHaveBeenCalledWith(
      'p1',
      expect.any(String),
      'https://github.com/x/y',
    );
  });
});
