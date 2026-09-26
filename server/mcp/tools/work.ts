import { z } from 'zod';
import { PRIORITY_KEYS } from '@shared/constants';
import { dueDateSchema } from '@shared/schemas/common';
import { DUE_FILTERS, MY_TASKS_SORTS, type MyTask } from '@shared/schemas/work';
import { getDashboard } from '../../services/dashboard';
import { listMyTasks } from '../../services/myWork';
import { resolveProject, resolveTeam } from '../../services/refs';
import { toAbsolute, withAbsoluteUrls } from '../util';
import { defineTool, type McpTool, type ToolContext } from './define';

/**
 * Work MCP tools (SPEC §5.1 [work]): `my_tasks` and `dashboard_summary`, over the same services
 * as `GET /api/me/tasks` and `GET /api/me/dashboard`.
 */

const todayField = dueDateSchema
  .optional()
  .describe(
    "Your local date as YYYY-MM-DD, used to decide what is overdue or due soon (due dates have no time zone). Default: today's date in UTC",
  );

const TASK_FIELDS_NOTE =
  'Each task has ref (KEY-12), title, status (name, category open/done), priority (0 none, 1 low, 2 medium, 3 high, 4 urgent), dueDate (YYYY-MM-DD or null), labels, assignees (users and roles), claim (holder, via key, lease end) or null, blocked, team, project, url, and assignment (direct: assigned to you by name; roles: your roles it is assigned to).';

function absoluteTasks(ctx: ToolContext, tasks: readonly MyTask[]): MyTask[] {
  return withAbsoluteUrls(ctx.deps, tasks);
}

const myTasksTool = defineTool({
  name: 'my_tasks',
  title: 'My tasks',
  description: `Open tasks assigned to you, directly or through one of your roles, across all your teams and projects (tasks in done statuses are left out). Use it to decide what to work on next; claim one with claim_task or let claim_next_task pick. ${TASK_FIELDS_NOTE}`,
  input: z.object({
    team: z.string().optional().describe('Only tasks of this team (slug or id)'),
    project: z
      .string()
      .optional()
      .describe('Only tasks of this project: KEY, team-slug/KEY or project id'),
    priority: z
      .array(z.enum(PRIORITY_KEYS))
      .max(PRIORITY_KEYS.length)
      .optional()
      .describe('Only these priorities, e.g. ["high", "urgent"]'),
    due: z
      .enum(DUE_FILTERS)
      .optional()
      .describe(
        'Only tasks that are overdue, due today, due this week (today and the next 6 days) or have no due date',
      ),
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Text in the title, or a task ref such as WEB-12'),
    sort: z
      .enum(MY_TASKS_SORTS)
      .default('priority')
      .describe(
        'priority (default: highest first, then earliest due), due (earliest due first), updated (recently changed first) or created (newest first)',
      ),
    today: todayField,
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Most tasks to return (1–200, default 50); `total` counts every match'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const teamId = input.team ? resolveTeam(ctx.deps, ctx.actor, input.team).team.id : undefined;
    const projectId = input.project
      ? resolveProject(ctx.deps, ctx.actor, input.project).project.id
      : undefined;
    const result = listMyTasks(ctx.deps, ctx.actor, {
      teamId,
      projectId,
      priority: input.priority,
      due: input.due,
      q: input.query?.trim() || undefined,
      sort: input.sort,
      today: input.today,
    });
    const tasks = absoluteTasks(ctx, result.items.slice(0, input.limit));
    return { total: result.total, returned: tasks.length, tasks };
  },
});

const dashboardSummaryTool = defineTool({
  name: 'dashboard_summary',
  title: 'Dashboard summary',
  description: `Your dashboard: counts (open tasks assigned to you, overdue, due within 7 days, claimed by you), the most urgent assigned tasks, overdue and due-soon tasks, tasks you or your agents have claimed (with the key and lease), the latest activity across your teams that you may see, and your teams with their projects and open task/issue counts. ${TASK_FIELDS_NOTE}`,
  input: z.object({ today: todayField }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const dashboard = getDashboard(ctx.deps, ctx.actor, { today: input.today });
    return {
      ...dashboard,
      assigned: absoluteTasks(ctx, dashboard.assigned),
      overdue: absoluteTasks(ctx, dashboard.overdue),
      dueSoon: absoluteTasks(ctx, dashboard.dueSoon),
      claimed: absoluteTasks(ctx, dashboard.claimed),
      activity: withAbsoluteUrls(ctx.deps, dashboard.activity),
      teams: dashboard.teams.map((team) => ({
        ...team,
        url: toAbsolute(ctx.deps, team.url),
        projects: withAbsoluteUrls(ctx.deps, team.projects),
      })),
    };
  },
});

export const workTools: McpTool[] = [myTasksTool, dashboardSummaryTool];
