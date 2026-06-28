#!/bin/bash
# Dumate Studio 真实数据后端启动（双击运行）
cd "$(dirname "$0")"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 Python3。请先安装 Python3。"
  read -r -p "按回车退出..."
  exit 1
fi

if [ -z "$JUSTONEAPI_KEY" ]; then
  echo "请输入 JustOneAPI Token（输入时不会显示，直接粘贴后回车）："
  stty -echo
  read -r JUSTONEAPI_KEY
  stty echo
  echo ""
  export JUSTONEAPI_KEY
fi

if [ -z "$JUSTONEAPI_KEY" ]; then
  echo "没有输入 Token，无法启动真实数据抓取。"
  read -r -p "按回车退出..."
  exit 1
fi

python3 - <<'PY'
import importlib.util
import subprocess
import sys

missing = [pkg for pkg in ("fastapi", "uvicorn", "httpx") if importlib.util.find_spec(pkg) is None]
if missing:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "server/requirements.txt"])
PY

echo "Dumate Studio 真实数据后端启动中…"
echo "访问地址：http://localhost:4288/#/analytics"
( sleep 1 && open "http://localhost:4288/#/analytics" ) &
exec python3 -m uvicorn server.main:app --host 0.0.0.0 --port 4288
