# Engineering handoff notes

Notes from the engineers who built the foundation, for everyone building feature modules. Read together with CLAUDE.md, docs/API.md and docs/DECISIONS.md. Where notes conflict, later sections (integration, review fixes) win.

## Scaffold

- Read CLAUDE.md first. It covers the service-layer conventions (Actor, db.write with BEGIN IMMEDIATE and no await inside, recordActivity in the same transaction, emit events only after write returns) and how to add a route, tool, job or page.
- Mutations: `const result = deps.db.write((tx) => {...})`, then `deps.events.emit(liveEvent({ type, teamId, projectId, entityType, entityId, parentType?, parentId?, actorId }))` (liveEvent is in server/lib/eventBus.ts). better-sqlite3 is synchronous: do file I/O and email outside write().
- Routes: add handlers to the already-mounted router files in server/routes/_.ts, writing full paths relative to /api (e.g. teamRoutes.get('/teams/:teamId', …)). Validate with validateJson/validateQuery/validateParams from server/lib/validate.ts and read input with c.req.valid('json'). Throw errors._ from server/lib/errors.ts.
- core-server should add: server/auth/auth.ts (Better Auth, drizzle adapter on deps.db.orm, provider 'sqlite', schema from server/db/schema.ts, usePlural false), a mailer, server/middleware/actor.ts (requireActor helper, cookie or bearer bat_ key via hashApiKey plus an api_key lookup), CSRF, rate limiting, the /mcp transport, and the SSE route. Extend AppDeps in server/context.ts (e.g. auth, mailer) additively and update createTestContext to match.
- MCP: export tools with defineTool({ name, title, description, input: z.object({...describe()}), handler: (ctx, input) => service(ctx.deps, ctx.actor, input) }) in server/mcp/tools/<module>.ts. registerTools(server, ctx) registers everything on a per-request McpServer.
- Tests: createTestContext() plus the factories in server/test/fixtures.ts (re-exported from helpers.ts). Call ctx.close() in afterEach. Run a single project with `npx vitest run --project server|web <file>`.
- Web: pages are placeholders with default exports in web/pages/<area>/; replace their contents in place. The AppShell placeholder is at web/components/layout/AppShell.tsx (core-web). Query keys are id-based (web/lib/queryKeys.ts): map URL slug and key to ids through the me query. web/lib/live.ts has invalidateForEvent(queryClient, event); core-web needs to add the EventSource hook (for example in the shell) and the API client in web/lib/api.ts (parse errors with apiErrorSchema from @shared/schemas/common).
- Put request/response zod schemas for each module in shared/schemas/<module>.ts. Document new REST routes in docs/API.md under 'Feature endpoints'.
- Schema changes: edit server/db/schema.ts, run `npm run db:generate`, and commit the SQL. Drizzle's migrator runs inside a transaction, so PRAGMA foreign_keys=OFF in table-rebuild migrations is a no-op; review generated SQL that recreates tables.
- In this environment, JSON \uXXXX escapes written through the Bash tool (heredocs) were decoded into literal characters. Use the Edit tool, or double-check files that need literal backslash-u escapes.
- Leave SPEC.md unformatted; it is in .prettierignore.

### Known issues at hand-off

- npm audit: 4 moderate advisories, all in drizzle-kit's dev-only @esbuild-kit/esbuild (a dev-server CORS issue). No production impact; accepted and logged in DECISIONS.
- Better Auth is not wired yet: no server/auth/auth.ts, no /api/auth handler, and no actor/CSRF middleware. routes/auth.ts is an empty router. This is core-server's scope. The schema follows the Better Auth CLI output, but the config must set user.additionalFields.theme = { type: ['system','light','dark'], required: true, defaultValue: 'system', input: false } and advanced.database.generateId: () => newId().
- No MCP transport is mounted at /mcp yet (it returns a JSON 404). mcp/server.ts, auth.ts and util.ts are core-server's. Mount it in app.ts before the SPA handlers.
- The route files, MCP tool lists and the claims/purge job lists are empty by design (registries for later modules). The pages and the AppShell/settings layouts are the placeholders the brief asked for.
- Vite prints a one-time warning that /theme-init.js 'can't be bundled without type=module'. This is intentional: it must be a classic blocking script served from public/.
- Graceful shutdown on SIGTERM was checked by reading the code, not by sending signals; Windows doesn't deliver SIGTERM the same way. Verify it on the Ubuntu target.
- When dist/web exists from an earlier build, the dev server on :3000 also serves that possibly stale SPA. Development normally goes through :5173, so this is harmless.

## Server core

- Mutations: `const r = deps.db.write((tx) => { …; recordActivity(tx, actor, {teamId, projectId, entityType, entityId, action, changes: diffFields(before, input, formatters), meta: {title, ref}}); indexSearch(tx, {...}); notifyMentions(tx, actor, target, body, {previousBody, notified}); emitAfterCommit(tx, {type, teamId, projectId, entityType, entityId, actorId}); })`. recordActivity emits activity.created automatically. Emitting after write with emitEvent(deps, …) also works.
- Use `requireMember(db, actor, teamId, 'Task')` for 404-for-outsiders, `requirePermission(m, 'UPDATE_TASKS')`, and `canEditContent`/`canDeleteContent`/`canRestoreContent(m, authorId)` from server/services/access.ts. Role and member management (teams module) must use canManageRole(m, oldPerms, newPerms), canAssignRole(m, role, targetMembership) and canModerateMember(m, target).
- Refs for MCP tools: resolveTeam, resolveProject, resolveTask, resolveIssue, resolveUser, resolveRole(db, teamId, ref), resolveStatus(db, projectId, ref) and resolveLabel in server/services/refs.ts; resolveItemRef(deps, actor, ref) and toAbsolute/withAbsoluteUrls in server/mcp/util.ts. App paths come from appPaths in server/lib/urls.ts.
- Attachments: feature services claim pending uploads with `attachToParent(tx, actor, attachmentIds, {type: 'issue'|'task'|'project', id, teamId, projectId})` inside their write, and show files with attachmentsByParent(db, type, ids).
- Notifications for features: notifyAssigned(tx, actor, target, {userIds, roleIds}, notified); notifyUsers(tx, actor, 'issue_resolved'|'issue_reopened'|'task_done', userIds, target, notified); autoSubscribe(tx, [authorId, ...assigneeIds], 'task', id). Share one `notified` Set per event to dedupe.
- Search: call indexSearch(tx, {entityType, entityId, teamId, projectId, title, body}) on create and edit of issues and tasks. Soft deletes need no index change. The core purge job cleans up index rows, orphaned replies, attachments, subscriptions and notifications of purged items, so feature modules only soft-delete.
- Trash: register `{ softDelete, restore }` for team, project, issue and task in server/services/trashHandlers.ts. Admin routes should serve listTrash(deps, actor, teamId) and restoreItem(deps, actor, {type, id}) with the shared trash schemas.
- Tasks module: register the sweeper with `export const claimJobs = [claimSweepJob(expireClaims)]` in server/jobs/claims.ts, where expireClaims(deps, now) returns the count. Replies on a task do not currently renew a claim; add that in the task resolver (server/services/items.ts) or in the tasks module if a reply should count as 'any write by the holder'.
- Web: sign-up must send `username`. After sign-up, POST /api/auth/email-otp/verify-email {email, otp} signs the user in. Resend is limited to one per 60 s (429). OAuth users have username null: GET /api/me works, every other endpoint returns 403 username_required, and the onboarding page should call POST /api/auth/update-user {username}. Cookie writes need Origin = BASE_URL, which browsers send automatically. SSE is at GET /api/events (cookie auth).
- Tests: createTestContext() now builds the full deps (auth, mailer, rate limiter). signIn(ctx, user) returns a Cookie header, web(ctx, cookie) adds Origin, createTask/createIssue are new factories, and E2E_MAILBOX: 'true' in the env writes emails to DATA_DIR/mailbox. Better Auth allows 3 sign-in attempts per 10 s per client, so tests needing more should use API keys.
- Account module: Better Auth's delete-user is disabled on purpose. Implement account deletion in services/account.ts (blocked while the user owns a team) and write security-log rows with recordActivity(tx, actor, {teamId: null, entityType: 'user', entityId: userId, action}). The security log is readable at GET /api/me/security-log.

### Known issues at hand-off

- DEPLOY RISK: plain `npm ci` fails in this worktree on Windows. npm 11 runs an implicit `node-gyp rebuild` for better-sqlite3 13 despite its `gypfile: false`, and the machine has no VC++ toolset. I installed with `npm ci --ignore-scripts`, which works: better-sqlite3 ships prebuilds, and esbuild's postinstall only checks its optional platform binary. On the Ubuntu target (no sudo), `npm ci` will also try to compile unless build tools exist. Consider `ignore-scripts=true` in .npmrc or `npm ci --ignore-scripts` in scripts/deploy.sh and CI. The lockfile has no other install scripts that matter.
- Playwright e2e was not run (it uses port 3000). The e2e smoke spec doesn't touch the new endpoints, but nothing proves it end to end yet.
- OAuth (Google/GitHub) flows could only be tested up to the provider redirect URL. The callback path, verified-flag forcing, link logging and unverified-email link guard are exercised by code only, not by tests.
- The SSE 25 s heartbeat is not asserted by a test; the retry hint, filtering and disconnect cleanup are.
- Graceful shutdown with open SSE connections relies on the scaffold's closeAllConnections path, which has not been verified with real SIGTERM on Ubuntu.
- The trash registry covers only reply and attachment. team, project, issue and task restores return 'can't be restored yet' until those modules register handlers in server/services/trashHandlers.ts.

## Web shell

- Page modules: wrap content in <PageContainer> (common/PageContainer). Resolve ids with useRouteContext(), check permissions with useTeamAccess(teamId), and set titles with useDocumentTitle([page, project.name]); the shell already sets a default from the route.
- Data: api.get(path, { schema, signal, query }) validates responses. Use queryKeys only. Mutation errors toast automatically; set meta: { suppressErrorToast: true } when a form shows the error inline.
- Teams module: create a component that calls useShellActionHandler('team.create', () => setOpen(true)) and add lazy(() => import(...)) to web/components/layout/shellExtensions.ts. The sidebar button and the palette entry then appear.
- Account module: call useThemePersister(theme => api.patch(...)) from a shell extension. The user menu, palette and gallery already call setTheme.
- Admin module: register palette search with registerSearchProvider / useSearchProvider({ id, group, search(q, signal) }) returning { id, label, description?, href }.
- Pages add hotkeys with useHotkey('c', fn, { description, group: 'Project' }); they appear in the ? dialog automatically. Pages add palette commands with usePaletteCommands([...]). A page-level '/' registration shadows the shell's '/' (which opens the palette).
- Issue and task pages: render <MarkdownView markdown teamId /> for the body, <Timeline parentType parentId /> plus <ReplyComposer parentType parentId teamId />, <AttachmentList> with useDeleteAttachment({ type, id }), and RichTextEditor with teamId (mentions and uploads) and onAttach for non-image files. Uploads default to parentType 'pending'; send the resulting ids as attachmentIds.
- Pickers are controlled and take their data as props; pass open/onOpenChange to open one from a hotkey (s/p/a/l on the task page). ConfirmDialog accepts an async onConfirm and a typedConfirmation.
- Run the visual review with `npx playwright test -c e2e/visual/visual.config.ts` (port 5174, or VISUAL_PORT). The gallery at /__dev/components (npm run dev:web) shows every shared component with sample data.
- Worktree install on Windows: use `npm ci --ignore-scripts` if node-gyp fails on better-sqlite3; the bundled prebuild loads fine.

### Known issues at hand-off

- Two Playwright smoke tests fail in the core-web worktree alone, because Better Auth is not mounted (/api/auth/* returns 404). They are expected to pass once core-server is merged.
- Server-side expectations for core-server, not verified here: emailOTP must use sendVerificationOnSignUp: false, because the web client sends codes itself, otherwise users get duplicate emails. Recommended: emailVerification.autoSignInAfterVerification: true (without it the web sends users to /login after verifying). username plugin: minUsernameLength 3, maxUsernameLength 32, and a validator matching shared usernameSchema (the Better Auth defaults are 3–30 and also allow '.'); /is-username-available and updateUser({ username }) are used for onboarding.
- The code assumes GET /api/teams/:teamId/mentionables with no q returns a useful default set (all or the first N members and mentionable roles). MarkdownView uses it to resolve mention chips; with a small cap, some @user chips render without a hover card.
- The live-notification toast fetches GET /api/notifications?limit=1&unread=1 when notification.created arrives, which relies on newest-first ordering (implied by the contract, not stated).
- npm ci failed in this worktree because node-gyp tried to rebuild better-sqlite3 (no Visual Studio C++ toolset). I used `npm ci --ignore-scripts`; better-sqlite3 loads its bundled prebuild and works. Other worktrees and CI may hit the same thing on Windows.
- The visual suite (e2e/visual) is a manual review tool and is not part of CI or npm run test:e2e (its specs are *.visual.ts, which the default config does not match). Its screenshots go to test-results/visual/, which git ignores.
- The main chunk is about 478 kB (148 kB gzip): React, the router, TanStack Query and zod. Tiptap and the pages load lazily.

## Integration

- E2E: import { test, expect } from './support/fixtures.ts', not from @playwright/test, so each test gets its own client IP. Helpers: newUser(), createVerifiedUser(request) (sign-up plus verification; the context ends up signed in), signedInUser(page) (the browser is signed in), readCode(email, 'email-verification'|'forget-password'), mailbox(email, kind), typeCode(page, code), withDatabase(db => ...), ORIGIN headers for cookie POSTs.
- Use the `request` fixture for a second, signed-out-in-the-browser user. `page.request` shares the browser's cookies. For bearer-only REST calls, create a cookie-less context with playwright.request.newContext({ baseURL, extraHTTPHeaders }).
- activity.created live events carry entityType 'activity' (the audit row). parentType/parentId name the entity the row is about.
- Feature pages are placeholders. When the work module fills the dashboard, keep the 'Dashboard' heading or update expectDashboard in e2e/auth.spec.ts and openShell in e2e/shell.spec.ts.
- The shell e2e tests fail on any browser console error, so a feature that adds a failing request to the signed-in shell will show up there.
- Run e2e on another port with E2E_PORT=3xxx npx playwright test. DATA_DIR follows the port.

### Known issues at hand-off

- Fresh Linux npm ci with the .npmrc was not run. WSL Ubuntu here has no Node, and downloading a Node binary needs the user's permission. The conclusion rests on inspection: better-sqlite3 ships prebuilds/linux-x64.node and loads it without a build, and esbuild's postinstall is not needed on Linux. Worth one `npm ci && npm run build && npm test` on the Ubuntu host or in CI.
- With ignore-scripts=true, a future dependency that really needs an install script will not get it silently. It would have to be run explicitly (`npm rebuild <pkg> --ignore-scripts=false`), or the setting revisited.
- MarkdownView resolves mention chips from GET /api/teams/:id/mentionables with no q. That endpoint returns at most 20 users, and only roles the viewer may mention. In larger teams some @user chips will lack hover cards, and chips for roles the viewer can't mention render without their color. It should switch to the team members and roles lists once the teams module adds those endpoints.
- Signing in by username with an unverified email shows an error instead of going to the verify page, because the web doesn't know the email. It is minor, and still possible by signing in with the email.
- Theme persistence is localStorage only until the account module registers useThemePersister for the profile. The e2e test covers the local reload path.
- Playwright browsers must be installed once (`npx playwright install chromium`). CI (.github/workflows/ci.yml) does not run e2e, matching SPEC's lint/typecheck/test/build.
- OAuth (Google/GitHub) flows remain untested end to end, since there are no provider credentials. Username onboarding is tested by clearing the username in the database.

## Review fixes

- Issues/tasks modules: call indexSearch with text: markdownToPlainText(body) computed BEFORE deps.db.write, and compute activity excerpts (excerpt(body, n)) before the transaction too. See server/services/replies.ts derivedText.
- Issue/task history: GET /api/activity already enforces the Trash rules through items.ts trashedItem/trashedReply. Attachment reads go through readableAttachment, which checks the parent chain. New parent types need a case in attachments.ts trashedParent.
- For cmdk lists (palette commands via usePaletteCommands, new pickers), use value={uniqueId} and keywords={[displayLabel, ...extraWords]}. The palette and PickerShell use commandFilter, which ignores value.
- MarkdownView resolves mentions by exact lookup (useMentionables(teamId, markdown)). The `role.changed` and `member.*` live invalidations of teams.mentionables(teamId) also cover the lookup keys.
- Editor markdown: add any new node or mark to createEditorExtensions and a round-trip case to web/components/editor/markdown.test.ts. After upgrading @tiptap/markdown, run those tests first, because BatonMarkdownManager relies on two private methods.
- Avatars (account module): Better Auth update-user accepts image only as the user's own user_avatar attachment path (/api/attachments/<id>/<name>, relative or absolute BASE_URL) or null.
- E2E: e2e/resilience.spec.ts shows how to insert a team, membership and notification with withDatabase for states the API can't produce yet.

### Known issues at hand-off

- notifyMentions/notifyUsers still run parseMentions (now linear) and a bounded excerpt (at most 1600 chars of input) inside db.write. Only the search text and activity excerpts were moved out of the transaction.
- The editor keeps unsupported markdown (raw HTML, footnotes) as read-only source chips and blocks: the text inside them can't be edited, only deleted or retyped.
- Text escaping is conservative at text-node boundaries and for single tildes (e.g. '~30 min' is written as '\~30 min'), and '<' before a letter is written as '\<' (Array\<string>) so it cannot become raw HTML.
- @tiptap/markdown registers custom tokenizers on the global marked singleton for each editor instance, so extensions pile up. This was already the case; the two new raw-markdown tokenizers are affected the same way.
- Not run: the visual review suite (npx playwright test -c e2e/visual/visual.config.ts), which is outside the required checks. The dev gallery's mention lookups are answered by setQueryDefaults in ComponentsPage.
- A user can still reach 50 API keys x 300 MCP calls/min, by SPEC design (per-key limit).

## Projects module

- Server: `requireProject(db, actor, projectId)` (server/services/projects.ts) returns the live project, its team and the actor's membership (404 for outsiders and deleted projects). `statusesOf(db, projectId)` and `labelsOf(db, projectId)` return the wire `Status[]`/`Label[]` with counts. Contracts are in `shared/schemas/projects.ts`; REST in docs/API.md → Projects.
- Tasks module: a task's `completedAt` is also set/cleared by the projects module when a status is recategorized or deleted (tasks moved to the `moveTo` status get fresh fractional positions at the end of that column). Default status for new tasks: `isDefault` (exactly one per project).
- Web: the project layout (`web/pages/projects/ProjectLayout.tsx`) wraps every `/t/:team/p/:key/*` page with the header and the Overview/Tasks/Issues/Settings tabs, so issue and task pages render below it (use `PageContainer`, not another page-level project header). It only renders its children once the team and project resolve, so `useRouteContext()` gives both. Reusable hooks: `useProject`, `useStatuses`, `useLabels` (and label/status mutations) in `web/pages/projects/queries.ts`.
- Shell action `project.create` takes `{ teamId?: string }` (the teams module's "New project" button passes the team); the palette's "New project…" comes from the projects shell extension.

## Integration (wave A: teams, projects, admin, account)

- Dev data: `npm run db:seed` (add `-- --reset` to start over). Sign in as `ethan` or `caden` with `password123`; the API keys are printed once. Seed issues and tasks from `scripts/seed.ts` once the issues and tasks services exist.
- Cross-module contracts are covered end to end by `server/crossModule.test.ts` (REST + MCP: deleted teams, account deletion guard, Trash restores of teams and projects, audit-log facets, live events) and `e2e/integration.spec.ts` (team home → New project dialog, settings nav by permission, Trash restore → Open, deleted team restored from account settings).
- Team settings pages (including the admin module's Audit log and Trash) render inside `TeamSettingsLayout`: use `SettingsHeader` (h2) from `web/pages/team-settings/SettingsSection.tsx`, not `PageContainer`/`PageHeader`.
- Issues/tasks modules: register `issue`/`task` in `server/services/trashHandlers.ts`; record `meta: { ref, title }` so `web/lib/activityText.ts` names them in the audit log and timelines; the team home counts (`GET /api/teams/:id/overview`) and the project Progress card already count live tasks and issues.
- Mutations whose optimistic update removes the row that started them must live in the list component, not the row (callbacks of an unmounted observer never run): see `DeletedTeamsCard` and the sessions list in `SecuritySettingsPage`.
- Account settings cards are named regions (`SettingsCard` sets `aria-labelledby`), so `getByLabel('Name')` inside a card-wrapping form also matches the card: use `{ exact: true }` or `getByRole('textbox', { name })`.
- E2E timing: dnd-kit's keyboard sensor starts listening for arrow keys on a timer after the pick-up, so wait a tick (`page.evaluate(() => new Promise((r) => setTimeout(r, 0)))`) before pressing arrows; match toasts with `[data-sonner-toast]` when the same words also show up in a log on the page.

## Issues module

- Server: `requireIssue(db, actor, issueId)` (server/services/issues.ts) gives `{ issue, project, team, membership }` for live issues (404 otherwise); `canTriageIssue(membership, authorId)` is the author-or-`RESOLVE_ISSUES` rule; `linkedTasksOf(db, issueId)` returns the live tasks linked through `task_issue_link` with status and kind. The `issue` trash handler is registered.
- Tasks module: `resolveIssue(deps, actor, issueId)` checks author-or-`RESOLVE_ISSUES`, so the `fixes` automation (a task entering a done status) should resolve inside its own transaction instead: set `resolved`, `resolvedAt`, `resolvedById`, `lastActivityAt`, record `issue.resolved` (`meta: { ref, title }`, no changes, so timelines read "resolved this issue"), notify `issue_resolved` and emit `issue.updated`. The issue page calls `POST /api/projects/:projectId/tasks/from-issue` `{ issueId }` and reads `number` and `ref` from the response; task and link changes should emit `task.*` events (live.ts refreshes `issues.all` on them) so "Addressed by" updates.
- Web: `web/pages/issues/queries.ts` has the hooks (`useIssueList`, `useIssue`, mutations). `IssueStateIcon` / `IssueStateBadge` (web/pages/issues/IssueState.tsx) are the open/resolved markers; the dashboard or inbox can reuse them. The list's filters live in the URL (`?state&label&match&author&q&sort`, labels and author by name), so links like `/t/acme/p/WEB/issues?state=resolved` work.
- Seed: `scripts/seed-issues.ts` (called from scripts/seed.ts after the API keys) adds 12 issues to WEB and API, with replies, resolved ones, two opened through API keys and one in Trash, backdated over two weeks.

## Tasks module

- Contract: `taskSummarySchema` (shared/schemas/tasks.ts) is the task shape other modules show; the work module's `workTaskSchema` should be unified with it. Server code that needs summaries of task rows can call `toTaskCards(db, rows)` and `toTaskSummary(card)` (server/services/taskViews.ts), which hydrate any number of tasks in a fixed number of queries. `assignedTo(userId, roleIds)`, `isUnassigned`, `isBlocked` and `claimValidAt(now)` there are the SQL conditions behind "assigned to me (or my roles)", blocked and claimed, for the dashboard and My tasks.
- Issues module: `POST /api/projects/:projectId/tasks/from-issue { issueId }` returns the created `Task` (`number`, `ref`, `path`); navigate to `path`. The "Addressed by" list can read `task_issue_link` joined with live tasks; each link change writes `issue.links_changed` (`changes.linkedTasks`, e.g. `["API-4 (fixes)"]`) on the issue, and a done task writes `issue.resolved` (`meta.byTask`) and emits `issue.updated`. The issues service's own resolve/reopen should keep using `resolved`, `resolvedAt`, `resolvedById` like `resolveFixedIssues` in server/services/taskLinks.ts.
- Web: the `task.create` shell action (`{ projectId?, statusId? }`, declared in web/pages/tasks/NewTaskDialog.tsx) opens the New task dialog anywhere, e.g. from the dashboard or My tasks. Task queries live under `queryKeys.tasks.all(projectId)` (board, list, detail by number), refreshed by the existing live invalidations.
- Claims: any write by the holder renews the lease, including replies, through `ItemResolver.onThreadWrite` (server/services/items.ts); another module writing to a task on the holder's behalf can call `renewClaimOnWrite(tx, actor, taskId)` from server/services/claimLease.ts.
- Seed: scripts/seed.ts doesn't create tasks yet. A realistic QA set (two projects, claims by agents, blockers, replies) can be created through the REST API with the seeded keys; the script used for visual QA is outside the repo (see the report).

## Work module (dashboard, My tasks, inbox)

- Server: `server/services/myWork.ts` (`workScope`, `assignedOpenCondition`, `claimedByCondition`, `selectTasks` + `toMyTasks` for the task summary with team/project/assignment reason) and `server/services/dashboard.ts` (`getDashboard`, `recentActivity`). REST: `GET /api/me/tasks`, `GET /api/me/dashboard`; MCP: `my_tasks`, `dashboard_summary`. Contracts in `shared/schemas/work.ts`.
- Merge with the tasks module: `workTaskSchema` mirrors `taskSummarySchema`; when both land, make `workTaskSchema` an alias of `taskSummarySchema` (keep `priority` 0–4 or change both), and consider replacing `toMyTasks`'s hydration with the tasks module's summary builder. Tasks are "blocked" only by live blockers in open statuses and a claim is shown only while its lease is valid; keep the tasks module consistent with that.
- Web: `web/pages/my-tasks/WorkTaskRow.tsx` is a reusable task row (priority, key, status, title, via-role hint, labels, claim, due). `web/pages/inbox/InboxShellExtension.tsx` now owns the live notification toast (core's `useLiveNotificationToasts` was removed) and the "Mark all notifications as read" palette command. `useMarkNotificationsRead` (web/pages/inbox/queries.ts) updates every cached notification list, the unread count and `me` optimistically.
- E2E: `e2e/work.spec.ts` seeds tasks with `withDatabase` (the tasks API is not in this branch) and waits for the shell extensions (the sidebar's "New team" button) and `/api/events` before relying on live events: lazily loaded shell extensions mount together, after the page. Once the tasks module lands, seeding could switch to its REST endpoints, and `scripts/seed.ts` could seed tasks so the dashboard has data out of the box.

## Integration (wave B: issues, tasks, work)

Later notes win over the module sections above where they disagree.

- One task shape: `taskSummarySchema` (shared/schemas/tasks.ts) is the only task summary; `myTaskSchema` (shared/schemas/work.ts) extends it with team, project, url and the assignment reason. Server code builds summaries with `toTaskCards` + `toTaskSummary` (server/services/taskViews.ts); `server/services/myWork.ts` only adds the scope (my teams and roles) and the My tasks filters. The issue page's "Create task" parses the tasks `taskSchema` and opens `task.path`.
- The web's "Blocked" marker is `BlockedBadge` (web/components/common); board cards, the list view and the work rows all use it. Components using it need the app's `TooltipProvider` in tests (`renderWorkPage` in web/pages/my-tasks/testing.tsx has it).
- `formatAge(value, now)` (web/lib/format.ts) now uses `now`, as its signature says.
- Pending uploads linked from saved text are claimed by one helper, `referencedPendingUploads(db, actor, teamId, markdown)` in server/services/attachments.ts, used by issues, tasks, projects and replies (create and edit).
- Tests that tie the modules together: `server/mcp/catalog.test.ts` (tool list vs SPEC §5.1, descriptions on every field), `server/mcp/agentWorkflow.test.ts` (a full agent session over `POST /mcp` with real keys: whoami → list_projects → create_issue → create_task_from_issue → claim_next_task → add_reply → move_task to Done → the issue resolves, its author is notified, and get_activity shows every step via the key; then search, delete and restore_item), the wave B block of `server/crossModule.test.ts` (REST: issue → task → done → resolved and notified live; mentions, role mentions, assignments and replies in the inbox; My tasks and dashboard counts) and `e2e/integration.spec.ts` (the issue page's Create task → task page → Done → the reporter's inbox updates live → "Addressed by" shows the done task).
- E2E: `e2e/work.spec.ts` and the issues spec create tasks through the tasks REST API (no more `withDatabase` inserts for tasks); work's "via role" rows use a real role, since tasks can't be assigned to `@everyone`.
- Dev data: `npm run db:seed -- --reset` now gives a lived-in workspace: sign in as `ethan` (password `password123`) for a dashboard with overdue, due-soon and claimed work (one claim via his key, one on the web), an inbox with unread items, and boards with every status. Claims last 240 minutes after seeding. Visual QA screenshots of every page (light/dark, 1440/375) were taken against a production build on :3300 with this data.

### Known issues at hand-off

- The work module still counts tasks assigned to a team's `@everyone` role as "mine", but the tasks module refuses such assignments, so that path only matters for data written outside the services.
- Linux `npm ci` and e2e were not run (Windows only), as in earlier waves.

## Security fixes (SEC-01 to SEC-09)

- Every `/api` route except `/api/auth/*` sits behind `signedInMiddleware` (server/middleware/actor.ts) and a 2 MB JSON body cap (server/middleware/bodyLimit.ts); only `GET /api/config`, registered on the app before the API router, is public. A new public endpoint must be registered the same way, and a new upload route must be added to `UPLOAD_PATHS` in server/routes/index.ts with its own `bodyLimit`. Read multipart bodies with `parseMultipartBody` (server/lib/validate.ts), never `c.req.parseBody()` directly.
- `applyIssueLinksChange` takes the actor's membership: a new `fixes` link needs `canTriageIssue`. Any new way to create links must go through it.
- Code that ends a membership must call `revokeInvitesOf(tx, actor, teamId, userId)` (server/services/invites.ts) in the same transaction. Audit meta must never hold a full invite code: use `inviteCodeHint`.
- Notifications about trashed items are filtered when read (`liveSubjectCondition` in server/services/notifications.ts); a new notification subject type needs a case there. Edits of text that notifications quote call `refreshNotificationText(tx, target)`.
- Pending uploads need a content permission (`PENDING_UPLOAD_PERMISSIONS`) and are capped per member at a tenth of the team quota (`pendingUploadCapBytes`), both in server/services/attachments.ts.

## Integrity fixes (CDI-01 to CDI-15)

- Every way a task changes status goes through `applyStatusTransition` (server/services/tasks.ts), status deletion included; a new path that moves tasks must call it and record `task.moved` per task.
- Code that removes task assignees without editing the task (memberships, roles, accounts) calls `unassignFromTasks` (server/services/taskAssignees.ts) in the same transaction, before the rows go.
- A task or issue change that shows on linked items calls `queueLinkedIssueEvents` / `queueLinkedTaskEvents` (server/services/linkEvents.ts); inside tasks.ts, `emitTaskChange` does it for you.
- Writes that also post a reply use `prepareReply` (before the write) and `insertReply` (inside it), never `createReply`, so the whole mutation is one transaction.

## MCP fixes (MCP-01 to MCP-17)

- Build every tool input, and every nested argument object, with `toolInput({...})` from `server/mcp/tools/define.ts`, never `z.object`: it refuses unknown keys with a "did you mean" hint. `server/mcp/agentSafety.test.ts` fails if any advertised object schema lacks `additionalProperties: false`, or if a tool that isn't `readOnlyHint: true` doesn't declare `destructiveHint` (`openWorldHint: false` is added by `defineTool`).
- MCP results name tasks and issues with team-qualified refs: use `qualifyRef`, `withQualifiedRefs` and `teamSlugs` from `server/mcp/util.ts` for any new output carrying a `KEY-12` / `KEY#51` ref.
- When a tool maps its parameters onto a shared REST schema, parse with `parseToolInput(schema, value, fieldNames)` so validation errors name the tool's parameters.
- `refs.ts` resolvers throw messages that list valid values; `toToolResult` appends `AppError.details` (minus `issues`, `ref`, `candidates`, which the messages already carry) as JSON.
- Paged reads for agents: `listReplyPage` (server/services/replies.ts), `listEntityActivityPage` (server/services/activity.ts) and `listMyTasks(…, { offset, limit })`.

## UX fixes (UX-01 to UX-16)

- A shell-wide shortcut that pages may override is registered with `useHotkey(keys, fn, { …, fallback: true })`; pages just use `useHotkey`. Don't rely on registration order.
- Dialogs, alert dialogs and sheets return focus to their opener automatically (`web/lib/useReturnFocus.tsx` inside the ui wrappers). Only pass `onCloseAutoFocus` with `preventDefault()` when focus must go somewhere else.
- Text drawn in an entity color (role-colored names) must use `useReadableTextColor(color)` or `readableTextColor(color, resolvedTheme)` from web/lib/colors.ts; never `style={{ color }}` with a raw user-picked color.
- New theme tokens used for text should be added to the pairs in `web/styles/contrast.test.ts`.
- Headings: a page has one h1 (the project name on project pages, the item on task/issue pages); `EmptyState` defaults to h2 (`headingLevel={3}` under a section h2); MarkdownView starts at h3.
- Palette search providers may set `rank` on results (lower is better) to order the groups.

## Production fixes (PERF-01 to PERF-04, OPS-01, SEC-01, LOG-01)

- Activity rows must be written through `recordActivity` (server/services/activity.ts): it also keeps the team's audit-log facets (`activity_facet`), which `GET /api/teams/:teamId/audit-log/facets` and MCP `get_audit_log_facets` read. A new facet dimension needs a kind in `ACTIVITY_FACET_KINDS`, a line in `recordFacets` and a backfill migration.
- Queries over `activity` that span teams must not use `team_id IN (…)` / `OR` with `ORDER BY created_at`: SQLite sorts every row of those teams. Query per team and merge (see `teamActivityStream` in server/services/dashboard.ts).
- App-wide shell extensions must stay light: anything heavy (the editor, the date picker, charts) belongs in a module the extension loads with `lazy()` when it is needed, like `NewTaskForm` in web/pages/tasks/NewTaskDialog.tsx. `e2e/bundles.spec.ts` fails if the dashboard loads ProseMirror or react-day-picker code.
- Live events invalidate queries 100 ms after they arrive (batched, deduplicated). Listeners registered with `useLiveEventListener` still run at once.
- Code that runs inside a request without the Hono context can log with `currentLogger(deps.logger)` (server/lib/requestContext.ts) to get the request id and client IP.
- Web source maps are in `dist/sourcemaps/web/` after `npm run build` (not published).
- docs/DEPLOY.md (owned by ops) should say that `backups/uploads/` now follows the snapshots' retention: files deleted in the app leave the mirror once no retained daily or pre-deploy snapshot references them.
