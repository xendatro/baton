import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { ViewportFill } from '@web/components/common/ViewportFill';
import { Button } from '@web/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@web/components/ui/sheet';
import { useMediaQuery } from '@web/lib/useMediaQuery';
import { cn } from '@web/lib/utils';
import {
  RAIL_INLINE_QUERY,
  RailContext,
  useItemRail,
  useRailCollapsed,
  type RailControls,
} from './railState';

/**
 * BAT-44: the frame of an issue or task page with the item rail on its left (the project's other
 * open issues or tasks, like a DM list). From `xl` the rail sits beside the page, sticky and one
 * screen tall, and can be collapsed (remembered per user in localStorage); on narrower screens it
 * opens as a sheet from the rail toggle in the page header.
 */

export function ItemPageFrame({
  rail,
  label,
  children,
}: {
  /** The rail's content (header, search and rows). */
  rail: ReactNode;
  /** "Issues" or "Tasks": names the rail for assistive technology. */
  label: string;
  children: ReactNode;
}) {
  const inline = useMediaQuery(RAIL_INLINE_QUERY);
  const [collapsed, setCollapsed] = useRailCollapsed();
  const [sheetOpen, setSheetOpen] = useState(false);
  const controls = useMemo<RailControls>(
    () => ({
      open: inline ? !collapsed : sheetOpen,
      inline,
      toggle: () => (inline ? setCollapsed(!collapsed) : setSheetOpen((open) => !open)),
      closeSheet: () => setSheetOpen(false),
      label,
    }),
    [inline, collapsed, sheetOpen, setCollapsed, label],
  );
  return (
    <RailContext.Provider value={controls}>
      <div className="flex min-w-0 flex-1">
        {inline && !collapsed ? (
          <ViewportFill
            mode="sticky"
            className="sticky top-12 h-[calc(100dvh-3rem)] w-64 shrink-0 self-start border-r bg-muted/20"
          >
            <nav aria-label={label} className="flex h-full flex-col" data-testid="item-rail">
              {rail}
            </nav>
          </ViewportFill>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      {inline ? null : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="left" className="w-80 gap-0 p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">{label}</SheetTitle>
            <SheetDescription className="sr-only">
              The project’s open {label.toLowerCase()}, by latest activity.
            </SheetDescription>
            <nav
              aria-label={label}
              className="flex min-h-0 flex-1 flex-col"
              data-testid="item-rail"
            >
              {rail}
            </nav>
          </SheetContent>
        </Sheet>
      )}
    </RailContext.Provider>
  );
}

/** The page header's button that shows or hides the rail. */
export function ItemRailToggle({ className }: { className?: string }) {
  const rail = useItemRail();
  if (!rail) return null;
  const label = rail.open
    ? `Hide ${rail.label.toLowerCase()} list`
    : `Show ${rail.label.toLowerCase()} list`;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={rail.open}
      className={cn('shrink-0 text-muted-foreground', className)}
      onClick={rail.toggle}
    >
      {rail.open ? (
        <PanelLeftCloseIcon aria-hidden="true" />
      ) : (
        <PanelLeftOpenIcon aria-hidden="true" />
      )}
    </Button>
  );
}
