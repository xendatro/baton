import { differenceInCalendarDays, format, formatDistanceToNowStrict, parseISO } from 'date-fns';

/** Display formatting shared by every page. Dates are shown in the viewer's time zone. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function toDate(value: Date | string): Date {
  return typeof value === 'string' ? parseISO(value) : value;
}

/** "just now", "4m ago", "3h ago", "2d ago", then a date ("Mar 4" or "Mar 4, 2025"). */
export function formatRelative(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatShortDate(date, now);
}

/** "Mar 4" this year, "Mar 4, 2025" otherwise. */
export function formatShortDate(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  return format(date, date.getFullYear() === now.getFullYear() ? 'MMM d' : 'MMM d, yyyy');
}

/** Full timestamp for tooltips: "Mar 4, 2026, 3:12 PM". */
export function formatDateTime(value: Date | string): string {
  return format(toDate(value), 'PPp');
}

/** Age of a claim or event without "ago": "4m", "2h". */
export function formatAge(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  if (now.getTime() - date.getTime() < 60_000) return 'now';
  return formatDistanceToNowStrict(date, { roundingMethod: 'floor' })
    .replace(/ seconds?/, 's')
    .replace(/ minutes?/, 'm')
    .replace(/ hours?/, 'h')
    .replace(/ days?/, 'd')
    .replace(/ months?/, 'mo')
    .replace(/ years?/, 'y');
}

// ---------------------------------------------------------------------------------------------
// Due dates (`YYYY-MM-DD`, calendar dates without a time zone)
// ---------------------------------------------------------------------------------------------

/** Today as `YYYY-MM-DD` in the viewer's time zone. */
export function todayIso(now: Date = new Date()): string {
  return format(now, 'yyyy-MM-dd');
}

/** Parses `YYYY-MM-DD` as a local calendar date. */
export function parseDueDate(value: string): Date {
  const [year = 1970, month = 1, day = 1] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function toDueDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** Days from today until the due date (negative when overdue). */
export function daysUntil(dueDate: string, now: Date = new Date()): number {
  return differenceInCalendarDays(parseDueDate(dueDate), now);
}

/** "Today", "Tomorrow", "Yesterday", "Mar 4" or "Mar 4, 2027". */
export function formatDueDate(dueDate: string, now: Date = new Date()): string {
  const days = daysUntil(dueDate, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return formatShortDate(parseDueDate(dueDate), now);
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

/** Up to two initials from a display name ("Ada Lovelace" → "AL"), falling back to the username. */
export function initials(name: string, fallback = '?'): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback.slice(0, 2).toUpperCase();
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words.at(-1) ?? '')[0] ?? '') : '';
  return (first + last).toUpperCase() || fallback.slice(0, 2).toUpperCase();
}

/** Deterministic avatar hue (0–359) for a seed such as a user id. */
export function hueFromString(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
