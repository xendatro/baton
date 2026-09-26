import {
  FilterXIcon,
  KanbanSquareIcon,
  ListIcon,
  PlusIcon,
  SquareKanbanIcon,
  UserIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Kbd } from '@web/components/common/Kbd';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Button } from '@web/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@web/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { pluralize } from '@web/lib/format';
import { useHotkey } from '@web/lib/hotkeys';
import { useTeamAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { useDocumentTitle } from '@web/lib/title';
import { useLabels, useStatuses } from '../projects/queries';
import { Board, BoardSkeleton } from './Board';
import { FILTER_SEARCH_ID, FilterBar } from './FilterBar';
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filtersToQuery,
  LIST_GROUPS,
  useTaskFilters,
  useTaskView,
  type ListGroup,
  type TaskView,
} from './filters';
import { useAssignables, useBoard, useMoveTask, useTaskList } from './queries';
import { TaskList, TaskListSkeleton } from './TaskList';
import { useShadowingHotkey } from './useShadowingHotkey';

/**
 * Tasks of a project (`/t/:team/p/:key/tasks`): the board or the list (`b` toggles, remembered per
 * project), with the filter bar synced to the URL (`/` focuses it).
 */
export default function TasksPage() {
  const { team, project } = useRouteContext();
  // The project layout renders its pages only once both are resolved.
  if (!team || !project) return null;
  return <Tasks key={project.id} team={team} project={project} />;
}

const GROUP_LABELS: Record<ListGroup, string> = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  none: 'No grouping',
};

function Tasks({ team, project }: { team: MeTeam; project: MeProject }) {
  const me = useMe().data;
  const access = useTeamAccess(team.id);
  const canCreate = access.has('CREATE_TASKS');
  const canMove = access.has('UPDATE_TASKS');
  const createAvailable = useShellActionAvailable('task.create');
  const [view, setView] = useTaskView(project.id);
  const { filters, listOptions, setFilters, setListOptions } = useTaskFilters();
  const query = filtersToQuery(filters);
  const filterCount = activeFilterCount(filters);
  const statuses = useStatuses(project.id);
  const labels = useLabels(project.id);
  const people = useAssignables(team.id);
  const board = useBoard(project.id, query, view === 'board');
  const list = useTaskList(
    project.id,
    { ...query, sort: listOptions.sort, order: listOptions.order },
    view === 'list',
  );
  const move = useMoveTask(project.id);
  useDocumentTitle([view === 'board' ? 'Board' : 'Tasks', project.name]);

  const toggleView = () => setView(view === 'board' ? 'list' : 'board');
  const newTask = (statusId?: string) =>
    runShellAction('task.create', { projectId: project.id, statusId });
  useHotkey('b', toggleView, { description: 'Toggle board / list', group: 'Project' });
  useShadowingHotkey('/', () => document.getElementById(FILTER_SEARCH_ID)?.focus(), {
    description: 'Filter tasks',
    group: 'Project',
  });
  usePaletteCommands([
    {
      id: `tasks.${project.id}.view`,
      label: view === 'board' ? 'Switch to list view' : 'Switch to board view',
      group: 'Board',
      icon: view === 'board' ? ListIcon : SquareKanbanIcon,
      keywords: ['toggle view', 'board', 'list', 'table'],
      shortcut: 'b',
      perform: toggleView,
    },
    {
      id: `tasks.${project.id}.mine`,
      label: 'Show tasks assigned to me',
      group: 'Board',
      icon: UserIcon,
      keywords: ['my tasks', 'filter assignee me'],
      perform: () => setFilters(() => ({ ...EMPTY_FILTERS, assignee: ['me'] })),
    },
    ...(filterCount > 0
      ? [
          {
            id: `tasks.${project.id}.clear`,
            label: 'Clear task filters',
            group: 'Board',
            icon: FilterXIcon,
            keywords: ['reset filters'],
            perform: () => setFilters(() => EMPTY_FILTERS),
          },
        ]
      : []),
  ]);

  const actions = (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={view}
        onValueChange={(value) => {
          if (value) setView(value as TaskView);
        }}
        aria-label="View"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroupItem value="board" aria-label="Board view">
              <KanbanSquareIcon aria-hidden="true" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>
            Board <Kbd keys="b" className="ml-1" />
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroupItem value="list" aria-label="List view">
              <ListIcon aria-hidden="true" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>
            List <Kbd keys="b" className="ml-1" />
          </TooltipContent>
        </Tooltip>
      </ToggleGroup>
      {canCreate && createAvailable ? (
        <Button size="sm" onClick={() => newTask()}>
          <PlusIcon aria-hidden="true" />
          <span className="hidden sm:inline">New task</span>
          <span className="sr-only sm:hidden">New task</span>
          <Kbd
            keys="c"
            className="ml-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
          />
        </Button>
      ) : null}
    </>
  );

  const listControls =
    view === 'list' ? (
      <Select
        value={listOptions.group}
        onValueChange={(value) => setListOptions({ group: value as ListGroup })}
      >
        <SelectTrigger size="sm" className="w-auto" aria-label="Group by">
          <span className="text-muted-foreground">Group:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {LIST_GROUPS.map((group) => (
            <SelectItem key={group} value={group}>
              {GROUP_LABELS[group]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  const current = view === 'board' ? board : list;
  const total = view === 'board' ? board.data?.total : list.data?.total;
  const nothingYet = total === 0 && filterCount === 0;

  const emptyProject = (
    <div className="px-4 sm:px-6">
      <EmptyState
        icon={KanbanSquareIcon}
        title="No tasks yet"
        description="Tasks are the work items of this project. Create one here, or let an agent pick up work with claim_next_task over MCP."
        action={
          canCreate && createAvailable ? (
            <Button onClick={() => newTask()}>
              <PlusIcon aria-hidden="true" />
              Create a task
            </Button>
          ) : undefined
        }
      />
    </div>
  );

  let content;
  if (current.isError && !current.data) {
    content = (
      <div className="px-4 sm:px-6">
        <ErrorState
          title="Couldn’t load the tasks"
          error={current.error}
          onRetry={() => void current.refetch()}
        />
      </div>
    );
  } else if (view === 'board') {
    content = !board.data ? (
      <BoardSkeleton />
    ) : nothingYet ? (
      emptyProject
    ) : (
      <Board
        board={board.data}
        canMove={canMove}
        canCreate={canCreate && createAvailable}
        filtered={filterCount > 0}
        onQuickAdd={(statusId) => newTask(statusId)}
        onMove={(variables) =>
          move.mutate(variables, {
            onError: (error) => toast.error(errorMessage(error, 'Couldn’t move the task.')),
          })
        }
      />
    );
  } else {
    content = !list.data ? (
      <TaskListSkeleton />
    ) : nothingYet ? (
      emptyProject
    ) : list.data.items.length === 0 ? (
      <div className="px-4 sm:px-6">
        <EmptyState
          icon={FilterXIcon}
          title="No tasks match these filters"
          action={
            <Button variant="outline" onClick={() => setFilters(() => EMPTY_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      </div>
    ) : (
      <>
        <TaskList
          tasks={list.data.items}
          statuses={statuses.data ?? []}
          options={listOptions}
          onSort={(sort, order) => setListOptions({ sort, order })}
        />
        {list.data.total > list.data.items.length ? (
          <p className="px-4 py-3 text-xs text-muted-foreground sm:px-6">
            Showing the first {list.data.items.length} of {pluralize(list.data.total, 'task')}.
            Narrow the filters to see the rest.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="px-4 pt-4 pb-3 sm:px-6">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          statuses={statuses.data ?? []}
          labels={labels.data ?? []}
          users={people.users}
          roles={people.roles}
          currentUserId={me?.user.id ?? null}
          actions={actions}
          extra={listControls}
        />
        {filterCount > 0 && total !== undefined ? (
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            {pluralize(total, 'matching task')}
          </p>
        ) : null}
      </div>
      {content}
    </div>
  );
}
