import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { StatusBadge, StatusIcon, type StatusLike } from '@web/components/common/StatusBadge';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import { PickerShell, type PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface StatusOption extends StatusLike {
  id: string;
}

export interface StatusPickerProps extends PickerControlProps {
  /** In display order. */
  statuses: readonly StatusOption[];
  value: string | null;
  onChange: (statusId: string) => void;
}

export function StatusPicker({
  statuses,
  value,
  onChange,
  open,
  onOpenChange,
  disabled,
  children,
  align,
}: StatusPickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const current = statuses.find((status) => status.id === value) ?? null;
  const trigger = children ?? (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={current ? `Status: ${current.name}` : 'Set status'}
    >
      {current ? <StatusBadge status={current} /> : 'Status'}
      <ChevronDownIcon className="opacity-50" aria-hidden="true" />
    </Button>
  );
  return (
    <PickerShell
      open={isOpen}
      onOpenChange={setOpen}
      trigger={trigger}
      searchPlaceholder="Change status…"
      align={align}
    >
      <CommandGroup>
        {statuses.map((status) => (
          <CommandItem
            key={status.id}
            value={status.id}
            keywords={[status.name]}
            onSelect={() => {
              onChange(status.id);
              setOpen(false);
            }}
          >
            <StatusIcon status={status} />
            <span className="truncate">{status.name}</span>
            {status.id === value ? <CheckIcon className="ml-auto" aria-label="selected" /> : null}
          </CommandItem>
        ))}
      </CommandGroup>
    </PickerShell>
  );
}
