#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server to host Inti. Runs once, as root:
#   ssh root@your-server 'bash -s -- https://github.com/you/inti.git' < scripts/setup-server.sh
# It installs Node (official build, checksum verified), pnpm (through corepack) and Caddy
# (official apt repository), creates the unprivileged user inti, and clones the repo to
# /home/inti/app. It never writes secrets: .env and the Inti key file are copied by you
# afterwards (README, Self-host), then scripts/deploy.sh builds and starts everything.
set -euo pipefail

REPO_URL=${1:?usage: setup-server.sh <git clone url>}
NODE_VERSION=24.22.2

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || echo "warning: tested on Ubuntu 24.04, this is $PRETTY_NAME"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl xz-utils ca-certificates gpg \
  debian-keyring debian-archive-keyring apt-transport-https

# Node from nodejs.org, checked against the published SHASUMS256.txt.
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  TMP=$(mktemp -d)
  FILE="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$TMP/$FILE" "https://nodejs.org/dist/v$NODE_VERSION/$FILE"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -)
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

if [ ! -d /home/inti/app/.git ]; then
  runuser -u inti -- env HOME=/home/inti git clone --quiet "$REPO_URL" /home/inti/app
fi
echo "== repo in /home/inti/app ($(runuser -u inti -- env HOME=/home/inti git -C /home/inti/app rev-parse --short HEAD))"

cat <<'NEXT'
== server ready. Next, from your own computer (README, Self-host):
   1. copy your production .env to /home/inti/app/.env
   2. copy the Inti key file to /home/inti/data/ (path in SERVER_INTI_KEY_FILE)
   3. bash scripts/deploy.sh <ssh host>
NEXT
