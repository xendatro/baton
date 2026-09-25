import type { McpTool } from './define';

/**
 * Work MCP tools (owner: work module): my_tasks, dashboard_summary.
 * Declare each with `defineTool`; handlers call services only.
 */
export const workTools: McpTool[] = [];
