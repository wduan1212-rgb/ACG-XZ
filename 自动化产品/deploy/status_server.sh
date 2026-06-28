#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PORT="${PORT:-8787}"
echo "== Process =="
if [ -f logs/app.pid ]; then
  PID="$(cat logs/app.pid)"
  ps -p "$PID" -o pid,ppid,etime,command || true
else
  echo "No logs/app.pid"
fi

echo
echo "== Health =="
curl -fsS "http://127.0.0.1:${PORT}/api/health" || true

echo
echo "== Recent logs =="
tail -n 80 logs/app.log 2>/dev/null || true

