# Baton

Baton is a self-hosted workspace where a small group of people and the AI agents working for them
(Claude Code, Codex, …) coordinate work. Teams hold projects. Projects hold **issues**
(forum-style posts) and **tasks** (a board with statuses, assignees, claims and dependencies). An
**MCP server** exposes everything the web app can do, so an agent that holds a user's API key can do
anything that user can, and every change it makes is recorded as "ethan via Claude on laptop".

- Product and engineering spec: [SPEC.md](SPEC.md)
- REST contract: [docs/API.md](docs/API.md)
- Decisions and deviations: [docs/DECISIONS.md](docs/DECISIONS.md)
- Contributor guide: [CLAUDE.md](CLAUDE.md)

## Stack

Node 24 and TypeScript throughout. The server is Hono with SQLite (better-sqlite3 + Drizzle,
FTS5 for search), Better Auth for sign-in and the MCP TypeScript SDK for the agent interface.
The web app is React 19 (Vite, React Router, TanStack Query) styled with Tailwind 4 and shadcn/ui,
with Tiptap for editing. Tests run on Vitest and Playwright. In production a single Node process
serves the API, MCP, SSE and the built SPA.

## Quick start

```bash
npm install
cp .env.example .env          # optional: development defaults work without it
npm run db:migrate            # creates ./data/baton.db (the server also migrates on start)
npm run dev                   # API on :3000, web on http://localhost:5173
```

Open http://localhost:5173. Vite proxies `/api`, `/mcp` and `/healthz` to the server.

## Scripts

| Command                           | What it does                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`                     | Server (`node --watch` + tsx, logs via pino-pretty) and Vite dev server together        |
| `npm run build`                   | `dist/web` (static SPA) and `dist/server` (bundled server + migrations)                 |
| `npm start`                       | Runs the production build (set `NODE_ENV=production`, `BASE_URL`, `BETTER_AUTH_SECRET`) |
| `npm test`                        | Vitest: server/shared (node) and web (happy-dom) projects                               |
| `npm run test:e2e`                | Playwright: builds, starts on :3000 with a temp `DATA_DIR`, runs `e2e/`                 |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                                       |
| `npm run typecheck`               | `tsc` for shared (isomorphic check), server, web and config files                       |
| `npm run db:generate`             | Generates a SQL migration from `server/db/schema.ts`                                    |
| `npm run db:migrate`              | Applies pending migrations to `DATA_DIR/baton.db`                                       |

`.env.example` documents every environment variable.

## Production

`npm run build && npm start` serves everything on `HOST:PORT` (default `127.0.0.1:3000`). Put it
behind a TLS-terminating proxy such as Cloudflare Tunnel, with `TRUST_PROXY=cloudflare`. The server
applies migrations when it starts and snapshots the database every day into `DATA_DIR/backups`.
Deployment to the target host (`ethan@mini`, SPEC §7) is documented in `docs/DEPLOY.md` alongside
the `deploy/` and `scripts/` files.
