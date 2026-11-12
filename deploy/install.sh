#!/usr/bin/env bash
# Installs or updates an Inti server: the web app, its API and HTTPS, on one domain.
# From the folder you cloned, the same command installs, updates and applies new settings:
#   sudo bash deploy/install.sh
#
# Two system users keep install-time code away from the keys:
#   inti-build  owns the code in /opt/inti, installs packages and builds the app. It cannot read
#               the settings or the keys.
#   inti        runs the API. It reads the code, the settings, and its own data in /var/lib/inti.
# Root installs files only from the clone this runs from, never from a folder either user can write.
set -euo pipefail

APP=/opt/inti
CONF=/etc/inti
SETTINGS=$CONF/inti.env
DATA=/var/lib/inti
BUILD_HOME=/var/lib/inti-build
KEY_FILE=$DATA/inti-key.json
GRANT_FILE=$DATA/grants.json
PORT=8787
NODE_VERSION=24.22.2
NODE_DIR=/opt/node-v$NODE_VERSION-linux-x64
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
OWNER=$(stat -c %U "$SRC")
# Root runs this file and installs files from this folder, so it must be the admin's own clone.
case $SRC in "$APP" | "$APP"/*) fail "run this from your own clone, not from $APP" ;; esac
case $OWNER in inti | inti-build) fail "run this from your own clone; $SRC belongs to $OWNER" ;; esac

# Runs git in the clone as its owner, so git never reads a config root does not own.
src_git() { runuser -u "$OWNER" -- git -C "$SRC" "$@"; }

# Bring the clone up to date first, then run its new copy of this script.
if [ -z "${INTI_CLONE_UPDATED:-}" ]; then
  src_git pull -q --ff-only || fail "could not update $SRC with git pull"
  INTI_CLONE_UPDATED=1 exec bash "$SRC/deploy/install.sh"
fi

# The value of KEY in an env file, without quotes or a Windows line end; empty if missing.
get() {
  sed -n "s/^$2=//p" "$1" | tail -n 1 | tr -d '\r' | sed -E "s/^['\"]//; s/['\"]\$//"
}

# Writes KEY=VALUE in an env file, replacing the line if it is there. A value with a line break
# would add a setting of its own, so it is refused.
put() {
  python3 - "$1" "$2" "$3" <<'PY'
import pathlib, sys
path, key, value = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if "\n" in value or "\r" in value:
    sys.exit(f"{key} has a line break")
lines = [line for line in path.read_text().splitlines() if not line.startswith(key + "=")]
path.write_text("\n".join(lines + [f"{key}={value}"]) + "\n")
PY
}

# Runs a command as one of the two users, from a folder it can read, with no secret in its
# environment.
as_user() {
  local user=$1 home=$2
  shift 2
  (cd / && runuser -u "$user" -- env -i HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@")
}
as_build() { as_user inti-build "$BUILD_HOME" "$@"; }
as_inti() { as_user inti "$DATA" "$@"; }

# A new .env next to the code is installed; without one, the installed settings are kept.
NEW=""
if [ -f "$SRC/.env" ]; then
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
# The partner key travels with every call, so only https is accepted.
agent_api_host=$(python3 -c '
import sys, urllib.parse
u = urllib.parse.urlsplit(sys.argv[1])
print(u.hostname if u.scheme == "https" and u.hostname else "")' "$agent_api")
[ -n "$agent_api_host" ] || fail "NEAR_INTENTS_AGENT_API_URL must be an https address, got: $agent_api"

say "1/6 Tools"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl xz-utils ca-certificates gpg \
  debian-keyring debian-archive-keyring apt-transport-https python3 >/dev/null
# Node from nodejs.org, checked against the pinned sha256, owned by root whatever the archive says.
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  file="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file"
  (cd "$tmp" && echo "$NODE_SHA256  $file" | sha256sum -c --quiet -) || fail "the Node download does not match its checksum"
  rm -rf "$NODE_DIR"
  tar --no-same-owner -xJf "$tmp/$file" -C /opt
  chown -R root:root "$NODE_DIR"
  rm -rf "$tmp"
  for bin in node npm npx corepack; do
    ln -sf "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"
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
echo "node $(node -v), $(caddy version | cut -d' ' -f1)"

say "2/6 Code"
id inti >/dev/null 2>&1 ||
  useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin inti
id inti-build >/dev/null 2>&1 ||
  useradd --system --home-dir "$BUILD_HOME" --create-home --shell /usr/sbin/nologin inti-build
install -d -m 700 -o inti -g inti "$DATA"
install -d -m 700 -o inti-build -g inti-build "$BUILD_HOME"
# A key and grants restored from another server are given to inti. The files are opened without
# following links, and only plain files are changed, so a link placed there cannot hand inti a
# file of the system.
python3 - inti "$KEY_FILE" "$GRANT_FILE" <<'PY'
import os, pwd, stat, sys
user = pwd.getpwnam(sys.argv[1])
for path in sys.argv[2:]:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        continue
    except OSError:
        sys.exit(f"{path} is not a plain file")
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            sys.exit(f"{path} is not a plain file")
        if (st.st_uid, st.st_gid) != (user.pw_uid, user.pw_gid):
            os.fchown(fd, user.pw_uid, user.pw_gid)
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
PY
# The installed code follows the branch of the clone this runs from.
branch=$(src_git rev-parse --abbrev-ref HEAD)
if [ ! -d "$APP/.git" ]; then
  repo=$(src_git remote get-url origin)
  install -d -m 755 -o inti-build -g inti-build "$APP"
  as_build git clone -q --branch "$branch" "$repo" "$APP"
fi
as_build git -C "$APP" fetch -q origin
as_build git -C "$APP" checkout -q -B "$branch" "origin/$branch"
as_build bash -c "cd $APP && pnpm install --frozen-lockfile --silent"
echo "$branch at $(as_build git -C "$APP" rev-parse --short HEAD)"

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
  as_inti bash -c "cd $APP && node --import tsx agent/cli/new-key.ts $KEY_FILE" >/dev/null
  KEY_CREATED=1
fi
public_key=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["publicKey"])' "$KEY_FILE")
[[ $public_key =~ ^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$ ]] || fail "$KEY_FILE does not hold an ed25519 public key"
# The key that encrypts the grants is made once, inside python, so it never shows in a command line.
python3 - "$SETTINGS" <<'PY'
import base64, pathlib, secrets, sys
path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
if not any(line.startswith("SERVER_GRANT_KEY=") and line.split("=", 1)[1].strip() for line in lines):
    lines = [line for line in lines if not line.startswith("SERVER_GRANT_KEY=")]
    lines.append("SERVER_GRANT_KEY=" + base64.b64encode(secrets.token_bytes(32)).decode())
    path.write_text("\n".join(lines) + "\n")
PY
# Everything below follows from the domain and this server's layout.
put "$SETTINGS" NEAR_INTENTS_AGENT_API_URL "$agent_api"
put "$SETTINGS" INTI_AGENT_API_HOST "$agent_api_host"
put "$SETTINGS" INTI_API_URL "$public"
put "$SETTINGS" INTI_KEY_PUBLIC "$public_key"
put "$SETTINGS" SERVER_ALLOWED_ORIGINS "$public"
put "$SETTINGS" SERVER_HOST 127.0.0.1
put "$SETTINGS" SERVER_PORT "$PORT"
put "$SETTINGS" SERVER_TRUSTED_PROXY 127.0.0.1
put "$SETTINGS" SERVER_GRANT_FILE "$GRANT_FILE"
put "$SETTINGS" SERVER_INTI_KEY_FILE "$KEY_FILE"
chown root:inti "$SETTINGS"
chmod 640 "$SETTINGS"

say "4/6 Web app"
# Only the public values reach the build; inti-build cannot read the keys at all. The page in use
# stays up while it builds.
build_log=$(mktemp)
as_build env PRIVY_APP_ID="$(get "$SETTINGS" PRIVY_APP_ID)" INTI_KEY_PUBLIC="$public_key" \
  INTI_API_URL="$public" INTI_AGENT_API_HOST="$agent_api_host" \
  bash -c "cd $APP && pnpm -s web:build" > "$build_log" 2>&1 ||
  { tail -n 30 "$build_log"; rm -f "$build_log"; fail "the web app did not build"; }
grep -E 'built in' "$build_log" || true
rm -f "$build_log"

say "5/6 Services"
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
    # Caddy reads braces as placeholders and backslashes as escapes.
    if any(c in value for c in '"\n\r{}\\'):
        sys.exit(f"header {name} has a character Caddy would not keep as text")
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
