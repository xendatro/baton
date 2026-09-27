import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Fragment } from 'react';
import { Link } from 'react-router';
import type { Status } from '@shared/schemas/projects';
import type { TaskCard, TaskSort } from '@shared/schemas/tasks';
import { BlockedBadge } from '@web/components/common/BlockedBadge';
import { ClaimBadge } from '@web/components/common/ClaimBadge';
import { DueDate } from '@web/components/common/DueDate';
import { LabelChip } from '@web/components/common/LabelChip';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { RoleChip } from '@web/components/common/RoleChip';
import { StatusBadge, StatusIcon } from '@web/components/common/StatusBadge';
import { UnreadBadge } from '@web/components/common/UnreadBadge';
import { AvatarStack } from '@web/components/common/UserAvatar';
import { Skeleton } from '@web/components/ui/skeleton';
import { cn } from '@web/lib/utils';
import type { ListOptions } from './filters';
import { groupTasks, type TaskGroup } from './helpers';

/**
 * The list view (SPEC §1.9): a table with sortable columns (sorted by the server) and groups by
 * status, priority, assignee or none (grouped here, keeping the sort within each group).
 */

interface Column {
  sort: TaskSort | null;
  label: string;
  className: string;
}

const COLUMNS: Column[] = [
  { sort: 'number', label: 'Key', className: 'w-20 pl-4 sm:w-24 sm:pl-6' },
  { sort: 'title', label: 'Title', className: '' },
  { sort: 'status', label: 'Status', className: 'hidden w-36 md:table-cell' },
  { sort: 'priority', label: 'Priority', className: 'hidden w-32 lg:table-cell' },
  { sort: null, label: 'Assignees', className: 'hidden w-40 md:table-cell' },
  { sort: 'dueDate', label: 'Due', className: 'hidden w-28 sm:table-cell' },
  { sort: 'updatedAt', label: 'Updated', className: 'hidden w-28 pr-4 xl:table-cell sm:pr-6' },
];

/** Columns sorted descending first (most useful end on top). */
const DESC_FIRST = new Set<TaskSort>(['priority', 'updatedAt', 'createdAt']);

export interface TaskListProps {
  tasks: readonly TaskCard[];
  statuses: readonly Status[];
  options: ListOptions;
  onSort: (sort: TaskSort, order: 'asc' | 'desc') => void;
}

export function TaskList({ tasks, statuses, options, onSort }: TaskListProps) {
  const groups = groupTasks(tasks, options.group, statuses);
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
            {COLUMNS.map((column) => {
              const active = column.sort !== null && options.sort === column.sort;
              const ariaSort = active
                ? options.order === 'asc'
                  ? 'ascending'
                  : 'descending'
                : undefined;
              return (
                <th
                  key={column.label}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn('h-9 px-2 font-medium', column.className)}
                >
                  {column.sort ? (
                    <button
                      type="button"
                      className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      onClick={() => {
                        const sort = column.sort as TaskSort;
                        const order = active
                          ? options.order === 'asc'
                            ? 'desc'
                            : 'asc'
                          : DESC_FIRST.has(sort)
                            ? 'desc'
                            : 'asc';
                        onSort(sort, order);
                      }}
                    >
                      {column.label}
                      {active ? (
                        options.order === 'asc' ? (
                          <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDownIcon className="size-3.5 opacity-40" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.key}>
              {options.group !== 'none' ? (
                <tr className="border-b bg-muted/20">
                  {/* Spans the key and title columns only: the other columns hide on small
                      screens, and a wider span would make the fixed layout share the width. */}
                  <th
                    scope="colgroup"
                    colSpan={2}
                    className="h-8 px-4 text-left text-xs font-semibold sm:px-6"
                  >
                    <span className="inline-flex items-center gap-2">
                      <GroupMark group={group} />
                      {group.label}
                      <span className="font-normal text-muted-foreground">
                        {group.tasks.length}
                      </span>
                    </span>
                  </th>
                  {COLUMNS.slice(2).map((column) => (
                    <td key={column.label} className={column.className} />
                  ))}
                </tr>
              ) : null}
              {group.tasks.map((task) => (
                <Row key={`${group.key}:${task.id}`} task={task} />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupMark({ group }: { group: TaskGroup }) {
  if (group.status) return <StatusIcon status={group.status} />;
  if (group.priority !== undefined) {
    return <PriorityIcon value={group.priority as 0 | 1 | 2 | 3 | 4} />;
  }
  if (group.kind === 'role') {
    return (
      <span
        aria-hidden="true"
        className="size-2.5 rounded-full"
        style={{ backgroundColor: group.color ?? 'var(--muted-foreground)' }}
      />
    );
  }
  return null;
}

function Row({ task }: { task: TaskCard }) {
  const done = task.completedAt !== null;
  return (
    <tr className="group border-b transition-colors hover:bg-muted/40">
      <td className="py-2 pr-2 pl-4 align-top font-mono text-xs text-muted-foreground tabular-nums sm:pl-6">
        <Link to={task.path} tabIndex={-1} className="leading-6">
          {task.ref}
        </Link>
      </td>
      <td className="min-w-0 px-2 py-2 align-top">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusIcon status={task.status} className="md:hidden" />
          <Link
            to={task.path}
            className={cn(
              'max-w-full shrink-0 truncate leading-6 font-medium outline-none hover:underline focus-visible:underline',
              done && 'text-muted-foreground',
            )}
          >
            {task.title}
          </Link>
          <UnreadBadge count={task.unreadCount} />
          {task.blocked ? <BlockedBadge blockers={task.blockers} /> : null}
          {task.labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {task.claim ? (
            <ClaimBadge
              holder={task.claim.user}
              via={task.claim.via}
              claimedAt={task.claim.claimedAt}
            />
          ) : null}
        </div>
      </td>
      <td className="hidden px-2 py-2 align-top leading-6 md:table-cell">
        <StatusBadge status={task.status} />
      </td>
      <td className="hidden px-2 py-2 align-top leading-6 lg:table-cell">
        <PriorityIcon value={task.priority} showLabel />
      </td>
      <td className="hidden px-2 py-2 align-top md:table-cell">
        <div className="flex min-h-6 items-center gap-1">
          {task.assignees.users.length ? (
            <AvatarStack users={task.assignees.users} size="sm" />
          ) : null}
          {task.assignees.roles.slice(0, 1).map((role) => (
            <RoleChip key={role.id} role={role} className="max-w-24" />
          ))}
          {task.assignees.roles.length > 1 ? (
            <span className="text-xs text-muted-foreground">
              +{task.assignees.roles.length - 1}
            </span>
          ) : null}
          {task.assignees.users.length === 0 && task.assignees.roles.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : null}
        </div>
      </td>
      <td className="hidden px-2 py-2 align-top leading-6 sm:table-cell">
        {task.dueDate ? (
          <DueDate value={task.dueDate} done={done} />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="hidden py-2 pr-4 pl-2 align-top text-xs leading-6 sm:pr-6 xl:table-cell">
        <RelativeTime value={task.updatedAt} />
      </td>
    </tr>
  );
}

export function TaskListSkeleton() {
  return (
    <div className="border-y" role="status" aria-label="Loading tasks">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-b px-4 py-3 sm:px-6">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-24 md:block" />
          <Skeleton className="hidden h-4 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}
