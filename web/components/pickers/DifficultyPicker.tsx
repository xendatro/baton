import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { TaskDifficultySummary } from '@shared/schemas/tasks';
import { DifficultyBadge } from '@web/components/common/DifficultyBadge';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import { PickerShell, type PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface DifficultyPickerProps extends PickerControlProps {
  /** The project's levels, easiest first. */
  levels: ReadonlyArray<Pick<TaskDifficultySummary, 'id' | 'name' | 'color'>>;
  /** Level id, or null for none. */
  value: string | null;
  onChange: (difficultyId: string | null) => void;
}

/**
 * Picks a task's difficulty level (BAT-24): the project's levels easiest first, and "No
 * difficulty" (each person's agent then uses their default model).
 */
export function DifficultyPicker({
  levels,
  value,
  onChange,
  open,
  onOpenChange,
  disabled,
  children,
  align,
}: DifficultyPickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const current = levels.find((level) => level.id === value) ?? null;
  const trigger = children ?? (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={`Difficulty: ${current?.name ?? 'none'}`}
    >
      <DifficultyBadge difficulty={current} />
      <ChevronDownIcon className="opacity-50" aria-hidden="true" />
    </Button>
  );
  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <PickerShell
      open={isOpen}
      onOpenChange={setOpen}
      trigger={trigger}
      searchPlaceholder="Set difficulty…"
      className="w-52"
      align={align}
    >
      <CommandGroup>
        {levels.map((level) => (
          <CommandItem
            key={level.id}
            value={level.id}
            keywords={[level.name]}
            onSelect={() => pick(level.id)}
          >
            <DifficultyBadge difficulty={level} />
            {level.id === value ? <CheckIcon className="ml-auto" aria-label="selected" /> : null}
          </CommandItem>
        ))}
        <CommandItem
          value="none"
          keywords={['none', 'no difficulty', 'default']}
          onSelect={() => pick(null)}
        >
          <DifficultyBadge difficulty={null} />
          {value === null ? <CheckIcon className="ml-auto" aria-label="selected" /> : null}
        </CommandItem>
      </CommandGroup>
    </PickerShell>
  );
}
