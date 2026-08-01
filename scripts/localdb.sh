#!/usr/bin/env bash
# ============================================================
# scripts/localdb.sh — no-root local MySQL-compatible DB for OpenAdult
# ------------------------------------------------------------
# For dev machines WITHOUT Docker or a system MySQL. Downloads a portable
# MariaDB 11.4 binary tarball into ~/.openadult-localdb and runs it from there
# (no root needed). MariaDB speaks the MySQL wire protocol, so mysql2/Drizzle
# connect to it unchanged.
#
# Usage:
#   scripts/localdb.sh start     # download+init if needed, then start (port 3307)
#   scripts/localdb.sh stop
#   scripts/localdb.sh status
#   scripts/localdb.sh cli       # open a SQL shell on the openadult database
#
# Env overrides: OPENADULT_LOCALDB_DIR, OPENADULT_DB_PORT, OPENADULT_DB_NAME
# Connection string it serves:  mysql://root@127.0.0.1:${OPENADULT_DB_PORT:-3307}/openadult
# ============================================================
set -euo pipefail

MARIADB_VERSION="11.4.5"
DIR="${OPENADULT_LOCALDB_DIR:-$HOME/.openadult-localdb}"
PORT="${OPENADULT_DB_PORT:-3307}"
DBNAME="${OPENADULT_DB_NAME:-openadult}"
BINDIR="$DIR/mariadb-${MARIADB_VERSION}-linux-systemd-x86_64"
DATADIR="$DIR/data"
SOCK="/tmp/oa-mysql-${PORT}.sock"     # must stay < 108 chars (unix socket limit)
PIDFILE="$DIR/mariadbd-${PORT}.pid"
ERRLOG="$DIR/mariadbd-${PORT}.err"
TARBALL_URL="https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/bintar-linux-systemd-x86_64/mariadb-${MARIADB_VERSION}-linux-systemd-x86_64.tar.gz"

msg() { printf '\033[1;36m[localdb]\033[0m %s\n' "$*"; }

ensure_binaries() {
  if [ -x "$BINDIR/bin/mariadbd" ]; then return; fi
  mkdir -p "$DIR"
  if [ ! -f "$DIR/mariadb.tar.gz" ]; then
    msg "downloading MariaDB ${MARIADB_VERSION} (~330MB, one time)..."
    curl -sS -L -o "$DIR/mariadb.tar.gz" "$TARBALL_URL"
  fi
  msg "extracting..."
  tar -xzf "$DIR/mariadb.tar.gz" -C "$DIR"
}

ensure_initialized() {
  if [ -d "$DATADIR/mysql" ]; then return; fi
  msg "initializing data directory (no-root)..."
  mkdir -p "$DATADIR"
  "$BINDIR/scripts/mariadb-install-db" --no-defaults \
    --basedir="$BINDIR" --datadir="$DATADIR" \
    --auth-root-authentication-method=normal --skip-test-db >/dev/null 2>&1
}

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

start() {
  if is_running; then msg "already running (pid $(cat "$PIDFILE")) on port $PORT"; return; fi
  ensure_binaries
  ensure_initialized
  rm -f "$SOCK"
  msg "starting mariadbd on 127.0.0.1:$PORT ..."
  # setsid detaches it into its own session so it survives this script exiting.
  setsid "$BINDIR/bin/mariadbd" --no-defaults \
    --basedir="$BINDIR" --datadir="$DATADIR" \
    --socket="$SOCK" --port="$PORT" --bind-address=127.0.0.1 \
    --pid-file="$PIDFILE" --innodb-buffer-pool-size=128M \
    --log-error="$ERRLOG" </dev/null >/dev/null 2>&1 &
  # wait until it accepts TCP connections
  for _ in $(seq 1 60); do
    if "$BINDIR/bin/mariadb" -h127.0.0.1 -P"$PORT" -uroot -e "SELECT 1" >/dev/null 2>&1; then
      "$BINDIR/bin/mariadb" -h127.0.0.1 -P"$PORT" -uroot \
        -e "CREATE DATABASE IF NOT EXISTS \`$DBNAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" 2>/dev/null
      msg "ready ✅  DATABASE_URL=mysql://root@127.0.0.1:$PORT/$DBNAME"
      return 0
    fi
    sleep 1
  done
  msg "FAILED to start — last errors:"; tail -15 "$ERRLOG" 2>/dev/null; return 1
}

stop() {
  if is_running; then
    local pid; pid="$(cat "$PIDFILE")"
    msg "stopping mariadbd (pid $pid)..."
    "$BINDIR/bin/mariadb-admin" -h127.0.0.1 -P"$PORT" -uroot shutdown 2>/dev/null || kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do is_running || break; sleep 1; done
    rm -f "$PIDFILE" "$SOCK"
    msg "stopped."
  else
    msg "not running."
  fi
}

status() {
  if is_running; then
    msg "running (pid $(cat "$PIDFILE")) — mysql://root@127.0.0.1:$PORT/$DBNAME"
  else
    msg "not running."
  fi
}

cli() { ensure_binaries; exec "$BINDIR/bin/mariadb" -h127.0.0.1 -P"$PORT" -uroot "$DBNAME"; }

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  cli) cli ;;
  *) echo "usage: $0 {start|stop|restart|status|cli}"; exit 2 ;;
esac
