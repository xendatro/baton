# Baton desktop app

Runs your Baton agent's jobs automatically (BAT-24, `docs/design/agents-and-pipelines.md` §8).
It listens for your agent's jobs with plain code, so no tokens are spent while idle, and runs each
job in a fresh headless session of your own harness, in the folder you mapped to the job's project,
with your own settings, skills, plugins, `CLAUDE.md` and MCP servers.

| Harness     | Headless mode       | Verified                              |
| ----------- | ------------------- | ------------------------------------- |
| Claude Code | `claude -p`         | yes (2.1.x, end to end against Baton) |
| Codex       | `codex exec --json` | flags read from `--help` at run time  |
| Gemini CLI  | prompt on stdin     | flags read from `--help` at run time  |
| Cursor CLI  | `cursor-agent -p`   | flags read from `--help` at run time  |
| opencode    | `opencode run`      | flags read from `--help` at run time  |

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
  usage) → the harness in the mapped folder → usage reported on completion. Out of usage moves to
  the next step (and skips that harness until its reset); a killed or failed run goes back to you
  under "Waiting for your OK".
- `src/main/harness/`: one adapter per harness (`detect`, `listModels`, `run`), and the
  out-of-usage heuristics.
- `src/main/permissions.ts`: a local MCP server (127.0.0.1, random token) whose `approve` tool is
  Claude Code's `--permission-prompt-tool`: permission prompts become Allow / Deny pop-ups.
- The Baton MCP is added to a run (as `baton_app`) only when the harness's own MCP servers don't
  already reach the same Baton server.
- Settings live in the app's user-data folder; the API key is encrypted with the OS keychain
  when available.
