/**
 * Demo tasks for `npm run db:seed` (scripts/seed.ts), seeded after the issues: every status of the
 * Web App, API Platform and Prototype Lab boards, assignees (people and roles), priorities, due
 * dates (overdue, today, soon, later, none), blockers, tasks created from issues (whose `fixes`
 * links resolve them when the task is done), replies with mentions, claims held through API keys
 * and on the web, and one task in Trash.
 *
 * Each step goes through the services and is then moved back to its place on a timeline over the
 * past weeks (`at`), so boards, timelines, the audit log and the inbox read like a real project.
 * Claims stay recent, so they are still valid right after seeding.
 */
import { addDays, format } from 'date-fns';
import { and, asc, eq, gte, isNotNull } from 'drizzle-orm';
import type { IssueLinkKind, PriorityValue } from '../shared/constants';
import {
  claimTaskInputSchema,
  createTaskInputSchema,
  updateTaskInputSchema,
  type Task,
} from '../shared/schemas/tasks';
import type { Actor, AppDeps } from '../server/context';
import * as s from '../server/db/schema';
import { createReply } from '../server/services/replies';
import { claimTask } from '../server/services/claims';
import {
  createTask,
  createTaskFromIssue,
  deleteTask,
  moveTask,
  updateTask,
} from '../server/services/tasks';

type Username = 'ethan' | 'caden' | 'maya' | 'leo' | 'sofia';
type StatusName = 'Backlog' | 'Todo' | 'In Progress' | 'In Review' | 'Done' | 'Canceled';

interface SeedReply {
  by: Username;
  /** Written by the author's agent (shown as "via <key name>"). */
  viaKey?: true;
  body: string;
}

interface SeedTask {
  /** Local name, for `blockedBy`. */
  id: string;
  by: Username;
  viaKey?: true;
  /** Required unless `fromIssue` gives the title. */
  title?: string;
  description?: string;
  /** Created from this issue (same project): title, body and labels copied, linked `fixes`. */
  fromIssue?: string;
  /** Other issue links, by issue title. */
  issues?: Array<{ title: string; kind: IssueLinkKind }>;
  /** Where the task ends up; it starts in Backlog or Todo and moves there. */
  status: StatusName;
  /** Who moves it to its final status (default: the first assignee, else the author). */
  movedBy?: Username;
  priority?: PriorityValue;
  /** Days from today; negative is overdue. */
  due?: number;
  users?: Username[];
  roles?: string[];
  labels?: string[];
  blockedBy?: string[];
  replies?: SeedReply[];
  /** Held right now: by whom, through their key or on the web, since how many minutes. */
  claim?: { by: Username; viaKey?: true; minutesAgo: number };
  deleted?: true;
  /** When it was created. */
  daysAgo: number;
}

const WEB_TASKS: SeedTask[] = [
  {
    id: 'release-checklist',
    by: 'ethan',
    fromIssue: 'Document the release checklist',
    status: 'Done',
    priority: 2,
    users: ['ethan'],
    labels: ['Documentation'],
    replies: [
      {
        by: 'leo',
        body: 'Please include the backup restore drill, we skipped it last time.',
      },
      { by: 'ethan', body: 'Added it as step 7, with the exact commands.' },
    ],
    daysAgo: 13,
  },
  {
    id: 'code-theme',
    by: 'maya',
    fromIssue: 'Dark mode: code blocks are hard to read',
    status: 'Done',
    priority: 2,
    users: ['maya'],
    daysAgo: 8,
  },
  {
    id: 'dashboard-empty',
    by: 'sofia',
    title: 'Illustrations for dashboard empty states',
    description: 'Custom illustrations for the empty dashboard sections.',
    status: 'Canceled',
    movedBy: 'ethan',
    priority: 1,
    labels: ['Design'],
    replies: [
      {
        by: 'ethan',
        body: 'Let’s keep the icon-based empty states for now; canceling this.',
      },
    ],
    daysAgo: 12,
  },
  {
    id: 'palette-lazy',
    by: 'ethan',
    title: 'Lazy-load the command palette and the editor',
    description:
      'Both are only needed after the first interaction. Load them with `React.lazy` and prefetch on idle.',
    issues: [{ title: 'Slow first load on the dashboard', kind: 'relates' }],
    status: 'In Progress',
    priority: 2,
    due: 3,
    roles: ['Frontend'],
    labels: ['Performance'],
    replies: [{ by: 'maya', body: 'Palette is done, the editor is next.' }],
    daysAgo: 3,
  },
  {
    id: 'bundle-split',
    by: 'leo',
    title: 'Split the main bundle below 300 kB',
    description:
      'The main chunk is 478 kB. Target: under 300 kB gzip-less, with the router and query client in their own chunks.\n\n- [ ] Analyse with `vite-bundle-visualizer`\n- [ ] Move zod schemas used by one page into that page',
    status: 'In Progress',
    priority: 4,
    due: -2,
    users: ['ethan'],
    labels: ['Performance'],
    blockedBy: ['palette-lazy'],
    claim: { by: 'ethan', minutesAgo: 25 },
    replies: [
      {
        by: 'leo',
        body: '@ethan this is the one blocking the release, can you take it this week?',
      },
    ],
    daysAgo: 3,
  },
  {
    id: 'board-overflow',
    by: 'maya',
    fromIssue: 'Board columns overflow on small screens',
    status: 'In Progress',
    priority: 3,
    due: 2,
    users: ['maya'],
    claim: { by: 'maya', viaKey: true, minutesAgo: 12 },
    replies: [
      {
        by: 'maya',
        viaKey: true,
        body: 'Root cause: the board container is missing `min-w-0`, so the columns stretch the page. Fix and a regression test are on the way.',
      },
    ],
    daysAgo: 1,
  },
  {
    id: 'avatar-formats',
    by: 'caden',
    fromIssue: 'Avatar upload fails for HEIC photos',
    status: 'In Review',
    priority: 2,
    due: 0,
    users: ['sofia'],
    replies: [
      {
        by: 'sofia',
        body: 'The upload dialog now lists PNG, JPEG, GIF and WebP, and the error names the format it got. Ready for review @caden.',
      },
    ],
    daysAgo: 5,
  },
  {
    id: 'settings-twice',
    by: 'ethan',
    title: 'Settings page fetches the profile twice',
    description: 'Both the layout and the page call `/api/me` on first load.',
    status: 'In Review',
    priority: 4,
    due: -4,
    users: ['caden'],
    labels: ['Bug'],
    replies: [
      {
        by: 'caden',
        body: 'Fixed: the page reads the layout’s query now. @ethan can you review?',
      },
    ],
    daysAgo: 7,
  },
  {
    id: 'inbox-grouping',
    by: 'caden',
    viaKey: true,
    fromIssue: 'Inbox should group notifications by issue',
    status: 'Todo',
    priority: 3,
    due: 6,
    users: ['ethan'],
    roles: ['Frontend'],
    daysAgo: 2,
  },
  {
    id: 'board-keyboard',
    by: 'sofia',
    title: 'Keyboard navigation between board columns',
    description: 'Arrow keys should move focus between cards and columns, like in Linear.',
    status: 'In Progress',
    priority: 3,
    due: -1,
    users: ['ethan'],
    labels: ['Feature', 'Design'],
    claim: { by: 'ethan', viaKey: true, minutesAgo: 6 },
    daysAgo: 4,
  },
  {
    id: 'empty-copy',
    by: 'sofia',
    viaKey: true,
    title: 'Review the copy of every empty state',
    status: 'Todo',
    priority: 1,
    due: 10,
    roles: ['Frontend'],
    labels: ['Design'],
    daysAgo: 2,
  },
  {
    id: 'sidebar-shortcut',
    by: 'leo',
    title: 'Shortcut to collapse the sidebar',
    issues: [{ title: 'Add a keyboard shortcut to toggle the sidebar', kind: 'fixes' }],
    status: 'Backlog',
    priority: 1,
    labels: ['Feature'],
    daysAgo: 4,
  },
  {
    id: 'onboarding-tour',
    by: 'leo',
    title: 'Onboarding tour for new teams',
    description: 'Three steps: create a project, invite someone, connect an agent.',
    status: 'Backlog',
    priority: 2,
    labels: ['Feature'],
    daysAgo: 10,
  },
  {
    id: 'css-spike',
    by: 'maya',
    title: 'Spike: CSS-in-JS for the board',
    status: 'Backlog',
    priority: 0,
    deleted: true,
    daysAgo: 6,
  },
];

const API_TASKS: SeedTask[] = [
  {
    id: 'cursor-tiebreak',
    by: 'caden',
    title: 'Add a tie-breaker to list cursors',
    issues: [{ title: 'Pagination cursor breaks when two tasks share a timestamp', kind: 'fixes' }],
    status: 'Done',
    priority: 3,
    users: ['leo'],
    labels: ['Bug'],
    daysAgo: 11,
  },
  {
    id: 'retry-after',
    by: 'leo',
    fromIssue: 'Rate limit headers missing on 429 responses',
    status: 'In Progress',
    priority: 3,
    due: 1,
    users: ['caden'],
    roles: ['Backend'],
    claim: { by: 'caden', viaKey: true, minutesAgo: 40 },
    replies: [
      {
        by: 'caden',
        viaKey: true,
        body: 'Moved the header into the shared rate-limit middleware; REST and MCP now both send it. Adding tests.',
      },
    ],
    daysAgo: 2,
  },
  {
    id: 'claim-load',
    by: 'ethan',
    title: 'Load test claim_next_task with 20 agents',
    description: 'Make sure no two agents ever get the same task under contention.',
    status: 'Todo',
    priority: 3,
    due: 3,
    users: ['leo'],
    labels: ['Performance'],
    blockedBy: ['retry-after'],
    daysAgo: 2,
  },
  {
    id: 'audit-mcp',
    by: 'sofia',
    title: 'Audit log MCP tool with filters',
    issues: [{ title: 'Expose the audit log over MCP with filters', kind: 'fixes' }],
    status: 'Todo',
    priority: 2,
    due: 8,
    roles: ['Backend'],
    labels: ['Feature'],
    daysAgo: 5,
  },
  {
    id: 'codex-docs',
    by: 'sofia',
    title: 'Document the MCP setup for Codex',
    description: 'Show `~/.codex/config.toml` with `url` and `bearer_token_env_var`.',
    status: 'In Review',
    priority: 2,
    due: 0,
    users: ['ethan'],
    labels: ['Documentation'],
    replies: [{ by: 'ethan', body: 'Looks good, one typo in the env var name.' }],
    daysAgo: 6,
  },
  {
    id: 'key-hashes',
    by: 'leo',
    title: 'Evaluate keyed hashing for API keys',
    status: 'Backlog',
    priority: 1,
    labels: ['Security'],
    daysAgo: 9,
  },
];

const LAB_TASKS: SeedTask[] = [
  {
    id: 'voice',
    by: 'caden',
    title: 'Voice commands prototype',
    description: 'Try the Web Speech API for "move WEB-12 to done".',
    status: 'In Progress',
    priority: 2,
    due: 4,
    users: ['ethan'],
    daysAgo: 6,
  },
  {
    id: 'offline',
    by: 'caden',
    title: 'Offline-first sync spike',
    status: 'Backlog',
    priority: 1,
    daysAgo: 8,
  },
  {
    id: 'local-llm',
    by: 'ethan',
    title: 'Triage issues with a local model',
    status: 'Done',
    priority: 2,
    users: ['ethan'],
    daysAgo: 12,
  },
];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The user's (first) API key, so seeded agent writes read "via <key name>". */
function withKey(deps: AppDeps, actor: Actor): Actor {
  const key = deps.db.orm
    .select({ id: s.apiKey.id, name: s.apiKey.name })
    .from(s.apiKey)
    .where(eq(s.apiKey.userId, actor.userId))
    .get();
  if (!key) throw new Error('Seed users need an API key before tasks are seeded');
  return { ...actor, source: 'mcp', key };
}

/**
 * Runs `fn` and moves every row it wrote (audit rows, notifications, replies, task and issue
 * timestamps, claims) to `time`. Rows written earlier were already moved into the past, so
 * "written at or after the real start" singles out this step's rows.
 */
function at<T>(deps: AppDeps, time: Date, fn: () => T): T {
  const start = new Date();
  const result = fn();
  deps.db.write((tx) => {
    // A millisecond apart, so rows of one step keep their order in newest-first lists.
    tx.select({ id: s.activity.id })
      .from(s.activity)
      .where(gte(s.activity.createdAt, start))
      .orderBy(asc(s.activity.createdAt), asc(s.activity.id))
      .all()
      .forEach((row, index) => {
        tx.update(s.activity)
          .set({ createdAt: new Date(time.getTime() + index) })
          .where(eq(s.activity.id, row.id))
          .run();
      });
    tx.update(s.notification)
      .set({ createdAt: time })
      .where(gte(s.notification.createdAt, start))
      .run();
    tx.update(s.reply)
      .set({ createdAt: time, updatedAt: time })
      .where(gte(s.reply.createdAt, start))
      .run();
    tx.update(s.task).set({ createdAt: time }).where(gte(s.task.createdAt, start)).run();
    tx.update(s.task)
      .set({ updatedAt: time, lastActivityAt: time })
      .where(gte(s.task.updatedAt, start))
      .run();
    tx.update(s.task)
      .set({ deletedAt: time })
      .where(and(isNotNull(s.task.deletedAt), gte(s.task.deletedAt, start)))
      .run();
    tx.update(s.task)
      .set({ completedAt: time })
      .where(and(isNotNull(s.task.completedAt), gte(s.task.completedAt, start)))
      .run();
    tx.update(s.issue)
      .set({ updatedAt: time, lastActivityAt: time })
      .where(gte(s.issue.updatedAt, start))
      .run();
    tx.update(s.issue)
      .set({ resolvedAt: time })
      .where(and(isNotNull(s.issue.resolvedAt), gte(s.issue.resolvedAt, start)))
      .run();
    const claims = tx
      .select({ id: s.task.id, claimedAt: s.task.claimedAt, expiresAt: s.task.claimExpiresAt })
      .from(s.task)
      .where(and(isNotNull(s.task.claimedAt), gte(s.task.claimedAt, start)))
      .all();
    for (const claim of claims) {
      if (!claim.claimedAt || !claim.expiresAt) continue;
      const lease = claim.expiresAt.getTime() - claim.claimedAt.getTime();
      tx.update(s.task)
        .set({ claimedAt: time, claimExpiresAt: new Date(time.getTime() + lease) })
        .where(eq(s.task.id, claim.id))
        .run();
    }
  });
  return result;
}

interface ProjectLookup {
  id: string;
  status: (name: StatusName) => string;
  label: (name: string) => string;
  issue: (title: string) => string;
}

function lookup(deps: AppDeps, projectId: string, teamId: string): ProjectLookup {
  const { orm } = deps.db;
  const statuses = orm.select().from(s.status).where(eq(s.status.projectId, projectId)).all();
  const labels = orm.select().from(s.label).where(eq(s.label.projectId, projectId)).all();
  const issues = orm.select().from(s.issue).where(eq(s.issue.teamId, teamId)).all();
  const find = <T>(rows: readonly T[], match: (row: T) => boolean, what: string): T => {
    const found = rows.find(match);
    if (!found) throw new Error(`Unknown seed ${what}`);
    return found;
  };
  return {
    id: projectId,
    status: (name) => find(statuses, (row) => row.name === name, `status ${name}`).id,
    label: (name) => find(labels, (row) => row.name === name, `label ${name}`).id,
    issue: (title) =>
      find(issues, (row) => row.title === title && row.deletedAt === null, `issue ${title}`).id,
  };
}

interface SeedContext {
  deps: AppDeps;
  actor: (username: Username) => Actor;
  roleId: (name: string) => string;
  today: Date;
  now: number;
}

function seedProject(
  context: SeedContext,
  project: ProjectLookup,
  tasks: readonly SeedTask[],
): void {
  const { deps, actor, roleId, today, now } = context;
  const created = new Map<string, Task>();
  const as = (username: Username, viaKey?: true) =>
    viaKey ? withKey(deps, actor(username)) : actor(username);

  // Oldest first, so numbers follow the dates and blockers exist before the tasks they block.
  for (const seed of [...tasks].sort((a, b) => b.daysAgo - a.daysAgo)) {
    const openedAt = now - seed.daysAgo * DAY_MS - 4 * HOUR_MS;
    const author = as(seed.by, seed.viaKey);
    const startStatus = seed.status === 'Backlog' ? 'Backlog' : 'Todo';
    const fields = {
      statusId: project.status(startStatus),
      priority: seed.priority ?? 0,
      dueDate: seed.due === undefined ? null : format(addDays(today, seed.due), 'yyyy-MM-dd'),
      assigneeUserIds: (seed.users ?? []).map((username) => actor(username).userId),
      assigneeRoleIds: (seed.roles ?? []).map(roleId),
      blockedByTaskIds: (seed.blockedBy ?? []).map((id) => {
        const blocker = created.get(id);
        if (!blocker) throw new Error(`Seed blocker ${id} must be older than ${seed.id}`);
        return blocker.id;
      }),
      issueLinks: (seed.issues ?? []).map((link) => ({
        issueId: project.issue(link.title),
        kind: link.kind,
      })),
    };

    let task = at(deps, new Date(openedAt), () => {
      if (!seed.fromIssue) {
        if (!seed.title) throw new Error(`Seed task ${seed.id} needs a title`);
        return createTask(
          deps,
          author,
          project.id,
          createTaskInputSchema.parse({
            title: seed.title,
            description: seed.description,
            labelIds: (seed.labels ?? []).map(project.label),
            ...fields,
          }),
        );
      }
      const fromIssue = createTaskFromIssue(deps, author, project.id, {
        issueId: project.issue(seed.fromIssue),
      });
      return updateTask(
        deps,
        author,
        fromIssue.id,
        updateTaskInputSchema.parse({
          statusId: fields.statusId,
          priority: fields.priority,
          dueDate: fields.dueDate,
          assigneeUsers: { set: fields.assigneeUserIds },
          assigneeRoles: { set: fields.assigneeRoleIds },
        }),
      );
    });
    created.set(seed.id, task);

    let clock = openedAt;
    const next = () => {
      clock += 3 * HOUR_MS + (task.number % 5) * 17 * MINUTE_MS;
      return new Date(Math.min(clock, now - 2 * HOUR_MS));
    };
    const worker = seed.movedBy ?? seed.users?.[0] ?? seed.by;
    const replies = [...(seed.replies ?? [])];
    // A reply or two before the task starts moving, the rest after.
    const early = replies.splice(0, Math.ceil(replies.length / 2));
    for (const reply of early) {
      at(deps, next(), () =>
        createReply(deps, as(reply.by, reply.viaKey), {
          parentType: 'task',
          parentId: task.id,
          body: reply.body,
        }),
      );
    }
    if (seed.status !== startStatus) {
      task = at(deps, next(), () =>
        moveTask(deps, actor(worker), task.id, { statusId: project.status(seed.status) }),
      );
    }
    for (const reply of replies) {
      at(deps, next(), () =>
        createReply(deps, as(reply.by, reply.viaKey), {
          parentType: 'task',
          parentId: task.id,
          body: reply.body,
        }),
      );
    }
    if (seed.claim) {
      const { by, viaKey, minutesAgo } = seed.claim;
      at(deps, new Date(now - minutesAgo * MINUTE_MS), () =>
        claimTask(deps, as(by, viaKey), task.id, claimTaskInputSchema.parse({ leaseMinutes: 240 })),
      );
    }
    if (seed.deleted) at(deps, next(), () => deleteTask(deps, author, task.id));
  }
}

/** Seeds the demo tasks (after `seedIssues`, whose issues they link to). */
export function seedTasks(
  deps: AppDeps,
  actor: (username: Username) => Actor,
  roleId: (name: string) => string,
  projects: {
    web: { id: string; teamId: string };
    api: { id: string; teamId: string };
    lab: { id: string; teamId: string };
  },
): void {
  const now = Date.now();
  const context: SeedContext = { deps, actor, roleId, today: new Date(now), now };
  seedProject(context, lookup(deps, projects.web.id, projects.web.teamId), WEB_TASKS);
  seedProject(context, lookup(deps, projects.api.id, projects.api.teamId), API_TASKS);
  seedProject(context, lookup(deps, projects.lab.id, projects.lab.teamId), LAB_TASKS);
}

/**
 * Final pass over the seeded timeline:
 * - rows still carrying the seeding time (moving an issue to Trash right after it was backdated)
 *   move to an hour and a half ago, and so does the item's `deletedAt`;
 * - every issue and task is "updated" when its latest history row or reply was written;
 * - notifications written while seeding issues move to the time of what they are about (the
 *   reply, the issue, its resolution);
 * - notifications older than three days are read, so the inbox mixes read and unread.
 */
export function settleSeedTimeline(deps: AppDeps, seededSince: Date): void {
  const now = Date.now();
  deps.db.write((tx) => {
    const leftovers = tx
      .select()
      .from(s.activity)
      .where(gte(s.activity.createdAt, seededSince))
      .orderBy(asc(s.activity.createdAt), asc(s.activity.id))
      .all();
    leftovers.forEach((row, index) => {
      const time = new Date(now - 90 * MINUTE_MS + index * MINUTE_MS);
      tx.update(s.activity).set({ createdAt: time }).where(eq(s.activity.id, row.id)).run();
      if (row.action === 'issue.deleted') {
        tx.update(s.issue).set({ deletedAt: time }).where(eq(s.issue.id, row.entityId)).run();
      }
      if (row.action === 'task.deleted') {
        tx.update(s.task).set({ deletedAt: time }).where(eq(s.task.id, row.entityId)).run();
      }
    });

    for (const [table, type] of [
      [s.task, 'task'],
      [s.issue, 'issue'],
    ] as const) {
      const latest = new Map<string, Date>();
      const bump = (id: string | null, at: Date) => {
        if (!id) return;
        const current = latest.get(id);
        if (!current || at > current) latest.set(id, at);
      };
      for (const row of tx
        .select({ id: s.activity.entityId, at: s.activity.createdAt })
        .from(s.activity)
        .where(eq(s.activity.entityType, type))
        .all()) {
        bump(row.id, row.at);
      }
      for (const row of tx
        .select({ id: s.reply.parentId, at: s.reply.createdAt })
        .from(s.reply)
        .where(eq(s.reply.parentType, type))
        .all()) {
        bump(row.id, row.at);
      }
      for (const [id, at] of latest) {
        tx.update(table).set({ updatedAt: at, lastActivityAt: at }).where(eq(table.id, id)).run();
      }
    }

    for (const row of tx
      .select()
      .from(s.notification)
      .where(gte(s.notification.createdAt, seededSince))
      .all()) {
      let time: Date | null | undefined;
      if (row.entityType === 'reply') {
        time = tx
          .select({ at: s.reply.createdAt })
          .from(s.reply)
          .where(eq(s.reply.id, row.entityId))
          .get()?.at;
      } else if (row.entityType === 'issue') {
        const issue = tx.select().from(s.issue).where(eq(s.issue.id, row.entityId)).get();
        time = row.type === 'issue_resolved' ? issue?.resolvedAt : issue?.createdAt;
      }
      if (time) {
        tx.update(s.notification)
          .set({ createdAt: time })
          .where(eq(s.notification.id, row.id))
          .run();
      }
    }
    const readBefore = new Date(now - 3 * DAY_MS);
    for (const row of tx.select().from(s.notification).all()) {
      if (row.createdAt < readBefore && row.readAt === null) {
        tx.update(s.notification)
          .set({ readAt: new Date(row.createdAt.getTime() + HOUR_MS) })
          .where(eq(s.notification.id, row.id))
          .run();
      }
    }
  });
}
