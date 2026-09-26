#!/usr/bin/env bash
# Deploys Baton to the always-on Linux box from a dev machine (SPEC §7, docs/DEPLOY.md).
#
#   scripts/deploy.sh [REF]        deploy REF (branch on origin, tag or commit; default: main)
#   scripts/deploy.sh --force REF  rebuild and restart even if REF is already live
#   scripts/deploy.sh --install    first install / repair (Node, clone, env, units), then deploy
#   scripts/deploy.sh --rollback   switch back to the previous release
#   scripts/deploy.sh --status     releases, service state and /healthz
#
# What a deploy does on the host (scripts/install-mini.sh deploy):
#   git fetch + reset ~/apps/baton to REF -> export it into a new release directory -> npm ci ->
#   npm run build -> DB snapshot -> npm run db:migrate -> switch `current` -> systemctl --user
#   restart baton -> wait for /healthz. A failed build or migration aborts before the switch, so
#   the running release keeps serving; a release that fails its health check is rolled back.
#
# The REF must be pushed to GitHub first: the host fetches it from origin. This script streams
# the local scripts/install-mini.sh and deploy/ to the host, so the tooling in your checkout runs.
#
# Environment: BATON_HOST (default ethan@mini).
set -Eeuo pipefail

HOST="${BATON_HOST:-ethan@mini}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}"; }

cmd=deploy
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) cmd=install; shift ;;
    --rollback) cmd=rollback; shift ;;
    --status) cmd=status; shift ;;
    --force) args+=(--force); shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) args+=(--ref "$1"); shift ;;
  esac
done

if [[ "$cmd" == deploy || "$cmd" == install ]]; then
  ref="main"
  for ((i = 0; i < ${#args[@]}; i++)); do [[ "${args[$i]}" == --ref ]] && ref="${args[$((i + 1))]}"; done
  # Warn when the ref differs from what is on GitHub (the host can only deploy pushed commits).
  if git -C "$ROOT" rev-parse --verify --quiet "refs/remotes/origin/$ref" >/dev/null; then
    git -C "$ROOT" fetch --quiet origin "$ref" 2>/dev/null || true
    local_sha="$(git -C "$ROOT" rev-parse --verify --quiet "refs/heads/$ref" 2>/dev/null || true)"
    remote_sha="$(git -C "$ROOT" rev-parse "refs/remotes/origin/$ref")"
    if [[ -n "$local_sha" && "$local_sha" != "$remote_sha" ]]; then
      echo "note: local $ref (${local_sha:0:10}) differs from origin/$ref (${remote_sha:0:10}); deploying origin/$ref" >&2
    fi
  fi
fi

# Quote the remote arguments for the remote shell.
remote_args="$(printf ' %q' "$cmd" "${args[@]}")"

echo "==> $HOST: install-mini.sh$remote_args"
# Ship the tooling as a small tarball and run it from a temporary directory on the host.
tar -C "$ROOT" -czf - scripts/install-mini.sh deploy |
  "${SSH[@]}" "$HOST" "set -e
    tmp=\$(mktemp -d)
    trap 'rm -rf \"\$tmp\"' EXIT
    tar -xzf - -C \"\$tmp\"
    bash \"\$tmp/scripts/install-mini.sh\"$remote_args"
