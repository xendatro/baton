/**
 * One label added to or removed from an issue or task (the Labels submenu of the right-click
 * menus, BAT-40): applied to cached copies at once, and undone by the opposite toggle.
 */
export interface LabelToggle<L extends { id: string; name: string }> {
  label: L;
  add: boolean;
}

/** `labels` with the toggle applied (idempotent), sorted by name like the server's. */
export function toggleLabel<L extends { id: string; name: string }>(
  labels: readonly L[],
  toggle: LabelToggle<L>,
): L[] {
  const without = labels.filter((label) => label.id !== toggle.label.id);
  const next = toggle.add ? [...without, toggle.label] : without;
  return next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
