import type { McpTool } from './define';

/**
 * Admin MCP tools (owner: admin module): list_trash, restore_item.
 * Declare each with `defineTool`; handlers call services only.
 */
export const adminTools: McpTool[] = [];
