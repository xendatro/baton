import type { Permission } from '@shared/permissions';
import { useMe } from './auth';

/**
 * The viewer's permissions in a team, from `GET /api/me` (already effective: owners and
 * administrators get every permission). The server enforces permissions; the UI only uses these
 * to hide actions the viewer can't take.
 */
export interface TeamAccess {
  userId: string | null;
  isOwner: boolean;
  isMember: boolean;
  has: (permission: Permission) => boolean;
  /** Authors can always edit/delete their own content; others need the `…_ANY_CONTENT` permission. */
  canEdit: (authorId: string | null | undefined) => boolean;
  canDelete: (authorId: string | null | undefined) => boolean;
}

export function useTeamAccess(teamId: string | null | undefined): TeamAccess {
  const me = useMe().data;
  const team = teamId ? me?.teams.find((candidate) => candidate.id === teamId) : undefined;
  const userId = me?.user.id ?? null;
  const permissions = new Set<Permission>(team?.permissions ?? []);
  const has = (permission: Permission) => permissions.has(permission);
  const isAuthor = (authorId: string | null | undefined) =>
    userId !== null && authorId !== null && authorId !== undefined && authorId === userId;
  return {
    userId,
    isOwner: team?.isOwner ?? false,
    isMember: team !== undefined,
    has,
    canEdit: (authorId) => isAuthor(authorId) || has('EDIT_ANY_CONTENT'),
    canDelete: (authorId) => isAuthor(authorId) || has('DELETE_ANY_CONTENT'),
  };
}
