import { z } from 'zod';
import { getActionRequest } from '../../services/agentActions';
import { toAbsolute } from '../util';
import { defineTool, toolInput, type McpTool } from './define';

/**
 * Human sign-off (docs/design/agents-and-pipelines.md §6). Destructive tools (delete_task,
 * remove_member, …) answer `{ pendingApproval: true, requestId, message }` instead of acting while
 * the team wants its agents' destructive actions signed off; this tool reads the outcome.
 */

const getActionRequestTool = defineTool({
  name: 'get_action_request',
  title: 'Get action request',
  description:
    "Checks a destructive action you asked for that waits for your owner's sign-off (the requestId a tool returned with pendingApproval: true). status is pending, approved (it ran; see result), denied, expired (after 7 days) or failed (it ran but was refused; see error). Don't retry a pending or denied action: ask your owner instead.",
  input: toolInput({
    id: z.string().min(1).describe('The requestId from a pendingApproval result'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const request = getActionRequest(ctx.deps, ctx.actor, input.id.trim());
    return { ...request, url: request.url ? toAbsolute(ctx.deps, request.url) : null };
  },
});

export const agentActionTools: McpTool[] = [getActionRequestTool];
