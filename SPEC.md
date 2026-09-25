# Baton — Product & Engineering Spec

Baton is a self-hosted workspace where a small group of people **and the AI agents acting for them**
(Claude Code, Codex, …) coordinate work. Teams contain projects; projects contain **issues**
(forum-style posts, like GitHub issues) and **tasks** (work items on a board, like Linear/Trello).
Every capability of the web app is also available through an **MCP server**, so an agent can do
anything a person can do from a prompt.

This file is the source of truth for every contributor. If something here is impossible (a package
doesn't exist, an API differs), pick the closest robust alternative and append a dated entry to
`docs/DECISIONS.md` explaining the deviation. Do not silently diverge.

---

## 1. Product requirements

### 1.1 Accounts & auth
- Sign up / log in with **email + password**, **Google**, or **GitHub**. Social providers are enabled
  only when their client id/secret env vars are set; the UI hides buttons for disabled providers.
- Email + password sign-up requires **email verification with a 6-digit code** (10-minute expiry,
  max 5 attempts, resend with cooldown). OAuth sign-ups arrive already verified.
- Password reset also uses an emailed 6-digit code.
- Every user has a unique **username** (3–32 chars, `[a-z0-9_]`, stored lowercase, reserved names
  blocked: admin, root, system, baton, everyone, here, me, api, mcp, settings, help, support…). Email
  sign-up collects it on the form; OAuth users are sent to a "choose a username" onboarding step
  before anything else. Username can be changed later in settings. Users also have a display name
  and an avatar (uploaded, or taken from the OAuth profile).
- Settings let a user **connect (link) Google and GitHub** to an existing account and unlink them
  (never allowing removal of the last sign-in method), set/change a password, see & revoke active
  sessions, and delete the account (blocked while they own a team — transfer or delete it first).
- Sign-ups are open (`SIGNUPS_ENABLED=true` by default) — teams are invite-only, so an account alone
  grants access to nothing.

### 1.2 Agents & API keys (identity model)
- Agents do **not** get their own accounts. An agent acts **as the user** whose API key it holds.
- Users create **named API keys** in settings (e.g. "Claude on laptop", "Codex desktop"). The key
  is shown once (`bat_` + 40 base62 chars); only a SHA-256 hash is stored. Keys can be revoked,
  show last-used time, optional expiry.
- Every write made with a key is attributed to the user **via** the key: the UI renders
  "ethan via Claude on laptop" (bot icon + key name). The audit log stores the key id and a snapshot
  of the key name. Claims (§1.8) are held by (user, key) so a user's two agents never collide.
- The settings page shows copy-paste setup snippets for Claude Code
  (`claude mcp add --transport http baton <BASE_URL>/mcp --header "Authorization: Bearer <key>"`)
  and Codex (`~/.codex/config.toml` with `url` + `bearer_token_env_var`).
- API keys also authenticate the REST API (`Authorization: Bearer …`) for scripts.

### 1.3 Teams, members, roles & permissions (Discord/Roblox-groups style, simplified)
- Any user can **create a team** (name, URL slug, description, icon emoji, accent color). The
  creator is the **Owner**. Owner can do everything, including owner-only actions: delete the team,
  transfer ownership. There is exactly one owner.
- Members join via **invite links** (`/join/<code>`): optional expiry and max uses, revocable,
  list shows creator/uses. Visiting a link logged-out → login/sign-up → back to the join page.
- **Roles** belong to a team: name, color, position (display order), `mentionable` flag, and a set
  of **permissions**. A member can have **any number of roles**; their permissions are the
  **union** of all their roles plus the built-in `@everyone` role (every member implicitly has it;
  it can be edited but not deleted or renamed).
- New teams are seeded with `@everyone` (default permissions below) and an **Admin** role
  (just a normal role with `ADMINISTRATOR` ticked; it can be renamed/deleted like any role).
- Members' names display in the color of their highest-positioned colored role.
- Roles can be **@mentioned** (`@&role-slug`) and **assigned to tasks**.

Permissions (`shared/permissions.ts`; stored as a JSON string array on the role):

| Permission | Allows | @everyone default |
|---|---|---|
| `ADMINISTRATOR` | Every permission below (not owner-only actions) | no |
| `MANAGE_TEAM` | Edit team name, slug, description, icon, color | no |
| `MANAGE_ROLES` | Create/edit/delete/reorder roles (see anti-escalation) | no |
| `MANAGE_MEMBERS` | Assign/remove roles on members, remove members | no |
| `CREATE_INVITES` | Create invite links (revoke own) | yes |
| `MANAGE_INVITES` | See and revoke everyone's invites | no |
| `MANAGE_PROJECTS` | Create, edit (name/key/description/README/icon), delete, restore projects | no |
| `MANAGE_STATUSES` | Create/edit/reorder/delete task statuses in projects | no |
| `MANAGE_LABELS` | Create/edit/delete labels in projects | yes |
| `CREATE_ISSUES` | Open issues | yes |
| `CREATE_TASKS` | Create tasks | yes |
| `REPLY` | Reply to issues and tasks | yes |
| `UPDATE_TASKS` | Change any task's status, priority, assignees, labels, due date, links, dependencies, and claim/release tasks | yes |
| `RESOLVE_ISSUES` | Resolve/reopen and label anyone's issues (authors can always resolve their own) | yes |
| `EDIT_ANY_CONTENT` | Edit other people's issue/task titles & bodies and replies | no |
| `DELETE_ANY_CONTENT` | Delete other people's issues, tasks, replies, attachments | no |
| `MANAGE_TRASH` | See and restore anyone's deleted items (authors can always restore their own) | no |
| `VIEW_AUDIT_LOG` | See the team-wide audit log (per-item history is visible to all members) | no |
| `MENTION_EVERYONE` | Mention `@everyone` and non-mentionable roles | no |

Rules:
- Authors can **always** edit and delete their own issues, tasks and replies (Discord-style).
- **Anti-escalation**: someone without `ADMINISTRATOR` can only create/edit a role, or grant/revoke a
  role on a member, if that role's permissions are a subset of their own; they can never touch a role
  that has `ADMINISTRATOR`, and can't remove/modify a member who has `ADMINISTRATOR` or is the owner.
  Nobody can remove the owner.
- Everyone in a team can **see** everything in the team. Non-members get 404 for everything.

### 1.4 Projects
- Belong to a team. Name, **key** (2–6 chars `[A-Z][A-Z0-9]{1,5}`, unique per team, auto-derived
  from the name, editable), short **description** (≤ 280 chars, shown on cards), **README**
  (rich markdown document shown on the project overview page), icon emoji, color.
- Rename, change key (old refs keep resolving via a `project_key_alias` table), archive-free
  delete → Trash (30 days), restore.
- Project has its own **task statuses** and **labels**.

### 1.5 Statuses (per project, fully customizable)
- Each status: name, color, **category** (`open` or `done` — "done" statuses count as finished for
  overdue logic, progress, claim eligibility and issue auto-resolution), position, one status is the
  **default** for new tasks.
- New projects start with **Open** (open, default, gray) and **Done** (done, green).
- Create, rename, recolor, recategorize, reorder (drag), set default, delete (requires choosing a
  status to move its tasks to; can't delete the last status; there must always be a default).
- No fixed Linear-style groups beyond the open/done flag.

### 1.6 Labels (per project, shared by issues and tasks)
- Name, color, optional description. Create/edit/delete (delete removes it from items; audited).

### 1.7 Issues (forum)
- Per project, numbered `#1, #2…` (global ref `KEY#51`). Title, rich **body**, **attachments**,
  **labels**, **resolved** state (+ who/when), author (+ via key).
- Issue list reads like a forum/GitHub issues: tabs **Open / Resolved / All**, label filter, author
  filter, text search, sort by latest activity (default) / newest / oldest / most replies. Each row:
  title, `#n`, labels, author (+via), reply count, last activity time.
- Issue page: original post, **replies** thread (chronological, rich text, attachments, edit/delete
  by author, "edited" marker), resolve/reopen, labels, **"Addressed by"** list of linked tasks,
  **Create task from issue** (prefills title/description, links it with kind `fixes`).
- Edit/delete by author (or with permission). Delete → Trash.

### 1.8 Tasks
- Per project, numbered `KEY-1, KEY-2…`. Title, rich **description**, **attachments**, **labels**,
  **status**, **priority** (none/low/medium/high/urgent), **due date** (date only, `YYYY-MM-DD`),
  **assignees** — any mix of users and roles. Assignment is a *suggestion*, not a lock: anyone with
  `UPDATE_TASKS` can work on/move any task.
- **Linked issues** ("addresses"): link kind `fixes` (when the task enters a `done` status the issue
  is auto-resolved, like GitHub "fixes #51") or `relates` (no automation).
- **Blocked by**: dependencies on other tasks in the same project; cycles rejected. A task is
  *blocked* while any blocker is in an `open`-category status. UI shows blocked/blocking.
- **Replies** thread exactly like issues. Edit/delete by author (or with permission). Delete → Trash.
- **Claiming** (for agents): a claim marks "(user, key) is actively working on this".
  - Lease: default 30 min, 5–240 allowed; any write by the holder on the task renews it;
    `renew_claim` renews explicitly; expired claims are treated as unclaimed and swept every minute
    (audited as `task.claim_expired`).
  - `claim_next_task` atomically (single `BEGIN IMMEDIATE` transaction) picks the best eligible task:
    in an open-category status, not blocked, not validly claimed, matching optional filters
    (role/label/priority/assigned-to-me); ordering: assigned to caller or caller's roles first, then
    unassigned, then others; then priority desc, due date asc (nulls last), number asc. Optional
    `move_to_status`.
  - `claim_task` claims a specific task; fails if validly held by a different (user, key) unless
    `force: true` (still requires `UPDATE_TASKS`; audited as a takeover).
  - `release_task` with optional note (posted as a reply if given).
  - Web users can claim/release too (key = null → shown as "ethan (web)").
  - Board cards and task pages show the holder "ethan via Claude on laptop · 4m ago".
- Board ordering uses fractional-index `position` strings per status column.

### 1.9 Views & navigation
- **Board view** (columns = statuses in order; drag cards between/within columns; quick-add per
  column; column counts) and **List view** (table rows, sortable columns, group by status/priority/
  assignee/none). Toggle persists per project (localStorage). Filters live in the URL query:
  text, status, assignee (me / user / role / unassigned), label, priority, due (overdue / today /
  this week / none), claimed (yes/no/mine), blocked (yes/no).
- **Dashboard** (`/`): assigned to me (directly or via my roles, not done), overdue & due soon,
  claimed by me/my keys, recent activity across my teams, my teams & projects, empty-state CTAs
  (create a team / join with a link).
- **My tasks** (`/my-tasks`): every open task assigned to me or my roles across teams, grouped by
  team/project, filterable.
- **Inbox** (`/inbox`): notifications with unread state, mark read / mark all read, bell with unread
  badge in the sidebar, live toast on new notification.
- **Search & command palette** (`Ctrl/Cmd+K`): jump to teams/projects/pages; full-text search over
  tasks, issues and replies (FTS5); actions (new task, new issue, new project, toggle theme, settings).
- **Keyboard shortcuts** with a `?` help dialog: `Ctrl/Cmd+K` palette, `/` focus filter/search,
  `c` new task (in a project), `i` new issue, `g d` dashboard, `g i` inbox, `g m` my tasks,
  `g b` board, `g l` issues list, `b` toggle board/list; on a task page: `s` status, `p` priority,
  `a` assignees, `l` labels, `e` edit title, `Esc` close. Shortcuts never fire while typing in inputs.
- Conventional layout: collapsible **left sidebar** (logo, search button, Inbox with badge, My tasks,
  Dashboard, Teams tree with projects under each, "New team", user menu at bottom with theme toggle,
  settings, sign out) + page header with **breadcrumbs**. Mobile: sidebar becomes a sheet.
- **Light / dark / system** theme, persisted (localStorage + user profile), no flash on load.

### 1.10 Notifications
Created (never for your own actions, including your own keys) when:
- you are `@username`-mentioned, or a role you have is `@&role` mentioned (in bodies or replies);
- you (or a role you have) are assigned to a task;
- someone replies to an issue/task you are subscribed to (authors, assignees, and repliers are
  auto-subscribed; manual subscribe/unsubscribe toggle on each page);
- your issue is resolved/reopened; a task you authored or are assigned to moves to a `done` status.
Mentions only fire for team members; role mentions require the role to be `mentionable` or the actor
to have `MENTION_EVERYONE` (`@everyone` also requires it).

### 1.11 Audit log (critical — the owner called this "huge")
- **Every mutation** writes an append-only `activity` row: team, project, actor user, source
  (`web` / `mcp` / `api` / `system`), key id + key-name snapshot, entity type & id, action
  (`task.created`, `task.status_changed`, `task.claimed`, `role.permissions_changed`, …), field-level
  `changes` `{field: {from, to}}` (human-readable values, e.g. status names not ids), and `meta`
  (e.g. title snapshot). Written in the **same DB transaction** as the change.
- Per-item **history** is interleaved with replies on issue/task pages (compact rows).
- Team **Audit log** page (needs `VIEW_AUDIT_LOG`): infinite list with filters (actor, source/key,
  entity type, action, project, date range), each row links to the entity; live-updating.
- A per-user **security log** in account settings: sign-ins, password changes, key created/revoked,
  account linked/unlinked.
- The audit log is never editable or deletable from the app.

### 1.12 Trash
- Deleting teams, projects, issues, tasks, replies and attachments is a **soft delete**. Items
  stay restorable for **30 days**, then a daily job purges them (and their files).
- Team settings → **Trash** lists deleted items (type, title snapshot, deleted by/via, when, days
  left) with Restore. Authors see their own; `MANAGE_TRASH` sees all. Deleted teams are listed for
  their owner in account settings.
- Deleted items disappear from lists, boards, search and MCP results. Restoring a project restores
  its contents' visibility.

### 1.13 Attachments & rich text
- Editor is **Notion-style** (Tiptap): WYSIWYG with markdown shortcuts, `/` slash menu (headings,
  lists, to-do list, quote, code block, divider, image, table), floating bubble menu (bold, italic,
  strike, code, link), syntax-highlighted code blocks, task checklists, tables, links, images
  (paste / drop / pick → uploaded), file drop → attachment, `@` mentions for users and roles.
- **Markdown is the storage format** (so agents read/write it natively). Mentions serialize as
  `@username` and `@&role-slug`. Read-only rendering is sanitized (no raw HTML).
- Attachments: any file type, ≤ `MAX_UPLOAD_MB` (default 25) each, per-team storage quota
  (`TEAM_STORAGE_QUOTA_MB`, default 5120). Images render inline; everything else downloads with
  `Content-Disposition: attachment`. SVG is never served inline.

### 1.14 MCP parity
Everything a member can do in the web UI must be doable over MCP, except: signing in, password /
OAuth-link / session management and creating API keys (security-sensitive, web only). See §5.

---

## 2. Tech stack (decided)

| Area | Choice |
|---|---|
| Runtime | Node 24, TypeScript (strict), ESM, npm |
| Server | Hono on `@hono/node-server`; zod validation; pino logging |
| DB | SQLite (WAL, `foreign_keys=ON`, `busy_timeout=5000`) via `better-sqlite3` + Drizzle ORM; SQL migrations generated by drizzle-kit and committed; FTS5 for search |
| Auth | Better Auth (drizzle adapter): emailAndPassword + `emailOTP` (verification & reset codes) + `username` plugin + Google/GitHub social providers + account linking |
| Email | nodemailer (SMTP URL from env). If SMTP unset, emails are logged to the server console with a startup warning |
| MCP | `@modelcontextprotocol/sdk` McpServer, Streamable HTTP transport, **stateless**, mounted at `/mcp` in the Hono app (web-standard transport or `@hono/mcp`) |
| Live updates | In-process typed event bus → Server-Sent Events at `GET /api/events` |
| Web | Vite + React 19 SPA, React Router 7, TanStack Query 5, Tailwind CSS 4, shadcn/ui (Radix), lucide-react, cmdk, sonner, @dnd-kit, Tiptap 3, react-markdown + remark-gfm + rehype-sanitize + syntax highlighting, `@fontsource-variable/inter` (self-hosted font) |
| Ordering | `fractional-indexing` |
| IDs | ULIDs (text) |
| Scheduling | `croner` in-process jobs |
| Tests | Vitest (unit + API integration via `app.request` against a temp SQLite DB) and Playwright (e2e) |
| Quality | ESLint (typescript-eslint) + Prettier; GitHub Actions CI: lint, typecheck, test, build |

Production: `npm run build` → `dist/web` (static SPA) + `dist/server` (bundled server). `npm start`
runs one Node process serving API, MCP, SSE and the SPA (index.html fallback for client routes).

---

## 3. Repository layout & ownership

```
SPEC.md  README.md  CLAUDE.md  docs/DECISIONS.md  docs/DEPLOY.md
package.json  tsconfig*.json  vite.config.ts  vitest.config.ts  drizzle.config.ts
eslint.config.js  .prettierrc  components.json  .env.example  .github/workflows/ci.yml
shared/                     isomorphic code (no node/browser-only imports)
  permissions.ts            permission list, labels, descriptions, @everyone defaults
  events.ts                 live event type union + payload type
  refs.ts                   parse/format KEY-12, KEY#51, team-slug/KEY refs
  constants.ts              limits, reserved usernames, color palette, priorities
  schemas/<module>.ts       zod input/output schemas shared by REST, MCP and web forms
server/
  index.ts  app.ts  env.ts  logger.ts
  db/  schema.ts  index.ts  migrate.ts  migrations/
  lib/ errors.ts validate.ts ids.ts diff.ts mentions.ts rateLimit.ts security.ts markdown.ts
  auth/ auth.ts mailer.ts emails/
  middleware/ actor.ts csrf.ts
  services/<module>.ts      ALL business logic, permission checks, audit, events, notifications
  routes/<module>.ts        thin REST handlers → services   (mounted in routes/index.ts)
  mcp/ server.ts auth.ts util.ts tools/<module>.ts          (registered in tools/index.ts)
  jobs/ index.ts backups.ts purge.ts claims.ts
  test/ helpers.ts fixtures.ts
web/
  index.html main.tsx App.tsx router.tsx styles/globals.css public/theme-init.js
  lib/ api.ts queryKeys.ts auth.ts live.ts hotkeys.ts format.ts utils.ts
  components/ui/            shadcn primitives
  components/layout/        sidebar, header, breadcrumbs, app shell
  components/editor/        RichTextEditor (Tiptap)
  components/markdown/      MarkdownView
  components/attachments/   uploader + list
  components/replies/       ReplyThread, ReplyComposer, ActivityRow (timeline)
  components/pickers/       StatusPicker, LabelPicker, AssigneePicker, PriorityPicker, DatePicker, ColorPicker, EmojiPicker
  components/common/        UserName(+via), UserAvatar, RoleChip, LabelChip, StatusBadge, PriorityIcon,
                            TaskKey, DueDate, ClaimBadge, EmptyState, PageHeader, ConfirmDialog, Kbd, RelativeTime
  components/palette/       CommandPalette + command registry
  pages/<area>/...          one folder per feature area (below)
e2e/                        Playwright specs
deploy/                     systemd user units, env template
scripts/                    install-mini.sh, deploy.sh, smoke.sh
```

Module ownership (who writes which service/route/MCP-tools/pages files):

| Module | Server services / routes / mcp tools | Web pages |
|---|---|---|
| core | access, activity, events, search, attachments, notifications, replies, trash, apiKeys, users, refs, subscriptions | auth/*, shared components, layout |
| teams | teams, members, roles, invites | teams/* (team home), team-settings/{general,members,roles,invites}, join/* |
| projects | projects, statuses, labels | projects/* (overview/README), project-settings/{general,statuses,labels} |
| issues | issues | issues/* |
| tasks | tasks, claims, taskLinks | tasks/* (board, list, detail) |
| work | myWork, dashboard (+ inbox UI) | dashboard/*, my-tasks/*, inbox/* |
| admin | trash routes, audit-log queries, search route | team-settings/{audit-log,trash}, palette search |
| account | account (profile/username/avatar/theme/sessions/deletion) | settings/{profile,account,connections,api-keys,appearance,security} |

Registration files (`server/routes/index.ts`, `server/mcp/tools/index.ts`, `server/jobs/index.ts`,
`web/router.tsx`, `web/lib/queryKeys.ts`, `web/lib/live.ts`, `shared/events.ts`) are pre-populated
for **all** modules by the foundation so feature work only fills in its own files. If you must edit
a shared file, keep the change minimal and additive.

---

## 4. Data model (SQLite via Drizzle)

Conventions: text ULID primary keys; timestamps are integer ms (`integer({ mode: 'timestamp_ms' })`);
soft-deletable rows have `deletedAt`, `deletedById`, `deletedViaKeyId`; every FK has an index;
`createdAt`/`updatedAt` on mutable rows; booleans as integer mode boolean.

- **Better Auth tables**: `user` (+ `username`, `displayUsername`, plus additional fields `theme`
  `'system'|'light'|'dark'`), `session`, `account`, `verification`. Match Better Auth's expected
  schema exactly (generate with the Better Auth CLI or follow its docs).
- `api_key`: id, userId, name, prefix (first 8 chars after `bat_`), hash (sha256 hex, unique),
  lastUsedAt, expiresAt?, revokedAt?, createdAt.
- `team`: id, name, slug (unique, lowercase), description, icon (emoji), color, ownerId, createdAt,
  updatedAt, deletedAt…
- `team_member`: teamId, userId, joinedAt — PK(teamId, userId).
- `role`: id, teamId, name, slug (unique per team), color?, position, permissions (JSON text array),
  mentionable, isEveryone, createdAt, updatedAt.
- `member_role`: teamId, userId, roleId — PK(userId, roleId).
- `invite`: id, teamId, code (unique, 10 chars base62), createdById, maxUses?, uses, expiresAt?,
  revokedAt?, createdAt.
- `project`: id, teamId, name, key, description, readme, icon, color, issueSeq, taskSeq,
  createdById, createdAt, updatedAt, deletedAt… — unique(teamId, key) among non-deleted.
- `project_key_alias`: projectId, teamId, key.
- `status`: id, projectId, name, color, category (`open`|`done`), position, isDefault.
- `label`: id, projectId, name, color, description — unique(projectId, name).
- `issue`: id, projectId, teamId, number, title, body, authorId, viaKeyId?, resolved, resolvedAt?,
  resolvedById?, replyCount, lastActivityAt, createdAt, updatedAt, editedAt?, deletedAt… —
  unique(projectId, number).
- `issue_label`: issueId, labelId.
- `task`: id, projectId, teamId, number, title, description, statusId, priority (0 none,1 low,
  2 medium,3 high,4 urgent), dueDate (`YYYY-MM-DD`)?, position (fractional key), authorId,
  viaKeyId?, claimedById?, claimedViaKeyId?, claimedAt?, claimExpiresAt?, completedAt?, replyCount,
  lastActivityAt, createdAt, updatedAt, editedAt?, deletedAt… — unique(projectId, number).
- `task_label`, `task_assignee_user` (taskId, userId), `task_assignee_role` (taskId, roleId).
- `task_issue_link`: taskId, issueId, kind (`fixes`|`relates`).
- `task_dependency`: taskId (blocked), blockedByTaskId.
- `reply`: id, teamId, projectId, parentType (`issue`|`task`), parentId, authorId, viaKeyId?, body,
  createdAt, updatedAt, editedAt?, deletedAt…
- `attachment`: id, teamId, uploaderId, viaKeyId?, parentType (`issue`|`task`|`reply`|`project`|
  `user_avatar`|`pending`), parentId?, filename, mimeType, size, sha256, storagePath, createdAt,
  deletedAt…
- `subscription`: userId, entityType, entityId, subscribed (bool; false = explicit unsubscribe).
- `notification`: id, userId, teamId, type (`mention`|`role_mention`|`assigned`|`reply`|
  `issue_resolved`|`issue_reopened`|`task_done`), entityType, entityId, actorId, viaKeyName?,
  title, snippet, url, readAt?, createdAt.
- `activity`: id, teamId?, projectId?, actorId?, source, viaKeyId?, viaKeyName?, entityType,
  entityId, action, changes (JSON), meta (JSON), createdAt — indexes (teamId, createdAt),
  (entityType, entityId, createdAt), (actorId, createdAt).
- `search_index`: FTS5 virtual table (entity_type, entity_id UNINDEXED, team_id UNINDEXED,
  project_id UNINDEXED, title, body) maintained by the service layer (custom SQL migration).

---

## 5. Server architecture

- **Service layer is the only place with business logic.** REST routes and MCP tools are thin
  adapters. Every service function takes an `Actor`:
  `{ userId, source: 'web'|'mcp'|'api'|'system', key: { id, name } | null }`.
  Each mutation: validate → check permission → write in one transaction → `recordActivity` →
  update search index → create notifications → after commit emit live event(s).
- **Errors**: `AppError(code, httpStatus, message, details?)`; JSON shape
  `{ "error": { "code": "not_found", "message": "…", "details": … } }`. Codes: `unauthorized`,
  `forbidden`, `not_found`, `validation_failed`, `conflict`, `rate_limited`, `payload_too_large`,
  `email_not_verified`, `username_required`, `internal`.
- **Auth for REST**: session cookie (web) or `Authorization: Bearer bat_…`. Unverified email or
  missing username → 403 (`email_not_verified` / `username_required`) except for auth/me endpoints.
- **CSRF**: cookie-authenticated mutating requests must carry an `Origin` (or `Referer`) matching
  `BASE_URL`; cookies are `SameSite=Lax`, `Secure` in production.
- **Security headers**: strict CSP (`default-src 'self'`; `img-src 'self' data: blob: https:` for
  OAuth avatars; `style-src 'self' 'unsafe-inline'`; no inline scripts — the theme bootstrap lives in
  `/theme-init.js`), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Content-Type-Options: nosniff`, HSTS in production.
- **Rate limits** (in-memory token buckets, keyed by IP / user / key): auth endpoints 10/min/IP,
  REST writes 120/min/user, MCP 300/min/key, uploads 30/min/user. Client IP from
  `CF-Connecting-IP` when `TRUST_PROXY=cloudflare`, else socket address.
- **Live events** (`shared/events.ts`): `{ type, teamId, projectId?, entityType, entityId,
  parentType?, parentId?, actorId, at }` for types: `team.updated|deleted`, `member.joined|left|
  updated`, `role.changed`, `invite.changed`, `project.created|updated|deleted|restored`,
  `status.changed`, `label.changed`, `issue.created|updated|deleted|restored`,
  `task.created|updated|deleted|restored|claimed|released`, `reply.created|updated|deleted`,
  `attachment.changed`, `activity.created`; personal: `notification.created`, `me.updated`.
  SSE sends only events for teams the user belongs to (+ their personal events), heartbeat every
  25 s, `retry:` hint. The web client maps event types → TanStack Query invalidations.
- **Jobs** (croner): expire claims (every minute), purge trash >30 days & orphaned files (daily
  03:15), purge pending uploads >24 h (hourly), purge expired sessions/verifications (daily),
  **backups** (daily 03:30: `VACUUM INTO DATA_DIR/backups/baton-YYYYMMDD.db`, keep 14; mirror new
  upload files into `backups/uploads/`).
- **Env** (`server/env.ts`, zod-validated, fail fast): `NODE_ENV`, `PORT` (3000), `HOST`
  (127.0.0.1), `BASE_URL`, `DATA_DIR` (./data), `BETTER_AUTH_SECRET` (≥32 chars; required in prod),
  `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `SMTP_URL`, `MAIL_FROM`, `SIGNUPS_ENABLED`,
  `MAX_UPLOAD_MB`, `TEAM_STORAGE_QUOTA_MB`, `TRUST_PROXY` (`none`|`cloudflare`), `LOG_LEVEL`.
- `GET /healthz` → `{ ok: true, version }`. `GET /api/config` → public config (enabled social
  providers, signups enabled, limits, version).

### 5.1 MCP server
- `POST|GET|DELETE /mcp`, Streamable HTTP, stateless (new McpServer per request or shared server
  with per-request context). Auth: `Authorization: Bearer bat_…` → Actor `{source:'mcp', key}`;
  missing/invalid → HTTP 401 with `WWW-Authenticate: Bearer`.
- Tools use snake_case names, zod input schemas with a `.describe()` on every field, and return
  concise JSON text (plus `structuredContent`). Entities returned include `ref` and absolute `url`.
  Errors return `isError: true` with the AppError message (never stack traces).
- Refs accepted everywhere: team = slug or id; project = `KEY` (if unambiguous across caller's
  teams), `team-slug/KEY`, or id; task = `KEY-12` / `team-slug/KEY-12` / id; issue = `KEY#51` /
  `team-slug/KEY#51` / id; user = username or id; role = slug/name or id; status/label = name or id.
- Tool catalog (owner module in brackets):
  - [core] `whoami`, `search`, `list_notifications`, `mark_notifications_read`, `list_replies`,
    `add_reply`, `edit_reply`, `delete_reply`, `upload_attachment` (base64 or text content),
    `list_attachments`, `get_attachment` (text content for text files, metadata + url otherwise),
    `delete_attachment`, `get_activity` (entity history, or team audit log if permitted),
    `subscribe`, `unsubscribe`
  - [teams] `list_teams`, `get_team`, `create_team`, `update_team`, `list_members`,
    `remove_member`, `list_roles`, `create_role`, `update_role` (incl. permissions), `delete_role`,
    `assign_role`, `unassign_role`, `create_invite`, `list_invites`, `revoke_invite`, `leave_team`
  - [projects] `list_projects`, `get_project` (with statuses, labels, readme), `create_project`,
    `update_project`, `delete_project`, `restore_project`, `list_statuses`, `create_status`,
    `update_status`, `reorder_statuses`, `delete_status`, `list_labels`, `create_label`,
    `update_label`, `delete_label`
  - [issues] `list_issues`, `get_issue` (with replies, links, history summary), `create_issue`,
    `update_issue` (title/body/labels add-remove-set), `resolve_issue`, `reopen_issue`,
    `delete_issue`, `restore_issue`
  - [tasks] `list_tasks` (all filters of §1.9), `get_task` (full context: description, status,
    assignees, labels, links, blockers/blocking, claim, recent replies & history),
    `create_task`, `update_task` (all fields; arrays support add/remove/set), `move_task`
    (status + position), `delete_task`, `restore_task`, `create_task_from_issue`,
    `claim_next_task`, `claim_task`, `renew_claim`, `release_task`
  - [work] `my_tasks`, `dashboard_summary`
  - [admin] `list_trash`, `restore_item`
  - [account] `update_profile` (display name, username)

---

## 6. Web app

Routes (all under the app shell unless noted):

| Path | Page (owner) |
|---|---|
| `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password`, `/onboarding/username` | auth (core) — no shell |
| `/join/:code` | join (teams) |
| `/` | dashboard (work) |
| `/inbox` | inbox (work) |
| `/my-tasks` | my tasks (work) |
| `/t/:team` | team home: projects grid, members preview (teams) |
| `/t/:team/settings/{general,members,roles,roles/:roleId,invites}` | team settings (teams) |
| `/t/:team/settings/{audit-log,trash}` | team settings (admin) |
| `/t/:team/p/:key` | project overview: description + README (projects) |
| `/t/:team/p/:key/settings/{general,statuses,labels}` | project settings (projects) |
| `/t/:team/p/:key/issues`, `/issues/new`, `/issues/:number` | issues |
| `/t/:team/p/:key/tasks` (board/list), `/tasks/:number` | tasks |
| `/settings/{profile,account,connections,api-keys,appearance,security}` | account |
| `*` | 404 page |

UX conventions:
- Look & feel: clean, compact, Linear/GitHub-like. Neutral zinc palette, indigo accent, Inter,
  8px radius, subtle borders, no gratuitous shadows. Every page has loading skeletons, empty states
  with a helpful CTA, and error states. Mutations show toasts; board drags and simple toggles are
  optimistic with rollback.
- Forms: labeled inputs, inline zod validation messages, disabled submit while pending,
  `Enter` submits single-field dialogs, `Ctrl/Cmd+Enter` submits editors.
- Accessibility: keyboard reachable, visible focus rings, aria labels on icon buttons,
  color is never the only signal (status/priority also have text/icons).
- Responsive down to 375px wide; board scrolls horizontally on small screens.
- Page titles: `<page> · <project> · Baton`.

---

## 7. Operations

- Target host: `ethan@mini` (Ubuntu 24.04 x64, no sudo). Node 24 installed user-locally in
  `~/.local/node`; app cloned to `~/apps/baton`; data in `~/.local/share/baton`; env file
  `~/.config/baton/baton.env` (mode 600); systemd **user** units `baton.service` and
  `baton-tunnel.service` (cloudflared, user-local binary); linger is enabled.
- Public access via Cloudflare Tunnel → `http://127.0.0.1:3000`; `TRUST_PROXY=cloudflare`.
- `scripts/deploy.sh` (from a dev machine): ssh → `git pull` → `npm ci` → `npm run build` →
  `npm run db:migrate` → `systemctl --user restart baton` → health check.
- Backups as in §5 (jobs); `docs/DEPLOY.md` documents restore and optional off-site copy.
