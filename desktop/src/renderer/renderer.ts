import {
  HARNESS_IDS,
  HARNESS_LABELS,
  type AgentStats,
  type Chain,
  type HarnessId,
  type JobSourceMode,
  type ModelMappings,
} from '@shared/schemas/agentRunner';

/**
 * The desktop app's window (BAT-24): the setup guide on first run, then the agents running now
 * (HUD, with Kill), jobs waiting for your OK, projects & folders, harnesses and their permission
 * modes, models, stats and settings. Plain DOM: the window is small and must stay fast.
 */

// ---------------------------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------------------------

interface RunnerJobView {
  jobId: string;
  ref: string | null;
  title: string | null;
  url: string | null;
  project: string | null;
  kind: string;
  harness: HarnessId | null;
  model: string;
  startedAt: number;
  state: string;
  note: string | null;
  output: string[];
}

interface RunnerView {
  status: 'stopped' | 'connecting' | 'online' | 'paused' | 'offline';
  statusText: string | null;
  runnerId: string | null;
  waitingCount: number;
  jobs: RunnerJobView[];
}

interface AppState {
  signedIn: boolean;
  serverUrl: string;
  machineName: string;
  setupDone: boolean;
  pausedHere: boolean;
  folders: Record<string, { path: string | null; label: string }>;
  permissionModes: Partial<Record<HarnessId, string>>;
  runner: RunnerView | null;
}

interface HarnessView {
  id: HarnessId;
  label: string;
  headless: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  models: string[];
  modes: Array<{ id: string; label: string; description: string; unattended: boolean }>;
  mode: string | null;
}

interface ProjectView {
  id: string;
  ref: string;
  name: string;
  team: string;
  folder: { path: string | null; label: string } | null;
}

interface WaitingView {
  jobId: string;
  kind: string;
  triggeredBy?: string | null;
  target: { ref: string | null; title: string | null; url: string | null };
  trigger?: { body: string } | null;
}

type RepoCheck =
  | { state: 'match'; remote: string }
  | { state: 'mismatch'; remote: string; expected: string }
  | { state: 'not-a-repo' }
  | { state: 'no-repo-url' };

interface BatonBridge {
  state(): Promise<AppState>;
  signIn(serverUrl: string, key: string): Promise<{ name: string; username: string | null }>;
  signOut(): Promise<AppState>;
  harnesses(): Promise<HarnessView[]>;
  projects(): Promise<ProjectView[]>;
  pickFolder(projectId: string, label: string): Promise<RepoCheck | null>;
  setScratch(projectId: string, label: string): Promise<AppState>;
  unmap(projectId: string): Promise<AppState>;
  checkRepo(projectId: string): Promise<RepoCheck | null>;
  setPermissionMode(harness: HarnessId, mode: string): Promise<AppState>;
  models(): Promise<ModelMappings | null>;
  setDefaultChain(chain: Chain): Promise<ModelMappings | null>;
  jobSources(): Promise<{ mode: JobSourceMode } | null>;
  setJobSources(sources: { mode: JobSourceMode; rule: null }): Promise<unknown>;
  waiting(): Promise<{ jobs: WaitingView[] }>;
  decide(jobId: string, decision: 'approve' | 'dismiss'): Promise<unknown>;
  stats(days: number): Promise<AgentStats | null>;
  kill(jobId: string): Promise<void>;
  pauseHere(paused: boolean): Promise<AppState>;
  pauseEverywhere(): Promise<AppState>;
  setMachineName(name: string): Promise<AppState>;
  finishSetup(): Promise<AppState>;
  testRun(harness: HarnessId): Promise<{ ok: boolean; output: string; outcome?: string }>;
  openExternal(url: string): Promise<void>;
  on(
    channel: 'runner' | 'output' | 'state' | 'error',
    listener: (payload: unknown) => void,
  ): () => void;
}

const baton = (window as unknown as { baton: BatonBridge }).baton;

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'className') {
      element.className = String(value);
    } else if (key in element && typeof value !== 'string') {
      (element as unknown as Record<string, unknown>)[key] = value;
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

function toast(message: string) {
  const node = h(
    'div',
    {
      role: 'status',
      className: 'card',
      style: 'position:fixed;bottom:16px;right:16px;z-index:10',
    },
    message,
  );
  document.body.append(node);
  setTimeout(() => node.remove(), 3500);
}

async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': /, '')
        : String(error),
    );
    return null;
  }
}

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

type Screen = 'hud' | 'waiting' | 'projects' | 'harnesses' | 'models' | 'stats' | 'settings';

let state: AppState | null = null;
let screen: Screen = 'hud';
let setupStep = 0;
const root = document.getElementById('app') as HTMLElement;

async function refresh() {
  state = await baton.state();
  render();
}

baton.on('runner', (payload) => {
  if (!state) return;
  state = { ...state, runner: payload as RunnerView };
  if (screen === 'hud' && state.setupDone) render();
  else renderNavOnly();
});
baton.on('state', (payload) => {
  state = payload as AppState;
  render();
});
baton.on('error', (payload) => toast(String(payload)));

function renderNavOnly() {
  const nav = root.querySelector('nav.side');
  if (nav && state) nav.replaceWith(navigation());
}

function render() {
  if (!state) return;
  if (!state.setupDone) {
    root.replaceChildren(h('main', {}, setupGuide()));
    return;
  }
  const content = h('main', { id: 'content' });
  root.replaceChildren(h('div', { className: 'layout' }, navigation(), content));
  void fillScreen(content);
}

function navigation(): HTMLElement {
  const runner = state?.runner;
  const items: Array<[Screen, string, string?]> = [
    ['hud', 'Agents', runner?.jobs.length ? String(runner.jobs.length) : undefined],
    [
      'waiting',
      'Waiting for your OK',
      runner?.waitingCount ? String(runner.waitingCount) : undefined,
    ],
    ['projects', 'Projects & folders'],
    ['harnesses', 'Harnesses'],
    ['models', 'Models'],
    ['stats', 'Stats'],
    ['settings', 'Settings'],
  ];
  const status = runner?.status ?? 'stopped';
  const badge =
    status === 'online'
      ? 'ok'
      : status === 'paused'
        ? 'warn'
        : status === 'offline'
          ? 'danger'
          : '';
  return h(
    'nav',
    { className: 'side', 'aria-label': 'Screens' },
    h('div', { className: 'brand' }, 'Baton ', h('span', { className: `badge ${badge}` }, status)),
    ...items.map(([id, label, count]) =>
      h(
        'button',
        {
          'aria-current': screen === id ? 'page' : undefined,
          onClick: () => {
            screen = id;
            render();
          },
        },
        label,
        count ? h('span', { className: 'badge' }, count) : null,
      ),
    ),
  );
}

async function fillScreen(content: HTMLElement) {
  switch (screen) {
    case 'hud':
      content.append(hudScreen());
      break;
    case 'waiting':
      content.append(await waitingScreen());
      break;
    case 'projects':
      content.append(await projectsScreen());
      break;
    case 'harnesses':
      content.append(await harnessesScreen());
      break;
    case 'models':
      content.append(await modelsScreen());
      break;
    case 'stats':
      content.append(await statsScreen(30));
      break;
    case 'settings':
      content.append(await settingsScreen());
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------------------------

function hudScreen(): HTMLElement {
  const runner = state?.runner;
  const header = h(
    'div',
    { className: 'row spread' },
    h(
      'div',
      {},
      h('h1', {}, 'Agents running now'),
      h(
        'p',
        { className: 'muted' },
        runner?.statusText ??
          (runner?.status === 'online'
            ? 'Listening for jobs. No tokens are used while nothing runs.'
            : ''),
      ),
    ),
    h(
      'button',
      {
        onClick: () =>
          void attempt(() => baton.pauseHere(!state?.pausedHere)).then(() => refresh()),
      },
      state?.pausedHere ? 'Resume on this machine' : 'Pause on this machine',
    ),
  );
  if (!runner || runner.jobs.length === 0) {
    return h(
      'div',
      {},
      header,
      h(
        'div',
        { className: 'card' },
        h(
          'p',
          { className: 'muted' },
          'Nothing is running. Jobs show here as soon as someone mentions or assigns your agent in a project mapped to a folder on this machine.',
        ),
      ),
    );
  }
  return h(
    'div',
    {},
    header,
    ...runner.jobs.map((job) =>
      h(
        'section',
        { className: 'card', 'aria-label': `${job.ref ?? 'Job'} ${job.title ?? ''}` },
        h(
          'div',
          { className: 'row spread' },
          h(
            'div',
            {},
            h('h2', {}, `${job.ref ?? ''} ${job.title ?? ''}`),
            h(
              'div',
              { className: 'row muted' },
              h('span', {}, job.kind.replace('_', ' ')),
              h(
                'span',
                {},
                job.harness
                  ? `${HARNESS_LABELS[job.harness]}${job.model ? ` · ${job.model}` : ''}`
                  : 'Starting…',
              ),
              h('span', {}, elapsed(job.startedAt)),
              h(
                'span',
                {
                  className: `badge ${job.state === 'blocked' ? 'warn' : job.state === 'waiting-usage' ? 'warn' : 'ok'}`,
                },
                job.state === 'blocked'
                  ? 'Blocked on a permission'
                  : job.state === 'waiting-usage'
                    ? 'Waiting for usage'
                    : job.state,
              ),
            ),
          ),
          h(
            'div',
            { className: 'row' },
            job.url
              ? h(
                  'button',
                  { onClick: () => void baton.openExternal(job.url ?? '') },
                  'Open in Baton',
                )
              : null,
            h(
              'button',
              { className: 'danger', onClick: () => void attempt(() => baton.kill(job.jobId)) },
              'Kill',
            ),
          ),
        ),
        job.note ? h('p', { className: 'muted' }, job.note) : null,
        h(
          'pre',
          { className: 'output', 'aria-label': 'Live output' },
          job.output.slice(-80).join('\n'),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Waiting for your OK
// ---------------------------------------------------------------------------------------------

async function waitingScreen(): Promise<HTMLElement> {
  const result = (await attempt(() => baton.waiting())) ?? { jobs: [] };
  return h(
    'div',
    {},
    h('h1', {}, 'Waiting for your OK'),
    h(
      'p',
      { className: 'muted' },
      'Jobs from people outside “Whose jobs run”, and runs you killed or that failed. They only run when you say so.',
    ),
    result.jobs.length === 0
      ? h('div', { className: 'card' }, h('p', { className: 'muted' }, 'Nothing is waiting.'))
      : h(
          'ul',
          { className: 'list card', 'aria-label': 'Jobs waiting for your OK' },
          ...result.jobs.map((job) =>
            h(
              'li',
              { className: 'row spread' },
              h(
                'div',
                {},
                h('b', {}, `${job.target.ref ?? ''} ${job.target.title ?? ''}`),
                h(
                  'div',
                  { className: 'muted' },
                  `${job.kind.replace('_', ' ')}${job.triggeredBy ? ` by @${job.triggeredBy}` : ''}${job.trigger ? ` — “${job.trigger.body.slice(0, 120)}”` : ''}`,
                ),
              ),
              h(
                'div',
                { className: 'row' },
                h(
                  'button',
                  {
                    className: 'primary',
                    onClick: () =>
                      void attempt(() => baton.decide(job.jobId, 'approve')).then(() => render()),
                  },
                  'Run',
                ),
                h(
                  'button',
                  {
                    onClick: () =>
                      void attempt(() => baton.decide(job.jobId, 'dismiss')).then(() => render()),
                  },
                  'Dismiss',
                ),
              ),
            ),
          ),
        ),
  );
}

// ---------------------------------------------------------------------------------------------
// Projects & folders
// ---------------------------------------------------------------------------------------------

function repoNote(check: RepoCheck | null): HTMLElement | null {
  if (!check) return null;
  switch (check.state) {
    case 'match':
      return h('span', { className: 'badge ok' }, 'Repository matches');
    case 'mismatch':
      return h(
        'span',
        { className: 'badge danger' },
        `Different repository: ${check.remote} (the project says ${check.expected})`,
      );
    case 'not-a-repo':
      return h('span', { className: 'badge' }, 'Not a git repository');
    case 'no-repo-url':
      return h('span', { className: 'badge' }, 'The project has no repository URL to check');
  }
}

async function projectsScreen(): Promise<HTMLElement> {
  const projects = (await attempt(() => baton.projects())) ?? [];
  return h(
    'div',
    {},
    h('h1', {}, 'Projects & folders'),
    h(
      'p',
      { className: 'muted' },
      'Map each project to a folder on this machine; jobs run there. Paths are yours alone (other people map their own). A project without a folder gets no jobs here; “No folder” uses a scratch folder the app creates.',
    ),
    h(
      'ul',
      { className: 'list card', 'aria-label': 'Projects' },
      ...projects.map((project) => {
        const noteSlot = h('div', {});
        const label = `${project.ref} — ${project.name}`;
        if (project.folder?.path)
          void baton
            .checkRepo(project.id)
            .then((check) => noteSlot.replaceChildren(repoNote(check) ?? ''));
        return h(
          'li',
          {},
          h(
            'div',
            { className: 'row spread' },
            h(
              'div',
              {},
              h('b', {}, label),
              h(
                'div',
                { className: 'muted' },
                project.folder
                  ? (project.folder.path ?? 'No folder (scratch folder)')
                  : 'Needs a folder: its jobs wait',
              ),
            ),
            h(
              'div',
              { className: 'row' },
              h(
                'button',
                {
                  onClick: () =>
                    void attempt(() => baton.pickFolder(project.id, label)).then((check) => {
                      render();
                      if (check) toast('Folder mapped');
                    }),
                },
                project.folder?.path ? 'Change folder' : 'Choose folder',
              ),
              h(
                'button',
                {
                  onClick: () =>
                    void attempt(() => baton.setScratch(project.id, label)).then(() => render()),
                },
                'No folder',
              ),
              project.folder
                ? h(
                    'button',
                    {
                      onClick: () =>
                        void attempt(() => baton.unmap(project.id)).then(() => render()),
                    },
                    'Remove',
                  )
                : null,
            ),
          ),
          noteSlot,
        );
      }),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------------------------

async function harnessesScreen(): Promise<HTMLElement> {
  const harnesses = (await attempt(() => baton.harnesses())) ?? [];
  return h(
    'div',
    {},
    h('h1', {}, 'Harnesses'),
    h(
      'p',
      { className: 'muted' },
      'Headless sessions can’t show permission prompts, so manual approval can’t run unattended. Pick how each harness handles permissions. Your own settings, skills, plugins and MCP servers are used as they are.',
    ),
    ...harnesses.map((harness) => harnessCard(harness)),
  );
}

function harnessCard(harness: HarnessView): HTMLElement {
  const output = h('pre', { className: 'output', hidden: true });
  return h(
    'section',
    { className: 'card', 'aria-label': harness.label },
    h(
      'div',
      { className: 'row spread' },
      h(
        'div',
        {},
        h('h2', {}, harness.label),
        h(
          'div',
          { className: 'muted' },
          harness.installed
            ? `${harness.path ?? ''}${harness.version ? ` · ${harness.version}` : ''} · runs as “${harness.headless}”`
            : 'Not installed on this machine',
        ),
      ),
      h(
        'span',
        { className: `badge ${harness.installed ? 'ok' : ''}` },
        harness.installed ? 'Installed' : 'Not found',
      ),
    ),
    harness.installed
      ? h(
          'div',
          {},
          h(
            'label',
            { className: 'row' },
            'Permissions ',
            h(
              'select',
              {
                'aria-label': `${harness.label} permission mode`,
                onChange: (event: Event) =>
                  void attempt(() =>
                    baton.setPermissionMode(harness.id, (event.target as HTMLSelectElement).value),
                  ).then(() => toast('Saved')),
              },
              ...harness.modes.map((mode) =>
                h(
                  'option',
                  { value: mode.id, selected: mode.id === harness.mode },
                  `${mode.label}${mode.unattended ? '' : ' (you approve in pop-ups)'}`,
                ),
              ),
            ),
          ),
          h(
            'p',
            { className: 'muted' },
            harness.modes.find((mode) => mode.id === harness.mode)?.description ?? '',
          ),
          h(
            'button',
            {
              onClick: (event: Event) => {
                const button = event.currentTarget as HTMLButtonElement;
                button.disabled = true;
                output.hidden = false;
                output.textContent = 'Running a test…';
                void attempt(() => baton.testRun(harness.id)).then((result) => {
                  button.disabled = false;
                  output.textContent = result
                    ? `${result.ok ? '✓' : '✗'} ${result.outcome ?? ''}\n${result.output}`
                    : 'The test failed.';
                });
              },
            },
            'Run a test',
          ),
          output,
        )
      : null,
  );
}

// ---------------------------------------------------------------------------------------------
// Models (the default chain; per-level mappings are edited on the web)
// ---------------------------------------------------------------------------------------------

function chainEditor(chain: Chain, onChange: (chain: Chain) => void): HTMLElement {
  const rows = chain.map((entry, index) =>
    h(
      'div',
      { className: 'row' },
      h('span', { className: 'muted' }, index === 0 ? 'Run with' : 'then'),
      h(
        'select',
        {
          'aria-label': `Harness ${index + 1}`,
          onChange: (event: Event) =>
            onChange(
              chain.map((item, at) =>
                at === index
                  ? { ...item, harness: (event.target as HTMLSelectElement).value as HarnessId }
                  : item,
              ),
            ),
        },
        ...HARNESS_IDS.map((id) =>
          h('option', { value: id, selected: id === entry.harness }, HARNESS_LABELS[id]),
        ),
      ),
      h('input', {
        'aria-label': `Model ${index + 1}`,
        value: entry.model,
        placeholder: 'default model',
        onChange: (event: Event) =>
          onChange(
            chain.map((item, at) =>
              at === index ? { ...item, model: (event.target as HTMLInputElement).value } : item,
            ),
          ),
      }),
      h('input', {
        'aria-label': `Effort ${index + 1}`,
        value: entry.effort,
        placeholder: 'effort',
        onChange: (event: Event) =>
          onChange(
            chain.map((item, at) =>
              at === index ? { ...item, effort: (event.target as HTMLInputElement).value } : item,
            ),
          ),
      }),
      h(
        'button',
        {
          'aria-label': `Remove step ${index + 1}`,
          onClick: () => onChange(chain.filter((_, at) => at !== index)),
        },
        '✕',
      ),
    ),
  );
  return h(
    'div',
    {},
    ...rows,
    h(
      'button',
      {
        disabled: chain.length >= 8,
        onClick: () =>
          onChange([
            ...chain,
            { harness: chain.length === 0 ? 'claude' : 'codex', model: '', effort: '' },
          ]),
      },
      chain.length === 0 ? 'Set a model' : 'Add a fallback',
    ),
  );
}

async function modelsScreen(): Promise<HTMLElement> {
  const mappings = await attempt(() => baton.models());
  const container = h('div', {});
  let chain: Chain = mappings?.default.chain ?? [];
  const editor = h('div', {});
  const draw = () =>
    editor.replaceChildren(
      chainEditor(chain, (next) => {
        chain = next;
        draw();
      }),
    );
  draw();
  container.append(
    h('h1', {}, 'Models'),
    h(
      'p',
      { className: 'muted' },
      'Which harness and model run a task, by its difficulty. When a harness is out of usage or not installed here, the next step of the chain runs instead.',
    ),
    h(
      'section',
      { className: 'card' },
      h('h2', {}, 'Default'),
      h('p', { className: 'muted' }, 'Tasks without a difficulty, and levels nothing else maps.'),
      editor,
      h(
        'div',
        { className: 'row', style: 'margin-top:12px' },
        h(
          'button',
          {
            className: 'primary',
            onClick: () =>
              void attempt(() => baton.setDefaultChain(chain)).then(
                (saved) => saved && toast('Saved'),
              ),
          },
          'Save',
        ),
      ),
    ),
    h(
      'section',
      { className: 'card' },
      h('h2', {}, 'By project and difficulty'),
      h(
        'p',
        { className: 'muted' },
        'Map each difficulty level of a project (Easy, Normal, Hard…) in Baton: Settings → Automatic agents.',
      ),
      h(
        'button',
        {
          onClick: () =>
            void baton.openExternal(`${state?.serverUrl ?? ''}/settings/automatic-agents`),
        },
        'Open in Baton',
      ),
    ),
  );
  return container;
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function statsTable(
  title: string,
  rows: Array<{
    name: string;
    jobs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    durationMs: number;
  }>,
) {
  if (rows.length === 0) return null;
  return h(
    'table',
    {},
    h('caption', { className: 'muted', style: 'text-align:left' }, title),
    h(
      'tr',
      {},
      h('th', {}, 'Name'),
      h('th', { className: 'num' }, 'Jobs'),
      h('th', { className: 'num' }, 'Tokens'),
      h('th', { className: 'num' }, 'Cost'),
      h('th', { className: 'num' }, 'Minutes'),
    ),
    ...rows.map((row) =>
      h(
        'tr',
        {},
        h('td', {}, row.name),
        h('td', { className: 'num' }, String(row.jobs)),
        h('td', { className: 'num' }, String(row.tokensIn + row.tokensOut)),
        h('td', { className: 'num' }, money.format(row.costUsd)),
        h('td', { className: 'num' }, String(Math.round(row.durationMs / 60000))),
      ),
    ),
  );
}

async function statsScreen(days: number): Promise<HTMLElement> {
  const stats = await attempt(() => baton.stats(days));
  const select = h(
    'select',
    {
      'aria-label': 'Period',
      onChange: (event: Event) =>
        void statsScreen(Number((event.target as HTMLSelectElement).value)).then((next) =>
          container.replaceWith(next),
        ),
    },
    ...[7, 30, 90].map((value) =>
      h('option', { value: String(value), selected: value === days }, `Last ${value} days`),
    ),
  );
  const container = h(
    'div',
    {},
    h('div', { className: 'row spread' }, h('h1', {}, 'Stats'), select),
    !stats || stats.totals.jobs === 0
      ? h(
          'div',
          { className: 'card' },
          h('p', { className: 'muted' }, 'No runs in this period yet.'),
        )
      : h(
          'div',
          { className: 'card' },
          h(
            'div',
            { className: 'tiles' },
            h('div', { className: 'tile' }, 'Jobs', h('b', {}, String(stats.totals.jobs))),
            h(
              'div',
              { className: 'tile' },
              'Tokens',
              h('b', {}, String(stats.totals.tokensIn + stats.totals.tokensOut)),
            ),
            h('div', { className: 'tile' }, 'Cost', h('b', {}, money.format(stats.totals.costUsd))),
            h(
              'div',
              { className: 'tile' },
              'Minutes',
              h('b', {}, String(Math.round(stats.totals.durationMs / 60000))),
            ),
          ),
          statsTable(
            'By harness',
            stats.byHarness.map((row) => ({
              name: HARNESS_LABELS[row.harness as HarnessId] ?? row.harness,
              ...row,
            })),
          ),
          statsTable(
            'By model',
            stats.byModel.map((row) => ({
              name: `${row.harness} ${row.model || '(default)'}`,
              ...row,
            })),
          ),
          statsTable(
            'By difficulty',
            stats.byDifficulty.map((row) => ({ name: row.difficulty, ...row })),
          ),
          statsTable(
            'By day',
            stats.byDay.map((row) => ({ name: row.day, ...row })),
          ),
        ),
  );
  return container;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function jobSourcesControl(current: JobSourceMode | null): HTMLElement {
  const choices: Array<[JobSourceMode, string]> = [
    ['me', 'Only jobs I trigger'],
    ['anyone', 'Anyone who can mention or assign my agent'],
  ];
  return h(
    'fieldset',
    { style: 'border:none;padding:0' },
    h('legend', {}, 'Whose jobs run by themselves'),
    ...choices.map(([mode, label]) =>
      h(
        'label',
        { className: 'row' },
        h('input', {
          type: 'radio',
          name: 'sources',
          value: mode,
          checked: current === mode,
          onChange: () =>
            void attempt(() => baton.setJobSources({ mode, rule: null })).then(() =>
              toast('Saved'),
            ),
        }),
        label,
      ),
    ),
    current === 'custom'
      ? h(
          'p',
          { className: 'muted' },
          'A custom list is set on the web (Settings → Automatic agents).',
        )
      : null,
  );
}

async function settingsScreen(): Promise<HTMLElement> {
  const sources = await attempt(() => baton.jobSources());
  const nameInput = h('input', { 'aria-label': 'Machine name', value: state?.machineName ?? '' });
  return h(
    'div',
    {},
    h('h1', {}, 'Settings'),
    h(
      'section',
      { className: 'card' },
      h('h2', {}, 'Account'),
      h('p', { className: 'muted' }, `Connected to ${state?.serverUrl ?? ''}`),
      h(
        'button',
        { onClick: () => void attempt(() => baton.signOut()).then(() => refresh()) },
        'Sign out',
      ),
    ),
    h(
      'section',
      { className: 'card' },
      h('h2', {}, 'This machine'),
      h(
        'div',
        { className: 'row' },
        nameInput,
        h(
          'button',
          {
            onClick: () =>
              void attempt(() => baton.setMachineName(nameInput.value)).then(() => toast('Saved')),
          },
          'Rename',
        ),
      ),
    ),
    h('section', { className: 'card' }, jobSourcesControl(sources?.mode ?? null)),
    h(
      'section',
      { className: 'card' },
      h('h2', {}, 'Pause'),
      h(
        'div',
        { className: 'row' },
        h(
          'button',
          {
            onClick: () =>
              void attempt(() => baton.pauseHere(!state?.pausedHere)).then(() => refresh()),
          },
          state?.pausedHere ? 'Resume on this machine' : 'Pause on this machine',
        ),
        h(
          'button',
          {
            className: 'danger',
            onClick: () =>
              void attempt(() => baton.pauseEverywhere()).then(() =>
                toast('Your agent is paused everywhere. Resume it in Baton: Settings → Agent.'),
              ),
          },
          'Pause everywhere',
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Setup guide
// ---------------------------------------------------------------------------------------------

const STEPS = [
  'Harnesses',
  'Sign in',
  'Projects & folders',
  'Default model',
  'Permissions',
  'Whose jobs',
  'Test run',
] as const;

function setupGuide(): HTMLElement {
  const body = h('div', {});
  const next = () => {
    setupStep += 1;
    render();
  };
  const container = h(
    'div',
    {},
    h('h1', {}, 'Set up automatic agents'),
    h(
      'p',
      { className: 'muted' },
      'Baton listens for your agent’s jobs without spending tokens, and runs each one in your own harness, in the folder you map to its project.',
    ),
    h(
      'div',
      { className: 'steps', 'aria-label': 'Steps' },
      ...STEPS.map((label, index) =>
        h(
          'span',
          { 'aria-current': index === setupStep ? 'step' : undefined },
          `${index + 1}. ${label}`,
        ),
      ),
    ),
    body,
  );
  void fillSetup(body, next);
  return container;
}

async function fillSetup(body: HTMLElement, next: () => void) {
  const nextButton = (label = 'Next', enabled = true) =>
    h('button', { className: 'primary', disabled: !enabled, onClick: next }, label);
  switch (setupStep) {
    case 0: {
      const harnesses = (await attempt(() => baton.harnesses())) ?? [];
      const any = harnesses.some((harness) => harness.installed);
      body.append(
        h(
          'ul',
          { className: 'list card' },
          ...harnesses.map((harness) =>
            h(
              'li',
              { className: 'row spread' },
              h(
                'span',
                {},
                harness.label,
                h('span', { className: 'muted' }, ` (${harness.headless})`),
              ),
              h(
                'span',
                { className: `badge ${harness.installed ? 'ok' : ''}` },
                harness.installed ? `Installed ${harness.version ?? ''}` : 'Not found',
              ),
            ),
          ),
        ),
        any
          ? h('p', {}, 'Found at least one harness.')
          : h(
              'p',
              { className: 'muted' },
              'Install Claude Code, Codex, Gemini CLI, Cursor CLI or opencode, then reopen this step.',
            ),
        h(
          'div',
          { className: 'row' },
          h('button', { onClick: () => render() }, 'Detect again'),
          nextButton('Next', any),
        ),
      );
      break;
    }
    case 1: {
      const server = h('input', {
        'aria-label': 'Baton server',
        value: state?.serverUrl ?? '',
        style: 'width:320px',
      });
      const key = h('input', {
        'aria-label': 'API key',
        type: 'password',
        placeholder: 'bat_…',
        style: 'width:320px',
      });
      body.append(
        h(
          'div',
          { className: 'card' },
          h(
            'p',
            {},
            'The app works as your Baton agent through an API key of your account. Create one named after this machine, then paste it here.',
          ),
          h(
            'button',
            {
              onClick: () =>
                void baton.openExternal(`${server.value.replace(/\/+$/, '')}/settings/api-keys`),
            },
            'Create a key in Baton',
          ),
          h(
            'div',
            { className: 'row', style: 'margin-top:12px' },
            h('label', {}, 'Server ', server),
          ),
          h('div', { className: 'row', style: 'margin-top:8px' }, h('label', {}, 'API key ', key)),
        ),
        h(
          'div',
          { className: 'row' },
          state?.signedIn ? nextButton('Keep the current key') : null,
          h(
            'button',
            {
              className: 'primary',
              onClick: () =>
                void attempt(() => baton.signIn(server.value, key.value)).then(async (me) => {
                  if (me) {
                    toast(`Signed in as ${me.name}`);
                    state = await baton.state();
                    next();
                  }
                }),
            },
            'Sign in',
          ),
        ),
      );
      break;
    }
    case 2:
      body.append(await projectsScreen(), h('div', { className: 'row' }, nextButton()));
      break;
    case 3:
      body.append(await modelsScreen(), h('div', { className: 'row' }, nextButton()));
      break;
    case 4:
      body.append(await harnessesScreen(), h('div', { className: 'row' }, nextButton()));
      break;
    case 5: {
      const sources = await attempt(() => baton.jobSources());
      body.append(
        h(
          'div',
          { className: 'card' },
          jobSourcesControl(sources?.mode ?? 'me'),
          h(
            'p',
            { className: 'muted' },
            'Jobs from anyone else wait under “Waiting for your OK” and never run by themselves.',
          ),
        ),
        h('div', { className: 'row' }, nextButton()),
      );
      break;
    }
    default: {
      const harnesses = ((await attempt(() => baton.harnesses())) ?? []).filter(
        (harness) => harness.installed,
      );
      body.append(
        h(
          'p',
          {},
          'Run a test so you can see it work: the harness checks it can reach Baton as your agent.',
        ),
        ...harnesses.map((harness) => harnessCard(harness)),
        h(
          'div',
          { className: 'row' },
          h(
            'button',
            {
              className: 'primary',
              onClick: () => void attempt(() => baton.finishSetup()).then(() => refresh()),
            },
            'Finish',
          ),
        ),
      );
    }
  }
}

void refresh();
setInterval(() => {
  if (state?.setupDone && screen === 'hud' && state.runner?.jobs.length) render();
}, 5_000);
