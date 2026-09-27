import type {
  ActivityEntry,
  Attachment,
  ConfigResponse,
  MeResponse,
  MentionablesResponse,
  ReplyNode,
  RoleSummary,
  UserSummary,
} from '@shared/schemas/core';

/** Sample data for the development component gallery (`/__dev/components`). */

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const TEAM_ID = 'team_dev';

export const users: UserSummary[] = [
  { id: 'u_ethan', username: 'ethan', name: 'Ethan Ho', image: null },
  { id: 'u_ada', username: 'ada', name: 'Ada Lovelace', image: null },
  { id: 'u_grace', username: 'grace', name: 'Grace Hopper', image: null },
  { id: 'u_linus', username: 'linus', name: 'Linus Torvalds', image: null },
  { id: 'u_margaret', username: 'margaret', name: 'Margaret Hamilton', image: null },
];

export const [ethan, ada, grace] = users as [UserSummary, UserSummary, UserSummary];

export const roles: RoleSummary[] = [
  { id: 'r_everyone', slug: 'everyone', name: '@everyone', color: null },
  { id: 'r_design', slug: 'design', name: 'Design', color: '#ec4899' },
  { id: 'r_backend', slug: 'backend', name: 'Backend', color: '#0ea5e9' },
  { id: 'r_admin', slug: 'admin', name: 'Admin', color: '#f59e0b' },
];

export const mentionables: MentionablesResponse = { users, roles: roles.slice(1) };

export const statuses = [
  { id: 's_open', name: 'Open', color: '#6b7280', category: 'open' as const },
  { id: 's_progress', name: 'In progress', color: '#f59e0b', category: 'open' as const },
  { id: 's_review', name: 'In review', color: '#8b5cf6', category: 'open' as const },
  { id: 's_done', name: 'Done', color: '#22c55e', category: 'done' as const },
];

export const labels = [
  { id: 'l_bug', name: 'Bug', color: '#ef4444', description: 'Something is broken' },
  { id: 'l_feature', name: 'Feature', color: '#6366f1', description: null },
  { id: 'l_docs', name: 'Docs', color: '#14b8a6', description: 'Documentation' },
  { id: 'l_perf', name: 'Performance', color: '#f97316', description: null },
];

export const config: ConfigResponse = {
  version: 'dev',
  signupsEnabled: true,
  providers: { google: true, github: true },
  maxUploadMb: 25,
};

export const me: MeResponse = {
  user: {
    id: ethan.id,
    email: 'ethan@example.com',
    emailVerified: true,
    username: ethan.username,
    displayUsername: ethan.username,
    name: ethan.name,
    image: null,
    theme: 'system',
  },
  teams: [
    {
      id: TEAM_ID,
      slug: 'acme',
      name: 'Acme',
      icon: '🚀',
      color: '#6366f1',
      isOwner: true,
      permissions: ['ADMINISTRATOR', 'REPLY', 'EDIT_ANY_CONTENT', 'DELETE_ANY_CONTENT'],
      projects: [
        { id: 'p_web', key: 'WEB', name: 'Web app', icon: null, color: '#0ea5e9' },
        { id: 'p_api', key: 'API', name: 'API', icon: '🧩', color: '#22c55e' },
      ],
    },
  ],
  unreadNotifications: 3,
};

const attachment = (
  overrides: Partial<Attachment> & Pick<Attachment, 'id' | 'filename'>,
): Attachment => ({
  teamId: TEAM_ID,
  parentType: 'reply',
  parentId: 'rep_2',
  mimeType: 'application/octet-stream',
  size: 1024,
  isImage: false,
  url: `/api/attachments/${overrides.id}/${overrides.filename}`,
  uploader: ethan,
  via: null,
  createdAt: minutesAgo(40),
  ...overrides,
});

export const attachments: Attachment[] = [
  attachment({
    id: 'att_img',
    filename: 'screenshot-dashboard.png',
    mimeType: 'image/png',
    size: 248_331,
    isImage: true,
    url: '/favicon.svg',
  }),
  attachment({
    id: 'att_pdf',
    filename: 'Quarterly plan.pdf',
    mimeType: 'application/pdf',
    size: 1_482_112,
  }),
  attachment({
    id: 'att_zip',
    filename: 'build-logs.zip',
    mimeType: 'application/zip',
    size: 18_203_998,
  }),
  attachment({ id: 'att_ts', filename: 'claims.test.ts', mimeType: 'text/plain', size: 5_210 }),
];

export const sampleMarkdown = `## Release checklist

We shipped the **claim sweeper** and *board drag & drop*. Thanks @ada and @&design!
Ping @everyone if anything regresses; see [the docs](https://example.com/docs) or [the board](/t/acme/p/WEB/tasks).

- [x] Migrations reviewed
- [ ] Update the README
- [ ] Announce in #general

1. Build
2. Deploy
   - smoke test

> Agents act **as** the user whose key they hold.

\`\`\`ts
export function renewClaim(taskId: string, minutes = 30): Date {
  return new Date(Date.now() + minutes * 60_000);
}
\`\`\`

| Key | Owner | Status |
| --- | --- | --- |
| WEB-12 | @grace | In review |
| WEB-14 | @linus | Open |

Inline \`code\`, ~~struck~~ text and an image:

![Baton logo](/favicon.svg)

<script>alert('xss')</script><img src="x" onerror="alert(1)">`;

export const replies: ReplyNode[] = [
  {
    id: 'rep_1',
    teamId: TEAM_ID,
    projectId: 'p_web',
    parentType: 'task',
    parentId: 'task_dev',
    parentReplyId: null,
    deleted: false,
    replyCount: 1,
    depth: 0,
    body: 'I can take this. Starting with the **API contract**, then the UI.',
    author: ada,
    via: null,
    attachments: [],
    reactions: [
      {
        emoji: '👍',
        count: 2,
        reactedByMe: true,
        users: [
          { ...ethan, via: null },
          { ...ethan, via: { keyId: 'key_1', keyName: 'MSI', agentName: 'Claude' } },
        ],
      },
      { emoji: '🎉', count: 1, reactedByMe: false, users: [{ ...ada, via: null }] },
    ],
    createdAt: minutesAgo(180),
    updatedAt: minutesAgo(180),
    editedAt: null,
  },
  {
    id: 'rep_2',
    teamId: TEAM_ID,
    projectId: 'p_web',
    parentType: 'task',
    parentId: 'task_dev',
    parentReplyId: 'rep_1',
    deleted: false,
    replyCount: 0,
    depth: 1,
    body: 'Pushed a first pass. Tests pass locally:\n\n```bash\nnpm test -- claims\n```\n\ncc @grace',
    author: ethan,
    via: { keyId: 'key_1', keyName: 'Claude on laptop' },
    attachments: attachments.slice(0, 2),
    reactions: [],
    createdAt: minutesAgo(45),
    updatedAt: minutesAgo(30),
    editedAt: minutesAgo(30),
  },
];

const actor = (user: UserSummary | null, keyName?: string) => ({
  user,
  via: keyName ? { keyId: 'key_1', keyName } : null,
  source: keyName ? ('mcp' as const) : user ? ('web' as const) : ('system' as const),
});

export const activity: ActivityEntry[] = [
  {
    id: 'act_1',
    teamId: TEAM_ID,
    projectId: 'p_web',
    actor: actor(ethan),
    entityType: 'task',
    entityId: 'task_dev',
    action: 'task.created',
    changes: {},
    meta: { title: 'Claim sweeper' },
    url: '/t/acme/p/WEB/tasks/12',
    createdAt: minutesAgo(240),
  },
  {
    id: 'act_2',
    teamId: TEAM_ID,
    projectId: 'p_web',
    actor: actor(ada),
    entityType: 'task',
    entityId: 'task_dev',
    action: 'task.updated',
    changes: {
      assignees: { from: [], to: ['ada', 'Backend'] },
      priority: { from: 'Medium', to: 'High' },
    },
    meta: {},
    url: '/t/acme/p/WEB/tasks/12',
    createdAt: minutesAgo(170),
  },
  {
    id: 'act_3',
    teamId: TEAM_ID,
    projectId: 'p_web',
    actor: actor(ethan, 'Claude on laptop'),
    entityType: 'task',
    entityId: 'task_dev',
    action: 'task.claimed',
    changes: {},
    meta: {},
    url: '/t/acme/p/WEB/tasks/12',
    createdAt: minutesAgo(60),
  },
  {
    id: 'act_4',
    teamId: TEAM_ID,
    projectId: 'p_web',
    actor: actor(ethan, 'Claude on laptop'),
    entityType: 'task',
    entityId: 'task_dev',
    action: 'task.status_changed',
    changes: { status: { from: 'Open', to: 'In review' } },
    meta: {},
    url: '/t/acme/p/WEB/tasks/12',
    createdAt: minutesAgo(20),
  },
  {
    id: 'act_5',
    teamId: TEAM_ID,
    projectId: 'p_web',
    actor: actor(null),
    entityType: 'task',
    entityId: 'task_dev',
    action: 'task.claim_expired',
    changes: {},
    meta: {},
    url: '/t/acme/p/WEB/tasks/12',
    createdAt: minutesAgo(5),
  },
];
