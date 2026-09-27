import {
  FilterXIcon,
  KanbanSquareIcon,
  ListIcon,
  PlusIcon,
  SparklesIcon,
  SquareKanbanIcon,
  TagsIcon,
  UserIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import type { Pipeline } from '@shared/schemas/projects';
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
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { runShellAction, useShellActionAvailable } from '@web/lib/shellActions';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import { blockedPipelines } from '@web/lib/newTaskStages';
import { useLabels, usePipelines, useStatuses } from '../projects/queries';
import { Board, BoardSkeleton } from './Board';
import { CustomizeMenu } from './CustomizeMenu';
import { FILTER_SEARCH_ID, FilterBar } from './FilterBar';
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filtersToQuery,
  LIST_GROUPS,
  useRememberTasksSearch,
  useTaskFilters,
  useTaskView,
  type ListGroup,
  type TaskView,
} from './filters';
import { useDifficulties } from '../projects/difficultyQueries';
import { useAssignables, useBoard, useMoveTask, useTaskList } from './queries';
import { NoStartStageNotices } from './NoStartStageNotices';
import { projectSettingsPath } from './settingsPaths';
import { TaskList, TaskListSkeleton } from './TaskList';

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
  const access = useProjectAccess(team.id, project.id);
  const canCreate = access.has('CREATE_TASKS');
  const canMove = access.has('UPDATE_TASKS');
  const canManageStatuses = access.has('MANAGE_STATUSES');
  const canManageLabels = access.has('MANAGE_LABELS');
  const projectBase = `/t/${team.slug}/p/${project.key}`;
  const navigate = useNavigate();
  const createAvailable = useShellActionAvailable('task.create');
  const [view, setView] = useTaskView(project.id);
  const { filters, listOptions, setFilters, setListOptions } = useTaskFilters();
  useRememberTasksSearch(project.id);
  // BAT-25: with several pipelines, tabs pick one (`?pipeline=`) or show them all.
  const [params, setParams] = useSearchParams();
  const pipelines = usePipelines(project.id);
  const pipelineList = pipelines.data ?? [];
  const pipeline = pipelineList.find((candidate) => candidate.id === params.get('pipeline'));
  // The last tab is remembered per project (this browser only).
  const storageKey = `baton.pipelineTab.${project.id}`;
  const hasParam = params.has('pipeline');
  const remembered = (() => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  })();
  useEffect(() => {
    if (hasParam || !remembered || remembered === 'all') return;
    if (!pipelines.data?.some((candidate) => candidate.id === remembered)) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('pipeline', remembered);
        return next;
      },
      { replace: true },
    );
  }, [hasParam, remembered, pipelines.data, setParams]);
  const selectPipeline = (pipelineId: string | null) => {
    try {
      window.localStorage.setItem(storageKey, pipelineId ?? 'all');
    } catch {
      // Storage unavailable: the tab just isn't remembered.
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (pipelineId) next.set('pipeline', pipelineId);
        else next.delete('pipeline');
        next.delete('status');
        return next;
      },
      { replace: true },
    );
  };
  const query = {
    ...filtersToQuery(filters),
    ...(pipeline ? { pipeline: pipeline.id } : {}),
  };
  const filterCount = activeFilterCount(filters);
  const allStatuses = useStatuses(project.id);
  const statuses = {
    ...allStatuses,
    data: allStatuses.data?.filter(
      (status) => !pipeline || !status.pipelineId || status.pipelineId === pipeline.id,
    ),
  };
  const pipelineNameOf =
    pipelineList.length > 1 && !pipeline
      ? (id: string | undefined) => pipelineList.find((candidate) => candidate.id === id)?.name
      : undefined;
  // BAT-34: pipelines where no stage accepts new tasks are warned about.
  const { blocked, createBlocked } = blockedPipelines(
    statuses.data ?? [],
    pipelineList,
    pipeline?.id,
  );
  const labels = useLabels(project.id);
  const difficulties = useDifficulties(project.id);
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
    runShellAction('task.create', {
      projectId: project.id,
      statusId,
      ...(pipeline ? { pipelineId: pipeline.id } : {}),
    });
  useHotkey('b', toggleView, { description: 'Toggle board / list', group: 'Project' });
  useHotkey('/', () => document.getElementById(FILTER_SEARCH_ID)?.focus(), {
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
    ...(canManageStatuses
      ? [
          {
            id: `tasks.${project.id}.editStatuses`,
            label: 'Edit statuses',
            group: 'Board',
            icon: KanbanSquareIcon,
            keywords: ['customize board', 'columns', 'workflow', 'status settings'],
            perform: () =>
              void navigate(projectSettingsPath(projectBase, 'statuses', undefined, pipeline?.id)),
          },
          {
            id: `tasks.${project.id}.pipelines`,
            label: 'Manage pipelines',
            group: 'Board',
            icon: KanbanSquareIcon,
            keywords: ['pipelines', 'workflows', 'boards'],
            perform: () => void navigate(projectSettingsPath(projectBase, 'statuses')),
          },
        ]
      : []),
    ...(pipelineList.length > 1
      ? [null, ...pipelineList].map((item) => ({
          id: `tasks.${project.id}.pipeline.${item?.id ?? 'all'}`,
          label: item ? `Show the ${item.name} pipeline` : 'Show all pipelines',
          group: 'Board',
          icon: SquareKanbanIcon,
          keywords: ['pipeline', 'tab', item?.name ?? 'all'],
          perform: () => selectPipeline(item?.id ?? null),
        }))
      : []),
    ...(canManageLabels
      ? [
          {
            id: `tasks.${project.id}.editLabels`,
            label: 'Edit labels',
            group: 'Board',
            icon: TagsIcon,
            keywords: ['customize board', 'tags', 'label settings'],
            perform: () => void navigate(projectSettingsPath(projectBase, 'labels')),
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
      <CustomizeMenu
        projectBase={projectBase}
        canManageStatuses={canManageStatuses}
        canManageLabels={canManageLabels}
        pipelineId={pipeline?.id}
      />
      {canCreate && createAvailable ? (
        <Button size="sm" onClick={() => newTask()} disabled={createBlocked}>
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
  const onCreate = canCreate && createAvailable && !createBlocked ? () => newTask() : undefined;

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
    ) : (
      <Board
        board={board.data}
        canMove={canMove}
        canCreate={canCreate && createAvailable}
        filtered={filterCount > 0}
        // Viewers who can't add tasks just see the empty columns.
        hint={nothingYet && onCreate ? <NoTasksHint onCreate={onCreate} /> : undefined}
        editStatusHref={
          canManageStatuses
            ? (statusId) =>
                projectSettingsPath(
                  projectBase,
                  'statuses',
                  statusId,
                  pipelineList.length > 1
                    ? board.data?.columns.find((column) => column.status.id === statusId)?.status
                        .pipelineId
                    : undefined,
                )
            : undefined
        }
        onQuickAdd={(statusId) => newTask(statusId)}
        pipelineNameOf={pipelineNameOf}
        difficulties={difficulties.data}
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
      <>
        <TaskList
          tasks={[]}
          statuses={statuses.data ?? []}
          options={listOptions}
          onSort={(sort, order) => setListOptions({ sort, order })}
        />
        <div className="px-4 py-3 sm:px-6">
          <NoTasksHint onCreate={onCreate} className="max-w-md" />
        </div>
      </>
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
        {pipelineList.length > 1 ? (
          <PipelineTabs
            pipelines={pipelineList}
            selectedId={pipeline?.id ?? null}
            onSelect={selectPipeline}
          />
        ) : null}
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
        {canCreate ? (
          <NoStartStageNotices
            blocked={blocked}
            named={pipelineList.length > 1}
            projectBase={projectBase}
            canManageStatuses={canManageStatuses}
          />
        ) : null}
      </div>
      {content}
    </div>
  );
}

/** The board's pipelines (BAT-25): All, then each one the viewer can see. */
function PipelineTabs({
  pipelines,
  selectedId,
  onSelect,
}: {
  pipelines: readonly Pipeline[];
  selectedId: string | null;
  onSelect: (pipelineId: string | null) => void;
}) {
  const tabs = [
    { id: null, name: 'All', count: pipelines.reduce((sum, item) => sum + item.taskCount, 0) },
    ...pipelines.map((item) => ({ id: item.id, name: item.name, count: item.taskCount })),
  ];
  return (
    <div role="tablist" aria-label="Pipelines" className="mb-3 flex flex-wrap gap-1 border-b">
      {tabs.map((tab) => (
        <button
          key={tab.id ?? 'all'}
          type="button"
          role="tab"
          aria-selected={tab.id === selectedId}
          onClick={() => onSelect(tab.id)}
          className={cn(
            '-mb-px border-b-2 px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
            tab.id === selectedId
              ? 'border-primary font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.name}
          <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{tab.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The prompt of a project without tasks: a compact card in the board's first column (or under the
 * list's headers) instead of a page-wide empty state, so the project's statuses stay visible.
 * Announced once as it appears (a polite status); the button opens the New task dialog, like `c`.
 */
function NoTasksHint({ onCreate, className }: { onCreate?: () => void; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-lg border border-dashed border-primary/40 bg-card p-3 text-sm shadow-xs',
        className,
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
        No tasks yet
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {onCreate
          ? 'Add the first one, or let an agent pick up work with claim_next_task over MCP.'
          : 'Tasks added to this project will show up here.'}
      </p>
      {onCreate ? (
        <Button size="sm" className="mt-3" onClick={onCreate}>
          <PlusIcon aria-hidden="true" />
          Create a task
          <Kbd
            keys="c"
            className="ml-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground sm:inline-flex"
          />
        </Button>
      ) : null}
    </div>
  );
}
