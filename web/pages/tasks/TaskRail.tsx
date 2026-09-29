import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon, SquareArrowOutUpRightIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import type { Status } from '@shared/schemas/projects';
import { taskSchema, type TaskCard } from '@shared/schemas/tasks';
import { StatusIcon } from '@web/components/common/StatusBadge';
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
import { useStatuses } from '../projects/queries';
import { finishingStage, useTaskRail } from './railQuery';

const enc = encodeURIComponent;

/**
 * BAT-44: the task page's rail, the project's unfinished tasks by latest activity (stage and
 * assignees on each row). Right-click a row for Mark done (`UPDATE_TASKS`): it moves the task to
 * its pipeline's finishing stage under the normal move rules, so a strict pipeline's refusal shows
 * in a toast; a finished task drops from the list.
 */
export function TaskRail({
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
  const query = useTaskRail(project.id, q);
  const statuses = useStatuses(project.id).data;
  // Marked done here: hidden at once, before the list refetches.
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const tasks = useMemo(
    () =>
      (query.data?.pages.flatMap((page) => page.items) ?? []).filter(
        (task) => task.completedAt === null && !done.has(task.id),
      ),
    [query.data, done],
  );
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const items = useMemo(
    () =>
      tasks.map((task): RailItem => ({
        id: task.id,
        ref: task.ref,
        title: task.title,
        path: task.path,
        unreadCount: task.unreadCount,
        activityAt: task.lastActivityAt ?? task.updatedAt,
        latestReply: task.latestReply,
        detail: <TaskDetail task={task} />,
      })),
    [tasks],
  );
  const current = tasks.find((task) => task.number === currentNumber);

  return (
    <ItemRail
      title="Open tasks"
      items={items}
      currentId={current?.id ?? null}
      query={query}
      search={search}
      onSearchChange={setSearch}
      emptyText="No other open tasks."
      emptyAction={
        <Button asChild variant="outline" size="sm">
          <Link to={`/t/${team.slug}/p/${project.key}/tasks`}>Go to the board</Link>
        </Button>
      }
      renderRow={(item, row) => {
        const task = byId.get(item.id);
        return task ? (
          <TaskRailMenu
            task={task}
            finish={statuses ? finishingStage(statuses, task) : null}
            onDone={() => setDone((current) => new Set(current).add(task.id))}
          >
            {row}
          </TaskRailMenu>
        ) : (
          row
        );
      }}
    />
  );
}

/** The row's second line: stage, then the first assignee (+ how many more). */
function TaskDetail({ task }: { task: TaskCard }) {
  const names = [
    ...task.assignees.users.map((user) => user.name),
    ...task.assignees.roles.map((role) => role.name),
  ];
  return (
    <>
      <span className="flex min-w-0 shrink items-center gap-1">
        <StatusIcon status={task.status} className="size-3" />
        <span className="truncate">{task.status.name}</span>
      </span>
      {names.length ? (
        <span className="min-w-0 truncate" title={names.join(', ')}>
          · {names[0]}
          {names.length > 1 ? ` +${names.length - 1}` : ''}
        </span>
      ) : null}
    </>
  );
}

function TaskRailMenu({
  task,
  finish,
  onDone,
  children,
}: {
  task: TaskCard;
  finish: Status | null;
  onDone: () => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const access = useProjectAccess(task.teamId, task.projectId);
  const canMove = access.has('UPDATE_TASKS');
  const markDone = useMutation({
    mutationFn: (statusId: string) =>
      api.post(`/api/tasks/${enc(task.id)}/move`, { statusId }, { schema: taskSchema }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.tasks.detail(updated.projectId, updated.number), updated);
      if (updated.completedAt !== null) onDone();
      toast.success(`Moved ${task.ref} to ${updated.status.name}`);
    },
    onError: (error) => toast.error(`Can’t mark ${task.ref} done: ${errorMessage(error)}`),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(task.projectId) }),
    meta: { suppressErrorToast: true },
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" aria-label={`${task.ref} actions`}>
        <MenuRow
          icon={SquareArrowOutUpRightIcon}
          label="Open"
          onSelect={() => void navigate(task.path, { replace: true })}
        />
        {canMove && finish && finish.id !== task.status.id ? (
          <>
            <ContextMenuSeparator />
            <MenuRow
              icon={CheckCircle2Icon}
              label="Mark done"
              onSelect={() => markDone.mutate(finish.id)}
            />
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
