import { z } from 'zod';
import { LIMITS, TRASHABLE_TYPES } from '@shared/constants';
import { TEAM_TRASH_TYPES } from '@shared/schemas/admin';
import {
  getAuditLogFacets,
  listTeamTrash,
  resolveTrashRef,
  restoreTrashItem,
} from '../../services/admin';
import { resolveTeam } from '../../services/refs';
import { toAbsolute } from '../util';
import { defineTool, type McpTool } from './define';

/**
 * Admin MCP tools (SPEC §5.1 [admin]): list_trash, restore_item, and get_audit_log_facets (the
 * audit log's filter values; the log itself is core's get_activity). Handlers call services only.
 */

const teamRef = z.string().min(1).describe('Team slug or id');

const listTrashTool = defineTool({
  name: 'list_trash',
  title: 'List trash',
  description:
    "Deleted items in a team's Trash (projects, issues, tasks, replies, attachments), most recently deleted first: type, title snapshot, ref, who deleted it (and via which key) and the days left before it is purged for good (30 days after deletion). You see the items you authored; with MANAGE_TRASH you see everything. Restore one with restore_item.",
  input: z.object({
    team: teamRef,
    type: z.enum(TEAM_TRASH_TYPES).optional().describe('Only items of this type'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.page.maxSize)
      .default(LIMITS.page.defaultSize)
      .describe('Page size'),
    cursor: z.string().optional().describe('nextCursor from a previous call, for the next page'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { team } = resolveTeam(ctx.deps, ctx.actor, input.team);
    return listTeamTrash(ctx.deps, ctx.actor, team.id, {
      type: input.type,
      limit: input.limit,
      cursor: input.cursor,
    });
  },
});

const restoreItemTool = defineTool({
  name: 'restore_item',
  title: 'Restore item',
  description:
    "Restores a deleted item from Trash: a task (KEY-12), an issue (KEY#51), a project (KEY), each optionally prefixed with team-slug/, or any item's id from list_trash (replies and attachments are restored by id). Authors can restore their own items; restoring someone else's needs MANAGE_TRASH. A reply or attachment can only come back while its task or issue is live, and items of a deleted project come back by restoring the project. Returns the restored item's URL.",
  input: z.object({
    item: z
      .string()
      .min(1)
      .describe('Deleted item: KEY-12, KEY#51, KEY, team-slug/KEY-12, or an id from list_trash'),
    type: z
      .enum(TRASHABLE_TYPES)
      .optional()
      .describe('Item type, to disambiguate an id (optional; checked against a ref)'),
  }),
  annotations: { destructiveHint: false, idempotentHint: false },
  handler: (ctx, input) => {
    const ref = resolveTrashRef(ctx.deps, ctx.actor, { item: input.item, type: input.type });
    const restored = restoreTrashItem(ctx.deps, ctx.actor, ref);
    return { ...restored, url: toAbsolute(ctx.deps, restored.url) };
  },
});

const auditLogFacetsTool = defineTool({
  name: 'get_audit_log_facets',
  title: 'Get audit log filters',
  description:
    "The values present in a team's audit log, to filter get_activity with: actors (usernames), sources, API keys (id, name, owner), entity types, actions and projects. Needs VIEW_AUDIT_LOG.",
  input: z.object({ team: teamRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { team } = resolveTeam(ctx.deps, ctx.actor, input.team);
    return getAuditLogFacets(ctx.deps, ctx.actor, team.id);
  },
});

export const adminTools: McpTool[] = [listTrashTool, restoreItemTool, auditLogFacetsTool];
