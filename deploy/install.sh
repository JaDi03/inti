#!/usr/bin/env bash
# Installs or updates an Inti server: the web app, its API and HTTPS, on one domain.
# From the folder you cloned, the same command installs, updates and applies new settings:
#   sudo bash deploy/install.sh
#
# What runs where:
#   /opt/inti/releases/<id>  one release, owned by root: the server code of the commit this clone
#                            is on, its packages (installed without running any package script)
#                            and the built web app. /opt/inti/current points to the live one.
#   inti-build               builds the web app in /var/lib/inti-build. It cannot read any key,
#                            and root copies only plain files from what it built.
#   inti                     runs the API from the current release. It reads the settings in
#                            /etc/inti and keeps Inti's key and the grants in /var/lib/inti.
# Root never runs, installs or follows a link in a folder either user can write.
set -euo pipefail
umask 022

APP=/opt/inti
RELEASES=$APP/releases
CURRENT=$APP/current
CONF=/etc/inti
SETTINGS=$CONF/inti.env
DATA=/var/lib/inti
BUILD_HOME=/var/lib/inti-build
STAGE=$BUILD_HOME/src
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
case $SRC in "$APP" | "$APP"/* | "$DATA" | "$DATA"/* | "$BUILD_HOME" | "$BUILD_HOME"/*)
  fail "run this from your own clone, not from $SRC" ;;
esac
case $OWNER in inti | inti-build) fail "run this from your own clone; $SRC belongs to $OWNER" ;; esac

# Runs git in the clone as its owner, so git never reads a config root does not own.
src_git() { runuser -u "$OWNER" -- git -C "$SRC" "$@"; }

# Bring the clone up to date first, then run its new copy of this script. Whoever can push to the
# branch this clone follows decides what runs here as root.
if [ -z "${INTI_CLONE_UPDATED:-}" ]; then
  src_git pull -q --ff-only || fail "could not update $SRC with git pull"
  INTI_CLONE_UPDATED=1 exec bash "$SRC/deploy/install.sh"
fi
# The release is exactly the commit this clone is on, the same one this script came from.
commit=$(src_git rev-parse HEAD)

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

# A new .env next to the code is merged into the installed settings; without one they are kept.
NEW=""
if [ -f "$SRC/.env" ]; then
  NEW=$SRC/.env
elif [ ! -f "$SETTINGS" ]; then
  fail "copy .env.example to .env in $SRC, fill it in, and run this again"
fi

# The value a setting will have: the new .env wins, the installed settings fill the rest.
value() {
  local v=""
  [ -n "$NEW" ] && v=$(get "$NEW" "$1")
  [ -z "$v" ] && [ -f "$SETTINGS" ] && v=$(get "$SETTINGS" "$1")
  printf '%s' "$v"
}

missing=()
for key in INTI_SITE NEAR_INTENTS_AGENT_API_KEY NEAR_AI_API_KEY PRIVY_APP_ID PRIVY_VERIFICATION_KEY; do
  [ -n "$(value "$key")" ] || missing+=("$key")
done
[ ${#missing[@]} -eq 0 ] || fail "fill in ${missing[*]} in ${NEW:-$SETTINGS}, then run this again"

site=$(value INTI_SITE)
[[ $site =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
  fail "INTI_SITE must be a domain like your-domain.com (no https://, no path), got: $site"
public="https://$site"
privy_app_id=$(value PRIVY_APP_ID)
[[ $privy_app_id =~ ^[A-Za-z0-9_-]{1,64}$ ]] || fail "PRIVY_APP_ID does not look like a Privy app id"
agent_api=$(value NEAR_INTENTS_AGENT_API_URL)
agent_api=${agent_api:-https://api.demo.agentsonintents.com}
# The partner key travels with every call, so only https is accepted.
agent_api_host=$(python3 -c '
import sys, urllib.parse
u = urllib.parse.urlsplit(sys.argv[1])
print(u.hostname if u.scheme == "https" and u.hostname else "")' "$agent_api")
[ -n "$agent_api_host" ] || fail "NEAR_INTENTS_AGENT_API_URL must be an https address, got: $agent_api"

say "1/7 Tools"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl xz-utils ca-certificates gpg \
  debian-keyring debian-archive-keyring apt-transport-https python3 iproute2 procps >/dev/null
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

say "2/7 Users and data"
id inti >/dev/null 2>&1 ||
  useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin inti
id inti-build >/dev/null 2>&1 ||
  useradd --system --home-dir "$BUILD_HOME" --create-home --shell /usr/sbin/nologin inti-build
install -d -m 700 -o inti -g inti "$DATA"
install -d -m 700 -o inti-build -g inti-build "$BUILD_HOME"
install -d -m 755 -o root -g root "$APP" "$RELEASES"
# A key and grants restored from another server are given to inti. The files are opened without
# following links or waiting on a pipe, and only plain files are changed, so nothing placed there
# can hand inti a file of the system.
python3 - inti "$KEY_FILE" "$GRANT_FILE" <<'PY'
import os, pwd, stat, sys
user = pwd.getpwnam(sys.argv[1])
for path in sys.argv[2:]:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
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

say "3/7 Settings"
install -d -m 750 -o root -g inti "$CONF"
# Kept until the new release answers, so a failed install can put everything back.
[ -f "$SETTINGS" ] && cp -p "$SETTINGS" "$CONF/inti.env.previous"
# A failure before the new release goes live leaves the settings the running release started with.
switched=0
restore_settings() {
  local status=$?
  if [ "$status" != 0 ] && [ "$switched" = 0 ] && [ -f "$CONF/inti.env.previous" ]; then
    install -m 640 -o root -g inti "$CONF/inti.env.previous" "$SETTINGS"
    echo "The installed settings were left as they were." >&2
  fi
}
trap restore_settings EXIT
# The new .env is merged into the installed settings. The key that encrypts the grants is made
# once and never replaced: a different one would make every saved grant unreadable.
python3 - "$SETTINGS" "${NEW:-}" "$GRANT_FILE" <<'PY'
import base64, os, pathlib, secrets, sys
settings, new, grants = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]

def read(path):
    out = {}
    for line in path.read_text().replace("\r", "").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            out[key.strip()] = value
    return out

current = read(settings) if settings.exists() else {}
incoming = read(pathlib.Path(new)) if new else {}
merged = dict(current)
for key, value in incoming.items():
    if key == "SERVER_GRANT_KEY":
        continue
    if value.strip() or key not in merged:
        merged[key] = value
old_key = current.get("SERVER_GRANT_KEY", "").strip()
new_key = incoming.get("SERVER_GRANT_KEY", "").strip()
if old_key:
    if new_key and new_key != old_key:
        sys.exit("SERVER_GRANT_KEY in .env differs from the installed one; it would make every saved grant unreadable")
    merged["SERVER_GRANT_KEY"] = old_key
elif new_key:
    merged["SERVER_GRANT_KEY"] = new_key
elif os.path.exists(grants):
    sys.exit(f"{grants} exists but no SERVER_GRANT_KEY was given: put the key from the old server in .env")
else:
    merged["SERVER_GRANT_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
# Written readable by root only; install below gives it to the group inti.
fd = os.open(str(settings) + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("".join(f"{k}={v}\n" for k, v in merged.items()))
PY
install -m 640 -o root -g inti "$SETTINGS.tmp" "$SETTINGS"
rm -f "$SETTINGS.tmp"
if [ -n "$NEW" ]; then
  rm -f "$NEW"  # merged: no second file with the keys is left in the clone
  echo "Settings merged into $SETTINGS. To change them, edit that file or write a new .env, and run this again."
fi

say "4/7 Server code"
release=$(date +%Y%m%d%H%M%S)-${commit:0:12}
next=$RELEASES/.$release
rm -rf "$RELEASES"/.[0-9]*  # releases a failed run left half made
install -d -m 755 "$next"
src_git archive --format=tar "$commit" | tar -x --no-same-owner -C "$next"
# Root installs the server's packages from the lockfile without running any package script.
(cd "$next" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --prod --frozen-lockfile --ignore-scripts --silent)
echo "commit ${commit:0:12}"

KEY_CREATED=0
if ! python3 -c 'import os, sys; os.lstat(sys.argv[1])' "$KEY_FILE" 2>/dev/null; then
  as_inti bash -c "cd $next && node --import tsx agent/cli/new-key.ts $KEY_FILE" >/dev/null
  KEY_CREATED=1
fi
# Read without following a link or waiting on a pipe, from a file inti owns.
public_key=$(python3 - "$KEY_FILE" <<'PY'
import json, os, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd) as f:
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
        sys.exit("not a plain file")
    print(json.load(f)["publicKey"])
PY
) || fail "could not read the public key from $KEY_FILE"
[[ $public_key =~ ^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$ ]] || fail "$KEY_FILE does not hold an ed25519 public key"

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

say "5/7 Web app"
# inti-build builds from the same commit, with only the public values; it cannot read any key.
as_build rm -rf "$STAGE"
as_build mkdir -m 700 "$STAGE"
src_git archive --format=tar "$commit" | as_build tar -x -C "$STAGE"
build_log=$(mktemp)
{
  as_build bash -c "cd $STAGE && pnpm install --frozen-lockfile --silent" &&
    as_build env PRIVY_APP_ID="$privy_app_id" INTI_KEY_PUBLIC="$public_key" \
      INTI_API_URL="$public" INTI_AGENT_API_HOST="$agent_api_host" \
      bash -c "cd $STAGE && pnpm -s web:build"
} > "$build_log" 2>&1 || { tail -n 30 "$build_log"; rm -f "$build_log"; fail "the web app did not build"; }
grep -E 'built in' "$build_log" || true
rm -f "$build_log"
# A package may have left a process running as inti-build; none may outlive the build.
pkill -KILL -u inti-build 2>/dev/null || true
for _ in $(seq 10); do pgrep -u inti-build >/dev/null || break; sleep 1; done
! pgrep -u inti-build >/dev/null || fail "processes of inti-build are still running"
# inti-build hands over the built app as a tar stream, so it can only pass on files it can read.
# Root unpacks only plain files and folders: Caddy serves this folder and can read its own TLS
# keys, so a link must never reach it.
untar=$(cat <<'PY'
import os, posixpath, sys, tarfile
dest = sys.argv[1]
os.makedirs(dest, mode=0o755)
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as tar:
    for m in tar:
        name = posixpath.normpath(m.name)
        if name == ".":
            continue
        if name.startswith("/") or name == ".." or name.startswith("../"):
            sys.exit(f"unsafe path in the web build: {m.name}")
        target = os.path.join(dest, name)
        if m.isdir():
            os.makedirs(target, mode=0o755, exist_ok=True)
        elif m.isfile():
            os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
            src = tar.extractfile(m)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, "wb") as out:
                out.write(src.read())
        else:
            sys.exit(f"the web build contains something that is not a plain file: {m.name}")
PY
)
as_build tar -C "$STAGE/web/dist" -cf - . | python3 -c "$untar" "$next/web/dist" ||
  fail "the web build could not be copied"
[ -f "$next/web/dist/index.html" ] || fail "the web build has no index.html"
chmod -R u=rwX,go=rX "$next"
mv "$next" "$RELEASES/$release"

# Copy the key now: a failure below must not hide this.
if [ "$KEY_CREATED" = 1 ]; then
  echo
  echo "A new Inti key was created in $KEY_FILE. Users authorize it in the app, so keep a copy"
  echo "apart from other backups, for example: scp root@your-server:$KEY_FILE ."
fi

say "6/7 Start"
previous=$(readlink "$CURRENT" 2>/dev/null || true)
UNIT=/etc/systemd/system/inti-agent.service
[ -f "$UNIT" ] && cp -p "$UNIT" "$CONF/inti-agent.service.previous"
switch_to() {
  ln -sfn "$1" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
}
# The API is up only when /health answers and the port belongs to the service's own process, not
# to anything else that may be listening there.
answers() {
  local main
  for _ in $(seq 30); do  # the agent takes a few seconds to start
    main=$(systemctl show -p MainPID --value inti-agent)
    if [ "${main:-0}" != 0 ] && curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null &&
      ss -ltnpH "sport = :$PORT" | grep -q "pid=$main,"; then
      return 0
    fi
    sleep 1
  done
  return 1
}
# Puts back the previous release, its settings and its unit, and checks that it answers again.
rollback() {
  trap - ERR
  journalctl -u inti-agent -n 20 --no-pager || true
  [ -n "$previous" ] && [ -d "$previous" ] || fail "the new release did not start: journalctl -u inti-agent -n 50"
  switch_to "$previous"
  [ -f "$CONF/inti.env.previous" ] && install -m 640 -o root -g inti "$CONF/inti.env.previous" "$SETTINGS"
  [ -f "$CONF/inti-agent.service.previous" ] && install -m 644 "$CONF/inti-agent.service.previous" "$UNIT"
  systemctl daemon-reload
  systemctl restart inti-agent || true
  answers || fail "the new release did not start, and the previous one does not answer either: journalctl -u inti-agent -n 50"
  fail "the new release did not start; the previous release, settings and service are running again"
}
switch_to "$RELEASES/$release"
switched=1
trap rollback ERR
install -m 644 "$SRC/deploy/inti-agent.service" "$UNIT"
systemctl daemon-reload
systemctl enable -q inti-agent
systemctl restart inti-agent
answers || rollback
trap - ERR

# Caddy: the whole configuration, with this site in it, is checked before it goes live, so a
# clash with another site never takes the others down.
python3 - "$SRC/deploy/Caddyfile" "$SRC/web/security-headers.json" "$site" "$public" > /etc/caddy/inti.caddy.new <<'PY'
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
import="import /etc/caddy/inti.caddy"
touch /etc/caddy/Caddyfile
if grep -q "The Caddyfile is an easy way" /etc/caddy/Caddyfile; then
  echo "$import" > /etc/caddy/Caddyfile.new  # the package's welcome page: replaced
else
  grep -vxF "$import" /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.new || true  # other sites: kept
  echo "$import" >> /etc/caddy/Caddyfile.new
fi
sed "s#^import /etc/caddy/inti.caddy\$#import /etc/caddy/inti.caddy.new#" /etc/caddy/Caddyfile.new > /etc/caddy/Caddyfile.check
if ! caddy validate --config /etc/caddy/Caddyfile.check --adapter caddyfile >/dev/null 2>&1; then
  caddy validate --config /etc/caddy/Caddyfile.check --adapter caddyfile || true
  rm -f /etc/caddy/inti.caddy.new /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile.check
  fail "the Caddy configuration with this site is not valid; nothing was changed"
fi
cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-inti
[ -f /etc/caddy/inti.caddy ] && cp -p /etc/caddy/inti.caddy /etc/caddy/inti.caddy.before
install -m 644 /etc/caddy/inti.caddy.new /etc/caddy/inti.caddy
install -m 644 /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
rm -f /etc/caddy/inti.caddy.new /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile.check
systemctl enable -q caddy
if ! systemctl reload-or-restart caddy; then
  install -m 644 /etc/caddy/Caddyfile.before-inti /etc/caddy/Caddyfile
  if [ -f /etc/caddy/inti.caddy.before ]; then
    install -m 644 /etc/caddy/inti.caddy.before /etc/caddy/inti.caddy
  fi
  systemctl reload-or-restart caddy || true
  fail "Caddy did not take the new configuration; the previous one is back: journalctl -u caddy -n 50"
fi

# Keep the live release and the one before it.
for old in $(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | sort -r | tail -n +3); do
  [ "$old" = "$(readlink "$CURRENT")" ] || [ "$old" = "$previous" ] || rm -rf "$old"
done

say "7/7 Check"
code=000
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
