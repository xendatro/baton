import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { PRIORITIES, type PriorityValue } from '@shared/constants';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem, CommandShortcut } from '@web/components/ui/command';
import { PickerShell, type PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface PriorityPickerProps extends PickerControlProps {
  value: PriorityValue;
  onChange: (priority: PriorityValue) => void;
}

/** Urgent first, like Linear; digits 0–4 appear as hints next to each option. */
const ORDER = [...PRIORITIES].sort((a, b) => {
  if (a.value === 0) return 1;
  if (b.value === 0) return -1;
  return b.value - a.value;
});

export function PriorityPicker({
  value,
  onChange,
  open,
  onOpenChange,
  disabled,
  children,
  align,
}: PriorityPickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const trigger = children ?? (
    <Button variant="outline" size="sm" disabled={disabled}>
      <PriorityIcon value={value} showLabel />
      <ChevronDownIcon className="opacity-50" aria-hidden="true" />
    </Button>
  );
  return (
    <PickerShell
      open={isOpen}
      onOpenChange={setOpen}
      trigger={trigger}
      searchPlaceholder="Set priority…"
      className="w-52"
      align={align}
    >
      <CommandGroup>
        {ORDER.map((priority) => (
          <CommandItem
            key={priority.value}
            value={`${priority.label} ${priority.key} ${priority.value}`}
            onSelect={() => {
              onChange(priority.value);
              setOpen(false);
            }}
          >
            <PriorityIcon value={priority.value} showLabel />
            {priority.value === value ? (
              <CheckIcon className="ml-auto" aria-label="selected" />
            ) : (
              <CommandShortcut>{priority.value}</CommandShortcut>
            )}
          </CommandItem>
        ))}
      </CommandGroup>
    </PickerShell>
  );
}
