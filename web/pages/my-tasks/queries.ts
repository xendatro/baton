import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  dashboardResponseSchema,
  myTasksResponseSchema,
  type DueFilter,
  type MyTasksSort,
} from '@shared/schemas/work';
import type { PriorityKey } from '@shared/constants';
import { api } from '@web/lib/api';
import { todayIso } from '@web/lib/format';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Data hooks of the work module (`GET /api/me/tasks`, `GET /api/me/dashboard`). Both send the
 * viewer's calendar date, since due dates have no time zone. Task, member and activity events
 * refresh them through web/lib/live.ts (`queryKeys.work.*`).
 */

export interface MyTasksFilters {
  teamId?: string;
  projectId?: string;
  priority?: readonly PriorityKey[];
  due?: DueFilter;
  q?: string;
  sort: MyTasksSort;
}

export function useMyTasks(filters: MyTasksFilters) {
  const params = {
    teamId: filters.teamId ?? null,
    projectId: filters.projectId ?? null,
    priority: filters.priority && filters.priority.length > 0 ? [...filters.priority] : null,
    due: filters.due ?? null,
    q: filters.q?.trim() || null,
    sort: filters.sort,
  };
  return useQuery({
    queryKey: queryKeys.work.myTasks(params),
    queryFn: ({ signal }) =>
      api.get('/api/me/tasks', {
        query: { ...params, today: todayIso() },
        schema: myTasksResponseSchema,
        signal,
      }),
    // Keep the list on screen while a changed filter loads.
    placeholderData: keepPreviousData,
  });
}

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.work.dashboard(),
    queryFn: ({ signal }) =>
      api.get('/api/me/dashboard', {
        query: { today: todayIso() },
        schema: dashboardResponseSchema,
        signal,
      }),
  });
}
