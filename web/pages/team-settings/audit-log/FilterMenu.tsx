import { CheckIcon, ChevronDownIcon, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@web/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@web/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { commandFilter } from '@web/lib/commandFilter';
import { cn } from '@web/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
  /** Secondary text under or beside the label. */
  description?: string;
  /** Leading visual (avatar, icon). */
  leading?: ReactNode;
  /** Extra words the search matches. */
  keywords?: string[];
  /** Heading of the group the option is listed under. */
  group?: string;
}

export interface FilterMenuProps {
  /** Filter name, e.g. "Actor"; also the trigger text while nothing is chosen. */
  label: string;
  icon: LucideIcon;
  value: string | null;
  options: readonly FilterOption[];
  onChange: (value: string | null) => void;
  /** Trigger text for a value that isn't among the options (e.g. a deleted user). */
  unknownLabel?: string;
  searchPlaceholder?: string;
  loading?: boolean;
}

/** A searchable single-choice filter: a compact trigger button and a command list in a popover. */
export function FilterMenu({
  label,
  icon: Icon,
  value,
  options,
  onChange,
  unknownLabel = 'Unknown',
  searchPlaceholder,
  loading = false,
}: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const selected = value === null ? null : options.find((option) => option.value === value);
  const groups = new Map<string, FilterOption[]>();
  for (const option of options) {
    const group = option.group ?? '';
    groups.set(group, [...(groups.get(group) ?? []), option]);
  }

  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'max-w-full min-w-0 justify-start',
            value !== null && 'border-primary/40 bg-primary/5 dark:bg-primary/10',
          )}
          aria-label={
            value === null
              ? `Filter by ${label.toLowerCase()}`
              : `${label}: ${selected?.label ?? unknownLabel}`
          }
        >
          <Icon aria-hidden="true" className="text-muted-foreground" />
          {value === null ? (
            <span className="text-muted-foreground">{label}</span>
          ) : (
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">{label}: </span>
              {selected?.label ?? unknownLabel}
            </span>
          )}
          <ChevronDownIcon aria-hidden="true" className="ml-auto text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 max-w-[calc(100vw-2rem)] p-0"
        align="start"
        collisionPadding={16}
      >
        <Command filter={commandFilter}>
          <CommandInput
            placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
            aria-label={searchPlaceholder ?? `Search ${label.toLowerCase()}`}
          />
          <CommandList>
            <CommandEmpty>{loading ? 'Loading…' : 'No matches.'}</CommandEmpty>
            {value !== null ? (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__any__"
                    keywords={[`Any ${label.toLowerCase()}`, 'clear', 'all']}
                    onSelect={() => choose(null)}
                  >
                    <span className="text-muted-foreground">Any {label.toLowerCase()}</span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            {[...groups.entries()].map(([group, items]) => (
              <CommandGroup key={group || 'options'} heading={group || undefined}>
                {items.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[
                      option.label,
                      ...(option.description ? [option.description] : []),
                      ...(option.keywords ?? []),
                    ]}
                    onSelect={() => choose(option.value)}
                  >
                    {option.leading}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {option.value === value ? (
                      <CheckIcon aria-label="Selected" className="text-primary" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
