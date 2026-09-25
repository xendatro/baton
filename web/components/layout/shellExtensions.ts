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
];
