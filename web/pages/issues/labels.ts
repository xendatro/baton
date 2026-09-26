import { COLOR_PALETTE } from '@shared/constants';
import type { Label } from '@shared/schemas/projects';
import { hueFromString } from '@web/lib/format';
import { useCreateLabel } from '@web/pages/projects/queries';

/** A palette color picked from the name, so labels created on the fly aren't all gray. */
export function labelColorFor(name: string): string {
  const colors = COLOR_PALETTE.filter((color) => color.name !== 'Gray');
  const color = colors[hueFromString(name.toLowerCase()) % colors.length] ?? COLOR_PALETTE[0];
  return color.hex;
}

/**
 * "Create label …" for the label pickers: creates the label in the project (`MANAGE_LABELS`)
 * and returns it so the picker selects it. Undefined without the permission.
 */
export function useCreateLabelOption(
  projectId: string,
  canManageLabels: boolean,
): ((name: string) => Promise<Label>) | undefined {
  const create = useCreateLabel(projectId);
  if (!canManageLabels) return undefined;
  return (name) => create.mutateAsync({ name, color: labelColorFor(name) });
}
