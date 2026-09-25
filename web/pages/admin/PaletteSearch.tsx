import {
  ListChecksIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  type LucideIcon,
} from 'lucide-react';
import type { SearchEntityType } from '@shared/constants';
import type { MeResponse } from '@shared/schemas/core';
import { useSearchProvider, type PaletteSearchResult } from '@web/components/palette/registry';
import { useMe } from '@web/lib/auth';
import { searchTerms } from '@web/lib/highlight';
import { searchAll } from './search';

/**
 * Admin module shell extension: full-text search in the command palette. Three providers (Tasks,
 * Issues, Replies) share one `GET /api/search` request per query; the palette debounces the
 * query and aborts stale searches.
 */

/** Results shown per group. */
const PER_GROUP = 6;

/** Project names by id: "Project", or "Project · Team" when the viewer is in several teams. */
function projectNames(me: MeResponse | undefined): Map<string, string> {
  const names = new Map<string, string>();
  const manyTeams = (me?.teams.length ?? 0) > 1;
  for (const team of me?.teams ?? []) {
    for (const project of team.projects) {
      names.set(project.id, manyTeams ? `${project.name} · ${team.name}` : project.name);
    }
  }
  return names;
}

function useGroupProvider(
  type: SearchEntityType,
  group: string,
  icon: LucideIcon,
  names: ReadonlyMap<string, string>,
) {
  useSearchProvider({
    id: `search.${type}`,
    group,
    search: async (query, signal) => {
      const results = await searchAll(query, signal);
      const highlight = searchTerms(query);
      return results
        .filter((result) => result.entityType === type)
        .slice(0, PER_GROUP)
        .map((result): PaletteSearchResult => ({
          id: result.entityId,
          label: result.title,
          ref: result.ref,
          ...(result.snippet ? { description: result.snippet } : {}),
          ...(names.has(result.projectId) ? { hint: names.get(result.projectId) } : {}),
          highlight,
          icon,
          // Replies open their thread at `#reply-<id>`.
          href: result.url,
        }));
    },
  });
}

export default function PaletteSearch() {
  const names = projectNames(useMe().data);
  useGroupProvider('task', 'Tasks', ListChecksIcon, names);
  useGroupProvider('issue', 'Issues', MessagesSquareIcon, names);
  useGroupProvider('reply', 'Replies', MessageSquareTextIcon, names);
  return null;
}
