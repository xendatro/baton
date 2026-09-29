import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon, SquareArrowOutUpRightIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import { issueSchema, type IssueSummary } from '@shared/schemas/issues';
import { ItemRail } from '@web/components/itemRail/ItemRail';
import type { RailItem } from '@web/components/itemRail/railState';
import { MenuRow } from '@web/components/layout/SidebarMenus';
import { Button } from '@web/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@web/components/ui/context-menu';
import { api, errorMessage } from '@web/lib/api';
import { useProjectAccess } from '@web/lib/permissions';
import { queryKeys } from '@web/lib/queryKeys';
import { useDebouncedValue } from '@web/lib/useDebouncedValue';
import { useIssueRail } from './railQuery';

const enc = encodeURIComponent;

/**
 * BAT-44: the issue page's rail, the project's open issues by latest activity. Right-click a row
 * for Mark resolved (its author, or `RESOLVE_ISSUES`), which drops it from the list.
 */
export function IssueRail({
  team,
  project,
  currentNumber,
}: {
  team: MeTeam;
  project: MeProject;
  currentNumber: number;
}) {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const query = useIssueRail(project.id, q);
  // Resolved here: hidden at once, before the list refetches.
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const issues = useMemo(
    () =>
      (query.data?.pages.flatMap((page) => page.items) ?? []).filter(
        (issue) => !issue.resolved && !resolved.has(issue.id),
      ),
    [query.data, resolved],
  );
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const items = useMemo(
    () =>
      issues.map((issue): RailItem => ({
        id: issue.id,
        ref: `#${issue.number}`,
        title: issue.title,
        path: issue.path,
        unreadCount: issue.unreadCount,
        activityAt: issue.lastActivityAt,
        latestReply: issue.latestReply,
      })),
    [issues],
  );
  const current = issues.find((issue) => issue.number === currentNumber);

  return (
    <ItemRail
      title="Open issues"
      items={items}
      currentId={current?.id ?? null}
      query={query}
      search={search}
      onSearchChange={setSearch}
      emptyText="No other open issues."
      emptyAction={
        <Button asChild variant="outline" size="sm">
          <Link to={`/t/${team.slug}/p/${project.key}/issues/new`}>New issue</Link>
        </Button>
      }
      renderRow={(item, row) => {
        const issue = byId.get(item.id);
        return issue ? (
          <IssueRailMenu
            issue={issue}
            onResolved={() => setResolved((current) => new Set(current).add(issue.id))}
          >
            {row}
          </IssueRailMenu>
        ) : (
          row
        );
      }}
    />
  );
}

function IssueRailMenu({
  issue,
  onResolved,
  children,
}: {
  issue: IssueSummary;
  onResolved: () => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const access = useProjectAccess(issue.teamId, issue.projectId);
  const canTriage = issue.author?.id === access.userId || access.has('RESOLVE_ISSUES');
  const resolve = useMutation({
    mutationFn: () =>
      api.post(`/api/issues/${enc(issue.id)}/resolve`, undefined, { schema: issueSchema }),
    onSuccess: (updated) => {
      onResolved();
      queryClient.setQueryData(queryKeys.issues.detail(updated.projectId, updated.number), updated);
      toast.success(`${issue.ref} resolved`);
      return queryClient.invalidateQueries({ queryKey: queryKeys.issues.all(issue.projectId) });
    },
    onError: (error) => toast.error(errorMessage(error, 'Couldn’t resolve the issue.')),
    meta: { suppressErrorToast: true },
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" aria-label={`${issue.ref} actions`}>
        <MenuRow
          icon={SquareArrowOutUpRightIcon}
          label="Open"
          onSelect={() => void navigate(issue.path, { replace: true })}
        />
        {canTriage ? (
          <>
            <ContextMenuSeparator />
            <MenuRow
              icon={CheckCircle2Icon}
              label="Mark resolved"
              onSelect={() => resolve.mutate()}
            />
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
