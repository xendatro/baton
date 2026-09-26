import { MessagesSquareIcon, PlusIcon, SearchXIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { MeProject, MeTeam, UserSummary } from '@shared/schemas/core';
import {
  ISSUE_SORTS,
  ISSUE_STATES,
  type IssueSort,
  type IssueState,
  type LabelMatch,
} from '@shared/schemas/issues';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Kbd } from '@web/components/common/Kbd';
import { PageContainer } from '@web/components/common/PageContainer';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { useMe } from '@web/lib/auth';
import { useHotkey } from '@web/lib/hotkeys';
import { useTeamAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useInView } from '@web/lib/useInView';
import { cn } from '@web/lib/utils';
import { useLabels } from '@web/pages/projects/queries';
import { useMembers } from '@web/pages/teams/api';
import { AuthorFilter, LabelFilter, SearchBox, SortMenu, StateTabs } from './IssueFilters';
import { IssueRow, IssueRowSkeleton } from './IssueRow';
import { useIssueList, type IssueListParams } from './queries';

/**
 * Issue list (`/t/:team/p/:key/issues`), forum style: Open / Resolved / All tabs with counts,
 * label, author and text filters, a sort menu, and rows that open with `j`/`k` and Enter.
 * Filters live in the URL (`?state&label&match&author&q&sort`, labels and author by name).
 */
export default function IssueListPage() {
  const { team, project } = useRouteContext();
  // The project layout only renders its pages once both are resolved.
  if (!team || !project) return null;
  return <IssueList key={project.id} team={team} project={project} />;
}

const SEARCH_DEBOUNCE_MS = 250;

function pick<T extends string>(values: readonly T[], value: string | null, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback;
}

function IssueList({ team, project }: { team: MeTeam; project: MeProject }) {
  useDocumentTitle(['Issues', project.name]);
  const navigate = useNavigate();
  const access = useTeamAccess(team.id);
  const canCreate = access.has('CREATE_ISSUES');
  const base = `/t/${team.slug}/p/${project.key}`;
  const me = useMe().data?.user.id;

  // Filters, from the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const state = pick<IssueState>(ISSUE_STATES, searchParams.get('state'), 'open');
  const sort = pick<IssueSort>(ISSUE_SORTS, searchParams.get('sort'), 'latest-activity');
  const labelMatch: LabelMatch = searchParams.get('match') === 'all' ? 'all' : 'any';
  const labelNames = (searchParams.get('label') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const authorName = searchParams.get('author')?.toLowerCase() ?? null;
  const q = searchParams.get('q') ?? '';

  const update = (changes: Record<string, string | null>) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  // Labels and authors are named in the URL; the API filters by id.
  const labels = useLabels(project.id);
  const members = useMembers(team.id);
  const users = useMemo(() => {
    const list = (members.data?.items ?? []).map((member) => member.user);
    return [...list].sort((a, b) =>
      a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name),
    );
  }, [members.data, me]);
  const selectedLabels = (labels.data ?? []).filter((label) =>
    labelNames.includes(label.name.toLowerCase()),
  );
  const author = authorName ? (users.find((user) => user.username === authorName) ?? null) : null;
  const resolving =
    (labelNames.length > 0 && labels.isPending) || (authorName !== null && members.isPending);

  const params: IssueListParams = {
    state,
    labels: selectedLabels.map((label) => label.id),
    labelMatch,
    author: author?.id ?? null,
    q: q.trim(),
    sort,
  };
  const list = useIssueList(project.id, params, !resolving);
  const issues = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const counts = list.data?.pages[0]?.counts;
  const filtered = params.labels.length > 0 || author !== null || params.q !== '';

  // Search box: typed text, pushed to the URL once typing pauses.
  const [draft, setDraft] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const onSearch = (value: string) => {
    setDraft(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => update({ q: value.trim() || null }), SEARCH_DEBOUNCE_MS);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const clearFilters = () => {
    setDraft('');
    if (timer.current) clearTimeout(timer.current);
    update({ label: null, match: null, author: null, q: null });
  };

  // Keyboard: `/` searches, `j`/`k` move through the rows (Enter opens the focused one).
  const [selected, setSelected] = useState(-1);
  const links = useRef<Array<HTMLAnchorElement | null>>([]);
  const move = (delta: number) => {
    if (issues.length === 0) return;
    const next = Math.min(issues.length - 1, Math.max(0, selected + delta));
    setSelected(next);
    links.current[next]?.focus();
  };
  // Also registered app-wide by IssuesShellExtension; here too so it works as soon as the list
  // shows (the shell extensions load lazily).
  useHotkey('i', () => void navigate(`${base}/issues/new`), {
    description: 'New issue',
    group: 'Project',
    enabled: canCreate,
  });
  useHotkey('/', () => searchRef.current?.focus(), {
    description: 'Search issues',
    group: 'Issues',
  });
  useHotkey('j', () => move(1), {
    description: 'Next issue (Enter opens it)',
    group: 'Issues',
  });
  useHotkey('k', () => move(-1), { description: 'Previous issue', group: 'Issues' });

  // Infinite scroll: load the next page as the end of the list comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const nearEnd = useInView(sentinel, {
    rootMargin: '0px 0px 400px 0px',
    enabled: Boolean(list.hasNextPage),
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [nearEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const newIssuePath = `${base}/issues/new`;
  const newIssue = canCreate ? (
    <Button asChild size="sm">
      <Link to={newIssuePath} aria-keyshortcuts="i">
        <PlusIcon aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">New issue</span>
        <Kbd
          keys="i"
          className="hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground sm:inline-flex"
        />
      </Link>
    </Button>
  ) : null;

  return (
    <PageContainer>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <StateTabs
            value={state}
            counts={counts}
            onChange={(next) => {
              setSelected(-1);
              update({ state: next === 'open' ? null : next });
            }}
          />
          {newIssue}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox ref={searchRef} value={draft} onChange={onSearch} />
          <div className="flex flex-wrap items-center gap-2">
            <LabelFilter
              labels={labels.data ?? []}
              value={params.labels}
              match={labelMatch}
              onChange={(ids) => {
                const names = (labels.data ?? [])
                  .filter((label) => ids.includes(label.id))
                  .map((label) => label.name);
                update({
                  label: names.join(',') || null,
                  ...(names.length < 2 ? { match: null } : {}),
                });
              }}
              onMatchChange={(match) => update({ match: match === 'all' ? 'all' : null })}
            />
            <AuthorFilter
              users={users}
              value={author}
              onChange={(user: UserSummary | null) => update({ author: user?.username ?? null })}
            />
            <SortMenu
              value={sort}
              onChange={(next) => update({ sort: next === 'latest-activity' ? null : next })}
            />
            {filtered ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <XIcon aria-hidden="true" />
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        {list.isError ? (
          <ErrorState
            title="Couldn’t load issues"
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        ) : list.isPending || resolving ? (
          <ul className="divide-y rounded-lg border bg-card" aria-label="Loading issues">
            {Array.from({ length: 6 }, (_, index) => (
              <IssueRowSkeleton key={index} />
            ))}
          </ul>
        ) : issues.length === 0 ? (
          <ListEmpty
            state={state}
            filtered={filtered}
            total={counts?.all ?? 0}
            action={
              canCreate ? (
                <Button asChild>
                  <Link to={newIssuePath}>
                    <PlusIcon aria-hidden="true" />
                    New issue
                  </Link>
                </Button>
              ) : null
            }
            onClear={clearFilters}
            onShowAll={() => update({ state: 'all' })}
          />
        ) : (
          <div>
            <ul
              aria-label="Issues"
              aria-busy={list.isPlaceholderData}
              className={cn(
                'divide-y overflow-hidden rounded-lg border bg-card transition-opacity',
                list.isPlaceholderData && list.isFetching && 'opacity-60',
              )}
            >
              {issues.map((issue, index) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  selected={index === selected}
                  onFocus={() => setSelected(index)}
                  linkRef={(element) => {
                    links.current[index] = element;
                  }}
                />
              ))}
            </ul>
            <div ref={sentinel} className="flex justify-center py-3">
              {list.hasNextPage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage ? <Spinner /> : null}
                  Load more
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}

function ListEmpty({
  state,
  filtered,
  total,
  action,
  onClear,
  onShowAll,
}: {
  state: IssueState;
  filtered: boolean;
  total: number;
  action: React.ReactNode;
  onClear: () => void;
  onShowAll: () => void;
}) {
  if (filtered) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="No issues match these filters"
        description="Try other words, fewer labels or another author."
        action={
          <Button variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  }
  if (total === 0) {
    return (
      <EmptyState
        icon={MessagesSquareIcon}
        title="No issues yet"
        description="Issues are for bug reports, questions and ideas. Anyone on the team, and their agents, can open one and discuss it."
        action={action}
        className="py-16"
      />
    );
  }
  return (
    <EmptyState
      icon={MessagesSquareIcon}
      title={state === 'open' ? 'No open issues' : 'No resolved issues yet'}
      description={
        state === 'open'
          ? 'Everything reported here has been resolved.'
          : 'Resolved issues show up here.'
      }
      action={
        <Button variant="outline" onClick={onShowAll}>
          Show all issues
        </Button>
      }
    />
  );
}
