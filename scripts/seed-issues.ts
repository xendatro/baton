/**
 * Demo issues for `npm run db:seed` (scripts/seed.ts): a forum's worth of issues in the Web App and
 * API Platform projects, with labels, mentions, replies, resolved ones, some opened by agents
 * through API keys, and one in Trash. Everything goes through the services; afterwards the
 * timestamps of each issue (and its replies and history) are spread over the past weeks, so the
 * list reads like a real project rather than "just now" everywhere.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { createIssueInputSchema } from '../shared/schemas/issues';
import type { Actor, AppDeps } from '../server/context';
import * as s from '../server/db/schema';
import { createIssue, deleteIssue, resolveIssue } from '../server/services/issues';
import { createReply } from '../server/services/replies';

type Username = 'ethan' | 'caden' | 'maya' | 'leo' | 'sofia';

interface SeedReply {
  by: Username;
  body: string;
}

interface SeedIssue {
  by: Username;
  /** Opened through the author's API key (shown as "via <key>"). */
  viaKey?: true;
  title: string;
  body: string;
  labels: string[];
  replies?: SeedReply[];
  resolvedBy?: Username;
  /** Moved to Trash by its author. */
  deleted?: true;
  /** When it was opened; replies follow a few hours apart. */
  daysAgo: number;
}

const WEB_ISSUES: SeedIssue[] = [
  {
    by: 'maya',
    title: 'Board columns overflow on small screens',
    body: 'On a 375px wide screen the last board column is cut off and the page scrolls sideways.\n\n**Steps**\n\n1. Open any project board on a phone\n2. Scroll to the right\n\n**Expected:** the board scrolls inside its own container.\n\ncc @sofia',
    labels: ['Bug', 'Design'],
    replies: [
      { by: 'sofia', body: 'Reproduced on an iPhone 13 mini. The header also wraps badly.' },
      {
        by: 'ethan',
        body: 'I think the flex container is missing `min-w-0`. @maya can you take it?',
      },
      { by: 'maya', body: 'Yes, picking it up today.' },
    ],
    daysAgo: 1,
  },
  {
    by: 'caden',
    viaKey: true,
    title: 'Inbox should group notifications by issue',
    body: 'When an issue gets ten replies the inbox shows ten rows. Grouping them per issue (with a count) would make the inbox much easier to scan.',
    labels: ['Improvement'],
    replies: [{ by: 'leo', body: 'Agreed. GitHub does this with "and 9 more".' }],
    daysAgo: 2,
  },
  {
    by: 'ethan',
    title: 'Slow first load on the dashboard',
    body: 'The dashboard takes ~3 s to show anything on a cold cache. The main chunk is 478 kB; most of it is not needed for the first paint.\n\n@leo could you profile the `/api/me` call too?',
    labels: ['Performance'],
    replies: [
      { by: 'leo', body: '`/api/me` is 40 ms locally, so it is mostly the bundle.' },
      { by: 'maya', body: 'We could lazy-load the command palette and the editor.' },
    ],
    daysAgo: 3,
  },
  {
    by: 'leo',
    title: 'Add a keyboard shortcut to toggle the sidebar',
    body: 'Something like `[` would be handy on small laptops.',
    labels: ['Feature'],
    daysAgo: 4,
  },
  {
    by: 'maya',
    title: 'Avatar upload fails for HEIC photos',
    body: 'Uploading a photo straight from an iPhone fails with "not an image". We should either convert HEIC or explain which formats work.',
    labels: ['Bug'],
    replies: [
      {
        by: 'caden',
        body: 'Explaining the formats is the quick fix; converting needs a native dependency.',
      },
    ],
    daysAgo: 6,
  },
  {
    by: 'sofia',
    title: 'Dark mode: code blocks are hard to read',
    body: 'Comments in code blocks are almost invisible in dark mode (contrast is about 2:1).',
    labels: ['Bug', 'Design'],
    replies: [
      {
        by: 'maya',
        body: 'Switched the highlight theme to one with better contrast, check it out.',
      },
      { by: 'sofia', body: 'Much better, thanks!' },
    ],
    resolvedBy: 'maya',
    daysAgo: 9,
  },
  {
    by: 'ethan',
    title: 'Document the release checklist',
    body: 'Write down the steps we follow for a release, including the smoke test and the backup check.',
    labels: ['Documentation'],
    resolvedBy: 'ethan',
    daysAgo: 14,
  },
  {
    by: 'sofia',
    title: 'Board columns overflow on phones',
    body: 'Duplicate of the other board overflow issue.',
    labels: ['Bug'],
    deleted: true,
    daysAgo: 1,
  },
];

const API_ISSUES: SeedIssue[] = [
  {
    by: 'leo',
    title: 'Rate limit headers missing on 429 responses',
    body: 'Clients get `429 rate_limited` but no `Retry-After` on some routes, so agents retry immediately.',
    labels: ['Bug', 'Security'],
    replies: [
      { by: 'caden', body: 'The MCP route sets it; the REST writes limiter does not.' },
      { by: 'ethan', body: 'Let’s add it in the shared middleware so every route gets it.' },
    ],
    daysAgo: 2,
  },
  {
    by: 'sofia',
    title: 'Expose the audit log over MCP with filters',
    body: 'Agents should be able to ask "what changed in API this week" without scraping the web app.',
    labels: ['Feature'],
    daysAgo: 5,
  },
  {
    by: 'ethan',
    viaKey: true,
    title: 'MCP: list_issues should accept label names',
    body: 'Agents know label names, not ids. Accept both, case-insensitively.',
    labels: ['Feature', 'Improvement'],
    replies: [{ by: 'caden', body: 'Done — names and ids both work now.' }],
    resolvedBy: 'caden',
    daysAgo: 8,
  },
  {
    by: 'caden',
    title: 'Pagination cursor breaks when two tasks share a timestamp',
    body: 'Page two repeats a row when two tasks were created in the same millisecond. The cursor needs a tie-breaker.',
    labels: ['Bug'],
    resolvedBy: 'leo',
    daysAgo: 12,
  },
];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The user's (first) API key, so seeded agent writes read "via <key name>". */
function withKey(deps: AppDeps, actor: Actor): Actor {
  const key = deps.db.orm
    .select({ id: s.apiKey.id, name: s.apiKey.name })
    .from(s.apiKey)
    .where(eq(s.apiKey.userId, actor.userId))
    .get();
  if (!key) throw new Error('Seed users need an API key before issues are seeded');
  return { ...actor, source: 'mcp', key };
}

/** Moves an issue's timestamps (its replies and history too) back to `openedAt` and after. */
function backdate(deps: AppDeps, issueId: string, openedAt: number): void {
  deps.db.write((tx) => {
    const replies = tx
      .select({ id: s.reply.id })
      .from(s.reply)
      .where(and(eq(s.reply.parentType, 'issue'), eq(s.reply.parentId, issueId)))
      .orderBy(s.reply.createdAt, s.reply.id)
      .all();
    replies.forEach((reply, index) => {
      const at = new Date(openedAt + (index + 1) * 3 * HOUR_MS);
      tx.update(s.reply)
        .set({ createdAt: at, updatedAt: at })
        .where(eq(s.reply.id, reply.id))
        .run();
    });
    const last = new Date(openedAt + (replies.length + 1) * 3 * HOUR_MS);
    const issue = tx.select().from(s.issue).where(eq(s.issue.id, issueId)).get();
    tx.update(s.issue)
      .set({
        createdAt: new Date(openedAt),
        updatedAt: last,
        lastActivityAt: replies.length > 0 || issue?.resolved ? last : new Date(openedAt),
        ...(issue?.resolved ? { resolvedAt: last } : {}),
      })
      .where(eq(s.issue.id, issueId))
      .run();
    const history = tx
      .select({ id: s.activity.id, action: s.activity.action })
      .from(s.activity)
      .where(
        or(
          and(eq(s.activity.entityType, 'issue'), eq(s.activity.entityId, issueId)),
          replies.length > 0
            ? and(
                eq(s.activity.entityType, 'reply'),
                inArray(
                  s.activity.entityId,
                  replies.map((reply) => reply.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(s.activity.createdAt, s.activity.id)
      .all();
    history.forEach((row, index) => {
      const at = row.action === 'issue.created' ? openedAt : openedAt + index * 3 * HOUR_MS;
      tx.update(s.activity)
        .set({ createdAt: new Date(at) })
        .where(eq(s.activity.id, row.id))
        .run();
    });
  });
}

function seedProject(
  deps: AppDeps,
  actor: (username: Username) => Actor,
  projectId: string,
  issues: readonly SeedIssue[],
): void {
  const labels = deps.db.orm
    .select({ id: s.label.id, name: s.label.name })
    .from(s.label)
    .where(eq(s.label.projectId, projectId))
    .all();
  const labelId = (name: string) => {
    const found = labels.find((label) => label.name === name);
    if (!found) throw new Error(`Unknown seed label ${name}`);
    return found.id;
  };
  // Oldest first, so issue numbers follow the dates.
  const ordered = [...issues].sort((a, b) => b.daysAgo - a.daysAgo);
  const now = Date.now();
  for (const seed of ordered) {
    const author = seed.viaKey ? withKey(deps, actor(seed.by)) : actor(seed.by);
    const issue = createIssue(
      deps,
      author,
      projectId,
      createIssueInputSchema.parse({
        title: seed.title,
        body: seed.body,
        labelIds: seed.labels.map(labelId),
      }),
    );
    for (const reply of seed.replies ?? []) {
      createReply(deps, actor(reply.by), {
        parentType: 'issue',
        parentId: issue.id,
        body: reply.body,
      });
    }
    if (seed.resolvedBy) resolveIssue(deps, actor(seed.resolvedBy), issue.id);
    backdate(deps, issue.id, now - seed.daysAgo * DAY_MS - 5 * HOUR_MS);
    if (seed.deleted) deleteIssue(deps, author, issue.id);
  }
}

/** Seeds the demo issues of the Web App and API Platform projects. */
export function seedIssues(
  deps: AppDeps,
  actor: (username: Username) => Actor,
  projects: { web: string; api: string },
): void {
  seedProject(deps, actor, projects.web, WEB_ISSUES);
  seedProject(deps, actor, projects.api, API_ISSUES);
}
