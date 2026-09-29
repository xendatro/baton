# Baton desktop app

The Baton desktop app is Baton itself, the same web app you use in a browser (you log in the same
way, and every feature is there), plus what only a computer can do: it runs your Baton agent's jobs
automatically (BAT-24, BAT-26, `docs/design/agents-and-pipelines.md` §8). It listens for your
agent's jobs with plain code, so no tokens are spent while idle, and runs each job in a fresh
headless session of your own harness, in the folder you picked for the job's project, with your own
settings, skills, plugins, `CLAUDE.md` and MCP servers.

**Parity rule:** every feature ships on both the website and the desktop app. Features are built
once in `web/`; the desktop-only pages (Running agents, Folders, Harnesses, Set up this computer)
live in `web/pages/desktop/` and show only inside the app (`window.batonDesktop`, see
`shared/desktopBridge.ts`).

| Harness     | Headless mode       | Verified                              |
| ----------- | ------------------- | ------------------------------------- |
| Claude Code | `claude -p`         | yes (2.1.x, end to end against Baton) |
| Codex       | `codex exec --json` | flags read from `--help` at run time  |
| Gemini CLI  | prompt on stdin     | flags read from `--help` at run time  |
| Cursor CLI  | `cursor-agent -p`   | flags read from `--help` at run time  |
| opencode    | `opencode run`      | flags read from `--help` at run time  |

## Updates

The web app inside the window updates with the Baton server. The app itself (runner, harnesses,
tray) updates from GitHub Releases from 0.3.0 on: Windows and Linux download a new version in the
background and install it on "Restart to update" (sidebar, tray or notification) or the next quit;
macOS offers the download, since unsigned macOS apps can't replace themselves. Release by bumping
`version` in `package.json` and pushing a `desktop-v<version>` tag.

## Develop

```bash
cd desktop
npm ci                      # needs the repository root's `npm ci` too (shared code)
npm run check               # typecheck + unit tests
npm start                   # build and open the app (on Linux without a root-owned
                            # chrome-sandbox: npx electron . --no-sandbox)
npm run dist:win            # Windows installer (NSIS) in release/; dist:mac for macOS
```

If npm skipped Electron's install script, download the binary once with
`node node_modules/electron/install.js`. `BATON_DESKTOP_SCREENSHOT=out.png` saves the window once
it has loaded, then quits (for checking the UI without clicking).

## How it works

- `src/main/runner.ts`: registers this machine as a runner, heartbeats every 30 s and long-polls
  `POST /api/agent/runners/:id/jobs/next` for jobs of the mapped projects. Each job: its brief
  (prompt, model chain, session to resume) → the chain's runnable steps (installed, not out of
  usage) → the harness in the mapped folder → usage (tokens by kind, the model the harness
  reported), the outcome, the last error and the output's last 200 lines reported when it ends.
  Out of usage moves to the next step (and skips that harness until its reset); a killed or failed
  run goes back to you under "Stopped runs".
- `src/main/harness/`: one adapter per harness (`detect`, `listModels`, `run`), and the
  out-of-usage heuristics.
- `src/main/main.ts`: the window loads the Baton server (default https://www.passthebaton.dev) in a
  persistent session; other sites open in your browser (sign-in with Google or GitHub stays in the
  app). If the server can't be reached, `src/offline/offline.html` offers a retry or another server.
- `src/preload.ts`: `window.batonDesktop` for the server's own pages only; `src/main/origin.ts`
  checks the sender of every call again.
- `src/main/permissions.ts`: a local MCP server (127.0.0.1, random token) whose `approve` tool is
  Claude Code's `--permission-prompt-tool`: permission prompts become Allow / Deny pop-ups.
- The Baton MCP is added to a run (as `baton_app`) only when the harness's own MCP servers don't
  already reach the same Baton server.
- "Set up this computer" (in the app, while signed in) creates this computer's agent key itself
  and keeps it in the app's user-data folder, encrypted with the OS keychain when available. You
  never paste keys, and the key the agent uses can't sign in as you.
