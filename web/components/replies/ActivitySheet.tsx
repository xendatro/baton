import { HistoryIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReplyParentType } from '@shared/constants';
import { ErrorState } from '@web/components/common/ErrorState';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Button } from '@web/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@web/components/ui/sheet';
import { Skeleton } from '@web/components/ui/skeleton';
import { useHotkey } from '@web/lib/hotkeys';
import { cn } from '@web/lib/utils';
import { ActivityRow } from './ActivityRow';
import { historyEntries } from './history';
import { useActivity } from './queries';

export interface ActivitySheetProps {
  parentType: ReplyParentType;
  parentId: string;
  /** The item's ref (`API-12`, `API#5`), for the palette command and the drawer's description. */
  itemRef: string;
  /** Hotkey and palette group, e.g. "Task". */
  group: string;
  className?: string;
}

/**
 * The "Activity" header button and the drawer it opens with the item's full history (who moved,
 * claimed, edited… and when), so the page's conversation shows replies only. `h` toggles it.
 */
export function ActivitySheet({
  parentType,
  parentId,
  itemRef,
  group,
  className,
}: ActivitySheetProps) {
  const [open, setOpen] = useState(false);
  const activity = useActivity(parentType, parentId);
  const entries = activity.data ? historyEntries(activity.data) : null;
  const count = entries?.length ?? 0;

  useHotkey('h', () => setOpen((value) => !value), { description: 'Show activity', group });
  usePaletteCommands([
    {
      id: `${parentType}.${parentId}.activity`,
      label: `${itemRef}: Show activity`,
      group,
      icon: HistoryIcon,
      shortcut: 'h',
      keywords: ['history', 'log', 'changes', 'audit'],
      perform: () => setOpen(true),
    },
  ]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        className={cn('shrink-0 gap-1.5 px-2.5', className)}
        aria-label={
          entries ? `Activity: ${count} ${count === 1 ? 'entry' : 'entries'}` : 'Activity'
        }
        aria-keyshortcuts="h"
        aria-expanded={open}
        title="Activity (h)"
        onClick={() => setOpen(true)}
      >
        <HistoryIcon aria-hidden="true" />
        <span className="hidden sm:inline">Activity</span>
        {entries ? (
          <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </Button>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Activity
          </SheetTitle>
          <SheetDescription>History of {itemRef}, newest first.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {activity.isPending ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading activity">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="flex items-center gap-2.5">
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </div>
          ) : activity.isError ? (
            <ErrorState
              title="Couldn’t load the activity"
              error={activity.error}
              onRetry={() => void activity.refetch()}
            />
          ) : count === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No changes yet.</p>
          ) : (
            <ol className="space-y-1" aria-label="History">
              {entries?.map((entry) => (
                <li key={entry.id}>
                  <ActivityRow entry={entry} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
