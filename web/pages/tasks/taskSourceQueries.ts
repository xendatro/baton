import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { taskDraftStateSchema } from '@shared/schemas/chat';
import { taskSchema, type CreateTaskFromIssueInput } from '@shared/schemas/tasks';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';
import type { TaskPrefill } from '@web/lib/taskPrefill';
import { storeTask } from './queries';

/** Data hooks of the New task form's source: create from an issue, and the agent's draft. */

const enc = encodeURIComponent;

/** `POST /api/projects/:projectId/tasks/from-issue` with the form's fields (links the issue). */
export function useCreateTaskFromIssueWith(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskFromIssueInput) =>
      api.post(`/api/projects/${enc(projectId)}/tasks/from-issue`, input, { schema: taskSchema }),
    onSuccess: async (task) => {
      void storeTask(queryClient, task);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.all(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.pipelines(projectId) }),
      ]);
    },
    meta: { suppressErrorToast: true },
  });
}

export function useRequestTaskDraft(source: TaskPrefill['source']) {
  return useMutation({
    mutationFn: () =>
      api.post(
        `/api/items/${enc(source.itemType)}/${enc(source.itemId)}/task-draft`,
        source.replyIds.length > 0 ? { replyIds: source.replyIds } : {},
        { schema: taskDraftStateSchema },
      ),
    meta: { suppressErrorToast: true },
  });
}

/** The draft job (refreshed by `agent_job.changed` when the agent hands it in). */
export function useTaskDraft(jobId: string | null) {
  return useQuery({
    queryKey: queryKeys.taskDraft(jobId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/api/task-drafts/${enc(jobId ?? '')}`, { schema: taskDraftStateSchema, signal }),
    enabled: jobId !== null,
  });
}
