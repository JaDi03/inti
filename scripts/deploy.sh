#!/usr/bin/env bash
# Deploys the main branch to an Inti server prepared with scripts/setup-server.sh.
# Usage, from a checkout of the repo:  bash scripts/deploy.sh <ssh host>
# <ssh host> is anything ssh accepts: root@203.0.113.7, or a Host alias from ~/.ssh/config.
# The server pulls main itself; this checkout only sends scripts/server-update.sh, then
# checks the web and the API from here, outside the server.
set -euo pipefail

HOST=${1:?usage: bash scripts/deploy.sh <ssh host>}
cd "$(dirname "$0")/.."

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
ssh "$HOST" 'sudo bash -s' < scripts/server-update.sh | tee "$OUT"

read -r WEB API < <(sed -n 's/^== urls: //p' "$OUT")
echo "== from outside"
curl -s -m 20 -o /dev/null -w "web      %{http_code}\n" "$WEB/"
curl -s -m 20 -o /dev/null -w "web app  %{http_code}\n" "$WEB/app"
curl -s -m 20 -w "  api health\n" "$API/health"
