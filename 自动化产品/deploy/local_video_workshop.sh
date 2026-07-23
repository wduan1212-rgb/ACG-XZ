#!/bin/bash
# Shared lifecycle helpers for Finder/Terminal .command launchers.
# The caller must set APP_DIR before sourcing this file.

LOCAL_VIDEO_WORKSHOP_PID=""
LOCAL_VIDEO_WORKSHOP_WATCHDOG_PID=""
# 同一台开发机可能误开多个 Finder/Terminal 启动器。PID 文件除了记录
# sidecar PID，还记录本次启动器的实例标识；旧启动器退出时只能清理自己
# 启动的 sidecar，不能把新启动器接管后的服务误停掉。
LOCAL_VIDEO_WORKSHOP_INSTANCE="${LOCAL_VIDEO_WORKSHOP_INSTANCE:-local-${PPID}-${RANDOM}-${RANDOM}}"
export LOCAL_VIDEO_WORKSHOP_INSTANCE
VIDEO_WORKSHOP_APP_DIR="$APP_DIR/apps/video-workshop"
VIDEO_WORKSHOP_VENV="$VIDEO_WORKSHOP_APP_DIR/.venv"
VIDEO_WORKSHOP_PYTHON="$VIDEO_WORKSHOP_VENV/bin/python"
VIDEO_WORKSHOP_PID_FILE="$APP_DIR/logs/video-workshop.pid"
VIDEO_WORKSHOP_LOG_FILE="$APP_DIR/logs/video-workshop-local.log"

prepare_local_video_workshop() {
  export VIDEO_WORKSHOP_HOST="127.0.0.1"
  export VIDEO_WORKSHOP_PORT="8765"
  export VIDEO_WORKSHOP_URL="http://127.0.0.1:8765"
  export VIDEO_WORKSHOP_PROJECTS_DIR="$APP_DIR/runtime/video-workshop/projects"
  export VIDEO_WORKSHOP_OUTPUT_DIR="$APP_DIR/runtime/video-workshop/outputs"
  export VIDEO_WORKSHOP_UPLOAD_DIR="$APP_DIR/runtime/video-workshop/uploads"
  export BGM_SOURCE="${BGM_SOURCE:-platform}"
  export DATA_DB="${DATA_DB:-$APP_DIR/server/data.sqlite}"
  export UPLOAD_DIR="${UPLOAD_DIR:-$APP_DIR/server/uploads}"
  export CUSTOM_CANVAS_BLOB_DIR="${CUSTOM_CANVAS_BLOB_DIR:-$APP_DIR/server/canvas_blobs}"
  export BGM_LIBRARY_DIR="${BGM_LIBRARY_DIR:-$APP_DIR/runtime/bgm-library}"
  export HF_HOME="$APP_DIR/runtime/model-cache"

  mkdir -p \
    "$APP_DIR/logs" \
    "$VIDEO_WORKSHOP_PROJECTS_DIR" \
    "$VIDEO_WORKSHOP_OUTPUT_DIR" \
    "$VIDEO_WORKSHOP_UPLOAD_DIR" \
    "$CUSTOM_CANVAS_BLOB_DIR" \
    "$HF_HOME"
  if [ "$BGM_SOURCE" != "platform" ]; then
    mkdir -p "$BGM_LIBRARY_DIR"
  fi

  if [ ! -f "$VIDEO_WORKSHOP_APP_DIR/run.py" ] || [ ! -f "$VIDEO_WORKSHOP_APP_DIR/requirements.txt" ]; then
    echo "视频工坊项目内副本不完整，请确认 apps/video-workshop 已复制到当前项目。"
    return 1
  fi
  for binary in ffmpeg ffprobe; do
    if ! command -v "$binary" >/dev/null 2>&1; then
      echo "未找到 ${binary}，视频工坊无法完成本地视频处理。请先安装 FFmpeg。"
      return 1
    fi
  done

  if [ ! -x "$VIDEO_WORKSHOP_PYTHON" ]; then
    echo "首次运行：创建视频工坊独立 Python 环境…"
    if ! python3 -m venv "$VIDEO_WORKSHOP_VENV"; then
      echo "创建视频工坊 Python 环境失败。"
      return 1
    fi
  fi

  local requirements_hash marker_hash marker_file
  marker_file="$VIDEO_WORKSHOP_VENV/.requirements.sha256"
  requirements_hash="$(shasum -a 256 "$VIDEO_WORKSHOP_APP_DIR/requirements.txt" | awk '{print $1}')"
  marker_hash="$(cat "$marker_file" 2>/dev/null || true)"
  if [ "$requirements_hash" != "$marker_hash" ]; then
    echo "首次运行或依赖有更新：安装视频工坊依赖…"
    if ! "$VIDEO_WORKSHOP_PYTHON" -m pip install -r "$VIDEO_WORKSHOP_APP_DIR/requirements.txt"; then
      echo "视频工坊依赖安装失败，请检查网络或 Python 版本。"
      return 1
    fi
    printf '%s\n' "$requirements_hash" > "$marker_file"
  fi
}

stop_local_video_workshop() {
  local pid="${LOCAL_VIDEO_WORKSHOP_PID:-}" recorded="" recorded_instance=""
  if [ -f "$VIDEO_WORKSHOP_PID_FILE" ]; then
    read -r recorded recorded_instance < "$VIDEO_WORKSHOP_PID_FILE" || true
  fi
  # 看门狗可能已重启 sidecar，此时由同一个实例记录的新 PID 才属于当前
  # 启动器。不同实例的记录一律不触碰，避免并行启动时互相误杀。
  if [ "$recorded_instance" = "$LOCAL_VIDEO_WORKSHOP_INSTANCE" ] && [ -n "$recorded" ]; then
    pid="$recorded"
  fi
  if [ -n "${LOCAL_VIDEO_WORKSHOP_WATCHDOG_PID:-}" ] \
    && kill -0 "$LOCAL_VIDEO_WORKSHOP_WATCHDOG_PID" 2>/dev/null; then
    kill "$LOCAL_VIDEO_WORKSHOP_WATCHDOG_PID" 2>/dev/null || true
    wait "$LOCAL_VIDEO_WORKSHOP_WATCHDOG_PID" 2>/dev/null || true
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [ -f "$VIDEO_WORKSHOP_PID_FILE" ]; then
    if [ "$recorded_instance" = "$LOCAL_VIDEO_WORKSHOP_INSTANCE" ]; then
      rm -f "$VIDEO_WORKSHOP_PID_FILE"
    fi
  fi
  LOCAL_VIDEO_WORKSHOP_PID=""
  LOCAL_VIDEO_WORKSHOP_WATCHDOG_PID=""
}

start_local_video_workshop() {
  local stale
  stale="$(lsof -ti tcp:8765 2>/dev/null || true)"
  if [ -n "$stale" ]; then
    echo "端口 8765 被旧视频工坊占用（PID: $stale），正在结束它…"
    kill $stale 2>/dev/null || true
    sleep 1
    kill -9 $stale 2>/dev/null || true
  fi

  (
    cd "$VIDEO_WORKSHOP_APP_DIR" || exit 1
    exec "$VIDEO_WORKSHOP_PYTHON" run.py
  ) > "$VIDEO_WORKSHOP_LOG_FILE" 2>&1 &
  LOCAL_VIDEO_WORKSHOP_PID=$!
  printf '%s %s\n' "$LOCAL_VIDEO_WORKSHOP_PID" "$LOCAL_VIDEO_WORKSHOP_INSTANCE" > "$VIDEO_WORKSHOP_PID_FILE"

  if ! "$VIDEO_WORKSHOP_PYTHON" - <<'PY'
import json
import time
import urllib.request

last_error = ""
for _ in range(40):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=2) as response:
            data = json.load(response)
        if data.get("ok"):
            raise SystemExit(0)
        last_error = str(data)[:300]
    except Exception as exc:
        last_error = f"{exc.__class__.__name__}: {exc}"
    time.sleep(0.25)
print(f"视频工坊健康检查失败：{last_error}")
raise SystemExit(1)
PY
  then
    echo "视频工坊启动失败，最近日志："
    tail -n 40 "$VIDEO_WORKSHOP_LOG_FILE" 2>/dev/null || true
    stop_local_video_workshop
    return 1
  fi
  echo "视频工坊 sidecar 已启动：http://127.0.0.1:8765（仅本机回环访问）"
}

local_video_workshop_healthy() {
  "$VIDEO_WORKSHOP_PYTHON" - <<'PY'
import json
import urllib.request

try:
    with urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=2) as response:
        data = json.load(response)
    raise SystemExit(0 if data.get("ok") else 1)
except Exception:
    raise SystemExit(1)
PY
}

start_local_video_workshop_watchdog() {
  local main_pid="$1"
  local log_file="$VIDEO_WORKSHOP_LOG_FILE"
  (
    local failed_checks=0
    while kill -0 "$main_pid" 2>/dev/null; do
      if local_video_workshop_healthy; then
        failed_checks=0
      else
        failed_checks=$((failed_checks + 1))
        # 连续两次失败再重启，避免单次健康请求抖动误杀正在处理任务的 sidecar。
        if [ "$failed_checks" -ge 2 ]; then
          printf '%s sidecar health lost; restarting for active main pid=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$main_pid" >> "$log_file"
          if start_local_video_workshop; then
            failed_checks=0
          else
            printf '%s sidecar restart failed; will retry while main stays alive\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$log_file"
          fi
        fi
      fi
      sleep 4
    done
  ) &
  LOCAL_VIDEO_WORKSHOP_WATCHDOG_PID=$!
}
