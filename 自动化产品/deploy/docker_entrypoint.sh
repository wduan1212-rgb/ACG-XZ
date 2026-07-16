#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/app"
VIDEO_APP_DIR="$APP_DIR/apps/video-workshop"
VIDEO_PYTHON="/opt/video-workshop-venv/bin/python"
MAIN_PID=""
VIDEO_PID=""

export VIDEO_WORKSHOP_HOST="${VIDEO_WORKSHOP_HOST:-127.0.0.1}"
export VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"
export VIDEO_WORKSHOP_URL="${VIDEO_WORKSHOP_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"
export VIDEO_WORKSHOP_PROJECTS_DIR="${VIDEO_WORKSHOP_PROJECTS_DIR:-/data/video-workshop/projects}"
export VIDEO_WORKSHOP_OUTPUT_DIR="${VIDEO_WORKSHOP_OUTPUT_DIR:-/data/video-workshop/outputs}"
export VIDEO_WORKSHOP_UPLOAD_DIR="${VIDEO_WORKSHOP_UPLOAD_DIR:-/data/video-workshop/uploads}"
export BGM_SOURCE="${BGM_SOURCE:-platform}"
export BGM_LIBRARY_DIR="${BGM_LIBRARY_DIR:-/data/bgm-library}"
export HF_HOME="${HF_HOME:-/data/model-cache}"

case "$VIDEO_WORKSHOP_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "VIDEO_WORKSHOP_HOST must stay on a loopback address." >&2
    exit 1
    ;;
esac
if [ "${PORT:-8787}" = "$VIDEO_WORKSHOP_PORT" ]; then
  echo "Main PORT and VIDEO_WORKSHOP_PORT must be different." >&2
  exit 1
fi

mkdir -p \
  "$VIDEO_WORKSHOP_PROJECTS_DIR" \
  "$VIDEO_WORKSHOP_OUTPUT_DIR" \
  "$VIDEO_WORKSHOP_UPLOAD_DIR" \
  "$HF_HOME"
if [ "$BGM_SOURCE" != "platform" ]; then
  mkdir -p "$BGM_LIBRARY_DIR"
fi

shutdown() {
  trap - EXIT INT TERM
  if [ -n "$MAIN_PID" ] && kill -0 "$MAIN_PID" 2>/dev/null; then
    kill "$MAIN_PID" 2>/dev/null || true
  fi
  if [ -n "$VIDEO_PID" ] && kill -0 "$VIDEO_PID" 2>/dev/null; then
    kill "$VIDEO_PID" 2>/dev/null || true
  fi
  wait "$MAIN_PID" 2>/dev/null || true
  wait "$VIDEO_PID" 2>/dev/null || true
}
trap shutdown EXIT INT TERM

(
  cd "$VIDEO_APP_DIR"
  exec "$VIDEO_PYTHON" run.py
) &
VIDEO_PID=$!

python -m uvicorn server.main:app \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-8787}" &
MAIN_PID=$!

while kill -0 "$MAIN_PID" 2>/dev/null && kill -0 "$VIDEO_PID" 2>/dev/null; do
  sleep 2
done

echo "A required service exited; stopping the remaining process." >&2
exit 1
