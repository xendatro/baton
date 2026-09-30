import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { IssueSummary } from '@shared/schemas/issues';
import type { Label } from '@shared/schemas/projects';
import { errorMessage } from '@web/lib/api';
import { useProjectAccess } from '@web/lib/permissions';
import { NewLabelDialog } from '../project-settings/LabelDialog';
import { LabelsSubmenu, type LabelsMenuKind } from '../projects/LabelsSubmenu';
import { useToggleIssueLabel } from './queries';

/**
 * An issue's "Labels ›" submenu (BAT-40) for its row's right-click menu or its page's "…" menu,
 * and the New label dialog it opens (render `dialog` outside the menu: the menu closes first).
 * Toggles apply at once and toast on failure; a label created there is added to the issue.
 * `submenu` is null when the viewer may not change its labels (`enabled`: its author, or
 * `RESOLVE_ISSUES`).
 */
export function useIssueLabelsMenu(
  issue: Pick<IssueSummary, 'id' | 'projectId' | 'teamId' | 'ref' | 'labels'>,
  menu: LabelsMenuKind,
  enabled: boolean,
): { submenu: ReactNode; dialog: ReactNode } {
  const access = useProjectAccess(issue.teamId, issue.projectId);
  const toggle = useToggleIssueLabel(issue);
  const [creating, setCreating] = useState(false);

  const apply = (label: Label, add: boolean) =>
    toggle.mutate(
      {
        label: {
          id: label.id,
          name: label.name,
          color: label.color,
          description: label.description,
        },
        add,
      },
      {
        onError: (error) =>
          toast.error(
            errorMessage(
              error,
              add
                ? `Couldn’t add ${label.name} to ${issue.ref}.`
                : `Couldn’t remove ${label.name}.`,
            ),
          ),
      },
    );

  return {
    submenu: enabled ? (
      <LabelsSubmenu
        menu={menu}
        projectId={issue.projectId}
        selected={issue.labels.map((label) => label.id)}
        onToggle={apply}
        onNewLabel={access.has('MANAGE_LABELS') ? () => setCreating(true) : undefined}
      />
    ) : null,
    dialog: creating ? (
      <NewLabelDialog
        projectId={issue.projectId}
        open
        onClose={() => setCreating(false)}
        onCreated={(label) => apply(label, true)}
      />
    ) : null,
  };
}
