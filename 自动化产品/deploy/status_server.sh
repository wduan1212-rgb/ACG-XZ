#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PORT="${PORT:-8787}"
VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"
VIDEO_WORKSHOP_HEALTH_URL="${VIDEO_WORKSHOP_HEALTH_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"

show_process() {
  local label="$1"
  local pid_file="$2"
  echo "== $label process =="
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
    ps -p "$pid" -o pid,ppid,etime,command || true
  else
    echo "No $pid_file"
  fi
}

show_process "Main" "$APP_DIR/logs/app.pid"
echo
show_process "Video workshop" "$APP_DIR/logs/video-workshop.pid"

echo
echo "== Main health =="
curl -fsS "http://127.0.0.1:${PORT}/api/health" || true

echo
echo
echo "== Video workshop health =="
curl -fsS "${VIDEO_WORKSHOP_HEALTH_URL}/api/health" || true

echo
echo
echo "== Recent main logs =="
tail -n 60 "$APP_DIR/logs/app.log" 2>/dev/null || true

echo
echo "== Recent video workshop logs =="
tail -n 60 "$APP_DIR/logs/video-workshop.log" 2>/dev/null || true
