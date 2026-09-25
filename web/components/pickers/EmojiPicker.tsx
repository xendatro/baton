import { SmilePlusIcon, XIcon } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { EMOJI_CATEGORIES, searchEmojis, type EmojiEntry } from './emojiData';
import type { PickerControlProps } from './PickerShell';
import { useOpenState } from './useOpenState';

export interface EmojiPickerProps extends PickerControlProps {
  value: string | null;
  onChange: (emoji: string | null) => void;
  /** Offer "Remove" when a value is set (default true). */
  clearable?: boolean;
  /** Accessible name of the default trigger. */
  label?: string;
}

const COLUMNS = 8;

/** Index of each category's first emoji in the full grid (the first one is the tab stop). */
const CATEGORY_STARTS = EMOJI_CATEGORIES.map((_, index) =>
  EMOJI_CATEGORIES.slice(0, index).reduce((sum, category) => sum + category.emojis.length, 0),
);

/** Lightweight emoji grid with search, for team and project icons. */
export function EmojiPicker({
  value,
  onChange,
  clearable = true,
  label = 'Icon',
  open,
  onOpenChange,
  disabled,
  children,
  align = 'start',
}: EmojiPickerProps) {
  const [isOpen, setOpen] = useOpenState(open, onOpenChange);
  const trigger = children ?? (
    <Button
      variant="outline"
      size="icon"
      disabled={disabled}
      aria-label={value ? `${label}: ${value}` : `Choose ${label.toLowerCase()}`}
      className="text-lg"
    >
      {value ?? <SmilePlusIcon className="text-muted-foreground" aria-hidden="true" />}
    </Button>
  );
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[18.5rem] p-0" align={align}>
        {isOpen ? (
          <EmojiPanel
            value={value}
            clearable={clearable}
            onChange={(emoji) => {
              onChange(emoji);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

interface EmojiPanelProps {
  value: string | null;
  clearable: boolean;
  onChange: (emoji: string | null) => void;
}

function EmojiPanel({ value, clearable, onChange }: EmojiPanelProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const results = query.trim() ? searchEmojis(query) : null;

  /** Arrow keys move between emoji buttons (one tab stop for the whole grid). */
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const delta: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    const step = delta[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, index + step))];
    next?.focus();
  };

  const renderGrid = (entries: readonly EmojiEntry[], startIndex: number) => (
    <div className="grid grid-cols-8 gap-0.5" role="presentation">
      {entries.map((entry, index) => (
        <button
          key={entry.emoji}
          type="button"
          data-emoji
          tabIndex={startIndex + index === 0 ? 0 : -1}
          title={entry.keywords}
          aria-label={entry.keywords.split(' ')[0] ?? entry.emoji}
          aria-pressed={entry.emoji === value}
          onClick={() => onChange(entry.emoji)}
          className="flex size-8 items-center justify-center rounded-md text-xl leading-none outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary/15"
        >
          {entry.emoji}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <label htmlFor={searchId} className="sr-only">
          Search emoji
        </label>
        <Input
          id={searchId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji…"
          className="h-8"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              gridRef.current?.querySelector<HTMLButtonElement>('button[data-emoji]')?.focus();
            }
          }}
        />
        {clearable && value ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove icon"
            title="Remove icon"
            onClick={() => onChange(null)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <ScrollArea className="h-64">
        <div ref={gridRef} className="space-y-3 p-2" onKeyDown={onGridKeyDown}>
          {results ? (
            results.length ? (
              renderGrid(results, 0)
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">No emoji found.</p>
            )
          ) : (
            EMOJI_CATEGORIES.map((category, index) => (
              <section key={category.name} aria-label={category.name}>
                <h4 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                  {category.name}
                </h4>
                {renderGrid(category.emojis, CATEGORY_STARTS[index] ?? 0)}
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
