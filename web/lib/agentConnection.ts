import { useQuery } from '@tanstack/react-query';
import { agentConnectionSchema, type AgentConnection } from '@shared/schemas/agentRunner';
import { api } from './api';
import { queryKeys } from './queryKeys';

/**
 * Is the viewer's agent connected to a project: a desktop runner with the project mapped to a
 * folder, or an MCP listener (`GET /api/projects/:projectId/agent-connection`)? Live
 * `agent_job.changed` events (jobs, runners registering, listeners starting) and `me.updated`
 * (pausing) refresh it; the interval notices runners that went away without a word.
 */
export function useAgentConnection(
  projectId: string | null | undefined,
  taskId?: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.account.agentConnection(projectId ?? '', taskId ?? null),
    queryFn: ({ signal }) =>
      api.get(
        `/api/projects/${encodeURIComponent(projectId ?? '')}/agent-connection${
          taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
        }`,
        { schema: agentConnectionSchema, signal },
      ),
    enabled: Boolean(projectId) && (options.enabled ?? true),
    refetchInterval: 30_000,
  });
}

export type AgentConnectionProblem =
  | { kind: 'paused'; reason: string; canResume: boolean }
  | { kind: 'no_access' }
  /** `elsewhere`: online runners (machine names) that don't take this project's jobs yet. */
  | { kind: 'not_connected'; elsewhere: string[] };

/** What keeps the viewer's agent from running jobs in the project, or null (all good). */
export function agentConnectionProblem(
  connection: AgentConnection | undefined,
): AgentConnectionProblem | null {
  if (!connection?.agent) return null;
  if (connection.paused) {
    return {
      kind: 'paused',
      reason: connection.pausedReason ?? 'Your agent is paused.',
      canResume: connection.pausedBy === 'owner',
    };
  }
  if (!connection.agentCanView) return { kind: 'no_access' };
  if (connection.covered) return null;
  return {
    kind: 'not_connected',
    elsewhere: connection.runners
      .filter((runner) => runner.online && !runner.coversProject)
      .map((runner) => runner.machineName),
  };
}
