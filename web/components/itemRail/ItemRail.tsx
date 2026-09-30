import type { AgentWorking } from '@shared/schemas/core';
import { InboxIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { UnreadBadge } from '@web/components/common/UnreadBadge';
import { WorkingDot } from '@web/components/common/WorkingDot';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { useInView } from '@web/lib/useInView';
import { cn } from '@web/lib/utils';
import { ItemRailToggle } from './ItemPageFrame';
import { sortByActivity, useItemRail, type RailItem, type RailQuery } from './railState';

/**
 * BAT-44: the list of a project's open issues or tasks beside an issue or task page, like a DM
 * list: one row per item (title, ref, unread badge, the latest message and when), newest activity
 * first, the open one highlighted. Rows are links (client-side, replacing the history entry, so
 * "← Issues" still returns to the list the page was opened from); each module wraps them in its
 * right-click menu. More rows load as the end of the list scrolls into view.
 */

export function ItemRail({
  title,
  items,
  currentId,
  query,
  search,
  onSearchChange,
  emptyText,
  emptyAction,
  renderRow,
}: {
  /** "Open issues", "Open tasks". */
  title: string;
  items: readonly RailItem[];
  /** The item on screen (highlighted). */
  currentId: string | null;
  query: RailQuery;
  search: string;
  onSearchChange: (value: string) => void;
  emptyText: string;
  /** The empty state's call to action (e.g. a link to the list). */
  emptyAction?: ReactNode;
  /** Wraps a row (its right-click menu). */
  renderRow: (item: RailItem, row: ReactNode) => ReactNode;
}) {
  const rail = useItemRail();
  const sorted = useMemo(() => sortByActivity(items), [items]);
  const end = useRef<HTMLLIElement>(null);
  const endVisible = useInView(end, {
    rootMargin: '0px 0px 240px 0px',
    enabled: query.hasNextPage,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (endVisible && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [endVisible, hasNextPage, isFetchingNextPage, fetchNextPage]);

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div role="status" aria-label={`Loading ${title.toLowerCase()}`} className="grid gap-1 p-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="grid gap-1.5 rounded-md px-2.5 py-2">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <div className="p-3">
        <ErrorState
          title={`Couldn’t load the ${title.toLowerCase()}`}
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  } else if (sorted.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm">
        <InboxIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-muted-foreground">{search ? 'Nothing matches.' : emptyText}</p>
        {search ? null : emptyAction}
      </div>
    );
  } else {
    body = (
      <ul className="grid gap-0.5 p-1.5" aria-label={title}>
        {sorted.map((item) => (
          <li key={item.id}>
            {renderRow(
              item,
              <ItemRailRow
                item={item}
                active={item.id === currentId}
                onNavigate={rail?.inline ? undefined : rail?.closeSheet}
              />,
            )}
          </li>
        ))}
        {query.hasNextPage ? (
          <li ref={end} className="flex justify-center py-2" aria-hidden="true">
            {query.isFetchingNextPage ? <Spinner /> : null}
          </li>
        ) : null}
      </ul>
    );
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-b p-2">
        <div className="flex items-center gap-1 pl-1.5">
          <h2 className="flex-1 truncate text-sm font-semibold">{title}</h2>
          <ItemRailToggle />
        </div>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Filter…"
            aria-label={`Filter ${title.toLowerCase()}`}
            className="h-8 pl-7 text-sm"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="item-rail-scroller">
        {body}
      </div>
    </>
  );
}

/**
 * One row: title and time, ref and detail with the unread badge, then "Caden: sounds good".
 * The agent-working dot (BAT#42) follows the title while an agent works on the item.
 */
export function ItemRailRow({
  item,
  active,
  working = item.working,
  onNavigate,
}: {
  item: RailItem;
  active: boolean;
  /** Agents working on it (default: the item's). */
  working?: AgentWorking | null;
  onNavigate?: () => void;
}) {
  const unread = active ? 0 : (item.unreadCount ?? 0);
  const latest = item.latestReply;
  return (
    <Link
      to={item.path}
      replace
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      data-testid="item-rail-row"
      className={cn(
        'flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-sm outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn('min-w-0 flex-1 truncate', unread > 0 ? 'font-semibold' : 'font-medium')}
        >
          {item.title}
        </span>
        <WorkingDot working={working} />
        <RelativeTime value={item.activityAt} className="shrink-0 text-[11px]" />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono">{item.ref}</span>
        {item.detail ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">{item.detail}</span>
        ) : (
          <span className="flex-1" />
        )}
        <UnreadBadge count={unread} />
      </span>
      {latest ? (
        <span className="truncate text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">
            {latest.author?.name ?? 'Deleted user'}:
          </span>{' '}
          {latest.excerpt || '(attachment)'}
        </span>
      ) : null}
    </Link>
  );
}
