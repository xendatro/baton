import { SearchIcon, WifiOffIcon } from 'lucide-react';
import { Fragment } from 'react';
import { Link } from 'react-router';
import { openPalette } from '@web/components/palette/registry';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@web/components/ui/breadcrumb';
import { Button } from '@web/components/ui/button';
import { Separator } from '@web/components/ui/separator';
import { SidebarTrigger } from '@web/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import type { LiveConnectionState } from '@web/lib/live';
import { useDebouncedValue } from '@web/lib/useDebouncedValue';
import type { Crumb } from './breadcrumbs';

export interface AppHeaderProps {
  crumbs: readonly Crumb[];
  connection: LiveConnectionState;
}

/** Sticky page header: sidebar toggle, breadcrumbs, live-connection warning and search. */
export function AppHeader({ crumbs, connection }: AppHeaderProps) {
  // Brief blips reconnect on their own; only a lasting outage is worth showing.
  const lasting = useDebouncedValue(connection, 4000);
  const offline = connection === 'reconnecting' && lasting === 'reconnecting';
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
      <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <Fragment key={`${index}-${crumb.label}`}>
                {index > 0 ? <BreadcrumbSeparator className="hidden sm:block" /> : null}
                <BreadcrumbItem className={last ? 'min-w-0' : 'hidden min-w-0 sm:inline-flex'}>
                  {crumb.to && !last ? (
                    <BreadcrumbLink asChild className="truncate">
                      <Link to={crumb.to}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {offline ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300"
              tabIndex={0}
              role="status"
            >
              <WifiOffIcon className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Reconnecting…</span>
              <span className="sr-only sm:hidden">Reconnecting</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Live updates paused. Retrying the connection…</TooltipContent>
        </Tooltip>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        aria-label="Search"
        onClick={openPalette}
      >
        <SearchIcon aria-hidden="true" />
      </Button>
    </header>
  );
}
