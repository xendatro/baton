import { inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { parseRef } from '@shared/refs';
import type { Actor, AppDeps } from '../context';
import * as s from '../db/schema';
import { AppError, errors, isAppError } from '../lib/errors';
import { absoluteUrl } from '../lib/urls';
import { parseInput, type ValidationIssue } from '../lib/validate';
import { requireProjectAccess } from '../services/access';
import { findItem, type ItemType } from '../services/items';
import { refFromAppUrl, resolveIssue, resolveTask } from '../services/refs';

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

// ---------------------------------------------------------------------------------------------
// Team-qualified refs
// ---------------------------------------------------------------------------------------------

/**
 * `team-slug/KEY-12` for a `KEY-12` / `KEY#51` / `KEY` ref (refs that already name a team are
 * returned as is). MCP results carry qualified refs: a short ref stops resolving as soon as
 * another of the caller's teams uses the same project key.
 */
export function qualifyRef(teamSlug: string, ref: string): string;
export function qualifyRef(teamSlug: string, ref: string | null): string | null;
export function qualifyRef(teamSlug: string, ref: string | null): string | null {
  if (ref === null || ref.includes('/')) return ref;
  return `${teamSlug}/${ref}`;
}

/** Slugs of the given teams by id (deleted teams included). */
export function teamSlugs(deps: Pick<AppDeps, 'db'>, teamIds: Iterable<string>) {
  const ids = [...new Set(teamIds)];
  const slugs = new Map<string, string>();
  if (ids.length === 0) return slugs;
  for (const row of deps.db.orm
    .select({ id: s.team.id, slug: s.team.slug })
    .from(s.team)
    .where(inArray(s.team.id, ids))
    .all()) {
    slugs.set(row.id, row.slug);
  }
  return slugs;
}

/** Adds `teamSlug` and qualifies `ref` on entities that carry a `teamId`. */
export function withQualifiedRefs<T extends { teamId: string; ref: string | null }>(
  deps: Pick<AppDeps, 'db'>,
  items: readonly T[],
): (T & { teamSlug: string })[] {
  const slugs = teamSlugs(
    deps,
    items.map((item) => item.teamId),
  );
  return items.map((item) => {
    const teamSlug = slugs.get(item.teamId) ?? '';
    return { ...item, teamSlug, ref: teamSlug ? qualifyRef(teamSlug, item.ref) : item.ref };
  });
}

// ---------------------------------------------------------------------------------------------
// Validation with the tool's parameter names
// ---------------------------------------------------------------------------------------------

/**
 * `parseInput` for a tool that maps its parameters onto a shared (REST) schema: validation errors
 * name the tool's parameters (`assignees`, `status`) rather than the schema's fields
 * (`assigneeUsers`, `statusId`), since those are what the agent sent.
 */
export function parseToolInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  fieldNames: Readonly<Record<string, string>>,
): z.output<T> {
  try {
    return parseInput(schema, input);
  } catch (error) {
    throw renameFields(error, fieldNames);
  }
}

/** Rewrites the field paths of a validation error (`details.issues`) with the tool's names. */
export function renameFields(error: unknown, fieldNames: Readonly<Record<string, string>>) {
  if (!isAppError(error) || error.code !== 'validation_failed') return error;
  const details = error.details as { issues?: ValidationIssue[] } | undefined;
  if (!details?.issues) return error;
  const rename = (path: string) => {
    const [head = '', ...rest] = path.split('.');
    return [fieldNames[head] ?? head, ...rest].join('.');
  };
  const issues = details.issues.map((issue) => ({ ...issue, path: rename(issue.path) }));
  const [first] = issues;
  const message = first
    ? first.path
      ? `${first.path}: ${first.message}`
      : first.message
    : error.message;
  return new AppError(error.code, error.status, message, { ...details, issues });
}

// ---------------------------------------------------------------------------------------------
// Item refs
// ---------------------------------------------------------------------------------------------

export interface ItemRef {
  type: ItemType;
  id: string;
}

/**
 * Resolves a task or issue ref (`KEY-12`, `KEY#51`, `team/KEY-12`, or an id of either) within the
 * caller's teams.
 */
export function resolveItemRef(deps: Pick<AppDeps, 'db'>, actor: Actor, ref: string): ItemRef {
  const parsed = parseRef(refFromAppUrl(ref));
  if (parsed?.kind === 'task') return { type: 'task', id: resolveTask(deps, actor, ref).task.id };
  if (parsed?.kind === 'issue') {
    return { type: 'issue', id: resolveIssue(deps, actor, ref).issue.id };
  }
  const value = ref.trim();
  if (parsed?.kind === 'project') {
    throw errors.validation(
      `"${value}" is a project ref; pass a task (KEY-12) or an issue (KEY#51)`,
    );
  }
  for (const type of ['task', 'issue'] as const) {
    const item = findItem(deps.db.orm, type, value);
    if (item) {
      requireProjectAccess(deps.db.orm, actor, item.projectId, 'Item');
      return { type, id: item.id };
    }
  }
  throw errors.notFoundWith(
    `Task or issue not found: "${value}". Use KEY-12 (task), KEY#51 (issue), team-slug/ before either, or an id`,
    { ref: value },
  );
}

/**
 * Rewords a project-restore key conflict (`details: { key, suggestion }`, raised when a live
 * project took the deleted project's key) with the tool call that fixes it.
 */
export function withKeyConflictHint<T>(run: () => T, hint: (suggestion: string) => string): T {
  try {
    return run();
  } catch (error) {
    if (isAppError(error) && error.code === 'conflict') {
      const details = error.details as { key?: unknown; suggestion?: unknown } | undefined;
      if (typeof details?.key === 'string' && typeof details.suggestion === 'string') {
        throw errors.conflict(
          `Another project now uses the key ${details.key}. ${hint(details.suggestion)}`,
          details,
        );
      }
    }
    throw error;
  }
}
