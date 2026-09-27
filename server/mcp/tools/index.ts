import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { accountTools } from './account';
import { adminTools } from './admin';
import { agentActionTools } from './agentActions';
import { coreTools } from './core';
import type { McpTool, ToolContext } from './define';
import { issuesTools } from './issues';
import { projectAccessTools } from './projectAccess';
import { projectsTools } from './projects';
import { tasksTools } from './tasks';
import { teamsTools } from './teams';
import { workTools } from './work';

export { defineTool, type McpTool, type ToolContext, type ToolDefinition } from './define';

/** Every MCP tool, one list per module (SPEC §5.1 tool catalog). */
export const allTools: readonly McpTool[] = [
  ...coreTools,
  ...teamsTools,
  ...projectsTools,
  ...projectAccessTools,
  ...issuesTools,
  ...tasksTools,
  ...workTools,
  ...adminTools,
  ...accountTools,
  ...agentActionTools,
];

/** Registers every tool on a (per-request) MCP server bound to the caller's context. */
export function registerTools(
  server: McpServer,
  ctx: ToolContext,
  tools: readonly McpTool[] = allTools,
): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    seen.add(tool.name);
    tool.register(server, ctx);
  }
}
