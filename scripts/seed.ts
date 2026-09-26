/**
 * `npm run db:seed`: fills DATA_DIR/baton.db with demo data for development and visual QA.
 *
 *   npm run db:seed              seed an empty database (refuses when it is already seeded)
 *   npm run db:seed -- --reset   delete DATA_DIR/baton.db (and its uploads) first
 *
 * Everything goes through the service layer, as the web app would, so the audit log, security
 * log and live-event paths are exercised. Refuses to run with NODE_ENV=production.
 */
import fs from 'node:fs';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import type { Permission } from '../shared/permissions';
import { createApiKeyInputSchema } from '../shared/schemas/core';
import {
  createLabelInputSchema,
  createProjectInputSchema,
  createStatusInputSchema,
  type Status,
} from '../shared/schemas/projects';
import { createInviteInputSchema, createRoleInputSchema } from '../shared/schemas/teams';
import type { Actor } from '../server/context';
import { runMigrations } from '../server/db/migrate';
import * as s from '../server/db/schema';
import { createAppDeps } from '../server/deps';
import { loadDotEnv, parseEnv } from '../server/env';
import { newId } from '../server/lib/ids';
import { dataPaths, ensureDataDirs } from '../server/lib/paths';
import { createLogger } from '../server/logger';
import { createApiKey } from '../server/services/apiKeys';
import { acceptInvite, createInvite } from '../server/services/invites';
import { createLabel } from '../server/services/labels';
import { assignRole } from '../server/services/members';
import { createProject, deleteProject, updateProject } from '../server/services/projects';
import { createRole, reorderRoles, teamRoles } from '../server/services/roles';
import { createStatus, reorderStatuses, updateStatus } from '../server/services/statuses';
import { createTeam } from '../server/services/teams';
import { seedIssues } from './seed-issues';
import { seedTasks, settleNotifications } from './seed-tasks';

const PASSWORD = 'password123';

const USERS = [
  { username: 'ethan', name: 'Ethan', key: 'Claude Code on laptop' },
  { username: 'caden', name: 'Caden', key: 'Codex desktop' },
  { username: 'maya', name: 'Maya Patel', key: 'Claude Code' },
  { username: 'leo', name: 'Leo Park', key: 'Codex CLI' },
  { username: 'sofia', name: 'Sofia Reyes', key: 'Claude on desktop' },
] as const;
type Username = (typeof USERS)[number]['username'];

const ROLES: ReadonlyArray<{
  name: string;
  color: string;
  mentionable: boolean;
  permissions: Permission[];
}> = [
  {
    name: 'Frontend',
    color: '#0ea5e9',
    mentionable: true,
    permissions: ['MANAGE_STATUSES', 'MANAGE_LABELS', 'UPDATE_TASKS'],
  },
  {
    name: 'Backend',
    color: '#22c55e',
    mentionable: true,
    permissions: ['MANAGE_PROJECTS', 'MANAGE_STATUSES', 'MANAGE_LABELS', 'UPDATE_TASKS'],
  },
  {
    name: 'Reviewer',
    color: '#f59e0b',
    mentionable: false,
    permissions: [
      'RESOLVE_ISSUES',
      'EDIT_ANY_CONTENT',
      'MANAGE_TRASH',
      'VIEW_AUDIT_LOG',
      'MENTION_EVERYONE',
    ],
  },
];

/** Final role order, highest first (every role but @everyone). */
const ROLE_ORDER = ['Admin', 'Backend', 'Frontend', 'Reviewer'];

const MEMBER_ROLES: Record<Exclude<Username, 'ethan'>, string[]> = {
  caden: ['Admin', 'Backend'],
  maya: ['Frontend'],
  leo: ['Backend', 'Reviewer'],
  sofia: ['Frontend', 'Reviewer'],
};

/** Board columns, in order; the first `open` one marked `default` receives new tasks. */
const STATUSES: ReadonlyArray<{
  name: string;
  color: string;
  category: 'open' | 'done';
  isDefault?: true;
}> = [
  { name: 'Backlog', color: '#6b7280', category: 'open' },
  { name: 'Todo', color: '#0ea5e9', category: 'open', isDefault: true },
  { name: 'In Progress', color: '#f59e0b', category: 'open' },
  { name: 'In Review', color: '#8b5cf6', category: 'open' },
  { name: 'Done', color: '#22c55e', category: 'done' },
  { name: 'Canceled', color: '#ef4444', category: 'done' },
];

const LABELS = [
  { name: 'Bug', color: '#ef4444', description: 'Something is broken' },
  { name: 'Feature', color: '#6366f1', description: 'New functionality' },
  { name: 'Improvement', color: '#0ea5e9', description: 'Makes something existing better' },
  { name: 'Design', color: '#ec4899', description: 'UI and UX work' },
  { name: 'Documentation', color: '#14b8a6', description: 'Docs, READMEs and guides' },
  { name: 'Performance', color: '#f59e0b', description: 'Speed and resource use' },
  { name: 'Security', color: '#f97316', description: 'Auth, permissions and hardening' },
];

const WEB_README = `# Web App

The customer-facing single-page app: dashboard, boards and the settings area.

## Getting started

1. \`npm ci\`
2. \`npm run dev\` and open http://localhost:5173
3. Sign in as **ethan** / \`password123\` (seeded)

## Conventions

- Components live in \`web/components\`, pages in \`web/pages/<area>\`.
- Every page has a loading skeleton, an empty state and an error state.
- Use the shared pickers instead of building new ones.

| Environment | URL                      |
| ----------- | ------------------------ |
| Local       | http://localhost:5173    |
| Staging     | https://staging.example  |

> Ask @caden before changing the build pipeline.
`;

const API_README = `# API Platform

REST and MCP endpoints used by the web app and by agents.

- Handlers are thin: all business logic lives in \`server/services\`.
- Every mutation is audited in the same transaction.
- Agents authenticate with API keys (\`Authorization: Bearer bat_…\`).
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  loadDotEnv();
  if (process.env.NODE_ENV === 'production') {
    fail('Refusing to seed: NODE_ENV is production. The seed is for development databases only.');
  }
  const env = parseEnv({ LOG_LEVEL: 'error', ...process.env });
  if (env.isProduction) fail('Refusing to seed a production configuration.');

  const paths = dataPaths(env.dataDir);
  if (process.argv.includes('--reset')) {
    for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) {
      fs.rmSync(file, { force: true });
    }
    fs.rmSync(paths.uploads, { recursive: true, force: true });
    console.log(`Reset ${paths.database}`);
  }
  ensureDataDirs(paths);

  const deps = createAppDeps({ env, logger: createLogger(env), databaseFile: paths.database });
  const { db } = deps;
  try {
    runMigrations(db);
    const existing = db.orm
      .select({ id: s.user.id })
      .from(s.user)
      .where(eq(s.user.username, 'ethan'))
      .get();
    if (existing) {
      fail(
        `${paths.database} is already seeded (user "ethan" exists). ` +
          'Run `npm run db:seed -- --reset` to start over.',
      );
    }
    await seed(deps);
  } finally {
    db.close();
  }
}

async function seed(deps: ReturnType<typeof createAppDeps>): Promise<void> {
  const { db } = deps;
  const seededSince = new Date();
  const passwordHash = await hashPassword(PASSWORD);

  // Users: verified email + password, as if they had signed up and entered their code.
  const users = new Map<Username, Actor>();
  for (const { username, name } of USERS) {
    const now = new Date();
    const id = newId();
    db.write((tx) => {
      tx.insert(s.user)
        .values({
          id,
          name,
          email: `${username}@example.com`,
          emailVerified: true,
          username,
          displayUsername: username,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(s.account)
        .values({
          id: newId(),
          accountId: id,
          providerId: 'credential',
          userId: id,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    users.set(username, { userId: id, source: 'web', key: null });
  }
  const actor = (username: Username): Actor => {
    const found = users.get(username);
    if (!found) throw new Error(`Unknown seed user ${username}`);
    return found;
  };
  const ethan = actor('ethan');
  const caden = actor('caden');

  // Team with custom roles; everyone else joins through an invite link.
  const team = createTeam(deps, ethan, {
    name: 'Northwind',
    slug: 'northwind',
    description: 'Product engineering: the web app, the API and everything in between.',
    icon: '🚀',
    color: '#6366f1',
  });
  for (const role of ROLES) createRole(deps, ethan, team.id, createRoleInputSchema.parse(role));
  const roleIds = new Map(teamRoles(db.orm, team.id).map((role) => [role.name, role.id]));
  const roleId = (name: string): string => {
    const id = roleIds.get(name);
    if (!id) throw new Error(`Unknown seed role ${name}`);
    return id;
  };
  reorderRoles(deps, ethan, team.id, { roleIds: ROLE_ORDER.map(roleId) });
  assignRole(deps, ethan, team.id, ethan.userId, roleId('Admin'));

  const onboarding = createInvite(
    deps,
    ethan,
    team.id,
    createInviteInputSchema.parse({ expiresIn: '7d', maxUses: 10 }),
  );
  for (const [username, roles] of Object.entries(MEMBER_ROLES) as Array<
    [Exclude<Username, 'ethan'>, string[]]
  >) {
    acceptInvite(deps, actor(username), onboarding.code);
    for (const role of roles)
      assignRole(deps, ethan, team.id, actor(username).userId, roleId(role));
  }
  const openInvite = createInvite(
    deps,
    ethan,
    team.id,
    createInviteInputSchema.parse({ expiresIn: 'never' }),
  );
  const singleUse = createInvite(
    deps,
    caden,
    team.id,
    createInviteInputSchema.parse({ expiresIn: '1d', maxUses: 1 }),
  );

  // Projects with custom workflows and labels.
  const web = createProject(
    deps,
    ethan,
    team.id,
    createProjectInputSchema.parse({
      name: 'Web App',
      key: 'WEB',
      description: 'The customer-facing single-page app: dashboard, boards and settings.',
      icon: '🌐',
      color: '#0ea5e9',
    }),
  );
  updateProject(deps, ethan, web.id, { readme: WEB_README });
  const api = createProject(
    deps,
    caden,
    team.id,
    createProjectInputSchema.parse({
      name: 'API Platform',
      key: 'API',
      description: 'REST and MCP endpoints used by the web app and by agents.',
      icon: '⚙️',
      color: '#22c55e',
      readme: API_README,
    }),
  );
  for (const project of [web, api]) {
    configureWorkflow(deps, ethan, project.id, project.statuses);
    for (const label of LABELS) {
      createLabel(deps, ethan, project.id, createLabelInputSchema.parse(label));
    }
  }

  // Something in Trash, for the Trash page.
  const legacy = createProject(
    deps,
    ethan,
    team.id,
    createProjectInputSchema.parse({
      name: 'Legacy Site',
      key: 'OLD',
      description: 'The old marketing site, replaced by the web app.',
      icon: '🗄️',
      color: '#6b7280',
    }),
  );
  deleteProject(deps, ethan, legacy.id);

  // A second, smaller team owned by caden, so ethan belongs to two teams.
  const side = createTeam(deps, caden, {
    name: 'Side Quests',
    slug: 'side-quests',
    description: 'Experiments and weekend projects.',
    icon: '🧪',
    color: '#8b5cf6',
  });
  const sideInvite = createInvite(deps, caden, side.id, createInviteInputSchema.parse({}));
  acceptInvite(deps, ethan, sideInvite.code);
  const lab = createProject(
    deps,
    caden,
    side.id,
    createProjectInputSchema.parse({
      name: 'Prototype Lab',
      key: 'LAB',
      description: 'Throwaway prototypes.',
      icon: '🧪',
      color: '#8b5cf6',
    }),
  );
  configureWorkflow(deps, caden, lab.id, lab.statuses);

  // One API key per user (shown once, like the settings page does).
  const keys = USERS.map(({ username, key }) => ({
    username,
    name: key,
    key: createApiKey(deps, actor(username), createApiKeyInputSchema.parse({ name: key })).key,
  }));

  // Issues (some opened by agents through the keys above), then the tasks that address them.
  seedIssues(deps, actor, { web: web.id, api: api.id });
  seedTasks(deps, actor, roleId, {
    web: { id: web.id, teamId: team.id },
    api: { id: api.id, teamId: team.id },
    lab: { id: lab.id, teamId: side.id },
  });
  settleNotifications(deps, seededSince);

  const base = deps.env.baseUrl;
  console.log(`\nSeeded ${deps.db.file}\n`);
  console.log(`Users (password "${PASSWORD}"): ${USERS.map((u) => u.username).join(', ')}`);
  console.log(`Teams: ${base}/t/${team.slug} (owner ethan), ${base}/t/${side.slug} (owner caden)`);
  console.log(`Projects: ${base}/t/${team.slug}/p/WEB, ${base}/t/${team.slug}/p/API`);
  console.log(
    `Invites: ${base}/join/${openInvite.code} (never expires), ${base}/join/${singleUse.code} (1 use)`,
  );
  console.log('\nAPI keys:');
  for (const entry of keys)
    console.log(`  ${entry.username.padEnd(6)} ${entry.name.padEnd(22)} ${entry.key}`);
  console.log(
    `\nClaude Code: claude mcp add --transport http baton ${base}/mcp --header "Authorization: Bearer <key>"\n`,
  );
}

/**
 * Open (default) + Done → Backlog, Todo (default), In Progress, In Review, Done, Canceled: the
 * seeded Open status becomes Backlog, the rest are created, then the columns are put in order.
 */
function configureWorkflow(
  deps: ReturnType<typeof createAppDeps>,
  actor: Actor,
  projectId: string,
  seeded: readonly Status[],
): void {
  const open = seeded.find((status) => status.category === 'open');
  const done = seeded.find((status) => status.category === 'done');
  if (!open || !done) throw new Error('A new project should have Open and Done statuses');
  const ids = new Map<string, string>([
    ['Backlog', open.id],
    ['Done', done.id],
  ]);
  updateStatus(deps, actor, open.id, { name: 'Backlog', color: '#6b7280' });
  for (const status of STATUSES) {
    if (ids.has(status.name)) continue;
    const created = createStatus(
      deps,
      actor,
      projectId,
      createStatusInputSchema.parse({
        name: status.name,
        color: status.color,
        category: status.category,
      }),
    );
    ids.set(status.name, created.id);
  }
  const defaultStatus = STATUSES.find((status) => status.isDefault);
  if (defaultStatus) {
    updateStatus(deps, actor, ids.get(defaultStatus.name) ?? open.id, { isDefault: true });
  }
  reorderStatuses(deps, actor, projectId, {
    statusIds: STATUSES.map((status) => ids.get(status.name) ?? ''),
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
