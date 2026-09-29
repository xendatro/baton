import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { Label } from '@shared/schemas/projects';
import type { TaskCard } from '@shared/schemas/tasks';
import { errorMessage } from '@web/lib/api';
import { useProjectAccess } from '@web/lib/permissions';
import { NewLabelDialog } from '../project-settings/LabelDialog';
import { LabelsSubmenu, type LabelsMenuKind } from '../projects/LabelsSubmenu';
import { useToggleTaskLabel } from './queries';

/**
 * A task's "Labels ›" submenu (BAT-40) for its right-click menu or its page's "…" menu, and the
 * New label dialog it opens (render `dialog` outside the menu: the menu closes first). Toggles
 * apply at once and toast on failure; a label created there is added to the task. `submenu` is
 * null when the viewer may not change the task (`enabled`).
 */
export function useTaskLabelsMenu(
  task: Pick<TaskCard, 'id' | 'projectId' | 'teamId' | 'ref' | 'labels'>,
  menu: LabelsMenuKind,
  enabled: boolean,
): { submenu: ReactNode; dialog: ReactNode } {
  const access = useProjectAccess(task.teamId, task.projectId);
  const toggle = useToggleTaskLabel(task);
  const [creating, setCreating] = useState(false);

  const apply = (label: Pick<Label, 'id' | 'name' | 'color'>, add: boolean) =>
    toggle.mutate(
      { label: { id: label.id, name: label.name, color: label.color }, add },
      {
        onError: (error) =>
          toast.error(
            errorMessage(
              error,
              add ? `Couldn’t add ${label.name} to ${task.ref}.` : `Couldn’t remove ${label.name}.`,
            ),
          ),
      },
    );

  return {
    submenu: enabled ? (
      <LabelsSubmenu
        menu={menu}
        projectId={task.projectId}
        selected={task.labels.map((label) => label.id)}
        onToggle={apply}
        onNewLabel={access.has('MANAGE_LABELS') ? () => setCreating(true) : undefined}
      />
    ) : null,
    dialog: creating ? (
      <NewLabelDialog
        projectId={task.projectId}
        open
        onClose={() => setCreating(false)}
        onCreated={(label) => apply(label, true)}
      />
    ) : null,
  };
}
