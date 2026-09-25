import { addDays, format, isValid, parse } from 'date-fns';
import { ACTIVITY_ENTITY_TYPES, ACTOR_SOURCES } from '@shared/constants';
import type { ActivityEntityType, ActorSource } from '@shared/constants';
import type { AuditLogQuery } from '@shared/schemas/core';
import { idSchema } from '@shared/schemas/common';

/**
 * Audit log filters as they live in the URL (`?actor=…&source=mcp&from=2026-09-01`) and as the
 * API wants them. Dates are calendar days in the viewer's time zone: `from` is inclusive, `to`
 * includes the whole day (the API's `to` is exclusive, so it gets the next midnight).
 */

export interface AuditFilters {
  actor: string | null;
  source: ActorSource | null;
  key: string | null;
  entity: ActivityEntityType | null;
  /** Exact action (`task.created`) or a prefix ending in a dot (`task.`). */
  action: string | null;
  project: string | null;
  /** `YYYY-MM-DD`. */
  from: string | null;
  /** `YYYY-MM-DD`, inclusive. */
  to: string | null;
}

export const FILTER_KEYS = [
  'actor',
  'source',
  'key',
  'entity',
  'action',
  'project',
  'from',
  'to',
] as const satisfies ReadonlyArray<keyof AuditFilters>;

export const EMPTY_FILTERS: AuditFilters = {
  actor: null,
  source: null,
  key: null,
  entity: null,
  action: null,
  project: null,
  from: null,
  to: null,
};

const ACTION_PATTERN = /^[a-z_]+(?:\.[a-z_.]*)?$/;

function oneOf<T extends string>(values: readonly T[], value: string | null): T | null {
  return value !== null && (values as readonly string[]).includes(value) ? (value as T) : null;
}

function validId(value: string | null): string | null {
  return value !== null && idSchema.safeParse(value).success ? value : null;
}

/** Parses `YYYY-MM-DD` as a local calendar day; null when it isn't one. */
export function parseDay(value: string | null): Date | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = parse(value, 'yyyy-MM-dd', new Date());
  return isValid(date) && format(date, 'yyyy-MM-dd') === value ? date : null;
}

export function formatDay(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** Reads the filters from URL search params, dropping anything malformed. */
export function readFilters(params: URLSearchParams): AuditFilters {
  const action = params.get('action');
  const from = params.get('from');
  const to = params.get('to');
  return {
    actor: validId(params.get('actor')),
    source: oneOf(ACTOR_SOURCES, params.get('source')),
    key: validId(params.get('key')),
    entity: oneOf(ACTIVITY_ENTITY_TYPES, params.get('entity')),
    action: action !== null && action.length <= 64 && ACTION_PATTERN.test(action) ? action : null,
    project: validId(params.get('project')),
    from: parseDay(from) ? from : null,
    to: parseDay(to) ? to : null,
  };
}

/** Writes the filters into `params` (other params are kept; empty filters are removed). */
export function writeFilters(params: URLSearchParams, filters: AuditFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

export function activeFilterCount(filters: AuditFilters): number {
  const { from, to, ...rest } = filters;
  return Object.values(rest).filter((value) => value !== null).length + (from || to ? 1 : 0);
}

/** The API query for the filters (without pagination). */
export function toApiQuery(filters: AuditFilters): Omit<AuditLogQuery, 'limit' | 'cursor'> {
  const from = parseDay(filters.from);
  const to = parseDay(filters.to);
  return {
    ...(filters.actor ? { actorId: filters.actor } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.key ? { keyId: filters.key } : {}),
    ...(filters.entity ? { entityType: filters.entity } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.project ? { projectId: filters.project } : {}),
    ...(from ? { from: from.toISOString() } : {}),
    ...(to ? { to: addDays(to, 1).toISOString() } : {}),
  };
}

function shortDay(date: Date, now: Date): string {
  return format(date, date.getFullYear() === now.getFullYear() ? 'MMM d' : 'MMM d, yyyy');
}

/** "Sep 3 – Sep 9", "Since Sep 3", "Until Sep 9", "Sep 3". */
export function describeRange(
  from: string | null,
  to: string | null,
  now = new Date(),
): string | null {
  const start = parseDay(from);
  const end = parseDay(to);
  if (start && end) {
    return from === to ? shortDay(start, now) : `${shortDay(start, now)} – ${shortDay(end, now)}`;
  }
  if (start) return `Since ${shortDay(start, now)}`;
  if (end) return `Until ${shortDay(end, now)}`;
  return null;
}
