#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"
export no_proxy="${no_proxy:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

mkdir -p logs

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

echo "Started Dumate Studio on http://127.0.0.1:${PORT}"
python - <<'PY'
import json
import urllib.request

url = "http://127.0.0.1:8787/api/health"
try:
    with urllib.request.urlopen(url, timeout=5) as resp:
        print(resp.read().decode("utf-8"))
except Exception as exc:
    print(f"Health check failed: {exc}")
    raise SystemExit(1)
PY

