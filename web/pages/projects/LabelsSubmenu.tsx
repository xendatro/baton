import { PlusIcon, TagIcon } from 'lucide-react';
import type { Label } from '@shared/schemas/projects';
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@web/components/ui/context-menu';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@web/components/ui/dropdown-menu';
import { useLabels } from './queries';

/** Which menu the submenu sits in: a right-click menu or a "…" dropdown. */
export type LabelsMenuKind = 'context' | 'dropdown';

const PARTS = {
  context: {
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
    CheckboxItem: ContextMenuCheckboxItem,
    Item: ContextMenuItem,
    Separator: ContextMenuSeparator,
  },
  dropdown: {
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
    CheckboxItem: DropdownMenuCheckboxItem,
    Item: DropdownMenuItem,
    Separator: DropdownMenuSeparator,
  },
} as const;

interface LabelsSubmenuProps {
  menu: LabelsMenuKind;
  projectId: string;
  /** Ids of the labels the issue or task has. */
  selected: readonly string[];
  /** Adds (`add`) or removes the label; the caller applies it at once. */
  onToggle: (label: Label, add: boolean) => void;
  /** "New label…" (the viewer can manage labels): opens the create-label dialog. */
  onNewLabel?: (() => void) | undefined;
}

/**
 * "Labels ›" in an issue's or task's menus (BAT-40): the project's labels as checkable items
 * (color swatch and name); checking one applies it right away and the submenu stays open for the
 * next. The labels load when the submenu first opens.
 */
export function LabelsSubmenu({ menu, ...props }: LabelsSubmenuProps) {
  const { Sub, SubTrigger, SubContent } = PARTS[menu];
  return (
    <Sub>
      <SubTrigger>
        <TagIcon aria-hidden="true" />
        Labels
      </SubTrigger>
      <SubContent className="max-h-80 w-56 overflow-y-auto" aria-label="Labels">
        <LabelItems menu={menu} {...props} />
      </SubContent>
    </Sub>
  );
}

function LabelItems({ menu, projectId, selected, onToggle, onNewLabel }: LabelsSubmenuProps) {
  const { CheckboxItem, Item, Separator } = PARTS[menu];
  const labels = useLabels(projectId);
  const items = labels.data ?? [];
  return (
    <>
      {labels.isPending ? (
        <Item disabled>Loading labels…</Item>
      ) : labels.isError ? (
        <Item disabled>Couldn’t load the labels</Item>
      ) : items.length === 0 ? (
        <Item disabled>No labels yet</Item>
      ) : (
        items.map((label) => {
          const checked = selected.includes(label.id);
          return (
            <CheckboxItem
              key={label.id}
              checked={checked}
              // Stay open, so several labels can be toggled in a row.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => onToggle(label, on === true)}
              title={label.description || undefined}
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full border border-black/10 dark:border-white/15"
                style={{ backgroundColor: label.color }}
              />
              <span className="truncate">{label.name}</span>
            </CheckboxItem>
          );
        })
      )}
      {onNewLabel ? (
        <>
          <Separator />
          <Item onSelect={onNewLabel}>
            <PlusIcon aria-hidden="true" />
            New label…
          </Item>
        </>
      ) : null}
    </>
  );
}
