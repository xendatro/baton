import { useParams } from 'react-router';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import { useMe } from './auth';

/**
 * The team and project named by the current URL (`/t/:team/p/:key/…`), resolved through the
 * `me` query. Query keys use ids, so pages call these to turn the URL's slug and key into ids.
 */
export interface RouteContext {
  team: MeTeam | null;
  project: MeProject | null;
  /** True until `me` has loaded. */
  isLoading: boolean;
}

export function findTeam(teams: readonly MeTeam[], slug: string | undefined): MeTeam | null {
  if (!slug) return null;
  const lower = slug.toLowerCase();
  return teams.find((team) => team.slug === lower) ?? null;
}

export function findProject(team: MeTeam | null, key: string | undefined): MeProject | null {
  if (!team || !key) return null;
  const upper = key.toUpperCase();
  return team.projects.find((project) => project.key === upper) ?? null;
}

export function useRouteContext(): RouteContext {
  const params = useParams();
  const me = useMe();
  const team = me.data ? findTeam(me.data.teams, params.team) : null;
  return { team, project: findProject(team, params.key), isLoading: me.isPending };
}
