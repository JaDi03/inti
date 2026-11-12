#!/usr/bin/env bash
# Deploys the main branch to an Inti server prepared with scripts/setup-server.sh.
# Usage, from a checkout of the repo:  bash scripts/deploy.sh <ssh host>
# <ssh host> is anything ssh accepts: root@203.0.113.7, or a Host alias from ~/.ssh/config.
# The server pulls main itself; this checkout sends scripts/server-update.sh and the service
# unit (deploy/inti-agent.service), so root on the server runs and installs only files from
# here. Then it checks the web and the API from here, outside the server.
set -euo pipefail

HOST=${1:?usage: bash scripts/deploy.sh <ssh host>}
cd "$(dirname "$0")/.."

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
{
  printf 'UNIT_FILE_B64=%s\n' "$(base64 < deploy/inti-agent.service | tr -d '\n')"
  cat scripts/server-update.sh
} | ssh "$HOST" 'sudo bash -s' | tee "$OUT"

read -r WEB API < <(sed -n 's/^== urls: //p' "$OUT")
echo "== from outside"
curl -s -m 20 -o /dev/null -w "web      %{http_code}\n" "$WEB/"
curl -s -m 20 -o /dev/null -w "web app  %{http_code}\n" "$WEB/app"
curl -s -m 20 -w "  api health\n" "$API/health"
