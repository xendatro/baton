import { Fragment, type ReactNode } from 'react';
import { hotkeyLabels } from '@web/lib/hotkeys';
import { cn } from '@web/lib/utils';

export interface KbdProps {
  /** A shortcut in hotkey syntax (`mod+k`, `g d`) rendered as key caps. */
  keys?: string;
  /** Or free content for a single key cap. */
  children?: ReactNode;
  className?: string;
}

const CAP =
  'inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-sans text-[0.7rem] font-medium text-muted-foreground';

/** Keyboard key caps: `<Kbd keys="mod+k" />` → [Ctrl] [K], `g d` → [G] then [D]. */
export function Kbd({ keys, children, className }: KbdProps) {
  if (keys === undefined) return <kbd className={cn(CAP, className)}>{children}</kbd>;
  const chords = hotkeyLabels(keys);
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {chords.map((caps, chordIndex) => (
        <Fragment key={chordIndex}>
          {chordIndex > 0 ? <span className="text-xs text-muted-foreground">then</span> : null}
          <kbd className="inline-flex items-center gap-0.5">
            {caps.map((cap) => (
              <kbd key={cap} className={CAP}>
                {cap}
              </kbd>
            ))}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}
