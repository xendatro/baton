#!/usr/bin/env bash
# Baton host installer and release manager for the always-on Linux box (SPEC §7, docs/DEPLOY.md).
# Runs ON the host as the service user (no sudo, no root). Idempotent: re-running it is safe.
#
#   install-mini.sh [install] [--ref REF]   first install / repair: Node, repo, dirs, env, units,
#                                           then deploy REF (default: main) if it isn't live yet
#   install-mini.sh deploy [--ref REF] [--force]
#                                           build REF into a new release, migrate, switch, restart,
#                                           health-check; rolls back automatically on failure
#   install-mini.sh rollback                switch back to the previous release and restart
#   install-mini.sh status                  releases, service state and /healthz
#
# Usually driven from a dev machine by scripts/deploy.sh, which streams this script and deploy/
# over ssh. It also works standalone: `ssh ethan@mini 'bash -s' < scripts/install-mini.sh`
# (unit files and the env template then come from the release being deployed).
#
# Layout on the host:
#   ~/.local/node                 -> ~/.local/lib/nodejs/node-vX.Y.Z-linux-x64 (official tarball)
#   ~/apps/baton                  git clone (fetched and reset to the deployed ref)
#   ~/apps/baton-releases/<id>    one built release per deploy (git archive + npm ci + build)
#   ~/apps/baton-releases/current -> active release (baton.service WorkingDirectory)
#   ~/apps/baton-releases/previous-> release that was active before the last switch
#   ~/.local/share/baton          DATA_DIR: baton.db, uploads/, backups/
#   ~/.config/baton/baton.env     environment (mode 600)
#   ~/.config/systemd/user/baton.service, baton-tunnel.service
#
# Overridable with environment variables: BATON_REPO (xendatro/baton), BATON_REF (main),
# NODE_VERSION (e.g. v24.21.0; default: newest Node 24 LTS), BATON_KEEP_RELEASES (3).
set -Eeuo pipefail
umask 077

REPO="${BATON_REPO:-xendatro/baton}"
REF="${BATON_REF:-main}"
NODE_MAJOR=24
NODE_VERSION="${NODE_VERSION:-}"
KEEP_RELEASES="${BATON_KEEP_RELEASES:-3}"
KEEP_PREDEPLOY_SNAPSHOTS=5
HEALTH_TIMEOUT_S=60

APP_DIR="$HOME/apps/baton"
RELEASES_DIR="$HOME/apps/baton-releases"
NODE_LINK="$HOME/.local/node"
NODE_STORE="$HOME/.local/lib/nodejs"
DATA_DIR="$HOME/.local/share/baton"
CONFIG_DIR="$HOME/.config/baton"
ENV_FILE="$CONFIG_DIR/baton.env"
UNIT_DIR="$HOME/.config/systemd/user"
UNITS=(baton.service baton-tunnel.service)

# deploy/ next to this script when it runs from a checkout or a bundle streamed by deploy.sh;
# empty when piped through `bash -s` (then the release's own deploy/ is used).
SCRIPT_DEPLOY_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy"
  [[ -f "$candidate/baton.service" ]] && SCRIPT_DEPLOY_DIR="$candidate"
fi

export PATH="$NODE_LINK/bin:$PATH"

# --- helpers ------------------------------------------------------------------------------------
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
# Unexpected failures (set -e) name the command; die() prints its own message.
trap 'rc=$?; [[ $BASH_SUBSHELL -eq 0 ]] && printf "\033[1;31merror:\033[0m %s failed (line %s, exit %s)\n" "${BASH_COMMAND}" "${LINENO}" "$rc" >&2' ERR

need() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "'$c' is required but not installed"; done
}

# Last PORT= value from the env file (default 3000).
app_port() {
  local port=""
  [[ -f "$ENV_FILE" ]] && port="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*"\{0,1\}\([0-9]\{1,5\}\)"\{0,1\}[[:space:]]*$/\1/p' "$ENV_FILE" | tail -n 1)"
  echo "${port:-3000}"
}

port_in_use() { [[ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]]; }

healthz() { curl -fsS --max-time 5 "http://127.0.0.1:$(app_port)/healthz" 2>/dev/null; }

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) body
  while ((SECONDS < deadline)); do
    if body="$(healthz)" && [[ "$body" == *'"ok":true'* ]]; then
      echo "$body"
      return 0
    fi
    if systemctl --user is-failed --quiet baton.service; then break; fi
    sleep 1
  done
  return 1
}

release_of() { # symlink name -> release directory name (empty if missing)
  local link="$RELEASES_DIR/$1"
  [[ -L "$link" ]] && basename "$(readlink "$link")" || true
}

set_link() { # set_link <name> <release id>: atomic symlink switch
  ln -sfn "$2" "$RELEASES_DIR/.$1.tmp"
  mv -Tf "$RELEASES_DIR/.$1.tmp" "$RELEASES_DIR/$1"
}

# --- preflight ----------------------------------------------------------------------------------
preflight() {
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die "this installer targets Linux x86_64"
  [[ "$(id -u)" -ne 0 ]] || die "run as the service user, not root"
  need curl tar xz sha256sum git gh openssl systemctl ss flock sed awk
  systemctl --user show-environment >/dev/null 2>&1 ||
    die "systemd --user is not reachable (is XDG_RUNTIME_DIR set? try: export XDG_RUNTIME_DIR=/run/user/\$(id -u))"
  if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]]; then
    warn "lingering is not enabled for $(id -un): the service stops when you log out (loginctl enable-linger)"
  fi
}

# --- Node ---------------------------------------------------------------------------------------
resolve_node_version() {
  if [[ -n "$NODE_VERSION" ]]; then
    [[ "$NODE_VERSION" == v* ]] || NODE_VERSION="v$NODE_VERSION"
    return
  fi
  # Newest v24 release that is marked LTS in the official index.
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json |
    grep -o "\"version\":\"v${NODE_MAJOR}\.[0-9]*\.[0-9]*\"[^}]*\"lts\":\"[^\"]*\"" |
    head -n 1 | sed 's/^"version":"\(v[0-9.]*\)".*/\1/')" || true
  [[ "$NODE_VERSION" =~ ^v${NODE_MAJOR}\.[0-9]+\.[0-9]+$ ]] ||
    die "could not determine the latest Node ${NODE_MAJOR} LTS version (set NODE_VERSION=v24.x.y)"
}

install_node() {
  resolve_node_version
  local current=""
  [[ -x "$NODE_LINK/bin/node" ]] && current="$("$NODE_LINK/bin/node" --version 2>/dev/null || true)"
  if [[ "$current" == "$NODE_VERSION" ]]; then
    log "Node $current already installed in $NODE_LINK"
    return
  fi
  local name="node-${NODE_VERSION}-linux-x64" tmp
  local base="https://nodejs.org/dist/${NODE_VERSION}"
  log "Installing Node $NODE_VERSION into $NODE_STORE/$name${current:+ (replacing $current)}"
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  curl -fsSL --retry 3 -o "$tmp/$name.tar.xz" "$base/$name.tar.xz"
  (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c --status -) ||
    { rm -rf "$tmp"; die "checksum mismatch for $name.tar.xz"; }
  log "Checksum OK ($(grep " $name.tar.xz\$" "$tmp/SHASUMS256.txt" | cut -c1-16)...)"
  mkdir -p "$NODE_STORE"
  rm -rf "${NODE_STORE:?}/$name.partial"
  mkdir "$NODE_STORE/$name.partial"
  tar -xJf "$tmp/$name.tar.xz" -C "$NODE_STORE/$name.partial" --strip-components=1
  rm -rf "$tmp" "${NODE_STORE:?}/$name"
  mv "$NODE_STORE/$name.partial" "$NODE_STORE/$name"
  chmod -R go+rX "$NODE_STORE/$name"
  ln -sfn "$NODE_STORE/$name" "$NODE_LINK.tmp"
  mv -Tf "$NODE_LINK.tmp" "$NODE_LINK"
  log "node $("$NODE_LINK/bin/node" --version), npm $("$NODE_LINK/bin/npm" --version)"
}

# --- repository ---------------------------------------------------------------------------------
setup_repo() {
  mkdir -p "$(dirname "$APP_DIR")"
  if [[ ! -d "$APP_DIR/.git" ]]; then
    [[ ! -e "$APP_DIR" ]] || die "$APP_DIR exists but is not a git clone"
    log "Cloning $REPO into $APP_DIR"
    gh repo clone "$REPO" "$APP_DIR" -- --quiet
  fi
  # Repo-local credential helper, so fetches authenticate through gh without touching the
  # user's global git config.
  git -C "$APP_DIR" config --local --unset-all credential.https://github.com.helper 2>/dev/null || true
  git -C "$APP_DIR" config --local credential.https://github.com.helper ''
  git -C "$APP_DIR" config --local --add credential.https://github.com.helper '!gh auth git-credential'
}

fetch_ref() { # prints the commit sha for REF after fetching
  git -C "$APP_DIR" fetch --quiet --prune --tags origin
  local sha
  if sha="$(git -C "$APP_DIR" rev-parse --verify --quiet "refs/remotes/origin/$REF^{commit}")"; then :
  elif sha="$(git -C "$APP_DIR" rev-parse --verify --quiet "$REF^{commit}")"; then :
  else die "unknown ref '$REF' (not a branch on origin, tag or commit)"; fi
  git -C "$APP_DIR" reset --quiet --hard "$sha"
  echo "$sha"
}

# --- data, config, units ------------------------------------------------------------------------
setup_dirs() {
  mkdir -p "$DATA_DIR" "$CONFIG_DIR" "$RELEASES_DIR" "$UNIT_DIR"
  chmod 700 "$DATA_DIR" "$CONFIG_DIR"
}

deploy_file() { # deploy_file <name> [release dir]: path of a deploy/ file (script's copy wins)
  local f
  for f in ${SCRIPT_DEPLOY_DIR:+"$SCRIPT_DEPLOY_DIR/$1"} ${2:+"$2/deploy/$1"}; do
    [[ -f "$f" ]] && { echo "$f"; return 0; }
  done
  return 1
}

setup_env() { # setup_env [release dir]
  if [[ -f "$ENV_FILE" ]]; then
    chmod 600 "$ENV_FILE"
    log "Keeping existing $ENV_FILE (port $(app_port))"
    return
  fi
  local template port=3000 secret
  template="$(deploy_file baton.env.example "${1:-}")" || die "deploy/baton.env.example not found"
  if port_in_use "$port"; then
    port=3080
    while port_in_use "$port"; do port=$((port + 1)); done
    warn "port 3000 is taken; Baton will listen on $port"
  fi
  secret="$(openssl rand -hex 32)"
  sed -e "s|__DATA_DIR__|$DATA_DIR|" \
    -e "s|__BETTER_AUTH_SECRET__|$secret|" \
    -e "s|^PORT=3000\$|PORT=$port|" \
    -e "s|^BASE_URL=http://localhost:3000\$|BASE_URL=http://localhost:$port|" \
    "$template" >"$ENV_FILE.tmp"
  chmod 600 "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  log "Created $ENV_FILE (mode 600, port $port, generated BETTER_AUTH_SECRET)"
}

install_units() { # install_units [release dir]: copies changed unit files, daemon-reload, enable
  local unit src changed=0
  for unit in "${UNITS[@]}"; do
    src="$(deploy_file "$unit" "${1:-}")" || die "deploy/$unit not found"
    if ! cmp -s "$src" "$UNIT_DIR/$unit"; then
      install -m 644 "$src" "$UNIT_DIR/$unit"
      changed=1
      log "Installed $UNIT_DIR/$unit"
    fi
  done
  ((changed)) && systemctl --user daemon-reload
  systemctl --user is-enabled --quiet baton.service 2>/dev/null || systemctl --user enable --quiet baton.service
  # baton-tunnel.service is enabled by scripts/cloudflare-tunnel.sh once the tunnel exists.
  return 0
}

# --- releases -----------------------------------------------------------------------------------
snapshot_database() { # snapshot_database <release dir> <release id>
  local db="$DATA_DIR/baton.db" dir="$DATA_DIR/backups/pre-deploy"
  [[ -f "$db" ]] || return 0
  mkdir -p "$dir"
  (cd "$1" && node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(process.argv[2]);
    db.close();' "$db" "$dir/baton-$2.db") ||
    die "database snapshot failed; nothing was migrated or switched"
  log "Database snapshot: $dir/baton-$2.db"
  # Keep the newest few pre-deploy snapshots (daily backups are separate: backups/baton-*.db).
  ls -1t "$dir"/baton-*.db 2>/dev/null | tail -n +$((KEEP_PREDEPLOY_SNAPSHOTS + 1)) | xargs -r rm -f --
}

prune_releases() {
  local keep_current keep_previous n=0 dir name
  keep_current="$(release_of current)"
  keep_previous="$(release_of previous)"
  rm -rf "$RELEASES_DIR"/.building-* 2>/dev/null || true
  while IFS= read -r dir; do
    name="$(basename "$dir")"
    [[ "$name" == "$keep_current" || "$name" == "$keep_previous" ]] && continue
    n=$((n + 1))
    if ((n > KEEP_RELEASES - 2)); then
      rm -rf "$dir"
      log "Pruned release $name"
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' | sort -r)
}

restart_and_check() {
  log "Restarting baton.service"
  systemctl --user reset-failed baton.service 2>/dev/null || true
  systemctl --user restart baton.service
  local body
  if body="$(wait_healthy)"; then
    log "Healthy: $body"
    return 0
  fi
  warn "baton.service did not become healthy within ${HEALTH_TIMEOUT_S}s; last log lines:"
  journalctl --user -u baton.service -n 30 --no-pager >&2 || true
  return 1
}

cmd_deploy() {
  local force="${1:-0}" sha short id build current body
  [[ -x "$NODE_LINK/bin/node" ]] || die "Node is not installed; run: install-mini.sh install"
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing; run: install-mini.sh install"
  sha="$(fetch_ref)" || exit 1
  short="${sha:0:10}"
  current="$(release_of current)"
  if [[ "$force" != 1 && -n "$current" && "$current" == *"-$short" ]] && body="$(healthz)"; then
    install_units "$RELEASES_DIR/current"
    log "Already running $short ($current): $body"
    return 0
  fi

  id="$(date -u +%Y%m%d%H%M%S)-$short"
  build="$RELEASES_DIR/.building-$id"
  log "Building release $id ($(git -C "$APP_DIR" log -1 --format='%s' "$sha"))"
  rm -rf "$build"
  mkdir -p "$build"
  git -C "$APP_DIR" archive --format=tar "$sha" | tar -x -C "$build"
  echo "$sha" >"$build/REVISION"
  # Each step is chained with && because `set -e` does not apply inside a `( ... ) ||` subshell.
  # Output goes to build.log in the release; it is shown when a step fails.
  log "npm ci + npm run build (log: $RELEASES_DIR/$id/build.log)"
  if ! (
    cd "$build" &&
      # .npmrc in the repo sets ignore-scripts=true: better-sqlite3 loads its bundled prebuild.
      npm ci --no-audit --no-fund --loglevel=error &&
      npm run build &&
      test -f dist/server/index.js && test -f dist/web/index.html &&
      node -e 'const D = require("better-sqlite3"); new D(":memory:").prepare("select 1").get();'
  ) >"$build/build.log" 2>&1; then
    tail -n 40 "$build/build.log" >&2 || true
    rm -rf "$build"
    die "build of $short failed; the running release (${current:-none}) was left untouched"
  fi
  mv "$build" "$RELEASES_DIR/$id"
  install_units "$RELEASES_DIR/$id"

  snapshot_database "$RELEASES_DIR/$id" "$id"
  log "Applying migrations (npm run db:migrate)"
  (cd "$RELEASES_DIR/$id" && NODE_ENV=production node --env-file="$ENV_FILE" --import tsx server/db/migrate-cli.ts) ||
    die "migrations failed; the running release ($current) was left untouched"

  [[ -n "$current" ]] && set_link previous "$current"
  set_link current "$id"
  if ! restart_and_check; then
    if [[ -n "$current" && -d "$RELEASES_DIR/$current" ]]; then
      warn "rolling back to $current"
      set_link current "$current"
      restart_and_check || warn "the previous release is not healthy either"
      warn "migrations of $id stay applied; to undo them restore $DATA_DIR/backups/pre-deploy/baton-$id.db (docs/DEPLOY.md)"
    fi
    die "deploy of $short failed"
  fi
  prune_releases
  log "Deployed $id"
}

cmd_rollback() {
  local current previous
  current="$(release_of current)"
  previous="$(release_of previous)"
  [[ -n "$previous" && -d "$RELEASES_DIR/$previous" ]] || die "no previous release to roll back to"
  log "Rolling back: $current -> $previous"
  set_link current "$previous"
  set_link previous "$current"
  restart_and_check || die "rolled-back release is not healthy"
  warn "database migrations are not reverted; see docs/DEPLOY.md (Rollback) if the schema changed"
}

cmd_status() {
  local current previous
  current="$(release_of current)"
  previous="$(release_of previous)"
  echo "node:     $("$NODE_LINK/bin/node" --version 2>/dev/null || echo 'not installed')"
  echo "current:  ${current:-none}"
  echo "previous: ${previous:-none}"
  echo "releases: $(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -printf '%f ' 2>/dev/null)"
  echo "port:     $(app_port)"
  echo "service:  $(systemctl --user is-active baton.service 2>/dev/null || true) ($(systemctl --user is-enabled baton.service 2>/dev/null || true))"
  echo "tunnel:   $(systemctl --user is-active baton-tunnel.service 2>/dev/null || true) ($(systemctl --user is-enabled baton-tunnel.service 2>/dev/null || true))"
  echo "healthz:  $(healthz || echo unreachable)"
}

cmd_install() {
  preflight
  install_node
  setup_dirs
  setup_repo
  # The env template and units may come from the release, so resolve the ref first.
  local sha
  sha="$(fetch_ref)" || exit 1
  local tmp_tree=""
  if [[ -z "$SCRIPT_DEPLOY_DIR" ]]; then
    tmp_tree="$(mktemp -d)"
    git -C "$APP_DIR" archive --format=tar "$sha" deploy | tar -x -C "$tmp_tree" 2>/dev/null ||
      die "deploy/ not found at ${sha:0:10}; run the installer from a checkout that has it"
  fi
  setup_env "$tmp_tree"
  install_units "$tmp_tree"
  [[ -n "$tmp_tree" ]] && rm -rf "$tmp_tree"
  cmd_deploy 0
  cmd_status
}

# --- main ---------------------------------------------------------------------------------------
main() {
  local cmd=install force=0
  if [[ $# -gt 0 && "$1" != -* ]]; then
    cmd="$1"
    shift
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
      --force) force=1; shift ;;
      -h | --help) sed -n '2,32p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || true; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  mkdir -p "$RELEASES_DIR"
  # One installer/deploy at a time.
  exec 9>"$RELEASES_DIR/.lock"
  flock -n 9 || die "another install/deploy is running"
  case "$cmd" in
    install) cmd_install ;;
    deploy) preflight; cmd_deploy "$force" ;;
    rollback) preflight; cmd_rollback ;;
    status) cmd_status ;;
    *) die "unknown command: $cmd (install | deploy | rollback | status)" ;;
  esac
}

main "$@"
