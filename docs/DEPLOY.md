# Deploying Baton

> **Since 2026-09-27 production runs on Render at https://www.passthebaton.dev** (see
> docs/DEPLOY-RENDER.md; pushes to `main` deploy automatically). This guide describes the previous
> self-hosted setup on the mini box, whose `baton` service is now stopped and disabled.

Baton runs on one always-on Linux box (`ethan@mini`: Ubuntu 24.04 x86_64, no sudo) as a systemd
**user** service, published to the internet through a Cloudflare Tunnel. This document covers the
first install, deploys, logs, backups and restores, configuration, the tunnel and rollback.

Tooling (all idempotent):

| File                           | Runs on     | Purpose                                                                    |
| ------------------------------ | ----------- | -------------------------------------------------------------------------- |
| `scripts/deploy.sh`            | dev machine | `ssh` wrapper: install, deploy, rollback, status                           |
| `scripts/install-mini.sh`      | host        | installer and release manager (what `deploy.sh` runs remotely)             |
| `scripts/smoke.sh`             | anywhere    | read-only post-deploy checks (curl), optionally through an `ssh -L` tunnel |
| `scripts/cloudflare-tunnel.sh` | host        | cloudflared download, login, tunnel, DNS, config, env update               |
| `deploy/baton.service`         | host        | systemd user unit for the app                                              |
| `deploy/baton-tunnel.service`  | host        | systemd user unit for `cloudflared tunnel run`                             |
| `deploy/baton.env.example`     | host        | template for `~/.config/baton/baton.env`                                   |

## Architecture

```
browser / agent ──https──> Cloudflare edge ──tunnel──> cloudflared (baton-tunnel.service)
                                                             │ http://127.0.0.1:3000
                                                             v
                                       node dist/server/index.js (baton.service)
                                       API + /mcp + SSE + SPA, one process, loopback only
                                                             │
                                          ~/.local/share/baton: baton.db (SQLite WAL),
                                          uploads/, backups/
```

Layout on the host (`$HOME` = `/home/ethan`):

| Path                                                           | What                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `~/.local/node`                                                | symlink to `~/.local/lib/nodejs/node-v24.x.y-linux-x64` (official tarball, SHA-256 checked)                    |
| `~/apps/baton`                                                 | git clone of `xendatro/baton` (fetched via `gh`, reset to the deployed ref)                                    |
| `~/apps/baton-releases/<UTC timestamp>-<sha10>/`               | one release per deploy: `git archive` of the ref + `npm ci` + `npm run build`, with `REVISION` and `build.log` |
| `~/apps/baton-releases/current`                                | symlink to the live release (the unit's `WorkingDirectory`)                                                    |
| `~/apps/baton-releases/previous`                               | symlink to the release that was live before the last switch                                                    |
| `~/.local/share/baton/`                                        | `DATA_DIR`: `baton.db`, `uploads/`, `backups/`                                                                 |
| `~/.config/baton/baton.env`                                    | environment, mode 600                                                                                          |
| `~/.config/systemd/user/baton.service`, `baton-tunnel.service` | units (only these two are managed; other user units are left alone)                                            |
| `~/.local/bin/cloudflared`, `~/.cloudflared/`                  | tunnel binary, `cert.pem`, `<tunnel-id>.json`, `config.yml`                                                    |

Notes:

- SPEC §7 says "app cloned to `~/apps/baton`". The clone is there, but the service runs from a
  separate built release directory, so a failed `npm ci`/build never touches the running code and
  rollback is a symlink switch. Three releases are kept (current, previous and one more).
- Port: 3000 was free on the mini and is used. The installer picks 3080+ if 3000 is taken on a
  first install and writes it to `PORT` (and `BASE_URL`) in the env file; everything else (health
  checks, smoke test, tunnel config) reads `PORT` from there.
- `lingering` is enabled for `ethan`, so user services run without a login session and start at
  boot (`WantedBy=default.target`).
- `.npmrc` has `ignore-scripts=true` (see DECISIONS 2026-09-25): no C++ toolchain is needed on the
  host; `better-sqlite3` loads its bundled `linux-x64` prebuild. Each build verifies that it loads.
- Hardening in the units is limited to what a user manager actually enforces on this host:
  `NoNewPrivileges`, seccomp (`SystemCallFilter=@system-service ~@privileged`,
  `RestrictNamespaces`, `RestrictAddressFamilies`, `LockPersonality`, ...), `UMask=0077` and
  cgroup limits (`MemoryMax=1536M`, `TasksMax=512`). Mount-namespace options (`ProtectSystem`,
  `ProtectHome`, `PrivateTmp`, `ReadWritePaths`) are silently ignored in user units here because
  Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`; they were tested and left out.

## First install

Prerequisites on the host (already true for the mini): `git`, `gh` logged in with access to the
private repo, `curl`, `xz`, `openssl`, `jq`, systemd user manager with lingering, a free port.

From a dev machine checkout:

```bash
scripts/deploy.sh --install          # BATON_HOST=user@host to target another box
```

This streams `scripts/install-mini.sh` and `deploy/` to the host and runs `install-mini.sh
install`, which:

1. installs the newest Node 24 LTS into `~/.local/node` if it isn't there (`NODE_VERSION=v24.x.y`
   pins one), verifying the tarball against `SHASUMS256.txt`;
2. clones the repo with `gh repo clone` (or reuses the clone) and sets a repo-local git credential
   helper (`gh auth git-credential`) so later fetches authenticate through `gh`;
3. creates `~/.local/share/baton` and `~/.config/baton` (mode 700);
4. creates `~/.config/baton/baton.env` from `deploy/baton.env.example` if it does not exist, with
   `DATA_DIR`, `PORT` and a fresh `BETTER_AUTH_SECRET` (`openssl rand -hex 32`); an existing file
   is never modified;
5. installs both units, `daemon-reload`s, enables `baton.service` (the tunnel unit stays disabled);
6. deploys `main` (see below) unless that commit is already live and healthy.

Without a dev machine, the same works directly on the host once the tooling is on `main`:

```bash
ssh ethan@mini 'bash -s' < scripts/install-mini.sh            # or: ... -s -- install --ref v1.2.0
```

After a first install the app answers only on the host's loopback. To use it before the tunnel
exists, forward the port with the **same** local port as `BASE_URL` (http://localhost:3000), so
cookie-authenticated requests pass the CSRF origin check:

```bash
ssh -N -L 3000:127.0.0.1:3000 ethan@mini      # then open http://localhost:3000
```

Until SMTP is configured, sign-up verification codes are only written to the log:
`journalctl --user -u baton | grep -i code`.

## Deploy

Push the commit to GitHub first; the host fetches from `origin`.

```bash
scripts/deploy.sh                  # deploy origin/main
scripts/deploy.sh v1.3.0           # a tag, another branch on origin, or a commit sha
scripts/deploy.sh --force main     # rebuild + restart even if that commit is already live
scripts/deploy.sh --status         # releases, service state, /healthz
scripts/smoke.sh --ssh             # then check it (see Smoke test)
```

`install-mini.sh deploy` on the host, in order, aborting on the first failure:

1. `git fetch` + `git reset --hard` `~/apps/baton` to the ref;
2. if that commit is already the live release and `/healthz` is ok: stop (unless `--force`);
3. `git archive` the commit into `~/apps/baton-releases/.building-<id>`, `npm ci`, `npm run build`,
   check `dist/server/index.js`, `dist/web/index.html` and that `better-sqlite3` loads
   (output in `build.log`). **On failure the directory is removed and the running release keeps
   serving, untouched**;
4. snapshot the database (`VACUUM INTO backups/pre-deploy/baton-<id>.db`, newest 5 kept);
5. apply migrations: `npm run db:migrate` equivalent,
   `NODE_ENV=production node --env-file=~/.config/baton/baton.env --import tsx server/db/migrate-cli.ts`
   (the server also migrates at startup; running it first surfaces errors before the switch);
6. point `previous` at the old release and `current` at the new one, `systemctl --user restart
baton`, and poll `http://127.0.0.1:$PORT/healthz` for up to 60 s;
7. if it doesn't become healthy: print the last 30 log lines, switch `current` back, restart the
   old release and exit non-zero (migrations stay applied, see Rollback);
8. prune old releases and print `Healthy: {"ok":true,"version":"…"}` and `Deployed <id>`.

Only one install/deploy runs at a time (`flock` on `~/apps/baton-releases/.lock`).

## Smoke test

```bash
scripts/smoke.sh --ssh                    # tunnel localhost:13000 -> mini:127.0.0.1:$PORT
scripts/smoke.sh https://baton.example.com
ssh ethan@mini 'bash -s' < scripts/smoke.sh     # on the host itself (http://127.0.0.1:3000)
SMOKE_API_KEY=bat_... scripts/smoke.sh --ssh    # + authenticated read-only checks
```

Checks: `/healthz` ok + version, `/api/config`, `/`, `/signup` and its entry script, `/theme-init.js`,
CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `X-Frame-Options`,
`nosniff`, `Referrer-Policy`, HSTS (`--no-hsts` for a development server), anonymous `/api/me` and
an unknown `/api` route → JSON 401 (every `/api` route except `/api/auth/*` and `/api/config` is
private), `/mcp` without or with a bad key → 401 with `WWW-Authenticate: Bearer`. With
`SMOKE_API_KEY`: `/api/me`, an unknown `/api` route → 404 JSON, and MCP `tools/list`. Nothing is
written.

## Logs and service control

```bash
ssh ethan@mini
journalctl --user -u baton -f                  # app logs (JSON lines, pino)
journalctl --user -u baton --since today -o cat | grep '"level":50'   # errors
journalctl --user -u baton-tunnel -f
systemctl --user status baton baton-tunnel
systemctl --user restart baton
systemctl --user reset-failed baton            # after 10 crashes in 5 min systemd stops retrying
```

For readable logs: `journalctl --user -u baton -o cat | ~/apps/baton-releases/current/node_modules/.bin/pino-pretty`.

## Configuration (`~/.config/baton/baton.env`)

Edit on the host, then `systemctl --user restart baton`. The file is read by systemd and by
`node --env-file`: plain `KEY=value`, no `export`, double quotes around values with spaces or `<>`.
`NODE_ENV=production` and `HOST=127.0.0.1` come from the unit; don't set them here. All variables
are documented in `.env.example` at the repo root.

**Email (SMTP).** Needed so people other than the owner can finish sign-up and password resets:

```
SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465     # URL-encode special characters
MAIL_FROM="Baton <baton@example.com>"
```

**Google sign-in.** Google Cloud console → APIs & Services → Credentials → OAuth client ID → Web
application. Authorized JavaScript origin: `<BASE_URL>`; authorized redirect URI, exactly:

```
<BASE_URL>/api/auth/callback/google          e.g. https://baton.example.com/api/auth/callback/google
```

then `GOOGLE_CLIENT_ID=…` and `GOOGLE_CLIENT_SECRET=…`.

**GitHub sign-in.** GitHub → Settings → Developer settings → OAuth Apps → New. Homepage URL
`<BASE_URL>`; Authorization callback URL, exactly:

```
<BASE_URL>/api/auth/callback/github          e.g. https://baton.example.com/api/auth/callback/github
```

then `GITHUB_CLIENT_ID=…` and `GITHUB_CLIENT_SECRET=…`. Set both values of a provider or neither
(the server refuses to start otherwise). OAuth needs the public https `BASE_URL`, so set up the
tunnel first. A provider's buttons appear once both variables are set and the service restarted.

**BETTER_AUTH_SECRET** signs sessions. Changing it signs everyone out; never commit it.
**BASE_URL** must be the exact origin people use (scheme + host, no trailing slash); it is used for
CSRF checks, OAuth callbacks, email links and MCP URLs.

## Cloudflare Tunnel

Requires a Cloudflare account with the domain's zone. Run on the host (not yet done for the mini):

```bash
ssh ethan@mini
~/apps/baton/scripts/cloudflare-tunnel.sh baton.example.com
```

(or from a dev machine: `ssh -t ethan@mini 'bash -s -- baton.example.com' < scripts/cloudflare-tunnel.sh`).

The script:

1. downloads the latest `cloudflared-linux-amd64` release to `~/.local/bin/cloudflared`, verified
   against the SHA-256 GitHub publishes for the asset (`--upgrade` to update later);
2. runs `cloudflared tunnel login` if `~/.cloudflared/cert.pem` is missing. **It prints a URL: the
   account owner opens it, signs in to Cloudflare and selects the zone.** The command waits for
   that and saves `cert.pem`;
3. creates the tunnel `baton` (`--tunnel-name` to change) unless it exists;
   credentials go to `~/.cloudflared/<tunnel-id>.json`;
4. `cloudflared tunnel route dns baton <hostname>`: a proxied CNAME to `<id>.cfargotunnel.com`
   (`--overwrite-dns` replaces an existing record);
5. writes `~/.cloudflared/config.yml` (an existing file not written by Baton is backed up first)
   and validates it:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/ethan/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: <hostname>
       service: http://127.0.0.1:3000
     - service: http_status:404
   ```
6. sets `BASE_URL=https://<hostname>` and `TRUST_PROXY=cloudflare` in `baton.env` (a timestamped
   backup of the file is kept next to it);
7. restarts `baton.service` and enables + starts `baton-tunnel.service`.

Then run `scripts/smoke.sh https://<hostname>` and register the OAuth callback URLs above.
`TRUST_PROXY=cloudflare` is only safe because Baton listens on 127.0.0.1: nothing but the tunnel
can reach it to set `CF-Connecting-IP`. Optional hardening in the Cloudflare dashboard: "Always
Use HTTPS", and a Cloudflare Access policy if the instance should not be public at all (note that
agents calling `/mcp` would then need Access service tokens).

To remove the tunnel: `systemctl --user disable --now baton-tunnel`, `cloudflared tunnel delete
baton`, delete the DNS record, and set `BASE_URL`/`TRUST_PROXY` back.

## Backups and restore

The app backs itself up (SPEC §5): daily at 03:30 host time it writes
`~/.local/share/baton/backups/baton-YYYYMMDD.db` with `VACUUM INTO` (the newest 14 are kept) and
copies new upload files into `backups/uploads/`. Every deploy also writes
`backups/pre-deploy/baton-<release id>.db` before migrating (newest 5 kept).

`backups/uploads/` follows the snapshots' retention: the same daily job deletes a mirrored file
once `uploads/` no longer has it (purged from Trash, a replaced avatar, a deleted account) and no
retained daily or pre-deploy snapshot has an attachment pointing at it. So every retained
snapshot can still be restored with its files, and a file deleted in the app leaves the mirror
about 14 days later. If any snapshot can't be opened, nothing is pruned that day and the journal
shows a warning (`old upload files were kept`).

These backups live on the same disk. For an off-site copy, pull them from another machine, e.g. a
daily scheduled task on the dev machine:

```bash
rsync -a --delete ethan@mini:.local/share/baton/backups/ ~/baton-backups/
```

(or `rclone copy` to object storage from a user timer on the host). The snapshots are complete,
consistent SQLite files; `uploads/` files are immutable once written. With `--delete` the copy
follows the host's retention (old snapshots and pruned files go); drop it to keep everything.

**Restore** (on the host):

```bash
systemctl --user stop baton
cd ~/.local/share/baton
mkdir -p ../baton-before-restore && cp -a baton.db* uploads ../baton-before-restore/   # safety copy
cp backups/baton-20260925.db baton.db          # or backups/pre-deploy/baton-<id>.db
rm -f baton.db-wal baton.db-shm                # stale WAL files would be replayed onto the snapshot
cp -an backups/uploads/. uploads/              # bring back files that are missing
systemctl --user start baton
curl -s 127.0.0.1:3000/healthz
```

Restoring an older snapshot loses everything written after it. If the snapshot predates a
migration, the server applies the pending migrations at startup. Upload files newer than the
snapshot stay on disk as orphans and are cleaned up by the daily purge job. Remove
`~/.local/share/baton-before-restore` once satisfied.

## Rollback

```bash
scripts/deploy.sh --rollback      # current <-> previous, restart, health check
scripts/deploy.sh <older sha|tag> # or deploy any older commit as a new release
```

`--rollback` swaps the `current` and `previous` symlinks, so running it twice returns to where you
started. It does **not** revert database migrations. Baton's migrations are forward-only; most are
additive and the older code keeps working. If a deploy's migration broke the older code, restore the
pre-deploy snapshot taken just before that migration (`backups/pre-deploy/baton-<id>.db`, where
`<id>` is the release that migrated), following the restore steps above, accepting the loss of
writes made since that deploy.

A deploy whose new release fails its health check rolls back automatically (step 7 of Deploy).

## Updating Node

`deploy.sh` (plain deploys) never changes Node. `scripts/deploy.sh --install` installs the newest
Node 24 LTS whenever it differs from the installed one (side by side in `~/.local/lib/nodejs/`,
then `~/.local/node` is switched; the running service keeps its binary until restarted). Follow it
with `scripts/deploy.sh --force` so the release is rebuilt and restarted on the new Node. Pin a
version with `NODE_VERSION=v24.x.y` in the host's environment. Old versions in
`~/.local/lib/nodejs/` can be deleted afterwards.
