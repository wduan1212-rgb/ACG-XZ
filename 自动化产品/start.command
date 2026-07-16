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

# 优先读取 .env.local。不要直接 source：文件里可能有带空格/中文的配置，
# 双击启动时直接 source 会因为未加引号的值中断，导致又回落到旧 devKeys。
if [ -f ".env.local" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ""|\#*) continue ;; esac
    case "$key" in *[!A-Za-z0-9_]* ) continue ;; esac
    value="${value%$'\r'}"
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    export "$key=$value"
  done < ".env.local"
fi

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

echo "Dumate Studio 共享后端启动中… http://localhost:${PORT}/#/overview  （Ctrl+C 退出）"
echo "定制创作视频工坊已在 127.0.0.1:8765 就绪，不对局域网单独暴露。"
echo "登录账号请联系管理员；新成员可在登录页提交账号申请。"
( sleep 2 && open "http://localhost:${PORT}/#/overview" ) &
# 强制使用纯 Python 的 asyncio + h11，避开部分 macOS/Python 环境下
# uvicorn 自动选择 httptools/uvloop 后在长轮询时触发 Segmentation fault: 11。
python3 -m uvicorn server.main:app --host 0.0.0.0 --port "${PORT}" --loop asyncio --http h11
MAIN_STATUS=$?
stop_local_video_workshop

echo ""
echo "—— 服务端已退出 ——"
echo "若上方有红色报错，请截图发给协作方定位。"
read -r -p "按回车关闭窗口..."
exit "$MAIN_STATUS"
