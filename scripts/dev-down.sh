#!/usr/bin/env bash
# scripts/dev-down.sh — stop the local OpenAdult app (and optionally the DB)
#   scripts/dev-down.sh          # stop the app server
#   scripts/dev-down.sh --db     # also stop the local database
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP_PIDFILE="$ROOT/.dev-app.pid"
msg() { printf '\033[1;33m[dev-down]\033[0m %s\n' "$*"; }

if [ -f "$APP_PIDFILE" ] && kill -0 "$(cat "$APP_PIDFILE")" 2>/dev/null; then
  kill "$(cat "$APP_PIDFILE")" && msg "app stopped (pid $(cat "$APP_PIDFILE"))"
else
  msg "app not running."
fi
rm -f "$APP_PIDFILE"

if [ "${1:-}" = "--db" ]; then
  bash "$ROOT/scripts/localdb.sh" stop
fi
