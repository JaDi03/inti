#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server to host Inti. scripts/deploy.sh --init sends it over ssh
# and it runs as root. It installs Node (official build, checksum verified), pnpm (through
# corepack) and Caddy (official apt repository), creates the unprivileged user inti, clones the
# repo to /home/inti/app, and creates /home/inti/app/.env with every generated value filled in
# (scripts/init-env.mjs). Inti's key is created there and never leaves the server.
set -euo pipefail

REPO_URL=${1:?usage: setup-server.sh <git clone url> [branch]}
BRANCH=${2:-main}
NODE_VERSION=24.22.2
# sha256 of node-v24.22.2-linux-x64.tar.xz from nodejs.org/dist/v24.22.2/SHASUMS256.txt. It lives
# here, not downloaded with the tarball, so a tampered download server cannot change both.
NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || echo "warning: tested on Ubuntu 24.04, this is $PRETTY_NAME"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl xz-utils ca-certificates gpg \
  debian-keyring debian-archive-keyring apt-transport-https

# Node from nodejs.org, checked against the pinned sha256.
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  TMP=$(mktemp -d)
  FILE="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$TMP/$FILE" "https://nodejs.org/dist/v$NODE_VERSION/$FILE"
  (cd "$TMP" && echo "$NODE_SHA256  $FILE" | sha256sum -c -)
  tar -xJf "$TMP/$FILE" -C /opt
  rm -rf "$TMP"
  for bin in node npm npx corepack; do
    ln -sf "/opt/node-v$NODE_VERSION-linux-x64/bin/$bin" "/usr/local/bin/$bin"
  done
fi
# pnpm comes from corepack, at the exact version in package.json (packageManager).
corepack enable --install-directory /usr/local/bin pnpm
echo "== node $(node -v)"

# Caddy from its official apt repository (caddyserver.com/docs/install).
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi
systemctl enable --now --quiet caddy
echo "== $(caddy version)"

# The agent runs as inti, which has no login shell and no sudo.
if ! id inti >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin inti
fi
chmod 750 /home/inti
install -d -m 700 -o inti -g inti /home/inti/data
# Caddy serves the built web app from here.
install -d -m 755 /var/www

as_inti() {
  runuser -u inti -- env HOME=/home/inti PATH=/usr/local/bin:/usr/bin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "$1"
}

if [ ! -d /home/inti/app/.git ]; then
  as_inti "git clone --quiet --branch '$BRANCH' '$REPO_URL' /home/inti/app"
fi
echo "== repo in /home/inti/app ($(as_inti "git -C /home/inti/app rev-parse --abbrev-ref HEAD") $(as_inti "git -C /home/inti/app rev-parse --short HEAD"))"

as_inti "cd /home/inti/app && pnpm install --frozen-lockfile >/dev/null && node scripts/init-env.mjs --data /home/inti/data --server"
