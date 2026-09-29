import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { KeepQueryRedirect } from './components/common/KeepQueryRedirect';
import { RouteError } from './components/common/RouteError';
import { LoadingScreen } from './components/common/Spinner';

/**
 * Every route of the app (SPEC §6). Pages are code-split: each route lazily imports one page
 * module (default export) from its owner's folder under web/pages/<area>/. Two error elements
 * catch failed page chunks (e.g. after a deploy) and render errors: one inside the app shell, so
 * the sidebar stays usable, and one around everything else (auth pages, the shell itself).
 */

type PageModule = { default: ComponentType };

/** Lazily loaded route component. */
function page(load: () => Promise<PageModule>): Pick<RouteObject, 'lazy' | 'HydrateFallback'> {
  return {
    lazy: async () => ({ Component: (await load()).default }),
    // Shown while the first page's module loads.
    HydrateFallback: LoadingScreen,
  };
}

/** Index route that redirects to a sibling path (e.g. /settings → /settings/profile). */
function redirectTo(to: string): RouteObject {
  return { index: true, element: <Navigate to={to} replace /> };
}

/** Development-only pages; `import.meta.env.DEV` is false in production builds, so they are dropped. */
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [{ path: '/__dev/components', ...page(() => import('./pages/dev/ComponentsPage')) }]
  : [];

/** Pages rendered inside the app shell. */
const shellRoutes: RouteObject[] = [
  // work
  { index: true, ...page(() => import('./pages/dashboard/DashboardPage')) },
  { path: 'inbox', ...page(() => import('./pages/inbox/InboxPage')) },
  { path: 'my-tasks', ...page(() => import('./pages/my-tasks/MyTasksPage')) },
  { path: 'download', ...page(() => import('./pages/download/DownloadPage')) },
  // agent access: requests to start your agent
  { path: 'agent/requests', ...page(() => import('./pages/agent/RequestsPage')) },
  // desktop app (BAT-26): shown inside the Baton desktop app
  { path: 'desktop', ...page(() => import('./pages/desktop/DesktopAgentsPage')) },
  { path: 'desktop/setup', ...page(() => import('./pages/desktop/DesktopSetupPage')) },
  { path: 'desktop/folders', ...page(() => import('./pages/desktop/DesktopFoldersPage')) },
  { path: 'desktop/harnesses', ...page(() => import('./pages/desktop/DesktopHarnessesPage')) },

  // teams
  { path: 'join/:code', ...page(() => import('./pages/join/JoinPage')) },
  { path: 't/:team', ...page(() => import('./pages/teams/TeamHomePage')) },
  { path: 't/:team/members', ...page(() => import('./pages/teams/TeamMembersPage')) },
  // Your settings for this team (BAT-34)
  { path: 't/:team/me', ...page(() => import('./pages/teams/MyTeamSettingsPage')) },
  {
    path: 't/:team/settings',
    ...page(() => import('./pages/team-settings/TeamSettingsLayout')),
    children: [
      redirectTo('general'),
      { path: 'general', ...page(() => import('./pages/team-settings/GeneralSettingsPage')) },
      { path: 'members', ...page(() => import('./pages/team-settings/MembersSettingsPage')) },
      { path: 'roles', ...page(() => import('./pages/team-settings/RolesSettingsPage')) },
      { path: 'roles/:roleId', ...page(() => import('./pages/team-settings/RoleEditPage')) },
      { path: 'invites', ...page(() => import('./pages/team-settings/InvitesSettingsPage')) },
      {
        path: 'integrations',
        ...page(() => import('./pages/team-settings/IntegrationsSettingsPage')),
      },
      // admin
      { path: 'audit-log', ...page(() => import('./pages/team-settings/AuditLogPage')) },
      { path: 'trash', ...page(() => import('./pages/team-settings/TrashPage')) },
    ],
  },

  // projects: the project layout (header + Overview/Tasks/Issues/Settings tabs, old-key
  // redirects) wraps every page of a project, including the issues and tasks modules' pages.
  {
    path: 't/:team/p/:key',
    ...page(() => import('./pages/projects/ProjectLayout')),
    children: [
      { index: true, ...page(() => import('./pages/projects/ProjectOverviewPage')) },
      {
        path: 'settings',
        ...page(() => import('./pages/project-settings/ProjectSettingsLayout')),
        children: [
          redirectTo('general'),
          {
            path: 'general',
            ...page(() => import('./pages/project-settings/GeneralSettingsPage')),
          },
          // Pipelines and their stages; the section was "Statuses" before pipelines were shown.
          {
            path: 'pipelines',
            ...page(() => import('./pages/project-settings/StatusesSettingsPage')),
          },
          { path: 'statuses', element: <KeepQueryRedirect to="../pipelines" /> },
          {
            path: 'labels',
            ...page(() => import('./pages/project-settings/LabelsSettingsPage')),
          },
          // Difficulty was removed (2026-09-29): old links land on Pipelines.
          { path: 'difficulty', element: <Navigate to="../pipelines" replace /> },
          {
            path: 'access',
            ...page(() => import('./pages/project-settings/AccessSettingsPage')),
          },
        ],
      },

      // issues
      { path: 'issues', ...page(() => import('./pages/issues/IssueListPage')) },
      { path: 'issues/new', ...page(() => import('./pages/issues/NewIssuePage')) },
      { path: 'issues/:number', ...page(() => import('./pages/issues/IssuePage')) },

      // tasks
      { path: 'tasks', ...page(() => import('./pages/tasks/TasksPage')) },
      { path: 'tasks/:number', ...page(() => import('./pages/tasks/TaskPage')) },

      // Your settings for this project (BAT-29)
      { path: 'me', ...page(() => import('./pages/projects/MySettingsPage')) },
    ],
  },

  // account
  {
    path: 'settings',
    ...page(() => import('./pages/settings/SettingsLayout')),
    children: [
      redirectTo('profile'),
      { path: 'profile', ...page(() => import('./pages/settings/ProfileSettingsPage')) },
      { path: 'account', ...page(() => import('./pages/settings/AccountSettingsPage')) },
      {
        path: 'connections',
        ...page(() => import('./pages/settings/ConnectionsSettingsPage')),
      },
      { path: 'api-keys', ...page(() => import('./pages/settings/ApiKeysSettingsPage')) },
      { path: 'agent', ...page(() => import('./pages/settings/AgentSettingsPage')) },
      {
        path: 'automatic-agents',
        ...page(() => import('./pages/settings/AutomaticAgentsSettingsPage')),
      },
      { path: 'appearance', ...page(() => import('./pages/settings/AppearanceSettingsPage')) },
      {
        path: 'notifications',
        ...page(() => import('./pages/settings/NotificationsSettingsPage')),
      },
      { path: 'security', ...page(() => import('./pages/settings/SecuritySettingsPage')) },
    ],
  },

  // core
  { path: '*', ...page(() => import('./pages/errors/NotFoundPage')) },
];

const appRoutes: RouteObject[] = [
  ...devRoutes,

  // --- Auth (core) — no app shell --------------------------------------------------------
  { path: '/login', ...page(() => import('./pages/auth/LoginPage')) },
  { path: '/signup', ...page(() => import('./pages/auth/SignupPage')) },
  { path: '/verify-email', ...page(() => import('./pages/auth/VerifyEmailPage')) },
  { path: '/forgot-password', ...page(() => import('./pages/auth/ForgotPasswordPage')) },
  { path: '/reset-password', ...page(() => import('./pages/auth/ResetPasswordPage')) },
  { path: '/onboarding/username', ...page(() => import('./pages/auth/OnboardingUsernamePage')) },

  // --- App shell (core) ------------------------------------------------------------------
  {
    ...page(() => import('./components/layout/AppShell')),
    children: [{ errorElement: <RouteError variant="page" />, children: shellRoutes }],
  },
];

export const routes: RouteObject[] = [
  { errorElement: <RouteError variant="screen" />, children: appRoutes },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
