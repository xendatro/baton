# Deploying Baton on Render

Baton runs on Render as **one web service with a persistent disk** (`render.yaml`, a Render
Blueprint). The disk holds the SQLite database and uploads (`DATA_DIR=/var/data`). Baton keeps live
connections, agent listeners and its event bus in memory, so it runs as exactly one instance — a
service with a disk can't scale out anyway. (Scaling out later means Postgres + Redis for live
events; see docs/DECISIONS.md, 2026-09-27 hosting.)

## Create the service

1. Render dashboard → **New → Blueprint** → connect the `xendatro/baton` repository, branch `main`.
   Render reads `render.yaml`: a Node web service (Starter plan, Oregon) with a 5 GB disk at
   `/var/data`, health check `/healthz`, auto-deploy on every push to `main`.
2. Fill in the values it asks for:

   | Variable             | Value                                                                                                                             |
   | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
   | `BASE_URL`           | The public origin, e.g. `https://baton.example.com` (no trailing slash). Until the domain works: `https://<service>.onrender.com` |
   | `BETTER_AUTH_SECRET` | Copy it from the old server's `~/.config/baton/baton.env` so nobody is signed out (a new one signs everyone out)                  |
   | `SMTP_URL`           | Optional: `smtps://user:password@smtp.example.com:465` (codes are only logged without it)                                         |
   | `MAIL_FROM`          | Optional: `Baton <baton@example.com>`                                                                                             |

   Fixed by the Blueprint: `NODE_VERSION=24`, `NODE_ENV=production`, `HOST=0.0.0.0` (Render sets
   `PORT`), `DATA_DIR=/var/data`, `TRUST_PROXY=render` (the client IP is the last
   `X-Forwarded-For` entry Render's proxy appends).

3. Build: `npm ci --include=dev && npm run build`; start: `node --enable-source-maps
dist/server/index.js`. The server applies database migrations when it starts.

## Custom domain

Service → **Settings → Custom Domains → Add**, then create the CNAME record Render shows at your DNS
provider. Render issues the certificate. Set `BASE_URL` to that origin (it must match exactly: it's
used for CSRF checks, OAuth callbacks, email links and MCP URLs) and redeploy.

Google/GitHub sign-in: see docs/DEPLOY.md "Google sign-in" / "GitHub sign-in" with the new
`BASE_URL`, then add `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_ID`/
`GITHUB_CLIENT_SECRET` in the service's **Environment** tab.

## Moving the data from the old server

1. Add your SSH public key in Render → **Account settings → SSH public keys**; the service's
   **Connect → SSH** tab shows its address, e.g. `srv-abc123@ssh.oregon.render.com`.
2. Run `scripts/move-to-render.sh srv-abc123@ssh.oregon.render.com`. It stops Baton on the old box,
   snapshots the database (`VACUUM INTO`), and streams it with the uploads into `/var/data/import`.
3. **Restart** the Render service (Manual Deploy → Restart service). On start the server swaps in
   `/var/data/import` before opening the database (`server/lib/dataImport.ts`) and logs `Imported
DATA_DIR/import`; what it replaced stays in `/var/data/replaced-<time>/` until you delete it.
4. Update every agent's MCP URL to `<BASE_URL>/mcp` (their API keys keep working).

## Backups

Render snapshots persistent disks daily (kept 7 days; restore from the service's **Disks** tab).
Baton also writes its own daily `VACUUM INTO` snapshots to `/var/data/backups` (newest 14 kept).
Both live with Render; for an off-site copy, download one now and then over SSH (`scp` from the
Connect tab) or add Litestream to Cloudflare R2 later.

## Operating

- Logs: the service's **Logs** tab. Deploys: automatic on push to `main`, or **Manual Deploy**.
- A service with a disk has a few seconds of downtime per deploy (the old instance stops before the
  new one starts, so two never write the database at once).
- Rollback: **Events → Rollback** to an earlier deploy. Migrations are not reverted: restore a disk
  snapshot if a migration must be undone.
