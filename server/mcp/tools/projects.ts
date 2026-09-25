import type { McpTool } from './define';

/**
 * Project MCP tools (owner: projects module): list_projects, get_project, create_project, update_project, delete_project, restore_project, list_statuses, create_status, update_status, reorder_statuses, delete_status, list_labels, create_label, update_label, delete_label.
 * Declare each with `defineTool`; handlers call services only.
 */
export const projectsTools: McpTool[] = [];
