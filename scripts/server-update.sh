#!/usr/bin/env bash
# Brings an Inti server up to date with the repo's main branch. Runs on the server as root,
# after scripts/setup-server.sh prepared it. scripts/deploy.sh sends this file over ssh, so
# the server always runs the version from the deployer's checkout.
# Steps: pull, install, build the web, publish it, install the service unit, render the
# Caddyfile from .env, restart the agent when its code or unit changed, check health.
set -euo pipefail

APP=/home/inti/app
WEB=/var/www/inti

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -d "$APP/.git" ] || { echo "$APP is not a clone; run scripts/setup-server.sh first"; exit 1; }
[ -f "$APP/.env" ] || { echo "$APP/.env is missing; copy your production .env there (see README, Self-host)"; exit 1; }

# The service may write only to /home/inti/data, so the grants file must live there.
grep -qE '^SERVER_GRANT_FILE=/home/inti/data/' "$APP/.env" \
  || { echo "SERVER_GRANT_FILE in $APP/.env must be a path under /home/inti/data/"; exit 1; }
chown inti:inti "$APP/.env" && chmod 600 "$APP/.env"

as_inti() {
  runuser -u inti -- env HOME=/home/inti PATH=/usr/local/bin:/usr/bin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "cd $APP && $1"
}

BEFORE=$(as_inti "git rev-parse HEAD")
as_inti "git pull --quiet --ff-only"
AFTER=$(as_inti "git rev-parse HEAD")
echo "== code: ${BEFORE:0:7} -> ${AFTER:0:7}"

as_inti "pnpm install --frozen-lockfile >/dev/null"
as_inti "pnpm web:build" | grep -E 'built in|error' || true
[ -f "$APP/web/dist/index.html" ] || { echo "web build failed"; exit 1; }

rm -rf "$WEB.new" && cp -r "$APP/web/dist" "$WEB.new" && chmod -R a+rX "$WEB.new"
rm -rf "$WEB.old"
[ -d "$WEB" ] && mv "$WEB" "$WEB.old"
mv "$WEB.new" "$WEB"
echo "== web published (previous one in $WEB.old)"

UNIT_CHANGED=no
if ! cmp -s "$APP/deploy/inti-agent.service" /etc/systemd/system/inti-agent.service; then
  cp "$APP/deploy/inti-agent.service" /etc/systemd/system/inti-agent.service
  systemctl daemon-reload
  systemctl enable --quiet inti-agent
  UNIT_CHANGED=yes
  echo "== service unit installed"
fi

CADDY_NEW=$(mktemp)
node "$APP/scripts/caddyfile.mjs" "$APP/.env" > "$CADDY_NEW"
caddy validate --config "$CADDY_NEW" --adapter caddyfile >/dev/null 2>&1 \
  || { echo "rendered Caddyfile is invalid:"; caddy validate --config "$CADDY_NEW" --adapter caddyfile; exit 1; }
if ! cmp -s "$CADDY_NEW" /etc/caddy/Caddyfile; then
  [ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  install -m 644 "$CADDY_NEW" /etc/caddy/Caddyfile
  systemctl reload-or-restart caddy
  echo "== Caddyfile updated (previous one kept as /etc/caddy/Caddyfile.bak-*)"
fi
rm -f "$CADDY_NEW"

CODE_CHANGED=no
if [ "$BEFORE" != "$AFTER" ] && as_inti "git diff --name-only $BEFORE $AFTER" \
  | grep -qE '^(agent/|package.json|pnpm-lock.yaml|pnpm-workspace.yaml)'; then
  CODE_CHANGED=yes
fi
if [ "$CODE_CHANGED" = yes ] || [ "$UNIT_CHANGED" = yes ] || ! systemctl is-active --quiet inti-agent; then
  systemctl restart inti-agent
  PORT=$(grep -E '^SERVER_PORT=' "$APP/.env" | cut -d= -f2)
  for i in $(seq 1 30); do
    curl -s -m 2 "http://127.0.0.1:${PORT:-8787}/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -s -m 2 "http://127.0.0.1:${PORT:-8787}/health" >/dev/null 2>&1 \
    || { echo "agent did not answer /health; last log lines:"; journalctl -u inti-agent -n 20 --no-pager; exit 1; }
  echo "== agent restarted (${i}s)"
else
  echo "== agent code unchanged, not restarted"
fi
echo "== services: $(systemctl is-active inti-agent caddy | tr '\n' ' ')"
# scripts/deploy.sh reads this line to check both addresses from outside the server.
WEB_ORIGIN=$(grep -E '^SERVER_ALLOWED_ORIGINS=' "$APP/.env" | cut -d= -f2 | cut -d, -f1)
API_ORIGIN=$(grep -E '^INTI_API_URL=' "$APP/.env" | cut -d= -f2)
echo "== urls: $WEB_ORIGIN $API_ORIGIN"
