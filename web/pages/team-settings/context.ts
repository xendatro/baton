import { useOutletContext } from 'react-router';
import type { MeTeam } from '@shared/schemas/core';
import { useMe } from '@web/lib/auth';
import type { Viewer } from '@web/pages/teams/access';

/** What the team settings layout hands its pages (via the router outlet). */
export interface TeamSettingsContext {
  team: MeTeam;
}

/** The team whose settings are open (rendered inside `TeamSettingsLayout`). */
export function useSettingsTeam(): MeTeam {
  return useOutletContext<TeamSettingsContext>().team;
}

/** The signed-in user's standing in `team`, for the anti-escalation helpers. */
export function useViewer(team: MeTeam): Viewer {
  const userId = useMe().data?.user.id ?? '';
  return { userId, isOwner: team.isOwner, permissions: team.permissions };
}
