import {
  FolderKanbanIcon,
  InfoIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  RotateCcwIcon,
  Trash2Icon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { TRASH_RETENTION_DAYS, type TrashableType } from '@shared/constants';
import { TEAM_TRASH_TYPES, type TeamTrashType } from '@shared/schemas/admin';
import type { MeTeam, TrashItem } from '@shared/schemas/core';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { NotFound } from '@web/components/common/NotFound';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { UserName } from '@web/components/common/UserName';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Skeleton } from '@web/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@web/components/ui/table';
import { pluralize } from '@web/lib/format';
import { useLiveEventListener } from '@web/lib/live';
import { useTeamAccess } from '@web/lib/permissions';
import { queryKeys } from '@web/lib/queryKeys';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useInView } from '@web/lib/useInView';
import { cn } from '@web/lib/utils';
import { useRestoreItem, useTrash } from './trash/queries';

const TYPES: Record<TrashableType, { label: string; plural: string; icon: LucideIcon }> = {
  team: { label: 'Team', plural: 'teams', icon: UsersIcon },
  project: { label: 'Project', plural: 'projects', icon: FolderKanbanIcon },
  issue: { label: 'Issue', plural: 'issues', icon: MessagesSquareIcon },
  task: { label: 'Task', plural: 'tasks', icon: ListChecksIcon },
  reply: { label: 'Reply', plural: 'replies', icon: MessageSquareTextIcon },
  attachment: { label: 'File', plural: 'files', icon: PaperclipIcon },
};

const ALL = 'all';

function readType(value: string | null): TeamTrashType | null {
  return (TEAM_TRASH_TYPES as readonly string[]).includes(value ?? '')
    ? (value as TeamTrashType)
    : null;
}

/** "12 days", "1 day", "Today" (purged by tonight's job). */
function DaysLeft({ days }: { days: number }) {
  const urgent = days <= 3;
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-normal tabular-nums',
        urgent
          ? 'border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400'
          : 'text-muted-foreground',
      )}
      title={`Removed for good ${TRASH_RETENTION_DAYS} days after it was deleted`}
    >
      {days === 0 ? 'Purged today' : `${pluralize(days, 'day')} left`}
    </Badge>
  );
}

function ItemTitle({ item, projectName }: { item: TrashItem; projectName: string | null }) {
  const { icon: Icon, label } = TYPES[item.type];
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        title={label}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium" title={item.title}>
          {item.title || <span className="text-muted-foreground italic">Untitled</span>}
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{label}</span>
          {item.ref ? (
            <span className="font-mono">{item.type === 'reply' ? `on ${item.ref}` : item.ref}</span>
          ) : null}
          {projectName && item.type !== 'project' ? (
            <span className="truncate">in {projectName}</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

function DeletedBy({ item }: { item: TrashItem }) {
  return (
    <UserName user={item.deletedBy} via={item.via} avatar="sm" className="max-w-full text-sm" />
  );
}

function TableSkeleton() {
  return (
    <div className="divide-y rounded-lg border" aria-busy="true" aria-label="Loading trash">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-6 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="hidden h-4 w-24 md:block" />
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Team settings → Trash (SPEC §1.12): deleted items with restore, 30 days before purge. */
export default function TrashPage() {
  const { team, isLoading } = useRouteContext();
  useDocumentTitle(['Trash', team?.name]);
  if (isLoading) {
    return (
      <PageContainer>
        <div className="space-y-2 pb-4">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-80" />
        </div>
        <TableSkeleton />
      </PageContainer>
    );
  }
  if (!team) return <NotFound what="Team" />;
  return <Trash team={team} />;
}

function Trash({ team }: { team: MeTeam }) {
  const access = useTeamAccess(team.id);
  const seesAll = access.has('MANAGE_TRASH');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const type = readType(params.get('type'));
  const trash = useTrash(team.id, type);
  const restore = useRestoreItem(team.id);
  const items = useMemo(() => trash.data?.pages.flatMap((page) => page.items) ?? [], [trash.data]);
  const projects = useMemo(
    () => new Map(team.projects.map((project) => [project.id, project.name])),
    [team.projects],
  );

  // Replies come back as `reply.created` and uploads as `attachment.changed`, which don't name
  // the trash; every delete and restore writes an audit row, so refresh on those.
  useLiveEventListener((event) => {
    if (
      event.type === 'activity.created' &&
      event.teamId === team.id &&
      event.parentType &&
      event.parentType in TYPES
    ) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams.trash(team.id) });
    }
  });

  const endRef = useRef<HTMLDivElement>(null);
  const nearEnd = useInView(endRef, { rootMargin: '0px 0px 400px 0px', enabled: items.length > 0 });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = trash;
  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [nearEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const setType = (value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === ALL) next.delete('type');
        else next.set('type', value);
        return next;
      },
      { replace: true },
    );

  const onRestore = (item: TrashItem) => {
    // "Restored API-12", "Restored project Web", "Restored the reply".
    const what =
      item.type === 'issue' || item.type === 'task'
        ? (item.ref ?? TYPES[item.type].label.toLowerCase())
        : item.type === 'project'
          ? `project ${item.title}`
          : `the ${TYPES[item.type].label.toLowerCase()}`;
    restore.mutate(item, {
      onSuccess: (result) => {
        const url = result.url;
        toast.success(`Restored ${what}`, {
          description: item.title,
          ...(url ? { action: { label: 'Open', onClick: () => void navigate(url) } } : {}),
        });
      },
    });
  };

  const restoringKey = restore.isPending
    ? `${restore.variables.type}:${restore.variables.id}`
    : null;

  const restoreButton = (item: TrashItem) => {
    const busy = restoringKey === `${item.type}:${item.id}`;
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => onRestore(item)}
        disabled={busy}
        aria-label={`Restore ${TYPES[item.type].label.toLowerCase()} ${item.title}`}
      >
        {busy ? <Spinner /> : <RotateCcwIcon aria-hidden="true" />}
        Restore
      </Button>
    );
  };

  return (
    <PageContainer>
      <PageHeader
        title="Trash"
        description={`Deleted items stay here for ${TRASH_RETENTION_DAYS} days before they’re removed for good.`}
        actions={
          <Select value={type ?? ALL} onValueChange={setType}>
            <SelectTrigger size="sm" className="w-40" aria-label="Filter by type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={ALL}>All types</SelectItem>
              {TEAM_TRASH_TYPES.map((value) => {
                const { icon: Icon, plural } = TYPES[value];
                return (
                  <SelectItem key={value} value={value}>
                    <Icon aria-hidden="true" />
                    {plural.charAt(0).toUpperCase() + plural.slice(1)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        }
      >
        {!seesAll ? (
          <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            You see the items you created. Members with the “Manage trash” permission see and
            restore everything deleted in {team.name}.
          </p>
        ) : null}
      </PageHeader>

      {trash.isPending ? (
        <TableSkeleton />
      ) : trash.isError ? (
        <ErrorState
          title="Couldn’t load the trash"
          error={trash.error}
          onRetry={() => void trash.refetch()}
        />
      ) : items.length === 0 ? (
        type ? (
          <EmptyState
            icon={TYPES[type].icon}
            title={`No deleted ${TYPES[type].plural}`}
            description={`Nothing of this type is in the trash${seesAll ? '' : ' for you'}.`}
            action={
              <Button variant="outline" size="sm" onClick={() => setType(ALL)}>
                Show all types
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Trash2Icon}
            title="Trash is empty"
            description={`Deleted projects, issues, tasks, replies and files land here. They can be restored for ${TRASH_RETENTION_DAYS} days, then they’re removed for good.`}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={`/t/${team.slug}`}>Back to {team.name}</Link>
              </Button>
            }
          />
        )
      ) : (
        <>
          {/* Wide screens: a table. */}
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Item</TableHead>
                  <TableHead>Deleted by</TableHead>
                  <TableHead>Deleted</TableHead>
                  <TableHead>Purge</TableHead>
                  <TableHead className="w-0 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={`${item.type}:${item.id}`} data-testid="trash-row">
                    <TableCell className="max-w-0 min-w-64 py-2.5 pl-4 whitespace-normal">
                      <ItemTitle
                        item={item}
                        projectName={item.projectId ? (projects.get(item.projectId) ?? null) : null}
                      />
                    </TableCell>
                    <TableCell className="max-w-56">
                      <DeletedBy item={item} />
                    </TableCell>
                    <TableCell>
                      <RelativeTime value={item.deletedAt} className="text-sm" />
                    </TableCell>
                    <TableCell>
                      <DaysLeft days={item.daysLeft} />
                    </TableCell>
                    <TableCell className="pr-4 text-right">{restoreButton(item)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Narrow screens: one card per item. */}
          <ul className="divide-y rounded-lg border md:hidden">
            {items.map((item) => (
              <li
                key={`${item.type}:${item.id}`}
                className="space-y-2 p-3"
                data-testid="trash-card"
              >
                <ItemTitle
                  item={item}
                  projectName={item.projectId ? (projects.get(item.projectId) ?? null) : null}
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-8.5 text-xs text-muted-foreground">
                  <DeletedBy item={item} />
                  <RelativeTime value={item.deletedAt} />
                  <DaysLeft days={item.daysLeft} />
                </div>
                <div className="pl-8.5">{restoreButton(item)}</div>
              </li>
            ))}
          </ul>

          <div ref={endRef} className="flex justify-center py-4">
            {isFetchingNextPage ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Loading more…
              </span>
            ) : hasNextPage ? (
              <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
                Load more
              </Button>
            ) : null}
          </div>
        </>
      )}
    </PageContainer>
  );
}
