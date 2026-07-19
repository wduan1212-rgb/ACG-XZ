#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIDEO_APP_DIR="$APP_DIR/apps/video-workshop"
cd "$APP_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"
export no_proxy="${no_proxy:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"

PORT="${PORT:-8787}"
HOST="${HOST:-::}"
VIDEO_WORKSHOP_HOST="${VIDEO_WORKSHOP_HOST:-127.0.0.1}"
VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"
VIDEO_WORKSHOP_URL="${VIDEO_WORKSHOP_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"
VIDEO_WORKSHOP_HEALTH_URL="${VIDEO_WORKSHOP_HEALTH_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
BACKUP_ROOT="${BACKUP_ROOT:-$APP_DIR/backups}"
DATA_DB_PATH="${DATA_DB:-$APP_DIR/server/data.sqlite}"
LEGACY_DATA_PATH="${LEGACY_DATA_FILE:-$APP_DIR/server/data.json}"
UPLOAD_DIR_PATH="${UPLOAD_DIR:-$APP_DIR/server/uploads}"
COMPOSED_DIR_PATH="${COMPOSED_DIR:-$APP_DIR/server/composed}"
CUSTOM_CANVAS_BLOB_DIR_PATH="${CUSTOM_CANVAS_BLOB_DIR:-$APP_DIR/server/canvas_blobs}"

# Keep sidecar runtime data outside the code directories so a code-only rsync
# cannot replace projects, uploads, outputs or the shared BGM library.
VIDEO_WORKSHOP_DATA_ROOT="${VIDEO_WORKSHOP_DATA_ROOT:-$APP_DIR/runtime/video-workshop}"
VIDEO_WORKSHOP_PROJECTS_DIR="${VIDEO_WORKSHOP_PROJECTS_DIR:-$VIDEO_WORKSHOP_DATA_ROOT/projects}"
VIDEO_WORKSHOP_OUTPUT_DIR="${VIDEO_WORKSHOP_OUTPUT_DIR:-$VIDEO_WORKSHOP_DATA_ROOT/outputs}"
VIDEO_WORKSHOP_UPLOAD_DIR="${VIDEO_WORKSHOP_UPLOAD_DIR:-$VIDEO_WORKSHOP_DATA_ROOT/uploads}"
BGM_SOURCE="${BGM_SOURCE:-platform}"
BGM_LIBRARY_DIR="${BGM_LIBRARY_DIR:-$APP_DIR/runtime/bgm-library}"
HF_HOME="${HF_HOME:-$APP_DIR/runtime/model-cache}"

export VIDEO_WORKSHOP_HOST VIDEO_WORKSHOP_PORT VIDEO_WORKSHOP_URL
export VIDEO_WORKSHOP_PROJECTS_DIR VIDEO_WORKSHOP_OUTPUT_DIR VIDEO_WORKSHOP_UPLOAD_DIR
export BGM_SOURCE BGM_LIBRARY_DIR HF_HOME
# Both services receive the exact same storage locations. The video sidecar
# opens these paths read-only when BGM_SOURCE=platform.
export DATA_DB="$DATA_DB_PATH"
export UPLOAD_DIR="$UPLOAD_DIR_PATH"
export CUSTOM_CANVAS_BLOB_DIR="$CUSTOM_CANVAS_BLOB_DIR_PATH"

MAIN_VENV="$APP_DIR/.venv"
VIDEO_VENV="$VIDEO_APP_DIR/.venv"
MAIN_PID_FILE="$APP_DIR/logs/app.pid"
VIDEO_PID_FILE="$APP_DIR/logs/video-workshop.pid"
MAIN_LOG="$APP_DIR/logs/app.log"
VIDEO_LOG="$APP_DIR/logs/video-workshop.log"

if [ "$PORT" = "$VIDEO_WORKSHOP_PORT" ]; then
  echo "Main PORT and VIDEO_WORKSHOP_PORT must be different." >&2
  exit 1
fi
case "$VIDEO_WORKSHOP_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "VIDEO_WORKSHOP_HOST must stay on a loopback address; the sidecar has no public authentication layer." >&2
    exit 1
    ;;
esac

mkdir -p \
  "$APP_DIR/logs" \
  "$BACKUP_ROOT" \
  "$VIDEO_WORKSHOP_PROJECTS_DIR" \
  "$VIDEO_WORKSHOP_OUTPUT_DIR" \
  "$VIDEO_WORKSHOP_UPLOAD_DIR" \
  "$CUSTOM_CANVAS_BLOB_DIR_PATH" \
  "$HF_HOME"
if [ "$BGM_SOURCE" != "platform" ]; then
  mkdir -p "$BGM_LIBRARY_DIR"
fi

migrate_legacy_tree() {
  local source_dir="$1"
  local target_dir="$2"
  if [ ! -d "$source_dir" ] || [ "$source_dir" = "$target_dir" ]; then
    return
  fi
  while IFS= read -r -d '' source_path; do
    local relative_path target_path
    relative_path="${source_path#"$source_dir"/}"
    target_path="$target_dir/$relative_path"
    if [ -d "$source_path" ]; then
      mkdir -p "$target_path"
    elif [ -f "$source_path" ] && [ ! -e "$target_path" ]; then
      mkdir -p "$(dirname "$target_path")"
      cp -p "$source_path" "$target_path"
    fi
  done < <(find "$source_dir" -mindepth 1 -print0)
}

backup_runtime_data() {
  local stamp dir video_backup_dir
  stamp="$(date +%Y%m%d-%H%M%S)"
  dir="$BACKUP_ROOT/$stamp"
  video_backup_dir="$dir/video-workshop"
  mkdir -p "$dir" "$video_backup_dir/projects"

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
  if [ -d "$CUSTOM_CANVAS_BLOB_DIR_PATH" ]; then
    find "$CUSTOM_CANVAS_BLOB_DIR_PATH" -type f -print | sort > "$dir/canvas-blobs.manifest"
    if [ "${BACKUP_CANVAS_MEDIA:-${BACKUP_MEDIA:-0}}" = "1" ]; then
      tar -C "$(dirname "$CUSTOM_CANVAS_BLOB_DIR_PATH")" -czf "$dir/canvas-blobs.tgz" \
        "$(basename "$CUSTOM_CANVAS_BLOB_DIR_PATH")"
    fi
  fi

  if [ -d "$VIDEO_WORKSHOP_PROJECTS_DIR" ]; then
    find "$VIDEO_WORKSHOP_PROJECTS_DIR" -maxdepth 1 -type f -name '*.json' \
      -exec cp -p {} "$video_backup_dir/projects/" \;
  fi
  if [ -d "$VIDEO_WORKSHOP_UPLOAD_DIR" ]; then
    find "$VIDEO_WORKSHOP_UPLOAD_DIR" -type f -print | sort > "$video_backup_dir/uploads.manifest"
    if [ "${BACKUP_VIDEO_MEDIA:-${BACKUP_MEDIA:-0}}" = "1" ]; then
      tar -C "$(dirname "$VIDEO_WORKSHOP_UPLOAD_DIR")" -czf "$video_backup_dir/uploads.tgz" \
        "$(basename "$VIDEO_WORKSHOP_UPLOAD_DIR")"
    fi
  fi
  if [ -d "$VIDEO_WORKSHOP_OUTPUT_DIR" ]; then
    find "$VIDEO_WORKSHOP_OUTPUT_DIR" -type f -print | sort > "$video_backup_dir/outputs.manifest"
    if [ "${BACKUP_VIDEO_MEDIA:-${BACKUP_MEDIA:-0}}" = "1" ]; then
      tar -C "$(dirname "$VIDEO_WORKSHOP_OUTPUT_DIR")" -czf "$video_backup_dir/outputs.tgz" \
        "$(basename "$VIDEO_WORKSHOP_OUTPUT_DIR")"
    fi
  fi
  if [ -d "$BGM_LIBRARY_DIR" ]; then
    find "$BGM_LIBRARY_DIR" -maxdepth 1 -type f -print | sort > "$video_backup_dir/bgm-library.manifest"
  fi
  echo "Runtime data snapshot: $dir"
}

stop_pid_file() {
  local pid_file="$1"
  if [ ! -f "$pid_file" ]; then
    return
  fi
  local pid
  pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
  fi
  rm -f "$pid_file"
}

stop_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi
  local old_pids
  old_pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$old_pids" ]; then
    echo "Stopping old process on port $port: $old_pids"
    kill $old_pids 2>/dev/null || true
    sleep 1
  fi
}

wait_for_health() {
  local python_bin="$1"
  local url="$2"
  local label="$3"
  "$python_bin" - "$url" "$label" <<'PY'
import json
import sys
import time
import urllib.request

url, label = sys.argv[1:3]
last_error = ""
for _ in range(40):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            payload = response.read().decode("utf-8")
        data = json.loads(payload)
        if data.get("ok"):
            print(f"{label} health: {payload}")
            raise SystemExit(0)
        last_error = payload[:300]
    except Exception as exc:
        last_error = f"{exc.__class__.__name__}: {exc}"
    time.sleep(0.5)
print(f"{label} health check failed: {last_error}", file=sys.stderr)
raise SystemExit(1)
PY
}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python3 not found. Please install Python 3.10+ first." >&2
  exit 1
fi
for binary in ffmpeg ffprobe; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "$binary not found. Install FFmpeg before starting the video workshop." >&2
    exit 1
  fi
done
if [ ! -f "$VIDEO_APP_DIR/requirements.txt" ] || [ ! -f "$VIDEO_APP_DIR/run.py" ]; then
  echo "Bundled video workshop is incomplete: $VIDEO_APP_DIR" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/vendor/infinite-canvas/index.html" ]; then
  echo "Bundled infinite-canvas static build is missing." >&2
  exit 1
fi

if [ ! -d "$MAIN_VENV" ]; then
  "$PYTHON_BIN" -m venv "$MAIN_VENV"
fi
"$MAIN_VENV/bin/python" -m pip install --upgrade pip
"$MAIN_VENV/bin/python" -m pip install -r "$APP_DIR/server/requirements.txt"

if [ ! -d "$VIDEO_VENV" ]; then
  "$PYTHON_BIN" -m venv "$VIDEO_VENV"
fi
"$VIDEO_VENV/bin/python" -m pip install --upgrade pip
"$VIDEO_VENV/bin/python" -m pip install -r "$VIDEO_APP_DIR/requirements.txt"

stop_pid_file "$MAIN_PID_FILE"
stop_pid_file "$VIDEO_PID_FILE"
stop_port "$PORT"
stop_port "$VIDEO_WORKSHOP_PORT"

# A previous local/server run may have stored data beside the sidecar code.
# After stopping writers, copy it into persistent storage without deleting or
# replacing either side, then snapshot the consistent runtime state.
migrate_legacy_tree "$VIDEO_APP_DIR/data/projects" "$VIDEO_WORKSHOP_PROJECTS_DIR"
migrate_legacy_tree "$VIDEO_APP_DIR/outputs" "$VIDEO_WORKSHOP_OUTPUT_DIR"
migrate_legacy_tree "$VIDEO_APP_DIR/uploads" "$VIDEO_WORKSHOP_UPLOAD_DIR"
if [ "$BGM_SOURCE" != "platform" ]; then
  migrate_legacy_tree "$VIDEO_APP_DIR/music_library" "$BGM_LIBRARY_DIR"
fi
backup_runtime_data

(
  cd "$VIDEO_APP_DIR"
  exec nohup "$VIDEO_VENV/bin/python" run.py
) > "$VIDEO_LOG" 2>&1 &
echo $! > "$VIDEO_PID_FILE"
if ! wait_for_health "$VIDEO_VENV/bin/python" "$VIDEO_WORKSHOP_HEALTH_URL/api/health" "Video workshop"; then
  stop_pid_file "$VIDEO_PID_FILE"
  exit 1
fi

nohup "$MAIN_VENV/bin/python" -m uvicorn server.main:app --host "$HOST" --port "$PORT" > "$MAIN_LOG" 2>&1 &
echo $! > "$MAIN_PID_FILE"
if ! wait_for_health "$MAIN_VENV/bin/python" "http://127.0.0.1:${PORT}/api/health" "Main service"; then
  stop_pid_file "$MAIN_PID_FILE"
  stop_pid_file "$VIDEO_PID_FILE"
  exit 1
fi

echo "Started Dumate Studio on http://localhost:${PORT}"
echo "Started video workshop sidecar on ${VIDEO_WORKSHOP_HEALTH_URL} (loopback only)"
