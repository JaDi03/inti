#!/usr/bin/env bash
# Sets up and deploys Inti on your own server, from a checkout of the repo.
#
#   bash scripts/deploy.sh <ssh host> --init [--branch <branch>] [--repo <git url>]
#       Once, on a fresh Ubuntu 24.04 server: installs everything, clones the repo and creates
#       /home/inti/app/.env with every generated value. Then you fill in your own values there.
#   bash scripts/deploy.sh <ssh host>
#       Every release: pulls the branch the server was set up with, builds, publishes and
#       restarts what changed, then checks the web and the API from here.
#
# <ssh host> is anything ssh accepts: root@203.0.113.7, or a Host alias from ~/.ssh/config.
# The repo defaults to this checkout's origin (an ssh GitHub URL is turned into https, since the
# server has no GitHub key) and the branch to main. Root on the server runs only the scripts sent
# from this checkout, never a file from the server's clone.
set -euo pipefail

usage() { echo "usage: bash scripts/deploy.sh <ssh host> [--init] [--branch <branch>] [--repo <git url>]"; exit 1; }
HOST=${1:-}
[ -n "$HOST" ] && [ "${HOST#-}" = "$HOST" ] || usage
shift
INIT=no
BRANCH=main
REPO=
while [ $# -gt 0 ]; do
  case "$1" in
    --init) INIT=yes ;;
    --branch) BRANCH=${2:?missing branch}; shift ;;
    --repo) REPO=${2:?missing repo url}; shift ;;
    *) usage ;;
  esac
  shift
done
cd "$(dirname "$0")/.."

if [ "$INIT" = yes ]; then
  [ -n "$REPO" ] || REPO=$(git remote get-url origin)
  case "$REPO" in git@github.com:*) REPO="https://github.com/${REPO#git@github.com:}" ;; esac
  # The values travel as arguments of bash -s, so they must not hold shell characters.
  [[ "$REPO" =~ ^https://[A-Za-z0-9./_-]+$ ]] || { echo "repo must be an https git url, got: $REPO"; exit 1; }
  [[ "$BRANCH" =~ ^[A-Za-z0-9./_-]+$ ]] || { echo "unexpected branch name: $BRANCH"; exit 1; }
  ssh "$HOST" "sudo bash -s -- '$REPO' '$BRANCH'" < scripts/setup-server.sh
  cat <<NEXT
== server ready. Fill in the values under "Fill in" (they come from your own accounts):
     ssh -t $HOST sudo -u inti nano /home/inti/app/.env
   then deploy:
     bash scripts/deploy.sh $HOST
NEXT
  exit 0
fi

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
