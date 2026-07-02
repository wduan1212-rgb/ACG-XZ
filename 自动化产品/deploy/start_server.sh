#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"
export no_proxy="${no_proxy:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"

PORT="${PORT:-8787}"
HOST="${HOST:-::}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
BACKUP_ROOT="${BACKUP_ROOT:-$APP_DIR/backups}"
DATA_DB_PATH="${DATA_DB:-$APP_DIR/server/data.sqlite}"
LEGACY_DATA_PATH="${LEGACY_DATA_FILE:-$APP_DIR/server/data.json}"
UPLOAD_DIR_PATH="${UPLOAD_DIR:-$APP_DIR/server/uploads}"
COMPOSED_DIR_PATH="${COMPOSED_DIR:-$APP_DIR/server/composed}"

mkdir -p logs

backup_runtime_data() {
  local stamp dir
  stamp="$(date +%Y%m%d-%H%M%S)"
  dir="$BACKUP_ROOT/$stamp"
  mkdir -p "$dir"

  if [ -f "$DATA_DB_PATH" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$DATA_DB_PATH" ".backup '$dir/data.sqlite'"
    else
      cp -p "$DATA_DB_PATH"* "$dir/" 2>/dev/null || true
    fi
  fi
  if [ -f "$LEGACY_DATA_PATH" ]; then
    cp -p "$LEGACY_DATA_PATH" "$dir/data.json"
  fi
  if [ -d "$UPLOAD_DIR_PATH" ]; then
    find "$UPLOAD_DIR_PATH" -maxdepth 1 -type f -print | sort > "$dir/uploads.manifest"
    if [ "${BACKUP_MEDIA:-0}" = "1" ]; then
      tar -C "$(dirname "$UPLOAD_DIR_PATH")" -czf "$dir/uploads.tgz" "$(basename "$UPLOAD_DIR_PATH")"
    fi
  fi
  if [ -d "$COMPOSED_DIR_PATH" ]; then
    find "$COMPOSED_DIR_PATH" -maxdepth 1 -type f -print | sort > "$dir/composed.manifest"
    if [ "${BACKUP_MEDIA:-0}" = "1" ]; then
      tar -C "$(dirname "$COMPOSED_DIR_PATH")" -czf "$dir/composed.tgz" "$(basename "$COMPOSED_DIR_PATH")"
    fi
  fi
  echo "Runtime data snapshot: $dir"
}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python3 not found. Please install Python 3.10+ first." >&2
  exit 1
fi

if [ ! -d ".venv" ]; then
  "$PYTHON_BIN" -m venv .venv
fi

# shellcheck disable=SC1091
. .venv/bin/activate

python -m pip install --upgrade pip
python -m pip install -r server/requirements.txt

backup_runtime_data

if command -v lsof >/dev/null 2>&1; then
  OLD_PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$OLD_PIDS" ]; then
    echo "Stopping old process on port $PORT: $OLD_PIDS"
    kill $OLD_PIDS 2>/dev/null || true
    sleep 1
  fi
fi

nohup python -m uvicorn server.main:app --host "$HOST" --port "$PORT" > logs/app.log 2>&1 &
echo $! > logs/app.pid
sleep 2

echo "Started Dumate Studio on http://localhost:${PORT}"
python - <<'PY'
import os
import json
import urllib.request

port = os.getenv("PORT", "8787")
url = f"http://localhost:{port}/api/health"
try:
    with urllib.request.urlopen(url, timeout=5) as resp:
        print(resp.read().decode("utf-8"))
except Exception as exc:
    print(f"Health check failed: {exc}")
    raise SystemExit(1)
PY
