import { z } from 'zod';
import { LIMITS, STATUS_CATEGORIES, STATUS_ICONS } from '@shared/constants';
import {
  createLabelInputSchema,
  createProjectInputSchema,
  createPipelineInputSchema,
  createStatusInputSchema,
  updatePipelineInputSchema,
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
import { resolveDifficulty } from '../../services/difficulties';
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
import {
  createPipeline,
  deletePipeline,
  listPipelines,
  resolvePipeline,
  updatePipeline,
} from '../../services/projectPipelines';
import { resolveLabel, resolveProject, resolveStatus, resolveTeam } from '../../services/refs';
import {
  createStatus,
  deleteStatus,
  listStatuses,
  reorderStatuses,
  updateStatus,
} from '../../services/statuses';
import { toAbsolute, withKeyConflictHint } from '../util';
import { defineTool, toolInput, type McpTool, type ToolContext } from './define';

/**
 * Project MCP tools (SPEC §5.1 [projects]): projects, their statuses and labels. Handlers resolve
 * refs, validate with the shared schemas and call the same services as the REST routes.
 */

const projectRef = z
  .string()
  .min(1)
  .describe('Project: KEY (if unambiguous across your teams), team-slug/KEY, or project id');

const statusRef = z
  .string()
  .min(1)
  .describe(
    'Status name (case-insensitive), Pipeline/Status when several pipelines share it, or id',
  );
const pipelineRef = z
  .string()
  .min(1)
  .describe('Pipeline name (case-insensitive), slug or id (list_pipelines)');
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
  input: toolInput({
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
    'Everything about a project: description, README (markdown), task statuses (stages) in board order with their icon and rules (which one is the default for new tasks), labels with usage counts, counts, previous keys and URL.',
  input: toolInput({ project: projectRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) =>
    withUrl(ctx, getProject(ctx.deps, ctx.actor, projectContext(ctx, input.project).id)),
});

const createProjectTool = defineTool({
  name: 'create_project',
  title: 'Create project',
  description:
    'Creates a project in a team (needs MANAGE_PROJECTS). Every project has at least one pipeline: it starts with one (named by `pipeline`, else "Main") whose stages are Open (default) and Done. The key is derived from the name unless given.',
  input: toolInput({
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
    pipeline: z
      .string()
      .max(40)
      .optional()
      .describe('Name of the project’s first pipeline (e.g. Development); "Main" if omitted'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { team, pipeline, ...fields } = input;
    const teamId = resolveTeam(ctx.deps, ctx.actor, team).team.id;
    const parsed = parseInput(createProjectInputSchema, { ...fields, pipelineName: pipeline });
    return withUrl(ctx, createProject(ctx.deps, ctx.actor, teamId, parsed));
  },
});

const updateProjectTool = defineTool({
  name: 'update_project',
  title: 'Update project',
  description:
    'Changes a project’s name, key, description, README, icon or color (needs MANAGE_PROJECTS). A new key keeps the old one working for existing refs and links. Pass only the fields to change.',
  input: toolInput({
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
  annotations: { destructiveHint: false },
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
  input: toolInput({ project: projectRef }),
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
  input: toolInput({
    project: z
      .string()
      .min(1)
      .describe('The deleted project: its id, or team-slug/KEY (the most recently deleted match)'),
    key: z.string().optional().describe('New key, when the old one is now used by another project'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const project = findDeletedProject(ctx.deps, ctx.actor, input.project);
    const parsed = parseInput(restoreProjectInputSchema, { key: input.key });
    const restore = () => restoreProject(ctx.deps, ctx.actor, project.id, parsed);
    return withUrl(
      ctx,
      input.key === undefined
        ? withKeyConflictHint(
            restore,
            (suggestion) => `Call restore_project again with key (e.g. "${suggestion}").`,
          )
        : restore(),
    );
  },
});

/** Stage behaviour an agent can set on a status (the full pipeline rules are edited on the web). */
const stageFields = {
  icon: z
    .enum(STATUS_ICONS)
    .optional()
    .describe(`Icon shape: ${STATUS_ICONS.join(', ')}`),
  handoff: z
    .enum(['keep', 'nobody'])
    .optional()
    .describe(
      'Who is assigned when a task enters: keep (its assignees there last time, else the previous stage’s) or nobody. Other hand-offs are set on the web.',
    ),
  onEnter: z
    .strictObject({
      resolveIssues: z.boolean().optional().describe('Resolve the issues the task fixes'),
      releaseClaim: z.boolean().optional().describe('Release the claim'),
      notifyAuthor: z.boolean().optional().describe('Tell the author it reached this stage'),
      notifyAssignees: z
        .boolean()
        .optional()
        .describe('Notify the people the hand-off assigns (default true)'),
      notifyPreviousHolder: z
        .boolean()
        .optional()
        .describe('Tell whoever held it in the stage it left that it reached this stage'),
    })
    .optional()
    .describe('What entering the stage does (only the flags given change)'),
  blocksDependents: z
    .boolean()
    .optional()
    .describe('Tasks here still block the tasks waiting on them (default true)'),
  claimable: z
    .boolean()
    .optional()
    .describe('claim_next_task / claim_task may take tasks here (default true)'),
  allowCreate: z
    .boolean()
    .optional()
    .describe(
      'New tasks can start here (default false for a new stage; making a stage the default turns it on). create_task without a status starts in the default stage when it allows this, else the first stage that does.',
    ),
  category: z
    .enum(STATUS_CATEGORIES)
    .optional()
    .describe('Deprecated and ignored: statuses have no open/done category any more'),
  defaultDifficulty: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'Difficulty (level name or id) a task gets on its first visit to this stage; null for none (it keeps the one it had)',
    ),
  sendBackTo: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe(
      'Earlier stages of the same pipeline (names or ids) tasks may be sent back to from this one, with a reason; [] for none. A new stage can send back to every earlier stage by default.',
    ),
};

/** `{ defaultDifficultyId }` for a level ref (null: none), or nothing when not given. */
function defaultDifficultyOf(ctx: ToolContext, projectId: string, ref: string | null | undefined) {
  if (ref === undefined) return {};
  return {
    defaultDifficultyId:
      ref === null ? null : resolveDifficulty(ctx.deps.db.orm, projectId, ref).id,
  };
}

/** Send-back stage refs as ids of the pipeline's stages. */
function sendBackIds(
  ctx: ToolContext,
  projectId: string,
  refs: readonly string[] | undefined,
  pipelineId: string | undefined,
) {
  return refs?.map((ref) => resolveStatus(ctx.deps.db.orm, projectId, ref, { pipelineId }).id);
}

/** The stage fields as a rules patch (undefined when none is given). */
function stageRulesPatch(input: {
  handoff?: 'keep' | 'nobody' | undefined;
  onEnter?:
    | {
        resolveIssues?: boolean | undefined;
        releaseClaim?: boolean | undefined;
        notifyAuthor?: boolean | undefined;
        notifyAssignees?: boolean | undefined;
        notifyPreviousHolder?: boolean | undefined;
      }
    | undefined;
  blocksDependents?: boolean | undefined;
  claimable?: boolean | undefined;
  allowCreate?: boolean | undefined;
  sendBackTo?: string[] | undefined;
}) {
  const onEnter = input.onEnter
    ? Object.fromEntries(Object.entries(input.onEnter).filter(([, value]) => value !== undefined))
    : undefined;
  const patch = {
    ...(input.handoff ? { handoff: { mode: input.handoff } } : {}),
    ...(onEnter ? { onEnter } : {}),
    ...(input.blocksDependents !== undefined ? { blocksDependents: input.blocksDependents } : {}),
    ...(input.claimable !== undefined ? { claimable: input.claimable } : {}),
    ...(input.allowCreate !== undefined ? { allowCreate: input.allowCreate } : {}),
    ...(input.sendBackTo !== undefined ? { sendBackTo: input.sendBackTo } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

const listStatusesTool = defineTool({
  name: 'list_statuses',
  title: 'List statuses',
  description:
    'Task statuses (stages) of a project in board order, pipeline by pipeline (pipelineId; see list_pipelines): name, color, icon, whether it is the default for new tasks of its pipeline, how many tasks it holds, and its rules (hand-off, onEnter effects such as resolving fixed issues or releasing the claim, blocksDependents, claimable, allowCreate (new tasks can start here), exit criteria, approvals).',
  input: toolInput({
    project: projectRef,
    pipeline: pipelineRef.optional().describe('Only the stages of this pipeline'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { items } = listStatuses(
      ctx.deps,
      ctx.actor,
      projectContext(ctx, input.project).id,
      input.pipeline,
    );
    return { statuses: items };
  },
});

const listPipelinesTool = defineTool({
  name: 'list_pipelines',
  title: 'List pipelines',
  description:
    'Pipelines of a project (BAT-25): its separate sets of stages, each with its own board (e.g. Modeling and Scripting). Every project has a default one. For each: name, slug, whether it is the default, how many stages and tasks it has, who may see it, create tasks in it and edit its stages (null: everyone), and whether you can create tasks in it or manage it. Pass `pipeline` to create_task, list_tasks and list_statuses.',
  input: toolInput({ project: projectRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { items } = listPipelines(ctx.deps, ctx.actor, projectContext(ctx, input.project).id);
    return { pipelines: items };
  },
});

const createPipelineTool = defineTool({
  name: 'create_pipeline',
  title: 'Create pipeline',
  description:
    'Adds a pipeline to a project (needs MANAGE_STATUSES), starting with an Open and a Done stage: add its own stages with create_status { pipeline }.',
  input: toolInput({
    project: projectRef,
    name: z.string().min(1).max(40).describe('Pipeline name, e.g. Modeling'),
    color: colorField.optional(),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const parsed = parseInput(createPipelineInputSchema, { name: input.name, color: input.color });
    return createPipeline(ctx.deps, ctx.actor, projectContext(ctx, input.project).id, parsed);
  },
});

const updatePipelineTool = defineTool({
  name: 'update_pipeline',
  title: 'Update pipeline',
  description: 'Renames a pipeline or changes its color (needs to be able to edit its stages).',
  input: toolInput({
    project: projectRef,
    pipeline: pipelineRef,
    name: z.string().min(1).max(40).optional().describe('New name'),
    color: colorField.optional(),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const projectId = projectContext(ctx, input.project).id;
    const pipeline = resolvePipeline(ctx.deps.db.orm, projectId, input.pipeline);
    const parsed = parseInput(updatePipelineInputSchema, { name: input.name, color: input.color });
    return updatePipeline(ctx.deps, ctx.actor, pipeline.id, parsed);
  },
});

const deletePipelineTool = defineTool({
  name: 'delete_pipeline',
  title: 'Delete pipeline',
  description:
    'Deletes a pipeline that is not the default (needs MANAGE_STATUSES): its tasks move to `moveTo`, a stage of another pipeline, and its stages go.',
  input: toolInput({
    project: projectRef,
    pipeline: pipelineRef,
    moveTo: statusRef.describe(
      'Stage of another pipeline that receives its tasks (Pipeline/Status)',
    ),
  }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const projectId = projectContext(ctx, input.project).id;
    const { orm } = ctx.deps.db;
    const pipeline = resolvePipeline(orm, projectId, input.pipeline);
    const moveTo = resolveStatus(orm, projectId, input.moveTo);
    const result = deletePipeline(ctx.deps, ctx.actor, pipeline.id, { moveTo: moveTo.id });
    return { ...result, deleted: pipeline.name, movedTo: moveTo.name };
  },
});

const createStatusTool = defineTool({
  name: 'create_status',
  title: 'Create status',
  description:
    'Adds a task status (stage) at the end of the board (needs MANAGE_STATUSES). A stage is just a column unless you give it rules: e.g. a finishing stage has handoff nobody, onEnter { resolveIssues, releaseClaim, notifyAuthor, notifyPreviousHolder }, blocksDependents false and claimable false. New tasks can only start in stages with allowCreate (off unless given or isDefault).',
  input: toolInput({
    project: projectRef,
    name: z.string().min(1).max(LIMITS.statusName.max).describe('Status name, e.g. In review'),
    color: colorField.optional(),
    isDefault: z.boolean().optional().describe('Make it the default status for new tasks'),
    pipeline: pipelineRef.optional().describe('The pipeline it joins (default: the default one)'),
    ...stageFields,
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const {
      project,
      pipeline,
      handoff,
      onEnter,
      blocksDependents,
      claimable,
      allowCreate,
      sendBackTo,
      defaultDifficulty,
      ...fields
    } = input;
    const projectId = projectContext(ctx, project).id;
    const pipelineId = pipeline
      ? resolvePipeline(ctx.deps.db.orm, projectId, pipeline).id
      : undefined;
    const rules = stageRulesPatch({
      handoff,
      onEnter,
      blocksDependents,
      claimable,
      allowCreate,
      sendBackTo: sendBackIds(ctx, projectId, sendBackTo, pipelineId),
    });
    const parsed = parseInput(createStatusInputSchema, {
      ...fields,
      ...(rules ? { rules } : {}),
      ...(pipelineId ? { pipelineId } : {}),
      ...defaultDifficultyOf(ctx, projectId, defaultDifficulty),
    });
    return createStatus(ctx.deps, ctx.actor, projectId, parsed);
  },
});

const updateStatusTool = defineTool({
  name: 'update_status',
  title: 'Update status',
  description:
    'Renames a status, changes its color, icon or stage behaviour, or makes it the default for new tasks (needs MANAGE_STATUSES). Changing blocksDependents marks its tasks completed (false) or not (true).',
  input: toolInput({
    project: projectRef,
    status: statusRef,
    name: z.string().optional().describe('New name'),
    color: colorField.optional(),
    ...stageFields,
    isDefault: z
      .literal(true)
      .optional()
      .describe('true to make this the default status (the previous default is unset)'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const {
      project,
      status,
      handoff,
      onEnter,
      blocksDependents,
      claimable,
      allowCreate,
      sendBackTo,
      defaultDifficulty,
      ...fields
    } = input;
    const projectId = projectContext(ctx, project).id;
    const row = resolveStatus(ctx.deps.db.orm, projectId, status);
    const statusId = row.id;
    const rules = stageRulesPatch({
      handoff,
      onEnter,
      blocksDependents,
      claimable,
      allowCreate,
      sendBackTo: sendBackIds(ctx, projectId, sendBackTo, row.pipelineId),
    });
    const parsed = parseInput(updateStatusInputSchema, {
      ...fields,
      ...(rules ? { rules } : {}),
      ...defaultDifficultyOf(ctx, projectId, defaultDifficulty),
    });
    return updateStatus(ctx.deps, ctx.actor, statusId, parsed);
  },
});

const reorderStatusesTool = defineTool({
  name: 'reorder_statuses',
  title: 'Reorder statuses',
  description:
    'Sets the board order of one pipeline’s statuses (needs MANAGE_STATUSES). List every status of that pipeline exactly once, first column first (Pipeline/Status names when pipelines share a name).',
  input: toolInput({
    project: projectRef,
    statuses: z
      .array(z.string().min(1))
      .min(1)
      .max(PROJECT_LIMITS.statuses)
      .describe('Every status (name or id) in the new order'),
  }),
  annotations: { destructiveHint: false, idempotentHint: true },
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
  input: toolInput({
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
  input: toolInput({ project: projectRef }),
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
  input: toolInput({
    project: projectRef,
    name: z.string().min(1).max(LIMITS.labelName.max).describe('Label name, e.g. bug'),
    color: colorField.optional(),
    description: z
      .string()
      .max(LIMITS.labelDescription.max)
      .optional()
      .describe('What the label means (shown on hover)'),
  }),
  annotations: { destructiveHint: false },
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
  input: toolInput({
    project: projectRef,
    label: labelRef,
    name: z.string().optional().describe('New name'),
    color: colorField.optional(),
    description: z.string().optional().describe('New description (empty string clears it)'),
  }),
  annotations: { destructiveHint: false },
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
  input: toolInput({ project: projectRef, label: labelRef }),
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
  listPipelinesTool,
  createPipelineTool,
  updatePipelineTool,
  deletePipelineTool,
  createStatusTool,
  updateStatusTool,
  reorderStatusesTool,
  deleteStatusTool,
  listLabelsTool,
  createLabelTool,
  updateLabelTool,
  deleteLabelTool,
];
