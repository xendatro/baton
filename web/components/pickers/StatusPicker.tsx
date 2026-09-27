import { CheckIcon, ChevronDownIcon, LockIcon } from 'lucide-react';
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
  /**
   * Why the task can't move to some statuses (pipeline rules, design §5): status id → reason,
   * shown under the status. They stay selectable (an administrator may force the move).
   */
  reasons?: Readonly<Record<string, string>>;
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
  reasons,
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
      className={reasons && Object.keys(reasons).length > 0 ? 'w-80' : undefined}
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
            {reasons?.[status.id] ? (
              <span className="grid min-w-0">
                <span className="truncate text-muted-foreground">{status.name}</span>
                <span className="flex items-start gap-1 text-xs text-muted-foreground">
                  <LockIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span className="line-clamp-2">
                    <span className="sr-only">Blocked: </span>
                    {reasons[status.id]}
                  </span>
                </span>
              </span>
            ) : (
              <span className="truncate">{status.name}</span>
            )}
            {status.id === value ? <CheckIcon className="ml-auto" aria-label="selected" /> : null}
          </CommandItem>
        ))}
      </CommandGroup>
    </PickerShell>
  );
}
