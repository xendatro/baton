#!/usr/bin/env bash
# Moves Baton's data from the mini box to the Render service (docs/DEPLOY-RENDER.md).
#
#   scripts/move-to-render.sh RENDER_SSH     e.g. srv-abc123@ssh.oregon.render.com
#
# 1. Stops Baton on the mini box (so nothing is written after the snapshot).
# 2. Takes a consistent snapshot of the database (VACUUM INTO) and packs it with the uploads.
# 3. Streams it into DATA_DIR/import/ on Render (/var/data/import), through this machine.
# The Render server swaps it in at its next start (server/lib/dataImport.ts): restart the service
# in the Render dashboard afterwards. Mini stays stopped; start it again with
# `ssh ethan@mini systemctl --user start baton` if you need to go back.
#
# Needs: SSH access to both (your key added in Render → Account settings → SSH public keys).
# Environment: BATON_HOST (default ethan@mini).
set -Eeuo pipefail

RENDER_SSH="${1:?usage: scripts/move-to-render.sh srv-…@ssh.<region>.render.com}"
HOST="${BATON_HOST:-ethan@mini}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)

echo "==> Checking Render can be reached ($RENDER_SSH)"
"${SSH[@]}" "$RENDER_SSH" 'test -d /var/data && echo "Render disk OK"'

echo "==> Stopping Baton on $HOST and taking a snapshot"
"${SSH[@]}" "$HOST" 'bash -s' <<'REMOTE'
set -Eeuo pipefail
systemctl --user stop baton
DATA="$HOME/.local/share/baton"
OUT="$HOME/.cache/baton-move"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$HOME/apps/baton-releases/current"
"$HOME/.local/node/bin/node" -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  db.prepare("VACUUM INTO ?").run(process.argv[2]);
  db.close();
' "$DATA/baton.db" "$OUT/baton.db"
ln -s "$DATA/uploads" "$OUT/uploads"
echo "Snapshot: $(du -sh "$OUT/baton.db" | cut -f1) database, $(du -sh "$DATA/uploads" | cut -f1) uploads"
REMOTE

echo "==> Streaming it to Render (DATA_DIR/import)"
"${SSH[@]}" "$HOST" 'tar -C "$HOME/.cache/baton-move" -chzf - baton.db uploads' |
  "${SSH[@]}" "$RENDER_SSH" 'rm -rf /var/data/import && mkdir -p /var/data/import && tar -C /var/data/import -xzf - && ls -la /var/data/import'

echo "==> Done. Restart the Render service (dashboard → Manual Deploy → Restart service)."
echo "    It logs 'Imported DATA_DIR/import' on start; the data it replaced stays in /var/data/replaced-*."
