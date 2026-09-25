import { matchPath } from 'react-router';
import type { MeResponse } from '@shared/schemas/core';
import { findProject, findTeam } from '@web/lib/routeContext';

/**
 * Route-driven breadcrumbs and document titles. Each crumb is derived from the URL and named
 * through the `me` query (team and project names); the last crumb is the current page.
 */

export interface Crumb {
  label: string;
  /** Link target; absent for the current page. */
  to?: string;
}

const SETTINGS_LABELS: Record<string, string> = {
  general: 'General',
  members: 'Members',
  roles: 'Roles',
  invites: 'Invites',
  'audit-log': 'Audit log',
  trash: 'Trash',
  statuses: 'Statuses',
  labels: 'Labels',
  profile: 'Profile',
  account: 'Account',
  connections: 'Connections',
  'api-keys': 'API keys',
  appearance: 'Appearance',
  security: 'Security',
};

function settingsLabel(section: string | undefined): string {
  if (!section) return 'Settings';
  return SETTINGS_LABELS[section] ?? section;
}

export function buildCrumbs(pathname: string, me: MeResponse | undefined): Crumb[] {
  if (pathname === '/') return [{ label: 'Dashboard' }];
  if (pathname === '/inbox') return [{ label: 'Inbox' }];
  if (pathname === '/my-tasks') return [{ label: 'My tasks' }];
  if (matchPath('/join/:code', pathname)) return [{ label: 'Join a team' }];

  const account = matchPath('/settings/:section?', pathname);
  if (account) {
    return [
      { label: 'Settings', to: '/settings' },
      { label: settingsLabel(account.params.section) },
    ];
  }

  const teamMatch = matchPath({ path: '/t/:team', end: false }, pathname);
  if (!teamMatch) return [];
  const slug = teamMatch.params.team ?? '';
  const team = me ? findTeam(me.teams, slug) : null;
  const teamBase = `/t/${slug}`;
  const crumbs: Crumb[] = [{ label: team?.name ?? slug, to: teamBase }];

  const teamSettings = matchPath('/t/:team/settings/*', pathname);
  if (teamSettings) {
    const [section, sub] = (teamSettings.params['*'] ?? '').split('/');
    crumbs.push({ label: 'Settings', to: `${teamBase}/settings` });
    if (section === 'roles' && sub) {
      crumbs.push({ label: 'Roles', to: `${teamBase}/settings/roles` }, { label: 'Edit role' });
    } else {
      crumbs.push({ label: settingsLabel(section) });
    }
    return lastIsCurrent(crumbs);
  }

  const projectMatch = matchPath({ path: '/t/:team/p/:key', end: false }, pathname);
  if (!projectMatch) return lastIsCurrent(crumbs);
  const key = (projectMatch.params.key ?? '').toUpperCase();
  const project = findProject(team, key);
  const projectBase = `${teamBase}/p/${projectMatch.params.key ?? key}`;
  crumbs.push({ label: project?.name ?? key, to: projectBase });

  const rest = pathname.slice(projectMatch.pathnameBase.length).split('/').filter(Boolean);
  const [area, detail, extra] = rest;
  if (area === 'tasks') {
    crumbs.push({ label: 'Tasks', to: `${projectBase}/tasks` });
    if (detail) crumbs.push({ label: `${key}-${detail}` });
  } else if (area === 'issues') {
    crumbs.push({ label: 'Issues', to: `${projectBase}/issues` });
    if (detail === 'new') crumbs.push({ label: 'New issue' });
    else if (detail) crumbs.push({ label: `${key}#${detail}` });
  } else if (area === 'settings') {
    crumbs.push({ label: 'Settings', to: `${projectBase}/settings` });
    crumbs.push({ label: settingsLabel(detail) });
  } else if (area) {
    crumbs.push({ label: extra ?? area });
  }
  return lastIsCurrent(crumbs);
}

function lastIsCurrent(crumbs: Crumb[]): Crumb[] {
  const last = crumbs.at(-1);
  if (last) crumbs[crumbs.length - 1] = { label: last.label };
  return crumbs;
}

/**
 * Title parts, most specific first (SPEC §6: `<page> · <project> · Baton`): the current page,
 * then the project (or the team outside projects).
 */
export function titleParts(crumbs: readonly Crumb[], pathname: string): string[] {
  if (crumbs.length === 0) return [];
  const page = crumbs.at(-1)?.label;
  if (!pathname.startsWith('/t/')) return page ? [page] : [];
  const context = crumbs.length >= 2 && pathname.includes('/p/') ? crumbs[1] : crumbs[0];
  if (!context || context.label === page) return page ? [page] : [];
  return [page ?? '', context.label];
}
