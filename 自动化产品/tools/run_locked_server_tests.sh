#!/usr/bin/env bash
set -euo pipefail

# Run the complete main-service suite in a disposable, offline, secret-free
# environment.  This is deliberately separate from the production runtime
# venv: requests/urllib3 exist only because Starlette 0.14 TestClient needs
# them, and production dependency verification must continue to reject them.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_LOCK="$APP_ROOT/server/requirements.lock.txt"
TEST_LOCK="$APP_ROOT/server/requirements-test.lock.txt"
VERIFIER="$APP_ROOT/deploy/verify_offline_dependencies.py"

BASE_PYTHON=""
WHEELHOUSE=""
MANIFEST_SHA256=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --python)
      BASE_PYTHON="${2:-}"
      shift 2
      ;;
    --wheelhouse)
      WHEELHOUSE="${2:-}"
      shift 2
      ;;
    --confirm-manifest-sha256)
      MANIFEST_SHA256="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -x "$BASE_PYTHON" ]; then
  echo "--python must identify the target-compatible Python executable." >&2
  exit 2
fi
if [ ! -d "$WHEELHOUSE" ]; then
  echo "--wheelhouse must identify the verified test wheelhouse." >&2
  exit 2
fi
if ! [[ "$MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "--confirm-manifest-sha256 must be an independently recorded SHA-256." >&2
  exit 2
fi

for required_tool in node ffmpeg ffprobe git; do
  if ! command -v "$required_tool" >/dev/null 2>&1; then
    echo "Secret-free full regression requires $required_tool on PATH." >&2
    exit 2
  fi
done
if ! node --experimental-strip-types -e '' >/dev/null 2>&1; then
  echo "Node must support --experimental-strip-types for canvas tests." >&2
  exit 2
fi
echo "Toolchain: $($BASE_PYTHON --version 2>&1)"
echo "Toolchain: $(node --version)"
echo "Toolchain: $(git --version)"
ffmpeg -version

# A passing result must not be attributable to a developer's ignored config.
for local_env in \
  "$APP_ROOT/.env.local" \
  "$APP_ROOT/.env" \
  "$APP_ROOT/apps/video-workshop/.env.local" \
  "$APP_ROOT/apps/video-workshop/.env"; do
  if [ -e "$local_env" ]; then
    echo "Secret-free test refused: local environment file is present." >&2
    exit 2
  fi
done

"$BASE_PYTHON" "$VERIFIER" extends \
  --base-lock "$RUNTIME_LOCK" \
  --extended-lock "$TEST_LOCK" \
  --allow-extra requests \
  --allow-extra urllib3
"$BASE_PYTHON" "$VERIFIER" verify-wheelhouse \
  --python "$BASE_PYTHON" \
  --lock "$TEST_LOCK" \
  --root "$WHEELHOUSE" \
  --confirm-manifest-sha256 "$MANIFEST_SHA256"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/acg-locked-server-tests.XXXXXX")"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

"$BASE_PYTHON" -m venv "$TEST_ROOT/venv"
TEST_PYTHON="$TEST_ROOT/venv/bin/python"
"$TEST_PYTHON" -m pip install \
  --isolated \
  --disable-pip-version-check \
  --no-index \
  --no-deps \
  --find-links "$WHEELHOUSE" \
  --requirement "$TEST_LOCK"
"$TEST_PYTHON" "$VERIFIER" installed \
  --python "$TEST_PYTHON" \
  --lock "$TEST_LOCK"
"$TEST_PYTHON" -m pip check

RUNTIME_ROOT="$TEST_ROOT/runtime"
mkdir -p \
  "$TEST_ROOT/home" \
  "$TEST_ROOT/cache" \
  "$TEST_ROOT/tmp" \
  "$RUNTIME_ROOT/uploads" \
  "$RUNTIME_ROOT/composed" \
  "$RUNTIME_ROOT/canvas-blobs" \
  "$RUNTIME_ROOT/usage-spool" \
  "$RUNTIME_ROOT/video-projects" \
  "$RUNTIME_ROOT/video-outputs" \
  "$RUNTIME_ROOT/video-uploads" \
  "$RUNTIME_ROOT/bgm" \
  "$RUNTIME_ROOT/model-cache"

CLEAN_ENV=(
  env -i
  "PATH=$PATH"
  "HOME=$TEST_ROOT/home"
  "XDG_CACHE_HOME=$TEST_ROOT/cache"
  "PYTHONPATH=$APP_ROOT"
  "PYTHONUNBUFFERED=1"
  "PYTHONDONTWRITEBYTECODE=1"
  "TMPDIR=$TEST_ROOT/tmp"
  "ACG_RUNTIME_MODE=test"
  "ACG_DB_BOOTSTRAP_MODE=auto"
  "ACG_READ_ONLY=0"
  "DATA_DB=$RUNTIME_ROOT/data.sqlite"
  "LEGACY_DATA_FILE=$RUNTIME_ROOT/data.json"
  "MODEL_USAGE_COMPLETION_SPOOL_DIR=$RUNTIME_ROOT/usage-spool"
  "UPLOAD_DIR=$RUNTIME_ROOT/uploads"
  "COMPOSED_DIR=$RUNTIME_ROOT/composed"
  "CUSTOM_CANVAS_BLOB_DIR=$RUNTIME_ROOT/canvas-blobs"
  "VIDEO_WORKSHOP_PROJECTS_DIR=$RUNTIME_ROOT/video-projects"
  "VIDEO_WORKSHOP_OUTPUT_DIR=$RUNTIME_ROOT/video-outputs"
  "VIDEO_WORKSHOP_UPLOAD_DIR=$RUNTIME_ROOT/video-uploads"
  "BGM_LIBRARY_DIR=$RUNTIME_ROOT/bgm"
  "HF_HOME=$RUNTIME_ROOT/model-cache"
  "LLM_API_KEY="
  "IMAGE_API_KEY="
  "MINIMAX_API_KEY="
  "SEEDANCE_API_KEY="
)

"${CLEAN_ENV[@]}" "$TEST_PYTHON" -c \
  'from server import config; assert config.loaded_environment_files() == ()'
"${CLEAN_ENV[@]}" "$TEST_PYTHON" \
  "$APP_ROOT/tools/run_server_unittest_suite.py" \
  "$APP_ROOT/server/tests"
