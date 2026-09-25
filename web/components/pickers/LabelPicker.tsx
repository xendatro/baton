import { PlusIcon, TagIcon } from 'lucide-react';
import { useState } from 'react';
import { LabelChip } from '@web/components/common/LabelChip';
import { Button } from '@web/components/ui/button';
import { CommandGroup, CommandItem } from '@web/components/ui/command';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';
import { toast } from 'sonner';
import { CheckBox, PickerShell, type PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface LabelOption {
  id: string;
  name: string;
  color: string;
  description?: string | null;
}

export interface LabelPickerProps extends PickerControlProps {
  labels: readonly LabelOption[];
  /** Selected label ids. */
  value: readonly string[];
  onChange: (labelIds: string[]) => void;
  /**
   * Offers "Create label …" for a search that matches no label. The new label is selected when
   * the callback returns it.
   */
  onCreate?: (name: string) => Promise<LabelOption | void> | LabelOption | void;
}

/** Multi-select label picker; the popover stays open while toggling. */
export function LabelPicker({
  labels,
  value,
  onChange,
  onCreate,
  open,
  onOpenChange,
  disabled,
  children,
  align,
}: LabelPickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const selected = labels.filter((label) => value.includes(label.id));
  const query = search.trim();
  const exact = labels.some((label) => label.name.toLowerCase() === query.toLowerCase());

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);

  async function create() {
    if (!onCreate || !query || creating) return;
    setCreating(true);
    try {
      const label = await onCreate(query);
      if (label) onChange([...value, label.id]);
      setSearch('');
    } catch (error) {
      toast.error(errorMessage(error, 'Couldn’t create the label.'));
    } finally {
      setCreating(false);
    }
  }

  const trigger = children ?? (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      className={cn(
        'h-auto min-h-8 max-w-full flex-wrap justify-start py-1',
        selected.length && 'px-2',
      )}
      aria-label={
        selected.length ? `Labels: ${selected.map((l) => l.name).join(', ')}` : 'Add labels'
      }
    >
      {selected.length ? (
        selected.map((label) => <LabelChip key={label.id} label={label} />)
      ) : (
        <>
          <TagIcon aria-hidden="true" />
          Labels
        </>
      )}
    </Button>
  );

  return (
    <PickerShell
      open={isOpen}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
      trigger={trigger}
      searchPlaceholder={onCreate ? 'Find or create a label…' : 'Find a label…'}
      search={search}
      onSearchChange={setSearch}
      emptyText={onCreate ? 'No labels yet.' : 'No labels found.'}
      align={align}
    >
      {labels.length ? (
        <CommandGroup>
          {labels.map((label) => {
            const checked = value.includes(label.id);
            return (
              <CommandItem
                key={label.id}
                value={`${label.name} ${label.id}`}
                onSelect={() => toggle(label.id)}
              >
                <CheckBox checked={checked} />
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                <span className="truncate">{label.name}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      ) : null}
      {onCreate && query && !exact ? (
        <CommandGroup forceMount>
          <CommandItem
            forceMount
            value={`__create__ ${query}`}
            onSelect={() => void create()}
            disabled={creating}
          >
            <PlusIcon aria-hidden="true" />
            <span className="truncate">
              Create label <span className="font-medium">“{query}”</span>
            </span>
          </CommandItem>
        </CommandGroup>
      ) : null}
    </PickerShell>
  );
}
