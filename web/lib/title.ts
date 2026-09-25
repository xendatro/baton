import { useEffect } from 'react';

/**
 * Document titles (SPEC §6: `<page> · <project> · Baton`). The app shell sets a route-derived
 * default at priority 0; a page can override it with a more specific title (e.g. a task's title)
 * at the default priority 1. The highest priority wins; among equals, the latest registration.
 */

export const APP_NAME = 'Baton';

interface Entry {
  id: number;
  title: string;
  priority: number;
}

let entries: Entry[] = [];
let nextId = 1;

function apply(): void {
  let best: Entry | undefined;
  for (const entry of entries) {
    if (!best || entry.priority >= best.priority) best = entry;
  }
  document.title = best ? best.title : APP_NAME;
}

/** Joins title parts with ` · ` and appends the app name, skipping empty parts. */
export function formatTitle(parts: ReadonlyArray<string | null | undefined>): string {
  return [...parts.filter((part): part is string => Boolean(part)), APP_NAME].join(' · ');
}

/**
 * Sets the document title while mounted. `parts` go from specific to general, e.g.
 * `['Board', project.name]` → "Board · Web app · Baton". Pass null to leave the title alone.
 */
export function useDocumentTitle(
  parts: ReadonlyArray<string | null | undefined> | null,
  priority = 1,
): void {
  const title = parts === null ? null : formatTitle(parts);
  useEffect(() => {
    if (title === null) return;
    const entry: Entry = { id: nextId++, title, priority };
    entries = [...entries, entry];
    apply();
    return () => {
      entries = entries.filter((candidate) => candidate.id !== entry.id);
      apply();
    };
  }, [title, priority]);
}
