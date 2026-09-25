# Baton: contributor guide

Read `SPEC.md` first; it is the source of truth. `docs/API.md` holds the REST contract, and
`docs/DECISIONS.md` records every deviation from the spec (add a dated line whenever you make one).

## Commands

```bash
npm run dev          # server :3000 (node --watch + tsx) + Vite :5173 (proxies /api /mcp /healthz)
npm test             # vitest run (projects: server = server/** + shared/**, web = web/**)
npx vitest run --project server server/app.test.ts   # one file
npm run test:e2e     # playwright: build + start on :3000 with a temp DATA_DIR
npm run lint         # eslint (type-aware)
npm run typecheck    # tsc for shared (no Node/DOM allowed), server, web, root config files
npm run format       # prettier (single quotes, width 100, tailwind class sorting)
npm run build        # dist/web + dist/server
npm run db:generate  # after editing server/db/schema.ts → new SQL migration (commit it)
npm run db:migrate   # apply migrations to DATA_DIR/baton.db
```

All of lint, typecheck, test and build must pass before you commit (CI runs the same steps).
Use `path.join`/`path.resolve` and Node scripts, never bash-only npm scripts. Development happens
on Windows, production runs on Ubuntu.

## Layout

```
shared/                 isomorphic code: no Node or DOM APIs (checked by shared/tsconfig.lib.json)
  constants.ts          limits, reserved usernames, palette, priorities, enums
  permissions.ts        permissions + metadata, @everyone defaults, role seeds, effective-permission helpers
  events.ts             live event types + zod schema
  refs.ts               KEY-12 / KEY#51 / team/KEY parsing and formatting
  schemas/<module>.ts   zod wire contracts (request + response) shared by REST, MCP and web forms
server/
  index.ts              entrypoint: env → migrate → createApp → serve → jobs → graceful shutdown
  app.ts                createApp(deps): request id, logging, security headers, errors, /healthz,
                        /api/config, routes, SPA fallback. Pure, so tests build their own app.
  context.ts            Actor, AppDeps { env, db, logger, events }, AppEnv (Hono variables)
  env.ts logger.ts version.ts
  db/                   schema.ts, index.ts (openDatabase, db.write), migrate.ts, migrations/
  lib/                  errors, validate, ids, cursor, security (API keys, invite codes), eventBus, paths
  services/<module>.ts  ALL business logic
  routes/<area>.ts      thin REST adapters, registered in routes/index.ts
  mcp/tools/<module>.ts MCP tools (defineTool), registered in mcp/tools/index.ts
  jobs/                 croner jobs (claims, purge, backups), registered in jobs/index.ts
  test/                 helpers.ts (createTestContext) + fixtures.ts (factories)
web/
  router.tsx            every route → lazily loaded page in web/pages/<area>/
  lib/                  queryKeys.ts, live.ts (event → invalidation), theme.ts, queryClient.ts, utils.ts
  components/ui/        shadcn/ui primitives (add more with `npx shadcn@latest add <name>`)
  components/layout/    app shell, sidebar, header
  pages/<area>/         one folder per feature area
e2e/                    playwright specs
```

The registration files (`server/routes/index.ts`, `server/mcp/tools/index.ts`, `server/jobs/index.ts`,
`web/router.tsx`, `web/lib/queryKeys.ts`, `web/lib/live.ts`, `shared/events.ts`) already cover
every module. Fill in your own files, and keep any change to a shared file small and additive.
Imports across top-level folders use the aliases `@shared/*`, `@server/*` (server only) and `@web/*`
(web only). Imports within a folder are relative. `server/db/schema.ts` uses relative imports only,
because drizzle-kit loads it directly.

## Server conventions

- **Services own the business logic.** Routes and MCP tools parse input, call one service function
  and shape the output. They never query the database themselves or check permissions.
- **Every service function takes `(deps: AppDeps, actor: Actor, input)`.** `Actor` is
  `{ userId, source: 'web'|'mcp'|'api'|'system', key: { id, name } | null }`.
- **Order of a mutation:** validate (zod) → load and check membership/permission (non-members get
  `errors.notFound`) → `deps.db.write((tx) => { change; recordActivity(tx, …); update the search
index; create notifications })` → **after** `write` returns (i.e. after commit), emit live
  events with `deps.events.emit(liveEvent({...}))`. Never emit inside the transaction.
- **`recordActivity` runs in the same transaction as the change**, for every mutation. It records
  field-level `changes` as `{ field: { from, to } }` with human-readable values (status names,
  usernames, not ids) and a `meta` snapshot such as the title.
- **`db.write` is synchronous** (better-sqlite3, `BEGIN IMMEDIATE`). Do no `await` inside it: do
  I/O such as file writes or email before or after. Reads can use `deps.db.orm` directly.
- **Errors:** throw `errors.notFound('Task')`, `errors.forbidden()`, `errors.conflict(msg)`,
  `errors.validation(msg, details)` and so on from `server/lib/errors.ts`. Anything else becomes a
  logged 500 `internal`. Messages are shown to users and agents, so keep them human and free of
  internals.
- **Validation:** zod everywhere input enters (route body/query/params, MCP tool input, env, cursors).
  Put request/response schemas in `shared/schemas/<module>.ts` so the web app reuses them for forms.
- **Ids:** `newId()` (ULID). Timestamps are `Date` in TypeScript, integer ms in SQLite, and ISO
  strings on the wire.
- **Soft delete:** set `deletedAt`/`deletedById`/`deletedViaKeyId`. Every list, search and MCP
  query must filter out `deletedAt IS NOT NULL` rows, and the rows of deleted parents too.
- **Better Auth** must be configured to match `server/db/schema.ts`: username + emailOTP plugins,
  `user.additionalFields.theme = { type: ['system','light','dark'], required: true, defaultValue:
'system', input: false }`, and `advanced.database.generateId: () => newId()`.
- **Logging:** use `c.var.logger` in routes (it carries the request id) and `deps.logger` elsewhere.
  Never call `console.*` in server code.

### Add a REST route

1. Add request and response schemas to `shared/schemas/<module>.ts`.
2. Implement the logic in `server/services/<module>.ts`.
3. Add the handler to your router in `server/routes/<area>.ts`. It is already mounted, and paths
   are written in full relative to `/api`. `requireActor` comes from the auth middleware in
   `server/middleware/actor.ts` (core module):
   ```ts
   taskRoutes.post('/tasks', validateJson(createTaskInputSchema), (c) => {
     const task = createTask(c.var.deps, requireActor(c), c.req.valid('json'));
     return c.json(task, 201);
   });
   ```
4. Test it with `createTestContext()` and `ctx.app.request(...)` against a real temporary database.
5. Document it in `docs/API.md`.

### Add an MCP tool

Add it to your module's list in `server/mcp/tools/<module>.ts`:

```ts
export const tasksTools: McpTool[] = [
  defineTool({
    name: 'get_task', // snake_case
    title: 'Get task',
    description: 'Full context of a task: description, status, assignees, claim, recent replies.',
    input: z.object({ task: z.string().describe('Task ref (KEY-12, team/KEY-12) or id') }),
    handler: (ctx, input) => getTask(ctx.deps, ctx.actor, input), // services only
  }),
];
```

`defineTool` sends the result as JSON text plus `structuredContent`, and turns an `AppError` into an
`isError` result without exposing stack traces. Every input field needs a `.describe()`. Entities
you return should include `ref` and an absolute `url` (`deps.env.baseUrl`). Accept refs wherever
SPEC §5.1 says so.

### Add a job

Add a `JobDefinition` (`{ name, schedule, run(deps) }`) to your module's list in
`server/jobs/<file>.ts`. Jobs act as the system: `actor` is null or `source: 'system'` in activity.

## Web conventions

- **Pages:** `web/router.tsx` already declares every route, each pointing at a placeholder in
  `web/pages/<area>/`. Replace the placeholder's contents and keep its default export. For a new
  route, add a lazy `page(() => import('./pages/<area>/XPage'))` entry.
- **Data:** use TanStack Query with keys from `web/lib/queryKeys.ts` only. Keys use ids, not URL
  slugs: resolve the slug or key to an id through the `me` query. When you add a query, check that
  `web/lib/live.ts` invalidates it for the relevant events.
- **UI:** shadcn/ui from `@web/components/ui/*`, `cn()` from `@web/lib/utils`, and lucide icons.
  Aim for a compact Linear/GitHub look: zinc neutrals, an indigo `primary`, 8px radius. Every page
  needs skeletons, an empty state with a call to action, an error state and toasts (sonner) for
  mutations.
- **Forms** validate with the shared zod schemas and show messages inline.
- **Theme:** use `useTheme()` from `web/lib/theme.ts`. `web/public/theme-init.js` applies the theme
  before first paint, because the CSP allows no inline scripts. Keep the two files in sync.
- **Accessibility:** everything must be reachable by keyboard, icon buttons need an `aria-label`,
  and color is never the only signal.

## Tests

- Server: `createTestContext()` (`server/test/helpers.ts`) gives a temp `DATA_DIR`, a migrated DB, the
  app and deps. Call `ctx.close()` in `afterEach`. The factories in `server/test/fixtures.ts`
  (`createUser`, `addPassword`, `createTeam` (seeds @everyone + Admin), `createRole`, `addMember`,
  `createProject` (seeds Open/Done), `createApiKey`) plus `bearer(key)` and `json(method, body)`
  cover most setup.
- Web: Vitest with happy-dom and Testing Library (`*.test.tsx` under `web/`).
- E2E: Playwright specs in `e2e/`.
