import { Suspense, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { ErrorBoundary } from '@web/components/common/ErrorBoundary';
import { CommandPalette } from '@web/components/palette/CommandPalette';
import { setPaletteOpen, usePaletteOpen } from '@web/components/palette/registry';
import { SidebarInset, SidebarProvider } from '@web/components/ui/sidebar';
import { useMe } from '@web/lib/auth';
import { setShortcutsHelpOpen, useHotkey } from '@web/lib/hotkeys';
import { useLiveEvents } from '@web/lib/live';
import { useNavigationHistory } from '@web/lib/navigationHistory';
import { useRouteContext } from '@web/lib/routeContext';
import { useSyncProfileTheme } from '@web/lib/theme';
import { useDocumentTitle } from '@web/lib/title';
import { usePipelines } from '@web/pages/projects/queries';
import { ALL_PIPELINES, resolvePipelineTab } from '@web/pages/tasks/pipelineTab';
import { AppHeader } from './AppHeader';
import { AppSidebar } from './AppSidebar';
import { buildCrumbs, titleParts } from './breadcrumbs';
import { RequireAuth, RequireOnboarded } from './guards';
import { shellExtensions } from './shellExtensions';
import { ShortcutsDialog } from './ShortcutsDialog';

function sidebarInitiallyOpen(): boolean {
  return !document.cookie.split('; ').includes('sidebar_state=false');
}

/** Shell-wide shortcuts (SPEC §1.9). Pages add their own with `useHotkey`. */
function useGlobalHotkeys() {
  const navigate = useNavigate();
  const paletteOpen = usePaletteOpen();
  const { team, project } = useRouteContext();
  const projectBase = team && project ? `/t/${team.slug}/p/${project.key}` : null;

  useHotkey('mod+k', () => setPaletteOpen(!paletteOpen), {
    description: 'Open the command palette',
    allowInInputs: true,
    allowInDialogs: true,
  });
  // Pages bind `/` to their own search field; the shell's binding only applies elsewhere.
  useHotkey('/', () => setPaletteOpen(true), { description: 'Search', fallback: true });
  useHotkey('?', () => setShortcutsHelpOpen(true), { description: 'Show keyboard shortcuts' });
  useHotkey('g d', () => void navigate('/'), {
    description: 'Go to dashboard',
    group: 'Navigation',
  });
  useHotkey('g i', () => void navigate('/inbox'), {
    description: 'Go to inbox',
    group: 'Navigation',
  });
  useHotkey('g m', () => void navigate('/my-tasks'), {
    description: 'Go to my tasks',
    group: 'Navigation',
  });
  useHotkey('g b', () => void navigate(`${projectBase ?? ''}/tasks`), {
    description: 'Go to the board',
    group: 'Project',
    enabled: projectBase !== null,
  });
  useHotkey('g l', () => void navigate(`${projectBase ?? ''}/issues`), {
    description: 'Go to issues',
    group: 'Project',
    enabled: projectBase !== null,
  });
}

/** On a project's Tasks page: the name of the pipeline its tabs show, for the breadcrumbs. */
function useBoardPipelineName(pathname: string, search: string): string | undefined {
  const { team, project } = useRouteContext();
  const onBoard = team && project ? pathname === `/t/${team.slug}/p/${project.key}/tasks` : false;
  const pipelines = usePipelines(onBoard ? project?.id : undefined);
  if (!onBoard || !project) return undefined;
  const tab = resolvePipelineTab(
    project.id,
    new URLSearchParams(search).get('pipeline'),
    pipelines.data,
  );
  if (tab === ALL_PIPELINES) return 'All pipelines';
  return pipelines.data?.find((pipeline) => pipeline.id === tab)?.name;
}

function Shell() {
  const location = useLocation();
  const me = useMe().data;
  const connection = useLiveEvents(true);
  const pipelineName = useBoardPipelineName(location.pathname, location.search);
  const crumbs = buildCrumbs(location.pathname, me, { pipelineName });
  useDocumentTitle(titleParts(crumbs, location.pathname), 0);
  useSyncProfileTheme(me?.user.theme);
  useGlobalHotkeys();
  useNavigationHistory();
  const [sidebarOpen] = useState(sidebarInitiallyOpen);

  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <AppHeader crumbs={crumbs} connection={connection} />
        <div id="main" className="flex min-w-0 flex-1 flex-col" tabIndex={-1}>
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </SidebarInset>
      <CommandPalette />
      <ShortcutsDialog />
      <Suspense fallback={null}>
        {shellExtensions.map((Extension, index) => (
          <Extension key={index} />
        ))}
      </Suspense>
    </SidebarProvider>
  );
}

/** The signed-in app: guards, sidebar, header, palette, shortcuts and the live connection. */
export default function AppShell() {
  return (
    <RequireAuth>
      <RequireOnboarded>
        <Shell />
      </RequireOnboarded>
    </RequireAuth>
  );
}
