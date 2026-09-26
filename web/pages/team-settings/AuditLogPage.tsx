import { ArrowUpIcon, DownloadIcon, FilterXIcon, HistoryIcon, LockIcon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { MeTeam } from '@shared/schemas/core';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { NotFound } from '@web/components/common/NotFound';
import { Spinner } from '@web/components/common/Spinner';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { isApiError } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { useTeamAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useInView } from '@web/lib/useInView';
import { AuditFilterBar } from './audit-log/AuditFilters';
import { AuditRow } from './audit-log/AuditRow';
import { auditLogCsv, csvFileName, downloadCsv } from './audit-log/csv';
import { groupByDay } from './audit-log/days';
import { activeFilterCount, EMPTY_FILTERS, readFilters, writeFilters } from './audit-log/filters';
import type { AuditFilters } from './audit-log/filters';
import {
  useAuditLogFacets,
  useAuditLogFeed,
  useNewAuditEntries,
  usePrependEntries,
} from './audit-log/queries';
import { SettingsHeader } from './SettingsSection';

function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="divide-y rounded-lg border">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="hidden h-3 w-12 sm:block" />
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-4" style={{ width: `${40 + ((index * 17) % 45)}%` }} />
        </div>
      ))}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div>
      <div className="space-y-2 pb-4" aria-busy="true" aria-label="Loading audit log">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <RowsSkeleton />
    </div>
  );
}

function NoAccess({ team }: { team: MeTeam }) {
  return (
    <div>
      <SettingsHeader title="Audit log" />
      <EmptyState
        icon={LockIcon}
        title="You can’t view the audit log"
        description="The team audit log needs the “View audit log” permission. Ask a team admin for a role that has it. Every task and issue still shows its own history."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to={`/t/${team.slug}`}>Back to {team.name}</Link>
          </Button>
        }
      />
    </div>
  );
}

/** Team settings → Audit log (SPEC §1.11): every change in the team, filterable and live. */
export default function AuditLogPage() {
  const { team, isLoading } = useRouteContext();
  const access = useTeamAccess(team?.id);
  useDocumentTitle(['Audit log', team?.name]);
  if (isLoading) return <PageSkeleton />;
  if (!team) return <NotFound what="Team" />;
  if (!access.has('VIEW_AUDIT_LOG')) return <NoAccess team={team} />;
  return <AuditLog team={team} />;
}

function AuditLog({ team }: { team: MeTeam }) {
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const filters = useMemo(() => readFilters(new URLSearchParams(search)), [search]);
  const setFilters = (next: AuditFilters) =>
    setParams((current) => writeFilters(current, next), { replace: true });
  const filtered = activeFilterCount(filters) > 0;

  const facets = useAuditLogFacets(team.id, true);
  const feed = useAuditLogFeed(team.id, filters, true);
  const entries = useMemo(() => feed.data?.pages.flatMap((page) => page.items), [feed.data]);
  const incoming = useNewAuditEntries(team.id, filters, feed.isSuccess ? entries : undefined);
  const prepend = usePrependEntries(team.id, filters);

  const topRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const listShown = feed.isSuccess && (entries?.length ?? 0) > 0;
  const atTop = useInView(topRef, { rootMargin: '-48px 0px 0px 0px', initial: true });
  const nearEnd = useInView(endRef, { rootMargin: '0px 0px 600px 0px', enabled: listShown });

  const pending = incoming.data;
  const pendingCount = pending?.entries.length ?? 0;

  const showNew = () => {
    if (pending) prepend(pending);
  };

  // Live: at the top of the list new rows slide in; further down a pill offers them.
  useEffect(() => {
    if (!atTop || !pending || (pending.entries.length === 0 && !pending.overflow)) return;
    prepend(pending);
  }, [atTop, pending, prepend]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [nearEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const exportCsv = () => {
    if (!entries?.length) return;
    downloadCsv(auditLogCsv(entries, window.location.origin), csvFileName(team.slug));
    toast.success(`Exported ${pluralize(entries.length, 'row')}`);
  };

  usePaletteCommands([
    {
      id: 'audit-log.export',
      label: 'Export loaded audit log rows (CSV)',
      group: 'Audit log',
      icon: DownloadIcon,
      keywords: ['csv', 'download', 'export'],
      perform: exportCsv,
    },
    ...(filtered
      ? [
          {
            id: 'audit-log.clear-filters',
            label: 'Clear audit log filters',
            group: 'Audit log',
            icon: FilterXIcon,
            keywords: ['reset', 'filters'],
            perform: () => setFilters(EMPTY_FILTERS),
          },
        ]
      : []),
  ]);

  if (feed.isError && isApiError(feed.error) && feed.error.code === 'forbidden') {
    return <NoAccess team={team} />;
  }

  const groups = entries ? groupByDay(entries) : [];
  const projectNames = new Map(
    (facets.data?.projects ?? []).map((project) => [project.id, project.name]),
  );

  return (
    <div>
      <SettingsHeader
        title="Audit log"
        description={`Every change in ${team.name}, by people and the agents working for them.`}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={!entries?.length}
            title="Download the rows loaded below as a CSV file"
          >
            <DownloadIcon aria-hidden="true" />
            Export CSV
          </Button>
        }
      />
      <div className="-mt-1 pb-4">
        <AuditFilterBar
          filters={filters}
          facets={facets.data}
          loading={facets.isPending}
          onChange={setFilters}
        />
      </div>

      <div ref={topRef} aria-hidden="true" />
      {!atTop && pendingCount > 0 ? (
        <div className="pointer-events-none sticky top-16 z-10 flex justify-center">
          <Button
            size="sm"
            className="pointer-events-auto rounded-full shadow-md"
            onClick={() => {
              showNew();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <ArrowUpIcon aria-hidden="true" />
            {pending?.overflow ? `${pendingCount}+ new` : `${pendingCount} new`}
          </Button>
        </div>
      ) : null}

      {feed.isPending ? (
        <RowsSkeleton />
      ) : feed.isError ? (
        <ErrorState
          title="Couldn’t load the audit log"
          error={feed.error}
          onRetry={() => void feed.refetch()}
        />
      ) : groups.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={FilterXIcon}
            title="No matching activity"
            description="Nothing in the log matches these filters. Widen the date range or remove a filter."
            action={
              <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={HistoryIcon}
            title="No activity yet"
            description="Changes made in this team, by people in the app and by agents through their API keys, will appear here as they happen."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={`/t/${team.slug}`}>Go to {team.name}</Link>
              </Button>
            }
          />
        )
      ) : (
        <div className="space-y-6" aria-live="polite" aria-relevant="additions">
          {groups.map((group) => (
            <section key={group.day} aria-labelledby={`day-${group.day}`}>
              <h3
                id={`day-${group.day}`}
                className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              >
                {group.label}
              </h3>
              <ol className="divide-y rounded-lg border bg-card">
                {group.entries.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    projectName={entry.projectId ? projectNames.get(entry.projectId) : null}
                  />
                ))}
              </ol>
            </section>
          ))}
          <div ref={endRef} className="flex justify-center pb-2">
            {isFetchingNextPage ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Loading older activity…
              </span>
            ) : hasNextPage ? (
              <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
                Load older activity
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {filtered
                  ? 'End of the matching activity.'
                  : 'You’ve reached the beginning of the log.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
