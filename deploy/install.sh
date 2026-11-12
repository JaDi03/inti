#!/usr/bin/env bash
# Installs or updates an Inti server: the web app, its API and HTTPS, on one domain.
# From the folder you cloned, the same command installs, updates and applies new settings:
#   sudo bash deploy/install.sh
set -euo pipefail

APP=/opt/inti
CONF=/etc/inti
SETTINGS=$CONF/inti.env
DATA=/var/lib/inti
KEY_FILE=$DATA/inti-key.json
PORT=8787
NODE_VERSION=24.22.2
# sha256 of node-v24.22.2-linux-x64.tar.xz from nodejs.org/dist/v24.22.2/SHASUMS256.txt. It lives
# here, not downloaded next to the tarball, so a changed download cannot change both.
NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run it with sudo: sudo bash deploy/install.sh"
command -v apt-get >/dev/null || fail "this script needs Debian or Ubuntu (apt-get)"
command -v systemctl >/dev/null || fail "this script needs systemd"
[ "$(uname -m)" = x86_64 ] || fail "this script installs the x64 build of Node; this server is $(uname -m)"

SRC=$(cd "$(dirname "$0")/.." && pwd)

# Run from a clone: bring it up to date first, then run its new copy of this script.
if [ "$SRC" != "$APP" ] && [ -z "${INTI_CLONE_UPDATED:-}" ]; then
  runuser -u "$(stat -c %U "$SRC")" -- git -C "$SRC" pull -q --ff-only ||
    fail "could not update $SRC with git pull"
  INTI_CLONE_UPDATED=1 exec bash "$SRC/deploy/install.sh"
fi

# The value of KEY in an env file, without quotes or a Windows line end; empty if missing.
get() {
  sed -n "s/^$2=//p" "$1" | tail -n 1 | tr -d '\r' | sed -E "s/^['\"]//; s/['\"]\$//"
}

# Writes KEY=VALUE in an env file, replacing the line if it is there.
put() {
  python3 - "$1" "$2" "$3" <<'PY'
import pathlib, sys
path, key, value = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = [line for line in path.read_text().splitlines() if not line.startswith(key + "=")]
path.write_text("\n".join(lines + [f"{key}={value}"]) + "\n")
PY
}

# Runs a command as inti, from a folder it can read, with no secret in its environment.
as_inti() {
  (cd / && runuser -u inti -- env -i HOME="$DATA" PATH=/usr/local/bin:/usr/bin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@")
}

# A new .env next to the code is installed; without one, the installed settings are kept.
NEW=""
if [ "$SRC" != "$APP" ] && [ -f "$SRC/.env" ]; then
  NEW=$SRC/.env
elif [ ! -f "$SETTINGS" ]; then
  fail "copy .env.example to .env in $SRC, fill it in, and run this again"
fi
FROM=${NEW:-$SETTINGS}

missing=()
for key in INTI_SITE NEAR_INTENTS_AGENT_API_KEY NEAR_AI_API_KEY PRIVY_APP_ID PRIVY_VERIFICATION_KEY; do
  [ -n "$(get "$FROM" "$key")" ] || missing+=("$key")
done
[ ${#missing[@]} -eq 0 ] || fail "fill in ${missing[*]} in $FROM, then run this again"

site=$(get "$FROM" INTI_SITE)
[[ $site =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
  fail "INTI_SITE must be a domain like your-domain.com (no https://, no path), got: $site"
public="https://$site"
if [ -f /etc/caddy/Caddyfile ] && grep -qE "^[[:space:]]*${site//./\\.}[[:space:]]*\{" /etc/caddy/Caddyfile; then
  fail "/etc/caddy/Caddyfile already has a block for $site: remove it, the install adds its own"
fi
agent_api=$(get "$FROM" NEAR_INTENTS_AGENT_API_URL)
agent_api=${agent_api:-https://api.demo.agentsonintents.com}
agent_api_host=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).hostname or "")' "$agent_api")
[ -n "$agent_api_host" ] || fail "NEAR_INTENTS_AGENT_API_URL is not a URL: $agent_api"

say "1/6 Tools"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl xz-utils ca-certificates gpg \
  debian-keyring debian-archive-keyring apt-transport-https python3 >/dev/null
# Node from nodejs.org, checked against the pinned sha256.
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  file="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file"
  (cd "$tmp" && echo "$NODE_SHA256  $file" | sha256sum -c --quiet -) || fail "the Node download does not match its checksum"
  tar -xJf "$tmp/$file" -C /opt
  rm -rf "$tmp"
  for bin in node npm npx corepack; do
    ln -sf "/opt/node-v$NODE_VERSION-linux-x64/bin/$bin" "/usr/local/bin/$bin"
  done
fi
# pnpm at the exact version in package.json (packageManager), through corepack.
corepack enable --install-directory /usr/local/bin pnpm
# Caddy from its official apt repository (caddyserver.com/docs/install).
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
fi
echo "node $(node -v), pnpm $(cd "$SRC" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm -v), $(caddy version | cut -d' ' -f1)"

say "2/6 Code"
id inti >/dev/null 2>&1 ||
  useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin inti
install -d -m 700 -o inti -g inti "$DATA"
# A key and grants restored from another server belong to the agent too.
[ -f "$KEY_FILE" ] && chown inti:inti "$KEY_FILE" && chmod 600 "$KEY_FILE"
[ -f "$DATA/grants.json" ] && chown inti:inti "$DATA/grants.json" && chmod 600 "$DATA/grants.json"
# The installed code follows the branch of the folder this runs from.
branch=$(git -c safe.directory='*' -C "$SRC" rev-parse --abbrev-ref HEAD)
if [ ! -d "$APP/.git" ]; then
  repo=$(git -c safe.directory='*' -C "$SRC" remote get-url origin)
  install -d -m 755 -o inti -g inti "$APP"
  as_inti git clone -q --branch "$branch" "$repo" "$APP"
fi
as_inti git -C "$APP" fetch -q origin
as_inti git -C "$APP" checkout -q -B "$branch" "origin/$branch"
as_inti bash -c "cd $APP && pnpm install --frozen-lockfile --silent"
echo "$branch at $(as_inti git -C "$APP" rev-parse --short HEAD)"

say "3/6 Settings"
install -d -m 750 -o root -g inti "$CONF"
if [ -n "$NEW" ]; then
  # moved, not copied: no second file with the keys is left in the clone
  tr -d '\r' < "$NEW" > "$SETTINGS.tmp"
  install -m 640 -o root -g inti "$SETTINGS.tmp" "$SETTINGS"
  rm -f "$SETTINGS.tmp" "$NEW"
  echo "Settings moved to $SETTINGS. To change them, edit that file and run this again."
fi
KEY_CREATED=0
if [ ! -f "$KEY_FILE" ]; then
  as_inti bash -c "cd $APP && pnpm -s new-key $KEY_FILE" >/dev/null
  KEY_CREATED=1
fi
public_key=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["publicKey"])' "$KEY_FILE")
[ -n "$(get "$SETTINGS" SERVER_GRANT_KEY)" ] || put "$SETTINGS" SERVER_GRANT_KEY "$(head -c 32 /dev/urandom | base64)"
# Everything below follows from the domain and this server's layout.
put "$SETTINGS" NEAR_INTENTS_AGENT_API_URL "$agent_api"
put "$SETTINGS" INTI_AGENT_API_HOST "$agent_api_host"
put "$SETTINGS" INTI_API_URL "$public"
put "$SETTINGS" INTI_KEY_PUBLIC "$public_key"
put "$SETTINGS" SERVER_ALLOWED_ORIGINS "$public"
put "$SETTINGS" SERVER_HOST 127.0.0.1
put "$SETTINGS" SERVER_PORT "$PORT"
put "$SETTINGS" SERVER_TRUSTED_PROXY 127.0.0.1
put "$SETTINGS" SERVER_GRANT_FILE "$DATA/grants.json"
put "$SETTINGS" SERVER_INTI_KEY_FILE "$KEY_FILE"
chown root:inti "$SETTINGS"
chmod 640 "$SETTINGS"

say "4/6 Web app"
# Only the public values reach the build; the server's keys never do. The page in use stays up
# while it builds.
build_log=$(mktemp)
as_inti env PRIVY_APP_ID="$(get "$SETTINGS" PRIVY_APP_ID)" INTI_KEY_PUBLIC="$public_key" \
  INTI_API_URL="$public" INTI_AGENT_API_HOST="$agent_api_host" \
  bash -c "cd $APP && pnpm -s web:build" > "$build_log" 2>&1 ||
  { tail -n 30 "$build_log"; rm -f "$build_log"; fail "the web app did not build"; }
grep -E 'built in' "$build_log" || true
rm -f "$build_log"

say "5/6 Services"
# Root installs files only from the clone this runs from, never from the folder inti can write.
install -m 644 "$SRC/deploy/inti-agent.service" /etc/systemd/system/inti-agent.service
systemctl daemon-reload
systemctl enable -q inti-agent
systemctl restart inti-agent
python3 - "$SRC/deploy/Caddyfile" "$SRC/web/security-headers.json" "$site" "$public" > /etc/caddy/inti.caddy.tmp <<'PY'
import json, sys
template, headers_file, site, origin = sys.argv[1:]
headers = json.load(open(headers_file))
lines = []
for name, value in headers.items():
    value = value.replace("{INTI_API_ORIGIN}", origin)
    if '"' in value or "\n" in value:
        sys.exit(f"header {name} has a quote or a line break")
    lines.append(f'\t\t\t{name} "{value}"')
text = open(template).read()
text = "\n".join(line for line in text.splitlines() if not line.startswith("#")) + "\n"
print(text.replace("{SITE}", site).replace("{HEADERS}", "\n".join(lines)).lstrip("\n"), end="")
PY
caddy validate --config /etc/caddy/inti.caddy.tmp --adapter caddyfile >/dev/null 2>&1 || {
  caddy validate --config /etc/caddy/inti.caddy.tmp --adapter caddyfile
  fail "the Caddy configuration is not valid"
}
install -m 644 /etc/caddy/inti.caddy.tmp /etc/caddy/inti.caddy
rm -f /etc/caddy/inti.caddy.tmp
import="import /etc/caddy/inti.caddy"
if grep -q "The Caddyfile is an easy way" /etc/caddy/Caddyfile 2>/dev/null; then
  echo "$import" > /etc/caddy/Caddyfile  # the package's welcome page: replaced
elif ! grep -qxF "$import" /etc/caddy/Caddyfile 2>/dev/null; then
  echo "$import" >> /etc/caddy/Caddyfile  # other sites already there: kept
fi
systemctl enable -q caddy
systemctl reload-or-restart caddy || fail "Caddy did not start: journalctl -u caddy -n 50"

say "6/6 Check"
for _ in $(seq 30); do  # the agent takes a few seconds to start
  curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 1
done
curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null ||
  fail "the agent does not answer: journalctl -u inti-agent -n 50"
for _ in $(seq 60); do  # Caddy may still be getting the HTTPS certificate
  code=$(curl -s -o /dev/null -w '%{http_code}' "$public/api/agent" || true)
  [ "$code" = 401 ] && break
  sleep 1
done
if [ "$code" != 401 ]; then
  echo "warning: $public does not answer yet. Check that $site points to this server and that"
  echo "ports 80 and 443 are open, then: journalctl -u caddy -n 50"
  exit 1
fi
echo "Done. Open $public"
if [ "$KEY_CREATED" = 1 ]; then
  echo
  echo "A new Inti key was created. Users authorize it in the app; keep a copy of it apart from"
  echo "other backups: sudo cat $KEY_FILE"
fi
