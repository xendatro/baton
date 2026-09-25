import { parseRef } from '@shared/refs';
import type { Actor, AppDeps } from '../context';
import { errors } from '../lib/errors';
import { absoluteUrl } from '../lib/urls';
import { requireMember } from '../services/access';
import { findItem, type ItemType } from '../services/items';
import { resolveIssue, resolveTask } from '../services/refs';

/** Helpers shared by MCP tools: absolute URLs and item refs. */

/** Absolute URL for a relative app path (MCP results always carry absolute URLs). */
export function toAbsolute(deps: Pick<AppDeps, 'env'>, path: string): string;
export function toAbsolute(deps: Pick<AppDeps, 'env'>, path: string | null): string | null;
export function toAbsolute(deps: Pick<AppDeps, 'env'>, path: string | null): string | null {
  return path === null ? null : absoluteUrl(deps.env.baseUrl, path);
}

/** Rewrites the `url` field of each entry to an absolute URL. */
export function withAbsoluteUrls<T extends { url: string | null }>(
  deps: Pick<AppDeps, 'env'>,
  items: readonly T[],
): T[] {
  return items.map((item) => ({ ...item, url: toAbsolute(deps, item.url) }));
}

export interface ItemRef {
  type: ItemType;
  id: string;
}

/**
 * Resolves a task or issue ref (`KEY-12`, `KEY#51`, `team/KEY-12`, or an id of either) within the
 * caller's teams.
 */
export function resolveItemRef(deps: Pick<AppDeps, 'db'>, actor: Actor, ref: string): ItemRef {
  const parsed = parseRef(ref);
  if (parsed?.kind === 'task') return { type: 'task', id: resolveTask(deps, actor, ref).task.id };
  if (parsed?.kind === 'issue') {
    return { type: 'issue', id: resolveIssue(deps, actor, ref).issue.id };
  }
  const value = ref.trim();
  for (const type of ['task', 'issue'] as const) {
    const item = findItem(deps.db.orm, type, value);
    if (item) {
      requireMember(deps.db.orm, actor, item.teamId, 'Item');
      return { type, id: item.id };
    }
  }
  throw errors.notFound('Task or issue');
}
