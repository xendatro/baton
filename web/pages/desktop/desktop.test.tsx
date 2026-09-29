import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatonDesktopBridge, DesktopJob, DesktopState } from '@shared/desktopBridge';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createQueryClient } from '@web/lib/queryClient';
import { jsonResponse, mockApi, testMe } from '@web/test/mockApi';
import { DesktopUpdateNotice } from '@web/components/layout/DesktopUpdateNotice';
import { DesktopVersionLine } from '@web/components/layout/DesktopVersionLine';
import { usageClock } from '@web/lib/desktop';
import DesktopAgentsPage from './DesktopAgentsPage';
import DesktopFoldersPage from './DesktopFoldersPage';
import DesktopHarnessesPage from './DesktopHarnessesPage';
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

const claudeHarness = {
  id: 'claude' as const,
  label: 'Claude Code',
  headless: 'claude -p',
  installed: true,
  path: '/usr/bin/claude',
  version: '2.0.0',
  models: [] as string[],
  modes: [{ id: 'default', label: 'Ask', description: 'Asks first', unattended: false }],
  mode: 'default',
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

  it('show a job waiting on usage with Retry now and Clear usage limit, and merged messages (BAT#30, BAT#31)', async () => {
    const user = userEvent.setup();
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent': {
        agent: { id: 'a', username: 'ada-ai', name: 'Ada AI', image: null },
        pausedAt: null,
        notifications: 'needs_me',
      },
    });
    const until = new Date();
    until.setHours(23, 30, 0, 0);
    const [running] = baseState.runner?.jobs ?? [];
    const bridge = mockBridge({
      ...baseState,
      runner: {
        ...(baseState.runner as NonNullable<DesktopState['runner']>),
        jobs: [
          {
            ...(running as DesktopJob),
            jobId: 'job-2',
            ref: 'baton/BAT-25',
            title: 'Waiting',
            state: 'waiting-usage',
            harness: null,
            waitingOn: [{ harness: 'codex', until: until.getTime() }],
          },
          { ...(running as DesktopJob), delivered: 1, queued: 1 },
        ],
      },
    });
    const retryNow = vi.fn(() => Promise.resolve());
    const clearUsageLimit = vi.fn(() => Promise.resolve(baseState));
    Object.assign(bridge, { retryNow, clearUsageLimit });
    renderPage(<DesktopAgentsPage />);
    const waiting = await screen.findByRole('listitem', { name: /baton\/BAT-25 Waiting/ });
    expect(within(waiting).getByLabelText('Waiting on usage')).toHaveTextContent(
      `Out of usage until ${usageClock(until.getTime())} (Codex)`,
    );
    await user.click(within(waiting).getByRole('button', { name: 'Retry now' }));
    expect(retryNow).toHaveBeenCalledWith('job-2');
    await user.click(within(waiting).getByRole('button', { name: 'Clear usage limit' }));
    expect(clearUsageLimit).toHaveBeenCalledWith('codex');
    const working = screen.getByRole('listitem', { name: /baton\/BAT-24 Desktop app/ });
    expect(working).toHaveTextContent('1 message delivered');
    expect(working).toHaveTextContent('1 message queued for next turn');
  });

  it('show a harness out of usage on the Harnesses page, with Clear usage limit', async () => {
    const user = userEvent.setup();
    mockApi({ '/api/me': testMe() });
    const bridge = mockBridge({
      ...baseState,
      exhaustedUntil: { claude: Date.now() + 3_600_000 },
    });
    const clearUsageLimit = vi.fn(() => Promise.resolve(baseState));
    Object.assign(bridge, { clearUsageLimit });
    bridge.harnesses.mockImplementation(() => Promise.resolve([claudeHarness]) as never);
    renderPage(<DesktopHarnessesPage />);
    expect(await screen.findByText(/Out of usage until .* \(Claude Code\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear usage limit' }));
    expect(clearUsageLimit).toHaveBeenCalledWith('claude');
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

  it('offers a test run only once this computer is connected', async () => {
    mockApi({ '/api/me': testMe() });
    const bridge = mockBridge({ ...baseState, connected: false, runner: null });
    bridge.harnesses.mockImplementation(() => Promise.resolve([claudeHarness]) as never);
    renderPage(<DesktopHarnessesPage />);
    expect(await screen.findByRole('button', { name: 'Run a test' })).toBeDisabled();
    expect(screen.getByText(/First connect this computer/)).toBeInTheDocument();
  });

  it('counts the setup steps, step 3 by a successful test run', async () => {
    mockApi({ '/api/me': testMe() });
    mockBridge({
      ...baseState,
      folders: { p1: { path: null, label: 'acme/WEB' } },
      permissionModes: { claude: 'default' },
      testedHarnesses: [],
    });
    renderPage(<DesktopSetupPage />);
    expect(await screen.findByText('2 of 3 steps done.')).toBeInTheDocument();
  });

  it('offers a downloaded update as Restart to update, and a manual one as Download', async () => {
    const user = userEvent.setup();
    const bridge = mockBridge();
    const installUpdate = vi.fn(() => Promise.resolve());
    Object.assign(bridge, { installUpdate });
    const update = { version: '0.3.1', progress: 100, error: null };
    const { rerender } = renderPage(
      <DesktopUpdateNotice update={{ ...update, status: 'ready', manual: false }} />,
    );
    expect(screen.getByText('Baton 0.3.1 is available')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <DesktopUpdateNotice update={{ ...update, status: 'available', manual: true }} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(installUpdate).toHaveBeenCalledTimes(2);
  });

  const config = {
    version: '0.1.0',
    signupsEnabled: true,
    providers: { google: false, github: false },
    maxUploadMb: 25,
  };
  const update = { progress: null, error: null, manual: false };

  it('shows the desktop version and commit, the latest release and the web build', async () => {
    mockApi({ '/api/me': testMe(), '/api/config': config });
    renderPage(
      <DesktopVersionLine
        state={{
          ...baseState,
          version: '0.3.0',
          commit: 'abc1234',
          update: { ...update, status: 'available', version: '0.3.1', latest: '0.3.1' },
        }}
      />,
    );
    const versions = screen.getByTestId('desktop-versions');
    expect(versions).toHaveTextContent('Baton desktop 0.3.0 (abc1234) · Latest: 0.3.1');
    await waitFor(() => expect(versions).toHaveTextContent('Web 0.1.0 (dev)'));
  });

  it('shows the version on Running agents, also for older apps without a commit', async () => {
    mockApi({ '/api/me': testMe(), '/api/config': config });
    mockBridge({
      ...baseState,
      version: '0.3.0',
      update: { ...update, status: 'latest', version: null },
    });
    renderPage(<DesktopAgentsPage />);
    expect(await screen.findByText('Baton desktop 0.3.0')).toBeInTheDocument();
    expect(screen.getByText('· Up to date')).toBeInTheDocument();
  });

  it('lists stopped jobs on Running agents, with Run again and Trash', async () => {
    const user = userEvent.setup();
    const decisions: string[] = [];
    mockApi({
      '/api/me': testMe(),
      '/api/me/agent/waiting': {
        jobs: [
          {
            jobId: 'job-9',
            kind: 'mention',
            createdAt: new Date().toISOString(),
            triggeredBy: 'ethan',
            project: { id: 'p1', ref: 'baton/BAT', name: 'Baton' },
            target: { ref: 'baton/BAT-35', title: 'Stage names', url: null },
            trigger: { body: 'can you fill in the criteria' },
          },
        ],
      },
      'POST /api/me/agent/jobs/job-9/dismiss': ({ url }: { url: URL }) => {
        decisions.push(url.pathname);
        return jsonResponse({ ok: true });
      },
    });
    mockBridge();
    renderPage(<DesktopAgentsPage />);
    const waiting = await screen.findByRole('region', { name: 'Waiting for your OK' });
    expect(within(waiting).getByText(/BAT-35/)).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    await user.click(within(waiting).getByRole('button', { name: 'Trash baton/BAT-35' }));
    await waitFor(() => expect(decisions).toEqual(['/api/me/agent/jobs/job-9/dismiss']));
  });
});
