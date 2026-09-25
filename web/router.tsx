import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { LoadingScreen } from './components/common/Spinner';

/**
 * Every route of the app (SPEC §6). Pages are code-split: each route lazily imports one page
 * module (default export) from its owner's folder under web/pages/<area>/.
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

export const routes: RouteObject[] = [
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
    children: [
      // work
      { index: true, ...page(() => import('./pages/dashboard/DashboardPage')) },
      { path: 'inbox', ...page(() => import('./pages/inbox/InboxPage')) },
      { path: 'my-tasks', ...page(() => import('./pages/my-tasks/MyTasksPage')) },

      // teams
      { path: 'join/:code', ...page(() => import('./pages/join/JoinPage')) },
      { path: 't/:team', ...page(() => import('./pages/teams/TeamHomePage')) },
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
          // admin
          { path: 'audit-log', ...page(() => import('./pages/team-settings/AuditLogPage')) },
          { path: 'trash', ...page(() => import('./pages/team-settings/TrashPage')) },
        ],
      },

      // projects
      { path: 't/:team/p/:key', ...page(() => import('./pages/projects/ProjectOverviewPage')) },
      {
        path: 't/:team/p/:key/settings',
        ...page(() => import('./pages/project-settings/ProjectSettingsLayout')),
        children: [
          redirectTo('general'),
          {
            path: 'general',
            ...page(() => import('./pages/project-settings/GeneralSettingsPage')),
          },
          {
            path: 'statuses',
            ...page(() => import('./pages/project-settings/StatusesSettingsPage')),
          },
          { path: 'labels', ...page(() => import('./pages/project-settings/LabelsSettingsPage')) },
        ],
      },

      // issues
      { path: 't/:team/p/:key/issues', ...page(() => import('./pages/issues/IssueListPage')) },
      { path: 't/:team/p/:key/issues/new', ...page(() => import('./pages/issues/NewIssuePage')) },
      { path: 't/:team/p/:key/issues/:number', ...page(() => import('./pages/issues/IssuePage')) },

      // tasks
      { path: 't/:team/p/:key/tasks', ...page(() => import('./pages/tasks/TasksPage')) },
      { path: 't/:team/p/:key/tasks/:number', ...page(() => import('./pages/tasks/TaskPage')) },

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
          { path: 'appearance', ...page(() => import('./pages/settings/AppearanceSettingsPage')) },
          { path: 'security', ...page(() => import('./pages/settings/SecuritySettingsPage')) },
        ],
      },

      // core
      { path: '*', ...page(() => import('./pages/errors/NotFoundPage')) },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
