#!/usr/bin/env bash
# Publishes Baton through a Cloudflare Tunnel (SPEC §7, docs/DEPLOY.md). Runs ON the host as the
# service user after scripts/install-mini.sh; no sudo, no open ports.
#
#   scripts/cloudflare-tunnel.sh <hostname>          e.g. baton.example.com (a zone on your account)
#   scripts/cloudflare-tunnel.sh --download-only     only install/upgrade cloudflared
#
# Options:
#   --tunnel-name NAME   tunnel name (default baton)
#   --overwrite-dns      replace an existing DNS record for <hostname>
#   --upgrade            re-download cloudflared even if it is installed
#
# Steps (each is skipped when already done, so re-running is safe):
#   1. download cloudflared (latest GitHub release, SHA-256 verified) to ~/.local/bin/cloudflared
#   2. `cloudflared tunnel login`: prints a URL the Cloudflare account owner must open to authorize
#      this machine for a zone; waits until that happens and saves ~/.cloudflared/cert.pem
#   3. create the tunnel (credentials in ~/.cloudflared/<tunnel-id>.json)
#   4. route DNS: a proxied CNAME <hostname> -> <tunnel-id>.cfargotunnel.com
#   5. write ~/.cloudflared/config.yml: <hostname> -> http://127.0.0.1:<PORT from baton.env>
#   6. set BASE_URL=https://<hostname> and TRUST_PROXY=cloudflare in ~/.config/baton/baton.env
#   7. enable + start baton-tunnel.service and restart baton.service
set -Eeuo pipefail
umask 077

TUNNEL_NAME=baton
HOSTNAME_ARG=""
OVERWRITE_DNS=0
UPGRADE=0
DOWNLOAD_ONLY=0
BIN="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
CF_DIR="$HOME/.cloudflared"
CONFIG="$CF_DIR/config.yml"
ENV_FILE="$HOME/.config/baton/baton.env"
MARKER="# Managed by Baton scripts/cloudflare-tunnel.sh"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel-name) TUNNEL_NAME="${2:?}"; shift 2 ;;
    --overwrite-dns) OVERWRITE_DNS=1; shift ;;
    --upgrade) UPGRADE=1; shift ;;
    --download-only) DOWNLOAD_ONLY=1; shift ;;
    -h | --help) sed -n '2,23p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) HOSTNAME_ARG="$1"; shift ;;
  esac
done

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die "this script targets Linux x86_64"
[[ "$(id -u)" -ne 0 ]] || die "run as the service user, not root"
for c in curl sha256sum sed grep jq systemctl; do command -v "$c" >/dev/null || die "'$c' is required"; done

# --- 1. cloudflared ------------------------------------------------------------------------------
install_cloudflared() {
  if [[ -x "$BIN" && "$UPGRADE" != 1 ]]; then
    log "cloudflared present: $("$BIN" --version 2>/dev/null | head -n 1)"
    return
  fi
  local asset=cloudflared-linux-amd64 tag expected tmp release
  local filter='.assets[] | select(.name == "'"$asset"'") | .digest // empty'
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    release="$(gh api repos/cloudflare/cloudflared/releases/latest)"
  else
    release="$(curl -fsSL https://api.github.com/repos/cloudflare/cloudflared/releases/latest)"
  fi
  command -v jq >/dev/null || die "'jq' is required to read the GitHub release metadata"
  tag="$(jq -r '.tag_name // empty' <<<"$release")"
  [[ -n "$tag" ]] || die "could not find the latest cloudflared release"
  # The asset's SHA-256 as published by GitHub ("digest"), else the checksum list in the notes.
  expected="$(jq -r "$filter" <<<"$release" | grep -o '^sha256:[0-9a-f]\{64\}$' | cut -d: -f2 || true)"
  if [[ -z "$expected" ]]; then
    expected="$(jq -r '.body // empty' <<<"$release" | grep -o "$asset: *[0-9a-f]\{64\}" | head -n 1 | grep -o '[0-9a-f]\{64\}$' || true)"
  fi
  [[ -n "$expected" ]] || die "no published SHA-256 for $asset $tag; refusing to install unverified"
  log "Downloading cloudflared $tag"
  tmp="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$tmp/$asset" "https://github.com/cloudflare/cloudflared/releases/download/$tag/$asset"
  echo "$expected  $tmp/$asset" | sha256sum -c --status - || { rm -rf "$tmp"; die "checksum mismatch for $asset $tag"; }
  mkdir -p "$(dirname "$BIN")"
  install -m 755 "$tmp/$asset" "$BIN.tmp"
  mv -f "$BIN.tmp" "$BIN"
  rm -rf "$tmp"
  log "Installed $BIN ($("$BIN" --version | head -n 1)), checksum ${expected:0:16}... verified"
}

install_cloudflared
((DOWNLOAD_ONLY)) && exit 0

[[ -n "$HOSTNAME_ARG" ]] || die "usage: cloudflare-tunnel.sh <hostname>   (e.g. baton.example.com)"
[[ "$HOSTNAME_ARG" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
  die "'$HOSTNAME_ARG' is not a hostname (no scheme or path, e.g. baton.example.com)"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found; run scripts/install-mini.sh first"
[[ -f "$HOME/.config/systemd/user/baton-tunnel.service" ]] ||
  die "baton-tunnel.service is not installed; run scripts/install-mini.sh first"
PORT="$(sed -n 's/^PORT="\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p' "$ENV_FILE" | tail -n 1)"
PORT="${PORT:-3000}"
mkdir -p "$CF_DIR"
chmod 700 "$CF_DIR"

# --- 2. login ------------------------------------------------------------------------------------
if [[ ! -f "$CF_DIR/cert.pem" ]]; then
  log "Authorizing this machine with Cloudflare."
  log "Open the URL printed below in a browser signed in to the Cloudflare account that owns"
  log "the zone of $HOSTNAME_ARG, and pick that zone. This command waits until you do."
  "$BIN" tunnel login
  [[ -f "$CF_DIR/cert.pem" ]] || die "login did not produce $CF_DIR/cert.pem"
else
  log "Already logged in ($CF_DIR/cert.pem)"
fi

# --- 3. tunnel -----------------------------------------------------------------------------------
tunnel_id() {
  "$BIN" tunnel list --name "$TUNNEL_NAME" --output json 2>/dev/null |
    grep -o '"id": *"[0-9a-f-]\{36\}"' | head -n 1 | grep -o '[0-9a-f-]\{36\}' || true
}
ID="$(tunnel_id)"
if [[ -z "$ID" ]]; then
  log "Creating tunnel '$TUNNEL_NAME'"
  "$BIN" tunnel create "$TUNNEL_NAME"
  ID="$(tunnel_id)"
  [[ -n "$ID" ]] || die "tunnel '$TUNNEL_NAME' was not created"
else
  log "Tunnel '$TUNNEL_NAME' exists ($ID)"
fi
CREDS="$CF_DIR/$ID.json"
[[ -f "$CREDS" ]] || die "credentials $CREDS missing (tunnel created on another machine?): delete it with 'cloudflared tunnel delete $TUNNEL_NAME' and re-run"
chmod 600 "$CREDS"

# --- 4. DNS --------------------------------------------------------------------------------------
log "Routing DNS $HOSTNAME_ARG -> tunnel $TUNNEL_NAME"
dns_args=(tunnel route dns)
((OVERWRITE_DNS)) && dns_args+=(--overwrite-dns)
if ! out="$("$BIN" "${dns_args[@]}" "$TUNNEL_NAME" "$HOSTNAME_ARG" 2>&1)"; then
  echo "$out" >&2
  if grep -qi 'already exists' <<<"$out"; then
    warn "a DNS record for $HOSTNAME_ARG already exists; if it doesn't point at this tunnel, re-run with --overwrite-dns"
  else
    die "DNS routing failed"
  fi
else
  echo "$out"
fi

# --- 5. config.yml -------------------------------------------------------------------------------
if [[ -f "$CONFIG" ]] && ! grep -qF "$MARKER" "$CONFIG"; then
  backup="$CONFIG.bak-$(date +%Y%m%d%H%M%S)"
  cp -p "$CONFIG" "$backup"
  warn "an existing $CONFIG (not written by Baton) was saved as $backup"
fi
cat >"$CONFIG.tmp" <<EOF
$MARKER
tunnel: $ID
credentials-file: $CREDS
ingress:
  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF
mv -f "$CONFIG.tmp" "$CONFIG"
"$BIN" tunnel --config "$CONFIG" ingress validate
log "Wrote $CONFIG"

# --- 6. env file ---------------------------------------------------------------------------------
set_env() { # set_env KEY VALUE: replace every KEY= line, or append one
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}
cp -p "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
set_env BASE_URL "https://$HOSTNAME_ARG"
set_env TRUST_PROXY cloudflare
chmod 600 "$ENV_FILE"
log "Updated $ENV_FILE: BASE_URL=https://$HOSTNAME_ARG, TRUST_PROXY=cloudflare"

# --- 7. services ---------------------------------------------------------------------------------
systemctl --user daemon-reload
systemctl --user restart baton.service
systemctl --user enable --now baton-tunnel.service
systemctl --user restart baton-tunnel.service
for _ in $(seq 1 30); do
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
log "baton: $(systemctl --user is-active baton.service), baton-tunnel: $(systemctl --user is-active baton-tunnel.service)"
log "Check https://$HOSTNAME_ARG/healthz (DNS can take a minute), then from a dev machine:"
log "  scripts/smoke.sh https://$HOSTNAME_ARG"
log "OAuth callback URLs: https://$HOSTNAME_ARG/api/auth/callback/google and .../github"
