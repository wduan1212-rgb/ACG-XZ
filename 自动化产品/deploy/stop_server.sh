#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PID_FILE="logs/app.pid"
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Stopped process $PID"
  fi
  rm -f "$PID_FILE"
fi

PORT="${PORT:-8787}"
if command -v lsof >/dev/null 2>&1; then
  OLD_PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$OLD_PIDS" ]; then
    kill $OLD_PIDS 2>/dev/null || true
    echo "Stopped remaining process on port $PORT: $OLD_PIDS"
  fi
fi

