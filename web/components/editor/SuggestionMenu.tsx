import type { SuggestionKeyDownProps } from '@tiptap/suggestion';
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { Spinner } from '@web/components/common/Spinner';
import { cn } from '@web/lib/utils';

/**
 * Popup list used by the editor's `@` mentions and `/` slash commands: arrow keys move, Enter or
 * Tab picks, Escape closes. Tiptap's suggestion plugin positions it (`props.mount`).
 */

export interface SuggestionItem {
  key: string;
  /** Group heading shown above the first item of each group. */
  group?: string;
}

export interface SuggestionMenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

export interface SuggestionMenuProps<I extends SuggestionItem> {
  items: I[];
  loading: boolean;
  command: (item: I) => void;
  renderItem: (item: I) => ReactNode;
  emptyText: string;
  label: string;
  ref?: Ref<SuggestionMenuHandle>;
}

export function SuggestionMenu<I extends SuggestionItem>({
  items,
  loading,
  command,
  renderItem,
  emptyText,
  label,
  ref,
}: SuggestionMenuProps<I>) {
  const [selected, setSelected] = useState(0);
  const [prevItems, setPrevItems] = useState(items);
  const listRef = useRef<HTMLDivElement>(null);
  if (prevItems !== items) {
    setPrevItems(items);
    setSelected(0);
  }

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) return false;
      if (event.key === 'ArrowDown') {
        setSelected((index) => (index + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((index) => (index - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      className="z-50 max-h-72 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          {loading ? <Spinner label="Loading" /> : null}
          {loading ? 'Searching…' : emptyText}
        </div>
      ) : (
        items.map((item, index) => (
          <div key={item.key}>
            {item.group && item.group !== items[index - 1]?.group ? (
              <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                {item.group}
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={index === selected}
              data-index={index}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none',
                index === selected && 'bg-accent text-accent-foreground',
              )}
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => command(item)}
            >
              {renderItem(item)}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
