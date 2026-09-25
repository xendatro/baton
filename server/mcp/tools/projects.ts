import { z } from 'zod';
import { LIMITS, STATUS_CATEGORIES } from '@shared/constants';
import {
  createLabelInputSchema,
  createProjectInputSchema,
  createStatusInputSchema,
  PROJECT_LIMITS,
  restoreProjectInputSchema,
  updateLabelInputSchema,
  updateProjectInputSchema,
  updateStatusInputSchema,
  type Project,
  type ProjectSummary,
} from '@shared/schemas/projects';
import { parseInput } from '../../lib/validate';
import { createLabel, deleteLabel, listLabels, updateLabel } from '../../services/labels';
import {
  createProject,
  deleteProject,
  findDeletedProject,
  getProject,
  listAllProjects,
  listTeamProjects,
  restoreProject,
  updateProject,
} from '../../services/projects';
import { resolveLabel, resolveProject, resolveStatus, resolveTeam } from '../../services/refs';
import {
  createStatus,
  deleteStatus,
  listStatuses,
  reorderStatuses,
  updateStatus,
} from '../../services/statuses';
import { toAbsolute } from '../util';
import { defineTool, type McpTool, type ToolContext } from './define';

/**
 * Project MCP tools (SPEC §5.1 [projects]): projects, their statuses and labels. Handlers resolve
 * refs, validate with the shared schemas and call the same services as the REST routes.
 */

const projectRef = z
  .string()
  .min(1)
  .describe('Project: KEY (if unambiguous across your teams), team-slug/KEY, or project id');

const statusRef = z.string().min(1).describe('Status name (case-insensitive) or id');
const labelRef = z.string().min(1).describe('Label name (case-insensitive) or id');

const colorField = z.string().describe('Hex color like #22c55e');
const emojiField = z.string().describe('A single emoji, e.g. 🚀');

/** Replaces the relative `path` with an absolute `url`, as every MCP entity carries. */
function withUrl<T extends ProjectSummary | Project>(ctx: ToolContext, project: T) {
  const { path, ...rest } = project;
  return { ...rest, url: toAbsolute(ctx.deps, path) };
}

function projectContext(ctx: ToolContext, ref: string) {
  return resolveProject(ctx.deps, ctx.actor, ref).project;
}

const listProjectsTool = defineTool({
  name: 'list_projects',
  title: 'List projects',
  description:
    'Projects in your teams (or in one team), with key, ref, description and open/done task and open/resolved issue counts. Use a project ref (team-slug/KEY) with the other tools.',
  input: z.object({
    team: z.string().optional().describe('Only this team (slug or id); default: all your teams'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { items } = input.team
      ? listTeamProjects(ctx.deps, ctx.actor, resolveTeam(ctx.deps, ctx.actor, input.team).team.id)
      : listAllProjects(ctx.deps, ctx.actor);
    return { projects: items.map((project) => withUrl(ctx, project)) };
  },
});

const getProjectTool = defineTool({
  name: 'get_project',
  title: 'Get project',
  description:
    'Everything about a project: description, README (markdown), task statuses in board order (category open/done, which one is the default for new tasks), labels with usage counts, counts, previous keys and URL.',
  input: z.object({ project: projectRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) =>
    withUrl(ctx, getProject(ctx.deps, ctx.actor, projectContext(ctx, input.project).id)),
});

const createProjectTool = defineTool({
  name: 'create_project',
  title: 'Create project',
  description:
    'Creates a project in a team (needs MANAGE_PROJECTS). It starts with the statuses Open (default) and Done. The key is derived from the name unless given.',
  input: z.object({
    team: z.string().min(1).describe('Team slug or id'),
    name: z.string().min(1).max(LIMITS.projectName.max).describe('Project name'),
    key: z
      .string()
      .optional()
      .describe(
        '2–6 characters, a letter then letters/digits (e.g. API); derived from the name if omitted',
      ),
    description: z
      .string()
      .max(LIMITS.projectDescription.max)
      .optional()
      .describe('Short description shown on project cards (max 280 characters)'),
    readme: z.string().optional().describe('README in markdown, shown on the project overview'),
    icon: emojiField.optional(),
    color: colorField.optional(),
  }),
  handler: (ctx, input) => {
    const { team, ...fields } = input;
    const teamId = resolveTeam(ctx.deps, ctx.actor, team).team.id;
    const parsed = parseInput(createProjectInputSchema, fields);
    return withUrl(ctx, createProject(ctx.deps, ctx.actor, teamId, parsed));
  },
});

const updateProjectTool = defineTool({
  name: 'update_project',
  title: 'Update project',
  description:
    'Changes a project’s name, key, description, README, icon or color (needs MANAGE_PROJECTS). A new key keeps the old one working for existing refs and links. Pass only the fields to change.',
  input: z.object({
    project: projectRef,
    name: z.string().optional().describe('New name'),
    key: z.string().optional().describe('New key (2–6 characters, e.g. WEB)'),
    description: z.string().optional().describe('New short description (max 280 characters)'),
    readme: z.string().optional().describe('New README markdown (replaces the whole document)'),
    icon: emojiField.nullable().optional().describe('New emoji icon, or null to remove it'),
    color: colorField.optional(),
    attachmentIds: z
      .array(z.string())
      .max(LIMITS.attachmentsPerItem)
      .optional()
      .describe(
        'Ids of pending uploads (upload_attachment without an item) to attach to the project',
      ),
  }),
  handler: (ctx, input) => {
    const { project, ...fields } = input;
    const projectId = projectContext(ctx, project).id;
    const parsed = parseInput(updateProjectInputSchema, fields);
    return withUrl(ctx, updateProject(ctx.deps, ctx.actor, projectId, parsed));
  },
});

const deleteProjectTool = defineTool({
  name: 'delete_project',
  title: 'Delete project',
  description:
    'Moves a project to Trash (needs MANAGE_PROJECTS). Its issues and tasks disappear from lists and search until it is restored; it is purged after 30 days.',
  input: z.object({ project: projectRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const project = projectContext(ctx, input.project);
    deleteProject(ctx.deps, ctx.actor, project.id);
    return { ok: true, deleted: { id: project.id, key: project.key, name: project.name } };
  },
});

const restoreProjectTool = defineTool({
  name: 'restore_project',
  title: 'Restore project',
  description:
    'Restores a project from Trash with everything in it (needs MANAGE_PROJECTS or MANAGE_TRASH). If another project took its key meanwhile, pass a new key.',
  input: z.object({
    project: z
      .string()
      .min(1)
      .describe('The deleted project: its id, or team-slug/KEY (the most recently deleted match)'),
    key: z.string().optional().describe('New key, when the old one is now used by another project'),
  }),
  handler: (ctx, input) => {
    const project = findDeletedProject(ctx.deps, ctx.actor, input.project);
    const parsed = parseInput(restoreProjectInputSchema, { key: input.key });
    return withUrl(ctx, restoreProject(ctx.deps, ctx.actor, project.id, parsed));
  },
});

const listStatusesTool = defineTool({
  name: 'list_statuses',
  title: 'List statuses',
  description:
    'Task statuses of a project in board order: name, color, category (open or done; done counts as finished), whether it is the default for new tasks, and how many tasks it holds.',
  input: z.object({ project: projectRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { items } = listStatuses(ctx.deps, ctx.actor, projectContext(ctx, input.project).id);
    return { statuses: items };
  },
});

const createStatusTool = defineTool({
  name: 'create_status',
  title: 'Create status',
  description:
    'Adds a task status at the end of the board (needs MANAGE_STATUSES). Category done means tasks in it count as finished.',
  input: z.object({
    project: projectRef,
    name: z.string().min(1).max(LIMITS.statusName.max).describe('Status name, e.g. In review'),
    category: z
      .enum(STATUS_CATEGORIES)
      .default('open')
      .describe('open (work in progress or to do) or done (finished)'),
    color: colorField.optional(),
    isDefault: z.boolean().optional().describe('Make it the default status for new tasks'),
  }),
  handler: (ctx, input) => {
    const { project, ...fields } = input;
    const parsed = parseInput(createStatusInputSchema, fields);
    return createStatus(ctx.deps, ctx.actor, projectContext(ctx, project).id, parsed);
  },
});

const updateStatusTool = defineTool({
  name: 'update_status',
  title: 'Update status',
  description:
    'Renames, recolors or recategorizes a status, or makes it the default for new tasks (needs MANAGE_STATUSES). Changing the category marks all its tasks finished (done) or unfinished (open).',
  input: z.object({
    project: projectRef,
    status: statusRef,
    name: z.string().optional().describe('New name'),
    color: colorField.optional(),
    category: z.enum(STATUS_CATEGORIES).optional().describe('open or done'),
    isDefault: z
      .literal(true)
      .optional()
      .describe('true to make this the default status (the previous default is unset)'),
  }),
  handler: (ctx, input) => {
    const { project, status, ...fields } = input;
    const projectId = projectContext(ctx, project).id;
    const statusId = resolveStatus(ctx.deps.db.orm, projectId, status).id;
    const parsed = parseInput(updateStatusInputSchema, fields);
    return updateStatus(ctx.deps, ctx.actor, statusId, parsed);
  },
});

const reorderStatusesTool = defineTool({
  name: 'reorder_statuses',
  title: 'Reorder statuses',
  description:
    'Sets the board order of a project’s statuses (needs MANAGE_STATUSES). List every status exactly once, first column first.',
  input: z.object({
    project: projectRef,
    statuses: z
      .array(z.string().min(1))
      .min(1)
      .max(PROJECT_LIMITS.statuses)
      .describe('Every status (name or id) in the new order'),
  }),
  handler: (ctx, input) => {
    const projectId = projectContext(ctx, input.project).id;
    const statusIds = input.statuses.map(
      (ref) => resolveStatus(ctx.deps.db.orm, projectId, ref).id,
    );
    const { items } = reorderStatuses(ctx.deps, ctx.actor, projectId, { statusIds });
    return { statuses: items };
  },
});

const deleteStatusTool = defineTool({
  name: 'delete_status',
  title: 'Delete status',
  description:
    'Deletes a status and moves its tasks to another status (needs MANAGE_STATUSES). Deleting the default status makes the target the default. The last status can’t be deleted.',
  input: z.object({
    project: projectRef,
    status: statusRef.describe('Status to delete (name or id)'),
    moveTo: statusRef.describe('Status that receives its tasks (name or id)'),
  }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const projectId = projectContext(ctx, input.project).id;
    const { orm } = ctx.deps.db;
    const status = resolveStatus(orm, projectId, input.status);
    const moveTo = resolveStatus(orm, projectId, input.moveTo);
    const result = deleteStatus(ctx.deps, ctx.actor, status.id, { moveTo: moveTo.id });
    return { ...result, deleted: status.name, movedTo: moveTo.name };
  },
});

const listLabelsTool = defineTool({
  name: 'list_labels',
  title: 'List labels',
  description:
    'Labels of a project (shared by its issues and tasks), alphabetical, with color, description and how many issues and tasks use each.',
  input: z.object({ project: projectRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { items } = listLabels(ctx.deps, ctx.actor, projectContext(ctx, input.project).id);
    return { labels: items };
  },
});

const createLabelTool = defineTool({
  name: 'create_label',
  title: 'Create label',
  description:
    'Creates a label for a project’s issues and tasks (needs MANAGE_LABELS). Names are unique per project, ignoring case.',
  input: z.object({
    project: projectRef,
    name: z.string().min(1).max(LIMITS.labelName.max).describe('Label name, e.g. bug'),
    color: colorField.optional(),
    description: z
      .string()
      .max(LIMITS.labelDescription.max)
      .optional()
      .describe('What the label means (shown on hover)'),
  }),
  handler: (ctx, input) => {
    const { project, ...fields } = input;
    const parsed = parseInput(createLabelInputSchema, fields);
    return createLabel(ctx.deps, ctx.actor, projectContext(ctx, project).id, parsed);
  },
});

const updateLabelTool = defineTool({
  name: 'update_label',
  title: 'Update label',
  description: 'Renames, recolors or re-describes a label (needs MANAGE_LABELS).',
  input: z.object({
    project: projectRef,
    label: labelRef,
    name: z.string().optional().describe('New name'),
    color: colorField.optional(),
    description: z.string().optional().describe('New description (empty string clears it)'),
  }),
  handler: (ctx, input) => {
    const { project, label, ...fields } = input;
    const projectId = projectContext(ctx, project).id;
    const labelId = resolveLabel(ctx.deps.db.orm, projectId, label).id;
    const parsed = parseInput(updateLabelInputSchema, fields);
    return updateLabel(ctx.deps, ctx.actor, labelId, parsed);
  },
});

const deleteLabelTool = defineTool({
  name: 'delete_label',
  title: 'Delete label',
  description:
    'Deletes a label and removes it from every issue and task that has it (needs MANAGE_LABELS). This can’t be undone.',
  input: z.object({ project: projectRef, label: labelRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const projectId = projectContext(ctx, input.project).id;
    const label = resolveLabel(ctx.deps.db.orm, projectId, input.label);
    return { ...deleteLabel(ctx.deps, ctx.actor, label.id), deleted: label.name };
  },
});

export const projectsTools: McpTool[] = [
  listProjectsTool,
  getProjectTool,
  createProjectTool,
  updateProjectTool,
  deleteProjectTool,
  restoreProjectTool,
  listStatusesTool,
  createStatusTool,
  updateStatusTool,
  reorderStatusesTool,
  deleteStatusTool,
  listLabelsTool,
  createLabelTool,
  updateLabelTool,
  deleteLabelTool,
];
