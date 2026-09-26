import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Components that feature modules mount inside the app shell (registration file, like
 * web/router.tsx). Use it for app-wide dialogs and handlers, for example the teams module's
 * "New team" dialog, which registers `useShellActionHandler('team.create', …)` (web/lib/shellActions.ts),
 * or the account module's `useThemePersister` (web/lib/theme.ts). Each entry is lazily loaded and
 * rendered once, for signed-in users, inside the router and query providers:
 *
 *   export const shellExtensions = [lazy(() => import('@web/pages/teams/NewTeamDialog'))];
 */
export const shellExtensions: ReadonlyArray<LazyExoticComponent<ComponentType>> = [
  // teams: the New team dialog (`team.create`)
  lazy(() => import('@web/pages/teams/NewTeamDialog')),
  // projects: "New project" dialog (`project.create`) and its palette command
  lazy(() => import('@web/pages/projects/NewProjectDialog')),
  // issues: `i` and the palette's "New issue" inside a project
  lazy(() => import('@web/pages/issues/IssuesShellExtension')),
  // tasks: the New task dialog (`task.create`, `c` in a project) and its palette command
  lazy(() => import('@web/pages/tasks/NewTaskDialog')),
  // admin: full-text search in the command palette
  lazy(() => import('@web/pages/admin/PaletteSearch')),
  // account: saves theme changes to the profile, settings palette commands
  lazy(() => import('@web/pages/settings/AccountShellExtension')),
];
