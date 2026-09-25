import { differenceInCalendarDays, format, isSameYear } from 'date-fns';
import type { ActivityEntry } from '@shared/schemas/core';

export interface DayGroup {
  /** `YYYY-MM-DD` in the viewer's time zone. */
  day: string;
  /** "Today", "Yesterday", "Wednesday, September 23" (plus the year when it isn't this year). */
  label: string;
  entries: ActivityEntry[];
}

export function dayLabel(date: Date, now: Date = new Date()): string {
  const days = differenceInCalendarDays(now, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return format(date, isSameYear(date, now) ? 'EEEE, MMMM d' : 'EEEE, MMMM d, yyyy');
}

/** Groups newest-first entries by local calendar day, keeping their order. */
export function groupByDay(entries: readonly ActivityEntry[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const date = new Date(entry.createdAt);
    const day = format(date, 'yyyy-MM-dd');
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, label: dayLabel(date, now), entries: [entry] });
  }
  return groups;
}
