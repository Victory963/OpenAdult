#!/usr/bin/env bash
# ============================================================
# scripts/dev-up.sh — bring up OpenAdult on localhost (no Docker needed)
# ------------------------------------------------------------
# Starts a local MySQL-compatible DB, applies migrations, (optionally) seeds
# sample data, builds if needed, and starts the PRODUCTION server on localhost.
# This runs the exact same artifact (node dist/index.js) that the Docker `app`
# container runs.
#
#   scripts/dev-up.sh            # start everything, http://localhost:3000
#   scripts/dev-up.sh --seed     # also load scripts/dev-seed.sql sample data
#   PORT=8080 scripts/dev-up.sh  # choose a port
#
# Stop with: scripts/dev-down.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT="${PORT:-3000}"
DB_PORT="${OPENADULT_DB_PORT:-3307}"
APP_PIDFILE="$ROOT/.dev-app.pid"
APP_LOG="$ROOT/.dev-app.log"
SEED=0; [ "${1:-}" = "--seed" ] && SEED=1

msg() { printf '\033[1;32m[dev-up]\033[0m %s\n' "$*"; }

# 1) Local DB ------------------------------------------------
bash "$ROOT/scripts/localdb.sh" start
export DATABASE_URL="${DATABASE_URL:-mysql://root@127.0.0.1:${DB_PORT}/openadult}"
msg "DATABASE_URL=$DATABASE_URL"

# 2) Migrations ---------------------------------------------
msg "applying migrations (drizzle-kit migrate)..."
pnpm exec drizzle-kit migrate

# 3) Optional seed ------------------------------------------
if [ "$SEED" = "1" ]; then
  msg "seeding sample data..."
  BINDIR="${OPENADULT_LOCALDB_DIR:-$HOME/.openadult-localdb}/mariadb-11.4.5-linux-systemd-x86_64"
  "$BINDIR/bin/mariadb" -h127.0.0.1 -P"$DB_PORT" -uroot openadult < "$ROOT/scripts/dev-seed.sql"
fi

# 4) Build if needed ----------------------------------------
if [ ! -f "$ROOT/dist/index.js" ]; then
  msg "no build found — running pnpm build..."
  pnpm build
fi

# 5) Start the app ------------------------------------------
if [ -f "$APP_PIDFILE" ] && kill -0 "$(cat "$APP_PIDFILE")" 2>/dev/null; then
  msg "app already running (pid $(cat "$APP_PIDFILE"))"
else
  msg "starting production server on port $PORT ..."
  # DATABASE_URL is exported; the app also reads .env via dotenv.
  setsid env NODE_ENV=production PORT="$PORT" DATABASE_URL="$DATABASE_URL" \
    node "$ROOT/dist/index.js" </dev/null >"$APP_LOG" 2>&1 &
  echo $! > "$APP_PIDFILE"
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
  msg "UP ✅  open  http://localhost:$PORT   (logs: $APP_LOG)"
else
  msg "app did not become healthy — see $APP_LOG"; tail -20 "$APP_LOG" || true; exit 1
fi
