#!/usr/bin/env bash
set -euo pipefail

ROOT="${ACG_WHISPER_HOME:-$HOME/.cache/acg-xz/whisper.cpp}"
MODEL="${ACG_WHISPER_MODEL_NAME:-base}"

if ! command -v git >/dev/null 2>&1; then
  echo "缺少 git，无法安装 whisper.cpp" >&2
  exit 1
fi
if ! command -v cmake >/dev/null 2>&1; then
  echo "缺少 cmake，请先由运维安装后重试" >&2
  exit 1
fi

mkdir -p "$(dirname "$ROOT")"
if [ -d "$ROOT/.git" ]; then
  git -C "$ROOT" pull --ff-only
else
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$ROOT"
fi

cmake -S "$ROOT" -B "$ROOT/build" \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$ROOT/build" --config Release -j "${WHISPER_BUILD_JOBS:-4}"

if [ ! -s "$ROOT/models/ggml-${MODEL}.bin" ]; then
  "$ROOT/models/download-ggml-model.sh" "$MODEL"
fi

echo "whisper.cpp 已安装：$ROOT/build/bin/whisper-cli"
echo "模型已安装：$ROOT/models/ggml-${MODEL}.bin"
