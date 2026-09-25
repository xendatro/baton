import type { McpTool } from './define';

/**
 * Issue MCP tools (owner: issues module): list_issues, get_issue, create_issue, update_issue, resolve_issue, reopen_issue, delete_issue, restore_issue.
 * Declare each with `defineTool`; handlers call services only.
 */
export const issuesTools: McpTool[] = [];
