#!/bin/bash
# Dumate Studio 一键启动（双击运行）
# 当前版本使用共享后端，并在本机回环地址启动独立视频工坊 sidecar。
cd "$(dirname "$0")"
APP_DIR="$(pwd)"

# Finder/Terminal 双击 .command 时通常不会加载 zsh 配置，
# 需要手动补上 Homebrew 和常见 Python/Node 安装路径。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"
export NO_PROXY="${NO_PROXY},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"
export no_proxy="${no_proxy},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"

# 优先读取当前 worktree 的 .env.local；干净 worktree 没复制私密文件时，
# 自动沿 Git common dir 找主工作区的同一份配置。不要直接 source：文件里
# 可能有带空格/中文的值，直接执行会把值的一部分误当命令。
LOCAL_ENV_FILE=""
if [ -f ".env.local" ]; then
  LOCAL_ENV_FILE="$APP_DIR/.env.local"
elif [ -n "${FALLBACK_ENV:-}" ] && [ -f "$FALLBACK_ENV" ]; then
  LOCAL_ENV_FILE="$FALLBACK_ENV"
elif command -v git >/dev/null 2>&1; then
  GIT_COMMON_DIR="$(git -C "$APP_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$GIT_COMMON_DIR" ]; then
    case "$GIT_COMMON_DIR" in
      /*) ;;
      *) GIT_COMMON_DIR="$(cd "$APP_DIR" && cd "$GIT_COMMON_DIR" 2>/dev/null && pwd || true)" ;;
    esac
    MAIN_ENV_CANDIDATE="$(dirname "$GIT_COMMON_DIR")/自动化产品/.env.local"
    if [ -f "$MAIN_ENV_CANDIDATE" ]; then LOCAL_ENV_FILE="$MAIN_ENV_CANDIDATE"; fi
  fi
fi
if [ -n "$LOCAL_ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ""|\#*) continue ;; esac
    case "$key" in *[!A-Za-z0-9_]* ) continue ;; esac
    value="${value%$'\r'}"
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    export "$key=$value"
  done < "$LOCAL_ENV_FILE"
  export FALLBACK_ENV="$LOCAL_ENV_FILE"
fi

# 本地恢复点必须整体绑定，不能只拿恢复库却继续读默认媒体目录，更不能
# 在未配置 DATA_DB 时悄悄回落到一个空的 server/data.sqlite。当前工作区
# 恰好只有一个完整恢复点时自动采用；存在多个候选时要求显式选择，避免
# 重启后会话和媒体看起来“消失”或串到另一份快照。
if [ -z "${DATA_DB:-}" ]; then
  LOCAL_RESTORE_CANDIDATES=()
  for candidate in "$APP_DIR"/server/local-restore-*; do
    [ -d "$candidate" ] || continue
    restore_name="$(basename "$candidate")"
    video_root="$APP_DIR/runtime/$restore_name/video-workshop"
    if [ -f "$candidate/data.sqlite" ] \
      && [ -d "$candidate/uploads" ] \
      && [ -d "$candidate/composed" ] \
      && [ -d "$candidate/canvas_blobs" ] \
      && [ -d "$video_root/projects" ] \
      && [ -d "$video_root/uploads" ] \
      && [ -d "$video_root/outputs" ]; then
      LOCAL_RESTORE_CANDIDATES+=("$restore_name")
    fi
  done
  if [ "${#LOCAL_RESTORE_CANDIDATES[@]}" -gt 1 ]; then
    echo "检测到多个完整本地恢复点，请在 .env.local 中显式设置 DATA_DB 及配套媒体目录："
    printf '  %s\n' "${LOCAL_RESTORE_CANDIDATES[@]}"
    read -r -p "按回车退出..."
    exit 1
  elif [ "${#LOCAL_RESTORE_CANDIDATES[@]}" -eq 1 ]; then
    LOCAL_RESTORE_NAME="${LOCAL_RESTORE_CANDIDATES[0]}"
    LOCAL_RESTORE_SERVER_ROOT="$APP_DIR/server/$LOCAL_RESTORE_NAME"
    LOCAL_RESTORE_VIDEO_ROOT="$APP_DIR/runtime/$LOCAL_RESTORE_NAME/video-workshop"
    export DATA_DB="$LOCAL_RESTORE_SERVER_ROOT/data.sqlite"
    export UPLOAD_DIR="$LOCAL_RESTORE_SERVER_ROOT/uploads"
    export COMPOSED_DIR="$LOCAL_RESTORE_SERVER_ROOT/composed"
    export CUSTOM_CANVAS_BLOB_DIR="$LOCAL_RESTORE_SERVER_ROOT/canvas_blobs"
    export VIDEO_WORKSHOP_PROJECTS_DIR="$LOCAL_RESTORE_VIDEO_ROOT/projects"
    export VIDEO_WORKSHOP_UPLOAD_DIR="$LOCAL_RESTORE_VIDEO_ROOT/uploads"
    export VIDEO_WORKSHOP_OUTPUT_DIR="$LOCAL_RESTORE_VIDEO_ROOT/outputs"
    echo "本地运行数据已绑定恢复点：$LOCAL_RESTORE_NAME"
  fi
fi

# Finder launchers are always local/test-compatible.  Production uses the
# dedicated deploy launcher, which validates an explicit migration ledger.
export ACG_RUNTIME_MODE="local"
export ACG_DB_BOOTSTRAP_MODE="auto"
export ACG_READ_ONLY="0"

export IMAGE_BASE_URL="${IMAGE_BASE_URL:-https://tokenhub.tencentmaas.com/v1}"
export IMAGE_ENDPOINT="${IMAGE_ENDPOINT:-https://tokenhub.tencentmaas.com/v1/aiart/gtimage}"
export IMAGE_MODEL="${IMAGE_MODEL:-custom-imagemodel-gt}"
export IMAGE_MODE="${IMAGE_MODE:-gpt-maas}"
export MINIMAX_BASE_URL="${MINIMAX_BASE_URL:-https://api.minimaxi.com}"
export MINIMAX_TTS_MODEL="${MINIMAX_TTS_MODEL:-speech-2.8-hd}"
export MINIMAX_VOICE_ID="${MINIMAX_VOICE_ID:-presenter_female}"

# 本机测试用：如果没有通过环境变量配置图片 Key，则从本地 devKeys 读取。
# 服务器部署时建议只配服务端环境变量，不依赖 js/local/devKeys.js。
if [ -z "$IMAGE_API_KEY" ] && [ -f "js/local/devKeys.js" ]; then
  IMAGE_API_KEY="$(python3 -c 'import re; text=open("js/local/devKeys.js", encoding="utf-8").read(); m=re.search("LOCAL_IMAGE_KEY\\s*=\\s*\\\"([^\\\"]+)\\\"", text); print(m.group(1) if m else "")' 2>/dev/null)"
  export IMAGE_API_KEY
fi
if [ -z "$MINIMAX_API_KEY" ] && [ -f "js/local/devKeys.js" ]; then
  MINIMAX_API_KEY="$(python3 -c 'import re; text=open("js/local/devKeys.js", encoding="utf-8").read(); m=re.search("LOCAL_MINIMAX_KEY\\s*=\\s*\\\"([^\\\"]+)\\\"", text); print(m.group(1) if m else "")' 2>/dev/null)"
  export MINIMAX_API_KEY
fi

# 视频工坊三条真实调用链必须在页面开放前全部具备配置。缺失时直接
# 停止启动，避免用户写完指令后才看到“API Key 未配置”。
MISSING_VIDEO_KEYS=()
for key in LLM_API_KEY SEEDANCE_API_KEY MINIMAX_API_KEY; do
  if [ -z "${!key:-}" ]; then MISSING_VIDEO_KEYS+=("$key"); fi
done
if [ "${#MISSING_VIDEO_KEYS[@]}" -gt 0 ]; then
  echo "视频工坊启动已停止：缺少 ${MISSING_VIDEO_KEYS[*]}。"
  echo "请在当前 .env.local、FALLBACK_ENV 或主工作区 .env.local 中补齐后重试。"
  read -r -p "按回车退出..."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 Python3。请先安装 Python3，然后重新双击 start.command。"
  read -r -p "按回车退出..."
  exit 1
fi

PORT=8787

STALE=$(lsof -ti tcp:${PORT} 2>/dev/null)
if [ -n "$STALE" ]; then
  echo "端口 ${PORT} 被旧进程占用（PID: $STALE），正在结束它…"
  kill $STALE 2>/dev/null; sleep 1
  kill -9 $STALE 2>/dev/null; sleep 1
fi

python3 - <<'PY'
import importlib.util, subprocess, sys
missing = [p for p in ("fastapi", "uvicorn", "httpx") if importlib.util.find_spec(p) is None]
if missing:
    print("首次运行：安装依赖", missing)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "server/requirements.txt"])
PY

if [ ! -f "$APP_DIR/deploy/local_video_workshop.sh" ]; then
  echo "缺少 deploy/local_video_workshop.sh，无法启动视频工坊。"
  read -r -p "按回车退出..."
  exit 1
fi
# shellcheck disable=SC1091
. "$APP_DIR/deploy/local_video_workshop.sh"
if ! prepare_local_video_workshop || ! start_local_video_workshop; then
  read -r -p "按回车退出..."
  exit 1
fi
trap stop_local_video_workshop EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

echo "Dumate Studio 共享后端启动中… http://localhost:${PORT}/#/home  （Ctrl+C 退出）"
echo "定制创作视频工坊已在 127.0.0.1:8765 就绪，不对局域网单独暴露。"
echo "登录账号请联系管理员；新成员可在登录页提交账号申请。"
( sleep 2 && open "http://localhost:${PORT}/#/home" ) &
# 强制使用纯 Python 的 asyncio + h11，避开部分 macOS/Python 环境下
# uvicorn 自动选择 httptools/uvloop 后在长轮询时触发 Segmentation fault: 11。
# 主服务与 sidecar 具有明确实例归属；sidecar 意外退出时仅本实例看门狗重启它。
python3 -m uvicorn server.main:app --host 0.0.0.0 --port "${PORT}" --loop asyncio --http h11 &
MAIN_PID=$!
start_local_video_workshop_watchdog "$MAIN_PID"
wait "$MAIN_PID"
MAIN_STATUS=$?
stop_local_video_workshop

echo ""
echo "—— 服务端已退出 ——"
echo "若上方有红色报错，请截图发给协作方定位。"
read -r -p "按回车关闭窗口..."
exit "$MAIN_STATUS"
