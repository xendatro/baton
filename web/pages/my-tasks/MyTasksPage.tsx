import {
  ArrowDownUpIcon,
  CalendarIcon,
  ChevronDownIcon,
  FolderKanbanIcon,
  ListChecksIcon,
  SearchIcon,
  SignalHighIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PRIORITIES, PRIORITY_KEYS, type PriorityKey } from '@shared/constants';
import type { MeTeam } from '@shared/schemas/core';
import { DUE_FILTERS, MY_TASKS_SORTS, type MyTasksResponse } from '@shared/schemas/work';
import { EmptyState } from '@web/components/common/EmptyState';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { ErrorState } from '@web/components/common/ErrorState';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { PriorityIcon } from '@web/components/common/PriorityIcon';
import { usePaletteCommands } from '@web/components/palette/registry';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { useMe } from '@web/lib/auth';
import { pluralize } from '@web/lib/format';
import { useHotkey } from '@web/lib/hotkeys';
import { useDebouncedValue } from '@web/lib/useDebouncedValue';
import { cn } from '@web/lib/utils';
import { FilterMenu, type FilterOption } from '@web/pages/team-settings/audit-log/FilterMenu';
import { TeamIcon } from '@web/pages/teams/TeamIcon';
import {
  DUE_LABELS,
  filtersToParams,
  groupTasks,
  hasActiveFilters,
  parseFilters,
  SORT_LABELS,
  toQueryFilters,
  type FilterState,
  type TeamGroup,
} from './filters';
import { useMyTasks } from './queries';
import { WorkTaskRow } from './WorkTaskRow';

const EMPTY_FILTERS: FilterState = {
  team: null,
  project: null,
  priority: [],
  due: null,
  q: '',
  sort: 'priority',
};

/**
 * `/my-tasks`: every task assigned to me or my roles in its current stage, grouped by team and
 * project.
 */
export default function MyTasksPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const filters = parseFilters(params);
  const setFilters = (next: FilterState) => setParams(filtersToParams(next), { replace: true });

  return (
    <PageContainer>
      <PageHeader
        title="My tasks"
        description="Tasks assigned to you or to one of your roles in their current stage, across all your teams."
      />
      {me.isPending ? (
        <MyTasksSkeleton />
      ) : me.isError ? (
        <ErrorState
          title="Couldn’t load your teams"
          error={me.error}
          onRetry={() => void me.refetch()}
        />
      ) : me.data.teams.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="You’re not in a team yet"
          description="Tasks assigned to you show up here once you create or join a team."
          action={
            <Button asChild>
              <Link to="/">Go to the dashboard</Link>
            </Button>
          }
        />
      ) : (
        <MyTasks teams={me.data.teams} filters={filters} onChange={setFilters} />
      )}
    </PageContainer>
  );
}

interface MyTasksProps {
  teams: MeTeam[];
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

function MyTasks({ teams, filters, onChange }: MyTasksProps) {
  const queryFilters = toQueryFilters(filters, teams);
  const tasks = useMyTasks(queryFilters ?? { sort: filters.sort });
  const active = hasActiveFilters(filters);
  const clear = () => onChange({ ...EMPTY_FILTERS, sort: filters.sort });

  usePaletteCommands([
    {
      id: 'my-tasks.overdue',
      label: 'My tasks: show overdue',
      group: 'My tasks',
      icon: CalendarIcon,
      keywords: ['late', 'past due'],
      perform: () => onChange({ ...filters, due: 'overdue' }),
    },
    {
      id: 'my-tasks.week',
      label: 'My tasks: show due this week',
      group: 'My tasks',
      icon: CalendarIcon,
      keywords: ['soon', 'upcoming'],
      perform: () => onChange({ ...filters, due: 'week' }),
    },
    ...(active
      ? [
          {
            id: 'my-tasks.clear',
            label: 'My tasks: clear filters',
            group: 'My tasks',
            icon: XIcon,
            keywords: ['reset', 'all'],
            perform: clear,
          },
        ]
      : []),
  ]);

  return (
    <div className="space-y-5">
      <FilterBar teams={teams} filters={filters} onChange={onChange} onClear={clear} />
      {queryFilters === null ? (
        <EmptyState
          icon={FolderKanbanIcon}
          title="That team or project isn’t available"
          description="It may have been renamed or deleted, or you may no longer be a member."
          action={
            <Button variant="outline" onClick={clear}>
              Clear filters
            </Button>
          }
        />
      ) : tasks.isPending ? (
        <ListSkeleton />
      ) : tasks.isError ? (
        <ErrorState
          title="Couldn’t load your tasks"
          error={tasks.error}
          onRetry={() => void tasks.refetch()}
        />
      ) : tasks.data.items.length === 0 ? (
        active ? (
          <EmptyState
            icon={SearchIcon}
            title="No tasks match these filters"
            description="Try another filter, or clear them to see everything assigned to you."
            action={
              <Button variant="outline" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={ListChecksIcon}
            title="Nothing assigned to you"
            description="Tasks assigned to you, or to a role you have, in their current stage show up here. Browse a project’s board to pick something up."
            action={<FirstProjectLink teams={teams} />}
          />
        )
      ) : (
        <TaskGroups data={tasks.data} stale={tasks.isPlaceholderData} />
      )}
    </div>
  );
}

/** A way to find work: the first project's board, or the first team. */
function FirstProjectLink({ teams }: { teams: MeTeam[] }) {
  const team = teams.find((candidate) => candidate.projects.length > 0) ?? teams[0];
  if (!team) return null;
  const project = team.projects[0];
  return (
    <Button asChild>
      {project ? (
        <Link to={`/t/${team.slug}/p/${project.key}/tasks`}>Open the {project.name} board</Link>
      ) : (
        <Link to={`/t/${team.slug}`}>Open {team.name}</Link>
      )}
    </Button>
  );
}

function TaskGroups({ data, stale }: { data: MyTasksResponse; stale: boolean }) {
  const groups = groupTasks(data.items);
  return (
    <div className={cn('space-y-8 transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {pluralize(data.total, 'assigned task')}
        {data.total > data.items.length ? ` · showing the first ${data.items.length}` : null}
      </p>
      {groups.map((group) => (
        <TeamSection key={group.team.id} group={group} />
      ))}
    </div>
  );
}

function TeamSection({ group }: { group: TeamGroup }) {
  const headingId = `team-${group.team.id}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-center gap-2">
        <TeamIcon
          icon={group.team.icon}
          name={group.team.name}
          color={group.team.color}
          size="sm"
        />
        <h2 id={headingId} className="min-w-0 truncate text-sm font-semibold">
          <Link to={`/t/${group.team.slug}`} className="hover:underline">
            {group.team.name}
          </Link>
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">{group.count}</span>
      </div>
      {group.projects.map(({ project, tasks }) => (
        <div key={project.id} className="overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 sm:px-4">
            <EntityIcon icon={project.icon} name={project.name} color={project.color} />
            <h3 className="min-w-0 truncate text-sm font-medium">{project.name}</h3>
            <span className="font-mono text-xs text-muted-foreground">{project.key}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              · {pluralize(tasks.length, 'task')}
            </span>
            <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" asChild>
              <Link to={`/t/${group.team.slug}/p/${project.key}/tasks`}>Board</Link>
            </Button>
          </div>
          <ul className="divide-y">
            {tasks.map((task) => (
              <WorkTaskRow key={task.id} task={task} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

interface FilterBarProps {
  teams: MeTeam[];
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  onClear: () => void;
}

function FilterBar({ teams, filters, onChange, onClear }: FilterBarProps) {
  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    onChange({ ...filters, [key]: value });
  const searchRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(filters.q);
  const debounced = useDebouncedValue(text, 250);
  const latest = useRef({ filters, onChange });
  useEffect(() => {
    latest.current = { filters, onChange };
  });
  // Typing updates the URL once the text settles.
  useEffect(() => {
    const { filters: current, onChange: change } = latest.current;
    if (debounced.trim() !== current.q.trim()) change({ ...current, q: debounced });
  }, [debounced]);
  // The URL changed elsewhere (back button, clear): show its text.
  const [shownQ, setShownQ] = useState(filters.q);
  if (filters.q !== shownQ) {
    setShownQ(filters.q);
    if (filters.q.trim() !== text.trim()) setText(filters.q);
  }

  useHotkey('/', () => searchRef.current?.focus(), {
    description: 'Search my tasks',
    group: 'My tasks',
  });

  const teamOptions: FilterOption[] = teams.map((team) => ({
    value: team.slug,
    label: team.name,
    leading: <TeamIcon icon={team.icon} name={team.name} color={team.color} size="sm" />,
    keywords: [team.slug],
  }));
  const projectTeams = filters.team ? teams.filter((team) => team.slug === filters.team) : teams;
  const projectOptions: FilterOption[] = projectTeams.flatMap((team) =>
    team.projects.map((project) => ({
      value: `${team.slug}/${project.key}`,
      label: project.name,
      description: project.key,
      leading: <EntityIcon icon={project.icon} name={project.name} color={project.color} />,
      keywords: [project.key],
      group: projectTeams.length > 1 ? team.name : undefined,
    })),
  );
  const dueOptions: FilterOption[] = DUE_FILTERS.map((due) => ({
    value: due,
    label: DUE_LABELS[due],
  }));
  const active = hasActiveFilters(filters);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative w-full sm:w-64">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchRef}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setText('');
              event.currentTarget.blur();
            }
          }}
          placeholder="Search title or key…"
          aria-label="Search my tasks"
          className="h-8 pl-8"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        {teams.length > 1 ? (
          <FilterMenu
            label="Team"
            icon={UsersIcon}
            value={filters.team}
            options={teamOptions}
            unknownLabel="Unknown team"
            onChange={(value) =>
              onChange({
                ...filters,
                team: value,
                // A project of another team no longer applies.
                project:
                  value && filters.project && !filters.project.startsWith(`${value}/`)
                    ? null
                    : filters.project,
              })
            }
          />
        ) : null}
        <FilterMenu
          label="Project"
          icon={FolderKanbanIcon}
          value={filters.project}
          options={projectOptions}
          unknownLabel="Unknown project"
          onChange={(value) => set('project', value)}
        />
        <PriorityFilter value={filters.priority} onChange={(value) => set('priority', value)} />
        <FilterMenu
          label="Due"
          icon={CalendarIcon}
          value={filters.due}
          options={dueOptions}
          onChange={(value) => set('due', DUE_FILTERS.find((due) => due === value) ?? null)}
        />
        <SortMenu value={filters.sort} onChange={(value) => set('sort', value)} />
        {active ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onClear}>
            <XIcon aria-hidden="true" />
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Priorities from most to least urgent, as the menu lists them. */
const PRIORITY_ORDER: PriorityKey[] = [...PRIORITY_KEYS].reverse();

function PriorityFilter({
  value,
  onChange,
}: {
  value: PriorityKey[];
  onChange: (value: PriorityKey[]) => void;
}) {
  const labels = value
    .map((key) => PRIORITIES.find((priority) => priority.key === key)?.label ?? key)
    .join(', ');
  const toggle = (key: PriorityKey, checked: boolean) =>
    onChange(
      PRIORITY_KEYS.filter((candidate) =>
        candidate === key ? checked : value.includes(candidate),
      ),
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'max-w-full min-w-0 justify-start',
            value.length > 0 && 'border-primary/40 bg-primary/5 dark:bg-primary/10',
          )}
          aria-label={value.length === 0 ? 'Filter by priority' : `Priority: ${labels}`}
        >
          <SignalHighIcon aria-hidden="true" className="text-muted-foreground" />
          {value.length === 0 ? (
            <span className="text-muted-foreground">Priority</span>
          ) : (
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">Priority: </span>
              {value.length > 2 ? `${value.length} selected` : labels}
            </span>
          )}
          <ChevronDownIcon aria-hidden="true" className="ml-auto text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>Priority</DropdownMenuLabel>
        {PRIORITY_ORDER.map((key) => {
          const priority = PRIORITIES.find((candidate) => candidate.key === key);
          if (!priority) return null;
          return (
            <DropdownMenuCheckboxItem
              key={key}
              checked={value.includes(key)}
              onCheckedChange={(checked) => toggle(key, checked)}
              onSelect={(event) => event.preventDefault()}
            >
              <PriorityIcon value={priority.value} />
              {priority.label}
            </DropdownMenuCheckboxItem>
          );
        })}
        {value.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={false} onCheckedChange={() => onChange([])}>
              <XIcon aria-hidden="true" />
              Any priority
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortMenu({
  value,
  onChange,
}: {
  value: FilterState['sort'];
  onChange: (value: FilterState['sort']) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Sort by ${SORT_LABELS[value].toLowerCase()}`}
        >
          <ArrowDownUpIcon aria-hidden="true" className="text-muted-foreground" />
          <span>
            <span className="text-muted-foreground">Sort: </span>
            {SORT_LABELS[value]}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const sort = MY_TASKS_SORTS.find((candidate) => candidate === next);
            if (sort) onChange(sort);
          }}
        >
          {MY_TASKS_SORTS.map((sort) => (
            <DropdownMenuRadioItem key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------------------------

function ListSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading your tasks">
      <Skeleton className="h-4 w-32" />
      <div className="overflow-hidden rounded-lg border">
        <div className="border-b bg-muted/40 px-4 py-2.5">
          <Skeleton className="h-4 w-40" />
        </div>
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
            <Skeleton className="size-4" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MyTasksSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-20" />
      </div>
      <ListSkeleton />
    </div>
  );
}
