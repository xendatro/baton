import { CheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Command, CommandEmpty, CommandInput, CommandList } from '@web/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';

export interface PickerControlProps {
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Custom trigger element (rendered with `asChild`); a default button is used otherwise. */
  children?: ReactNode;
  align?: 'start' | 'center' | 'end';
}

export interface PickerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  /** Accessible name of the list and placeholder of its search box. */
  searchPlaceholder: string;
  search?: string;
  onSearchChange?: (search: string) => void;
  emptyText?: string;
  align?: 'start' | 'center' | 'end';
  className?: string;
  children: ReactNode;
}

/** Popover with a searchable command list, shared by the pickers. */
export function PickerShell({
  open,
  onOpenChange,
  trigger,
  searchPlaceholder,
  search,
  onSearchChange,
  emptyText = 'No results.',
  align = 'start',
  className,
  children,
}: PickerShellProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={cn('w-64 p-0', className)} align={align}>
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={search}
            onValueChange={onSearchChange}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {children}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Checkbox look for multi-select items (cmdk items can't be real checkboxes). */
export function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-sm border',
        checked && 'border-primary bg-primary',
      )}
    >
      {checked ? <CheckIcon className="size-3 text-primary-foreground" aria-hidden="true" /> : null}
      {checked ? <span className="sr-only">(selected)</span> : null}
    </span>
  );
}
