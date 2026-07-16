#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PORT="${PORT:-8787}"
VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"

stop_pid_file() {
  local pid_file="$1"
  local label="$2"
  if [ ! -f "$pid_file" ]; then
    return
  fi
  local pid
  pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped $label process $pid"
  fi
  rm -f "$pid_file"
}

stop_port() {
  local port="$1"
  local label="$2"
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi
  local old_pids
  old_pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$old_pids" ]; then
    kill $old_pids 2>/dev/null || true
    echo "Stopped remaining $label process on port $port: $old_pids"
  fi
}

stop_pid_file "$APP_DIR/logs/app.pid" "main"
stop_pid_file "$APP_DIR/logs/video-workshop.pid" "video workshop"
stop_port "$PORT" "main"
if [ "$VIDEO_WORKSHOP_PORT" != "$PORT" ]; then
  stop_port "$VIDEO_WORKSHOP_PORT" "video workshop"
fi
