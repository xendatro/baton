import { PRIORITY_KEYS, type PriorityKey } from '@shared/constants';
import type { MeTeam } from '@shared/schemas/core';
import {
  DUE_FILTERS,
  MY_TASKS_SORTS,
  type DueFilter,
  type MyTask,
  type MyTasksSort,
} from '@shared/schemas/work';
import type { MyTasksFilters } from './queries';

/**
 * My tasks filters live in the URL (`?team=acme&project=acme/WEB&priority=high,urgent&due=week
 * &sort=due&q=login`), so a filtered view can be bookmarked and shared. Teams and projects are
 * named by slug and key in the URL and resolved to ids through the `me` query.
 */

export interface FilterState {
  /** Team slug. */
  team: string | null;
  /** `team-slug/KEY`. */
  project: string | null;
  priority: PriorityKey[];
  due: DueFilter | null;
  q: string;
  sort: MyTasksSort;
}

export const DEFAULT_SORT: MyTasksSort = 'priority';

export const DUE_LABELS: Record<DueFilter, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due this week',
  none: 'No due date',
};

export const SORT_LABELS: Record<MyTasksSort, string> = {
  priority: 'Priority',
  due: 'Due date',
  updated: 'Recently updated',
  created: 'Newest',
};

function oneOf<T extends string>(values: readonly T[], value: string | null): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

export function parseFilters(params: URLSearchParams): FilterState {
  const priorities = (params.get('priority') ?? '').split(',');
  return {
    team: params.get('team')?.toLowerCase() || null,
    project: params.get('project') || null,
    priority: PRIORITY_KEYS.filter((key) => priorities.includes(key)),
    due: oneOf(DUE_FILTERS, params.get('due')),
    q: params.get('q') ?? '',
    sort: oneOf(MY_TASKS_SORTS, params.get('sort')) ?? DEFAULT_SORT,
  };
}

/** The URL query of a filter state (defaults are left out). */
export function filtersToParams(state: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.team) params.set('team', state.team);
  if (state.project) params.set('project', state.project);
  if (state.priority.length > 0) params.set('priority', state.priority.join(','));
  if (state.due) params.set('due', state.due);
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.sort !== DEFAULT_SORT) params.set('sort', state.sort);
  return params;
}

export function hasActiveFilters(state: FilterState): boolean {
  return (
    state.team !== null ||
    state.project !== null ||
    state.priority.length > 0 ||
    state.due !== null ||
    state.q.trim() !== ''
  );
}

/** `team-slug/KEY` → the team and project it names among the viewer's teams. */
export function findProjectRef(teams: readonly MeTeam[], ref: string | null) {
  if (!ref) return null;
  const [slug, key] = ref.split('/');
  const team = teams.find((candidate) => candidate.slug === slug?.toLowerCase());
  const project = team?.projects.find((candidate) => candidate.key === key?.toUpperCase());
  return team && project ? { team, project } : null;
}

/**
 * The API filters for a state. `null` when the URL names a team or project the viewer can't see
 * (the page then says so instead of silently showing everything).
 */
export function toQueryFilters(
  state: FilterState,
  teams: readonly MeTeam[],
): MyTasksFilters | null {
  const team = state.team ? teams.find((candidate) => candidate.slug === state.team) : undefined;
  if (state.team && !team) return null;
  const project = findProjectRef(teams, state.project);
  if (state.project && !project) return null;
  return {
    teamId: project?.team.id ?? team?.id,
    projectId: project?.project.id,
    priority: state.priority,
    due: state.due ?? undefined,
    q: state.q,
    sort: state.sort,
  };
}

export interface ProjectGroup {
  project: MyTask['project'];
  tasks: MyTask[];
}

export interface TeamGroup {
  team: MyTask['team'];
  projects: ProjectGroup[];
  count: number;
}

/**
 * Groups tasks by team, then project (both alphabetical); tasks keep the server's order within
 * their project.
 */
export function groupTasks(tasks: readonly MyTask[]): TeamGroup[] {
  const teams = new Map<string, TeamGroup>();
  for (const task of tasks) {
    let team = teams.get(task.team.id);
    if (!team) {
      team = { team: task.team, projects: [], count: 0 };
      teams.set(task.team.id, team);
    }
    let project = team.projects.find((group) => group.project.id === task.project.id);
    if (!project) {
      project = { project: task.project, tasks: [] };
      team.projects.push(project);
    }
    project.tasks.push(task);
    team.count += 1;
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...teams.values()]
    .sort((a, b) => byName(a.team, b.team))
    .map((group) => ({
      ...group,
      projects: [...group.projects].sort((a, b) => byName(a.project, b.project)),
    }));
}

/** "via Backend, Frontend" when the task is mine only through roles; null when assigned by name. */
export function assignmentHint(task: Pick<MyTask, 'assignment'>): string | null {
  const { direct, roles } = task.assignment;
  if (direct || roles.length === 0) return null;
  return `via ${roles.map((role) => role.name).join(', ')}`;
}
