#!/usr/bin/env bash
# Post-deploy smoke checks for Baton (docs/DEPLOY.md). curl only; read-only (no sign-ups, no writes).
#
#   scripts/smoke.sh [BASE_URL]         check a URL (default http://127.0.0.1:3000), e.g. on the
#                                       host itself or the public https://<hostname>
#   scripts/smoke.sh --ssh [USER@HOST]  open an ssh -L tunnel to the host's loopback port (read from
#                                       ~/.config/baton/baton.env) and check through it
#                                       (default host: $BATON_HOST or ethan@mini)
#
# Options / environment:
#   --local-port N     local end of the ssh tunnel (default: $SMOKE_LOCAL_PORT or 13000)
#   --no-hsts          don't require Strict-Transport-Security (a NODE_ENV=development server)
#   SMOKE_API_KEY=bat_...  also call MCP tools/list and GET /api/me with this key (read-only)
#
# Exit status: 0 when every check passes, 1 otherwise.
set -Euo pipefail

BASE_URL=""
SSH_HOST=""
LOCAL_PORT="${SMOKE_LOCAL_PORT:-13000}"
REQUIRE_HSTS=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh)
      SSH_HOST="${BATON_HOST:-ethan@mini}"
      if [[ $# -gt 1 && "$2" != -* ]]; then SSH_HOST="$2"; shift; fi
      shift ;;
    --local-port) LOCAL_PORT="${2:?}"; shift 2 ;;
    --no-hsts) REQUIRE_HSTS=0; shift ;;
    -h | --help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) BASE_URL="${1%/}"; shift ;;
  esac
done

TMP="$(mktemp -d)"
TUNNEL_PID=""
cleanup() {
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null && wait "$TUNNEL_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

if [[ -n "$SSH_HOST" ]]; then
  SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
  remote_port="$("${SSH[@]}" "$SSH_HOST" \
    "sed -n 's/^PORT=\"\\{0,1\\}\\([0-9]*\\)\"\\{0,1\\}\$/\\1/p' ~/.config/baton/baton.env 2>/dev/null | tail -n 1")" || true
  remote_port="${remote_port:-3000}"
  echo "==> ssh tunnel localhost:$LOCAL_PORT -> $SSH_HOST:127.0.0.1:$remote_port"
  "${SSH[@]}" -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$remote_port" "$SSH_HOST" &
  TUNNEL_PID=$!
  BASE_URL="http://127.0.0.1:$LOCAL_PORT"
  for _ in $(seq 1 30); do
    curl -s -o /dev/null --max-time 2 "$BASE_URL/healthz" && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "ssh tunnel failed" >&2; exit 1; }
    sleep 0.5
  done
fi
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
echo "==> smoke checks against $BASE_URL"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m    %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
check() { # check <description> <condition...>
  local what="$1"
  shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}

# fetch <name> <curl args...>: body -> $TMP/<name>.body, headers -> $TMP/<name>.headers,
# status code -> $TMP/<name>.status
fetch() {
  local name="$1"
  shift
  curl -sS --max-time 15 -o "$TMP/$name.body" -D "$TMP/$name.headers" -w '%{http_code}' "$@" \
    >"$TMP/$name.status" 2>"$TMP/$name.err" || echo 000 >"$TMP/$name.status"
}
status() { cat "$TMP/$1.status"; }
header() { # header <name> <header>: value (case-insensitive name, CR stripped)
  grep -i "^$2:" "$TMP/$1.headers" | tail -n 1 | cut -d: -f2- | sed 's/^ *//' | tr -d '\r'
}
body_has() { grep -q -- "$2" "$TMP/$1.body"; }
is() { [[ "$1" == "$2" ]]; }
has() { [[ "$1" == *"$2"* ]]; }
lacks() { [[ "$1" != *"$2"* ]]; }

# 1. Health
fetch health "$BASE_URL/healthz"
check "GET /healthz -> 200" is "$(status health)" 200
check "/healthz reports ok:true" body_has health '"ok":true'
VERSION="$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$TMP/health.body")"
check "/healthz reports a version (${VERSION:-none})" test -n "$VERSION"

# 2. Public config
fetch config "$BASE_URL/api/config"
check "GET /api/config -> 200" is "$(status config)" 200
check "/api/config is JSON with signupsEnabled and providers" \
  bash -c 'grep -q "\"signupsEnabled\":" "$1" && grep -q "\"providers\":" "$1"' _ "$TMP/config.body"
check "/api/config version matches /healthz" body_has config "\"version\":\"$VERSION\""

# 3. SPA: index and a client route (sign-up page), plus its entry script
fetch index "$BASE_URL/"
check "GET / -> 200" is "$(status index)" 200
check "GET / is HTML with the app root" body_has index '<div id="root">'
check "GET / is not cached (Cache-Control: no-cache)" has "$(header index cache-control)" no-cache
fetch signup "$BASE_URL/signup"
check "GET /signup (sign-up page) -> 200 HTML" is "$(status signup):$(has "$(header signup content-type)" text/html && echo html)" 200:html
check "GET /signup serves the SPA shell" body_has signup '<div id="root">'
ENTRY="$(grep -o 'src="/assets/[^"]*\.js"' "$TMP/signup.body" | head -n 1 | sed 's/^src="//; s/"$//')"
if [[ -n "$ENTRY" ]]; then
  fetch entry "$BASE_URL$ENTRY"
  check "GET $ENTRY -> 200 JavaScript" is "$(status entry):$(has "$(header entry content-type)" javascript && echo js)" 200:js
  check "hashed asset is cached immutably" has "$(header entry cache-control)" immutable
else
  bad "entry script not found in /signup"
fi
fetch themeinit "$BASE_URL/theme-init.js"
check "GET /theme-init.js -> 200" is "$(status themeinit)" 200

# 4. Security headers (SPEC §5)
CSP="$(header index content-security-policy)"
check "CSP has default-src 'self'" has "$CSP" "default-src 'self'"
SCRIPT_SRC="$(sed -n 's/.*script-src \([^;]*\).*/\1/p' <<<"$CSP")"
check "CSP script-src is set without 'unsafe-inline' ($SCRIPT_SRC)" \
  bash -c '[[ -n "$1" && "$1" != *unsafe-inline* ]]' _ "$SCRIPT_SRC"
check "CSP frame-ancestors 'none'" has "$CSP" "frame-ancestors 'none'"
check "X-Frame-Options: DENY" is "$(header index x-frame-options)" DENY
check "X-Content-Type-Options: nosniff" is "$(header index x-content-type-options)" nosniff
check "Referrer-Policy: strict-origin-when-cross-origin" is "$(header index referrer-policy)" strict-origin-when-cross-origin
if ((REQUIRE_HSTS)); then
  check "Strict-Transport-Security (production)" has "$(header index strict-transport-security)" max-age=
fi
check "no X-Powered-By header" is "$(header index x-powered-by)" ""

# 5. Auth boundaries: REST and MCP refuse anonymous callers
fetch me "$BASE_URL/api/me"
check "GET /api/me without a session -> 401" is "$(status me)" 401
fetch nope "$BASE_URL/api/definitely-not-a-route"
check "unknown /api route -> 404 JSON" is "$(status nope):$(has "$(header nope content-type)" json && echo json)" 404:json
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"baton-smoke","version":"1"}}}'
fetch mcp -X POST "$BASE_URL/mcp" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' --data "$MCP_INIT"
check "POST /mcp without an API key -> 401" is "$(status mcp)" 401
check "/mcp 401 carries WWW-Authenticate: Bearer" has "$(header mcp www-authenticate)" Bearer
fetch mcpbad -X POST "$BASE_URL/mcp" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer bat_invalidinvalidinvalidinvalidinvalid0000' \
  --data "$MCP_INIT"
check "POST /mcp with an invalid key -> 401" is "$(status mcpbad)" 401

# 6. Optional: authenticated, read-only checks with a real key
if [[ -n "${SMOKE_API_KEY:-}" ]]; then
  fetch meKey "$BASE_URL/api/me" -H "Authorization: Bearer $SMOKE_API_KEY"
  check "GET /api/me with SMOKE_API_KEY -> 200" is "$(status meKey)" 200
  fetch tools -X POST "$BASE_URL/mcp" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $SMOKE_API_KEY" \
    --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  check "MCP tools/list with SMOKE_API_KEY -> 200 listing whoami" \
    bash -c '[[ "$(cat "$1")" == 200 ]] && grep -q "\"whoami\"" "$2"' _ "$TMP/tools.status" "$TMP/tools.body"
fi

echo "==> $PASS passed, $FAIL failed (version ${VERSION:-unknown})"
((FAIL == 0))
