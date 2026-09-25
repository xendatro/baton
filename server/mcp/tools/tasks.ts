import type { McpTool } from './define';

/**
 * Task MCP tools (owner: tasks module): list_tasks, get_task, create_task, update_task, move_task, delete_task, restore_task, create_task_from_issue, claim_next_task, claim_task, renew_claim, release_task.
 * Declare each with `defineTool`; handlers call services only.
 */
export const tasksTools: McpTool[] = [];
