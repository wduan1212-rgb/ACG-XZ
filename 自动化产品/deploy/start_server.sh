#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIDEO_APP_DIR="$APP_DIR/apps/video-workshop"
cd "$APP_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export NO_PROXY="${NO_PROXY:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"
export no_proxy="${no_proxy:-},localhost,127.0.0.1,::1,api.dbh.baidu-int.com,.baidu-int.com"

PYTHON_BIN="${PYTHON_BIN:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python3 not found. Please install Python 3.10+ first." >&2
  exit 1
fi

load_external_environment() {
  local env_file="$1"
  local payload key value
  case "$env_file" in
    /*) ;;
    *)
      echo "ACG_ENV_FILE must be an absolute path." >&2
      return 1
      ;;
  esac
  if [ ! -f "$env_file" ]; then
    echo "ACG_ENV_FILE must already exist as a regular file." >&2
    return 1
  fi
  payload="$(mktemp "${TMPDIR:-/tmp}/acg-runtime-env.XXXXXX")"
  if ! "$PYTHON_BIN" - "$env_file" > "$payload" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    lines = path.read_text("utf-8").splitlines()
except (OSError, UnicodeError) as exc:
    print(f"cannot read ACG_ENV_FILE: {exc}", file=sys.stderr)
    raise SystemExit(1)

for raw_line in lines:
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        continue
    if len(value) >= 2 and value[:1] == value[-1:] and value[:1] in {'"', "'"}:
        value = value[1:-1]
    if "\0" in value:
        print(f"invalid NUL in environment value: {key}", file=sys.stderr)
        raise SystemExit(1)
    sys.stdout.buffer.write(key.encode("ascii") + b"\0")
    sys.stdout.buffer.write(value.encode("utf-8") + b"\0")
PY
  then
    rm -f "$payload"
    return 1
  fi
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$payload"
  rm -f "$payload"
}

if [ -n "${ACG_ENV_FILE:-}" ]; then
  load_external_environment "$ACG_ENV_FILE"
fi

PORT="${PORT:-8787}"
HOST="${HOST:-::}"
VIDEO_WORKSHOP_HOST="${VIDEO_WORKSHOP_HOST:-127.0.0.1}"
VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"
VIDEO_WORKSHOP_URL="${VIDEO_WORKSHOP_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"
VIDEO_WORKSHOP_HEALTH_URL="${VIDEO_WORKSHOP_HEALTH_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"
BACKUP_ROOT="${BACKUP_ROOT:-$APP_DIR/backups}"
LOG_DIR="${LOG_DIR:-$APP_DIR/logs}"
DATA_DB_PATH="${DATA_DB:-$APP_DIR/server/data.sqlite}"
MODEL_USAGE_COMPLETION_SPOOL_DIR_PATH="${MODEL_USAGE_COMPLETION_SPOOL_DIR:-$APP_DIR/server/model_usage_spool}"
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
SQLITE_BACKUP_SCRIPT="$APP_DIR/server/scripts/consistent_sqlite_backup.py"
RELEASE_CONTRACT_VERIFIER="$APP_DIR/deploy/verify_release_contracts.sh"
DEPENDENCY_CONTRACT_VERIFIER="$APP_DIR/deploy/verify_offline_dependencies.py"
PRODUCTION_WRITE_GATE_VERIFIER="$APP_DIR/deploy/verify_production_write_gate.py"
MAIN_DEPENDENCY_LOCK="$APP_DIR/server/requirements.lock.txt"
VIDEO_DEPENDENCY_LOCK="$VIDEO_APP_DIR/requirements.lock.txt"

export VIDEO_WORKSHOP_HOST VIDEO_WORKSHOP_PORT VIDEO_WORKSHOP_URL
export VIDEO_WORKSHOP_PROJECTS_DIR VIDEO_WORKSHOP_OUTPUT_DIR VIDEO_WORKSHOP_UPLOAD_DIR
export BGM_SOURCE BGM_LIBRARY_DIR HF_HOME
# Both services receive the exact same storage locations. The video sidecar
# opens these paths read-only when BGM_SOURCE=platform.
export DATA_DB="$DATA_DB_PATH"
export MODEL_USAGE_COMPLETION_SPOOL_DIR="$MODEL_USAGE_COMPLETION_SPOOL_DIR_PATH"
export LEGACY_DATA_FILE="$LEGACY_DATA_PATH"
export UPLOAD_DIR="$UPLOAD_DIR_PATH"
export COMPOSED_DIR="$COMPOSED_DIR_PATH"
export CUSTOM_CANVAS_BLOB_DIR="$CUSTOM_CANVAS_BLOB_DIR_PATH"
export ACG_RUNTIME_MODE="${ACG_RUNTIME_MODE:-production}"
if [ "$ACG_RUNTIME_MODE" != "production" ]; then
  echo "Deployment entrypoint requires ACG_RUNTIME_MODE=production." >&2
  exit 1
fi
export ACG_DB_BOOTSTRAP_MODE="${ACG_DB_BOOTSTRAP_MODE:-validate}"
export ACG_READ_ONLY="${ACG_READ_ONLY:-1}"
export ACG_REQUIRE_INTERNAL_TEAM="${ACG_REQUIRE_INTERNAL_TEAM:-1}"
export ACG_REQUIRE_RESOURCE_SCOPES="${ACG_REQUIRE_RESOURCE_SCOPES:-1}"
export ACG_REQUIRE_PRIVATE_MEDIA="${ACG_REQUIRE_PRIVATE_MEDIA:-1}"
export FALLBACK_ENV="${FALLBACK_ENV:-${ACG_ENV_FILE:-}}"

MAIN_VENV="$APP_DIR/.venv"
VIDEO_VENV="$VIDEO_APP_DIR/.venv"
MAIN_PID_FILE="$LOG_DIR/app.pid"
VIDEO_PID_FILE="$LOG_DIR/video-workshop.pid"
MAIN_LOG="$LOG_DIR/app.log"
VIDEO_LOG="$LOG_DIR/video-workshop.log"

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

production_preflight() {
  ACG_RELEASE_ROOT="${ACG_RELEASE_ROOT:-}" \
  ACG_PERSISTENT_ROOT="${ACG_PERSISTENT_ROOT:-}" \
  ACG_ENV_FILE="${ACG_ENV_FILE:-}" \
  ACG_RELEASE_ID="${ACG_RELEASE_ID:-}" \
  ACG_READY_TOKEN="${ACG_READY_TOKEN:-}" \
  ACG_REQUIRE_INTERNAL_TEAM="${ACG_REQUIRE_INTERNAL_TEAM:-}" \
  ACG_DB_BOOTSTRAP_MODE="$ACG_DB_BOOTSTRAP_MODE" \
  APP_DIR="$APP_DIR" \
  BACKUP_ROOT="$BACKUP_ROOT" \
  LOG_DIR="$LOG_DIR" \
  DATA_DB="$DATA_DB_PATH" \
  MODEL_USAGE_COMPLETION_SPOOL_DIR="$MODEL_USAGE_COMPLETION_SPOOL_DIR_PATH" \
  LEGACY_DATA_FILE="$LEGACY_DATA_PATH" \
  UPLOAD_DIR="$UPLOAD_DIR_PATH" \
  COMPOSED_DIR="$COMPOSED_DIR_PATH" \
  CUSTOM_CANVAS_BLOB_DIR="$CUSTOM_CANVAS_BLOB_DIR_PATH" \
  VIDEO_WORKSHOP_PROJECTS_DIR="$VIDEO_WORKSHOP_PROJECTS_DIR" \
  VIDEO_WORKSHOP_OUTPUT_DIR="$VIDEO_WORKSHOP_OUTPUT_DIR" \
  VIDEO_WORKSHOP_UPLOAD_DIR="$VIDEO_WORKSHOP_UPLOAD_DIR" \
  VIDEO_WORKSHOP_PORT="$VIDEO_WORKSHOP_PORT" \
  VIDEO_WORKSHOP_URL="$VIDEO_WORKSHOP_URL" \
  VIDEO_WORKSHOP_HEALTH_URL="$VIDEO_WORKSHOP_HEALTH_URL" \
  HF_HOME="$HF_HOME" \
  BGM_SOURCE="$BGM_SOURCE" \
  BGM_LIBRARY_DIR="$BGM_LIBRARY_DIR" \
  "$PYTHON_BIN" - <<'PY'
import os
import sys
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlsplit


errors = []


def resolved(name):
    raw = str(os.environ.get(name, "") or "").strip()
    if not raw:
        errors.append(f"{name} must be explicitly configured")
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        errors.append(f"{name} must be an absolute path")
        return None
    return path.resolve(strict=False)


def within(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_sidecar_url(name, expected_port):
    raw_value = str(os.environ.get(name, "") or "")
    raw = raw_value.strip()
    valid = bool(raw) and raw == raw_value and expected_port is not None
    try:
        parsed = urlsplit(raw)
        parsed_port = parsed.port
        address = ip_address(parsed.hostname or "")
    except (TypeError, ValueError):
        valid = False
    else:
        valid = bool(
            valid
            and parsed.scheme == "http"
            and address.is_loopback
            and parsed.username is None
            and parsed.password is None
            and not parsed.path
            and not parsed.query
            and not parsed.fragment
            and parsed_port == expected_port
        )
    if not valid:
        errors.append(
            f"{name} must use http with a literal loopback IP, no "
            "credentials/path/query/fragment, and VIDEO_WORKSHOP_PORT"
        )


def validate_public_origin(name, *, required):
    raw_value = str(os.environ.get(name, "") or "")
    values = [raw_value] if name == "PUBLIC_BASE_URL" else raw_value.split(",")
    values = [value.strip() for value in values if value.strip()]
    if required and not values:
        errors.append(f"{name} must be explicitly configured")
        return
    for value in values:
        valid = value == value.strip()
        try:
            parsed = urlsplit(value)
            _ = parsed.port
        except (TypeError, ValueError):
            valid = False
        else:
            valid = bool(
                valid
                and parsed.scheme in {"http", "https"}
                and parsed.hostname
                and parsed.username is None
                and parsed.password is None
                and parsed.path in {"", "/"}
                and not parsed.query
                and not parsed.fragment
                and parsed.hostname.lower() not in {"localhost", "127.0.0.1", "::1"}
            )
        if not valid:
            errors.append(
                f"{name} entries must be exact public http(s) origins with no "
                "credentials/path/query/fragment"
            )
            return


app_dir = resolved("APP_DIR")
release_root = resolved("ACG_RELEASE_ROOT")
persistent_root = resolved("ACG_PERSISTENT_ROOT")
env_file = resolved("ACG_ENV_FILE")
fallback_env = resolved("FALLBACK_ENV")
if app_dir and release_root and app_dir != release_root:
    errors.append("ACG_RELEASE_ROOT must resolve to the active release directory")
if persistent_root:
    if not persistent_root.is_dir():
        errors.append("ACG_PERSISTENT_ROOT must already exist as a directory")
    if release_root and (
        within(persistent_root, release_root) or within(release_root, persistent_root)
    ):
        errors.append("release and persistent roots must not contain one another")
if env_file:
    if not env_file.is_file():
        errors.append("ACG_ENV_FILE must already exist as a regular file")
    if release_root and within(env_file, release_root):
        errors.append("ACG_ENV_FILE must be outside the release directory")
if env_file and fallback_env and env_file != fallback_env:
    errors.append("FALLBACK_ENV must resolve to the same file as ACG_ENV_FILE")
if app_dir:
    for relative in (".env", ".env.local", "apps/video-workshop/.env.local"):
        if (app_dir / relative).exists():
            errors.append(f"production release must not contain {relative}")

if not str(os.environ.get("ACG_RELEASE_ID", "")).strip():
    errors.append("ACG_RELEASE_ID must be explicitly configured")
if not str(os.environ.get("ACG_READY_TOKEN", "")).strip():
    errors.append("ACG_READY_TOKEN must be explicitly configured")
if str(os.environ.get("ACG_DB_BOOTSTRAP_MODE", "")).strip() != "validate":
    errors.append("ACG_DB_BOOTSTRAP_MODE must be validate in production")
if str(os.environ.get("ACG_READ_ONLY", "")).strip().lower() not in {
    "0", "1", "false", "true", "no", "yes", "off", "on",
}:
    errors.append("ACG_READ_ONLY must be an explicit boolean")
for required_gate in (
    "ACG_REQUIRE_INTERNAL_TEAM",
    "ACG_REQUIRE_RESOURCE_SCOPES",
    "ACG_REQUIRE_PRIVATE_MEDIA",
):
    if str(os.environ.get(required_gate, "")).strip().lower() not in {
        "1", "true", "yes", "on",
    }:
        errors.append(f"{required_gate} must be enabled in production")

try:
    sidecar_port = int(str(os.environ.get("VIDEO_WORKSHOP_PORT", "")).strip())
    if not 1 <= sidecar_port <= 65535:
        raise ValueError
except ValueError:
    sidecar_port = None
    errors.append("VIDEO_WORKSHOP_PORT must be an integer from 1 to 65535")
validate_sidecar_url("VIDEO_WORKSHOP_URL", sidecar_port)
validate_sidecar_url("VIDEO_WORKSHOP_HEALTH_URL", sidecar_port)
validate_public_origin("PUBLIC_BASE_URL", required=True)
validate_public_origin("PRIVATE_MEDIA_LEGACY_ORIGINS", required=False)

path_specs = {
    "BACKUP_ROOT": "dir",
    "LOG_DIR": "dir",
    "DATA_DB": "file",
    "MODEL_USAGE_COMPLETION_SPOOL_DIR": "dir",
    "LEGACY_DATA_FILE": "optional_file",
    "UPLOAD_DIR": "dir",
    "COMPOSED_DIR": "dir",
    "CUSTOM_CANVAS_BLOB_DIR": "dir",
    "VIDEO_WORKSHOP_PROJECTS_DIR": "dir",
    "VIDEO_WORKSHOP_OUTPUT_DIR": "dir",
    "VIDEO_WORKSHOP_UPLOAD_DIR": "dir",
    "HF_HOME": "dir",
    "BGM_LIBRARY_DIR": "dir",
}

for name, kind in path_specs.items():
    path = resolved(name)
    if not path:
        continue
    if persistent_root and not within(path, persistent_root):
        errors.append(f"{name} must resolve under ACG_PERSISTENT_ROOT")
    if release_root and within(path, release_root):
        errors.append(f"{name} must be outside the release directory")
    if kind == "dir" and not path.is_dir():
        errors.append(f"{name} must already exist as a directory")
    elif kind == "file" and not path.is_file():
        errors.append(f"{name} must already exist as a regular file")
    elif kind == "optional_file" and path.exists() and not path.is_file():
        errors.append(f"{name} must be absent or a regular file")
    elif kind == "optional_file" and not path.parent.is_dir():
        errors.append(f"the parent of {name} must already exist")

if errors:
    print("Production runtime preflight failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)
PY
}

verify_release_contracts() {
  if [ ! -x "$RELEASE_CONTRACT_VERIFIER" ]; then
    echo "Release contract verifier is missing or not executable." >&2
    return 1
  fi
  "$RELEASE_CONTRACT_VERIFIER"
}

verify_release_contracts
production_preflight

verify_dependency_contracts() {
  if [ ! -f "$DEPENDENCY_CONTRACT_VERIFIER" ]; then
    echo "Dependency contract verifier is missing: $DEPENDENCY_CONTRACT_VERIFIER" >&2
    return 1
  fi
  "$MAIN_VENV/bin/python" "$DEPENDENCY_CONTRACT_VERIFIER" installed \
    --python "$MAIN_VENV/bin/python" --lock "$MAIN_DEPENDENCY_LOCK"
  "$MAIN_VENV/bin/python" "$DEPENDENCY_CONTRACT_VERIFIER" installed \
    --python "$VIDEO_VENV/bin/python" --lock "$VIDEO_DEPENDENCY_LOCK"
}

verify_production_write_gate() {
  if [ ! -f "$PRODUCTION_WRITE_GATE_VERIFIER" ]; then
    echo "Production write gate verifier is missing: $PRODUCTION_WRITE_GATE_VERIFIER" >&2
    return 1
  fi
  "$MAIN_VENV/bin/python" "$PRODUCTION_WRITE_GATE_VERIFIER" "$@"
}

backup_runtime_data() {
  local stamp dir video_backup_dir
  stamp="$(date +%Y%m%d-%H%M%S)-$$"
  dir="$BACKUP_ROOT/$stamp"
  video_backup_dir="$dir/video-workshop"
  mkdir "$dir"
  mkdir -p "$video_backup_dir/projects"

  if [ -f "$DATA_DB_PATH" ]; then
    "$PYTHON_BIN" "$SQLITE_BACKUP_SCRIPT" \
      --source "$DATA_DB_PATH" \
      --destination "$dir/data.sqlite" \
      --manifest "$dir/data.sqlite.manifest.json"
  fi
  if [ -f "$LEGACY_DATA_PATH" ]; then
    cp -p "$LEGACY_DATA_PATH" "$dir/data.json"
  fi
  if [ -d "$MODEL_USAGE_COMPLETION_SPOOL_DIR_PATH" ]; then
    find "$MODEL_USAGE_COMPLETION_SPOOL_DIR_PATH" -type f -print | sort \
      > "$dir/model-usage-spool.manifest"
    tar -C "$(dirname "$MODEL_USAGE_COMPLETION_SPOOL_DIR_PATH")" \
      -cf "$dir/model-usage-spool.tar" \
      "$(basename "$MODEL_USAGE_COMPLETION_SPOOL_DIR_PATH")"
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

readonly STOP_WAIT_ATTEMPTS=20
readonly STOP_WAIT_INTERVAL_SECONDS=0.25

pid_is_running() {
  local pid="$1"
  local state
  if ! kill -0 "$pid" 2>/dev/null; then
    if ps -p "$pid" >/dev/null 2>&1; then
      # Permission or transient inspection failure: treat it as live so the
      # subsequent identity check fails closed instead of removing the file.
      return 0
    fi
    return 1
  fi
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  case "$state" in
    Z*|z*) return 1 ;;
    "") return 0 ;;
  esac
  return 0
}

managed_process_identity_matches() {
  local pid="$1"
  local expected_service="$2"
  local expected_cwd="$3"
  local expected_executable="$4"
  local expected_marker="$5"
  local expected_port="${6:-}"
  "$PYTHON_BIN" - \
    "$pid" "$expected_service" "$expected_cwd" "$expected_executable" \
    "$expected_marker" "$expected_port" <<'PY'
import os
import subprocess
import sys
from pathlib import Path


pid_raw, service, cwd_raw, executable_raw, marker, port = sys.argv[1:7]
try:
    pid = int(pid_raw)
except ValueError:
    raise SystemExit(1)
if pid <= 1 or service not in {"main", "video-workshop", "test"}:
    raise SystemExit(1)

expected_cwd = Path(cwd_raw).resolve(strict=False)
expected_executable = Path(executable_raw).resolve(strict=False)
proc_root = Path("/proc") / str(pid)
args = []
actual_cwd = None

if proc_root.is_dir():
    try:
        args = [
            value.decode("utf-8", "surrogateescape")
            for value in (proc_root / "cmdline").read_bytes().split(b"\0")
            if value
        ]
        actual_cwd = Path(os.readlink(proc_root / "cwd")).resolve(strict=False)
    except (OSError, ValueError):
        raise SystemExit(1)
else:
    lsof_binary = next(
        (value for value in ("/usr/sbin/lsof", "/usr/bin/lsof") if Path(value).is_file()),
        "lsof",
    )
    try:
        command = subprocess.check_output(
            ["ps", "-ww", "-p", str(pid), "-o", "command="],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        cwd_lines = subprocess.check_output(
            [lsof_binary, "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).splitlines()
    except (OSError, subprocess.CalledProcessError):
        raise SystemExit(1)
    cwd_values = [line[1:] for line in cwd_lines if line.startswith("n")]
    if len(cwd_values) != 1:
        raise SystemExit(1)
    actual_cwd = Path(cwd_values[0]).resolve(strict=False)
    # macOS does not expose argv as NUL-separated data. Keep the full ps value
    # and apply the same exact service markers below.
    args = [command]

if actual_cwd != expected_cwd or not args:
    raise SystemExit(1)

if proc_root.is_dir():
    try:
        actual_executable = Path(args[0]).resolve(strict=False)
    except (OSError, ValueError):
        raise SystemExit(1)
    if actual_executable != expected_executable:
        raise SystemExit(1)
    values = set(args)
    joined = "\0".join(args)
else:
    joined = args[0]
    values = set()
    executable_spellings = {
        executable_raw,
        str(expected_executable),
    }
    if not any(joined.startswith(value + " ") or joined == value for value in executable_spellings):
        raise SystemExit(1)

if service == "main":
    if proc_root.is_dir():
        valid = {"-m", "uvicorn", marker, "--port", port}.issubset(values)
    else:
        valid = all(value and value in joined for value in ("-m uvicorn", marker, "--port", port))
elif service == "video-workshop":
    if proc_root.is_dir():
        valid = marker in values and any(Path(value).name == "run.py" for value in args[1:])
    else:
        valid = bool(marker and marker in joined and "run.py" in joined)
else:
    valid = bool(marker and marker in joined)

raise SystemExit(0 if valid else 1)
PY
}

write_managed_pid_file() {
  local pid_file="$1"
  local pid="$2"
  local service="$3"
  local expected_cwd="$4"
  local temporary="${pid_file}.tmp.$$"
  if ! printf '%s\nservice=%s\ncwd=%s\n' \
    "$pid" "$service" "$expected_cwd" > "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  mv "$temporary" "$pid_file"
}

wait_for_pid_exit() {
  local pid="$1"
  local attempt
  for ((attempt = 0; attempt < STOP_WAIT_ATTEMPTS; attempt++)); do
    sleep "$STOP_WAIT_INTERVAL_SECONDS"
    if ! pid_is_running "$pid"; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
  done
  return 1
}

stop_pid_file() {
  local pid_file="$1"
  local expected_service="$2"
  local expected_cwd="$3"
  local expected_executable="$4"
  local expected_marker="$5"
  local expected_port="${6:-}"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  local pid declared_service declared_cwd
  pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || [ "$pid" -le 1 ]; then
    echo "Invalid managed-service pidfile; refusing to remove it: $pid_file" >&2
    return 1
  fi
  declared_service="$(sed -n 's/^service=//p' "$pid_file" 2>/dev/null | sed -n '1p')"
  declared_cwd="$(sed -n 's/^cwd=//p' "$pid_file" 2>/dev/null | sed -n '1p')"
  if [ -n "$declared_service" ] && [ "$declared_service" != "$expected_service" ]; then
    echo "Pidfile service identity mismatch; refusing TERM: $pid_file" >&2
    return 1
  fi
  if [ -n "$declared_cwd" ] && [ "$declared_cwd" != "$expected_cwd" ]; then
    echo "Pidfile working-directory identity mismatch; refusing TERM: $pid_file" >&2
    return 1
  fi
  if pid_is_running "$pid"; then
    if ! managed_process_identity_matches \
      "$pid" "$expected_service" "$expected_cwd" "$expected_executable" \
      "$expected_marker" "$expected_port"; then
      echo "PID $pid does not match managed $expected_service identity; refusing TERM and preserving pidfile: $pid_file" >&2
      return 1
    fi
    echo "Stopping managed process from $pid_file: $pid"
    kill -TERM "$pid" 2>/dev/null || true
    if ! wait_for_pid_exit "$pid"; then
      echo "Managed process $pid is still alive; preserving pidfile: $pid_file" >&2
      return 1
    fi
  fi
  if ! rm -f "$pid_file"; then
    echo "Unable to remove stopped-service pidfile: $pid_file" >&2
    return 1
  fi
  return 0
}

list_port_listener_pids() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    echo "lsof is required to prove that TCP port $port has no listener." >&2
    return 1
  fi
  local output status
  status=0
  output="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    if [ -n "$output" ]; then
      printf '%s\n' "$output"
    fi
    return 0
  fi
  if [ "$status" -eq 1 ] && [ -z "$output" ]; then
    return 0
  fi
  echo "lsof could not prove that TCP port $port is empty (status $status)." >&2
  if [ -n "$output" ]; then
    echo "$output" >&2
  fi
  return 1
}

stop_port() {
  local port="$1"
  local expected_service="$2"
  local expected_cwd="$3"
  local expected_executable="$4"
  local expected_marker="$5"
  local listener_pids pid invalid_pid attempt
  if ! listener_pids="$(list_port_listener_pids "$port")"; then
    return 1
  fi
  if [ -z "$listener_pids" ]; then
    return 0
  fi

  # Validate the complete listener set before signaling any PID. This avoids a
  # partial shutdown when the configured port belongs to an unrelated service.
  invalid_pid=0
  while IFS= read -r pid; do
    if [ -z "$pid" ]; then
      continue
    fi
    if [[ ! "$pid" =~ ^[0-9]+$ ]] || [ "$pid" -le 1 ]; then
      echo "lsof returned an invalid listener PID for TCP port $port: $pid" >&2
      invalid_pid=1
      continue
    fi
    if ! managed_process_identity_matches \
      "$pid" "$expected_service" "$expected_cwd" "$expected_executable" \
      "$expected_marker" "$port"; then
      echo "Listener PID $pid on TCP port $port is not managed $expected_service; refusing TERM." >&2
      invalid_pid=1
    fi
  done <<< "$listener_pids"
  if [ "$invalid_pid" -ne 0 ]; then
    return 1
  fi

  echo "Stopping managed listener(s) on TCP port $port: $listener_pids"
  while IFS= read -r pid; do
    if [ -n "$pid" ]; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done <<< "$listener_pids"

  for ((attempt = 0; attempt < STOP_WAIT_ATTEMPTS; attempt++)); do
    sleep "$STOP_WAIT_INTERVAL_SECONDS"
    if ! listener_pids="$(list_port_listener_pids "$port")"; then
      return 1
    fi
    if [ -z "$listener_pids" ]; then
      return 0
    fi
  done

  if ! listener_pids="$(list_port_listener_pids "$port")"; then
    return 1
  fi
  if [ -n "$listener_pids" ]; then
    echo "TCP port $port still has listener(s); refusing runtime backup: $listener_pids" >&2
    return 1
  fi
  return 0
}

wait_for_health() {
  local python_bin="$1"
  local url="$2"
  local label="$3"
  local use_ready_token="${4:-0}"
  local require_service_ready="${5:-0}"
  "$python_bin" - "$url" "$label" "$use_ready_token" "$require_service_ready" <<'PY'
import json
import os
import sys
import time
import urllib.request

url, label, use_ready_token, require_service_ready = sys.argv[1:5]
ready_token = os.environ.get("ACG_READY_TOKEN", "") if use_ready_token == "1" else ""
release_id = str(os.environ.get("ACG_RELEASE_ID", "") or "").strip()
expected_read_only = str(os.environ.get("ACG_READ_ONLY", "")).strip().lower() in {
    "1", "true", "yes", "on",
}
last_error = ""
for _ in range(40):
    try:
        request = urllib.request.Request(url)
        if ready_token:
            request.add_header("X-Readiness-Token", ready_token)
        with urllib.request.urlopen(request, timeout=3) as response:
            payload = response.read().decode("utf-8")
        data = json.loads(payload)
        service_contract_ok = True
        if use_ready_token == "1":
            checks = data.get("checks") if isinstance(data.get("checks"), dict) else {}
            release = checks.get("release") if isinstance(checks.get("release"), dict) else {}
            service_contract_ok = bool(
                data.get("ready") is True
                and release_id
                and release.get("id") == release_id
            )
        if require_service_ready == "1":
            service_contract_ok = bool(
                service_contract_ok
                and data.get("ready") is True
                and data.get("contractVersion") == "video-workshop-v137-read-only-1"
                and release_id
                and data.get("buildId") == release_id
                and (
                    (
                        expected_read_only
                        and
                        data.get("readOnly") is True
                        and data.get("writePolicy") == "deny-mutations"
                    )
                    or (
                        not expected_read_only
                        and data.get("readOnly") is False
                        and data.get("writePolicy") == "normal"
                    )
                )
            )
        if data.get("ok") and service_contract_ok:
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

stop_managed_runtime() {
  local failed=0
  if ! stop_pid_file \
    "$MAIN_PID_FILE" "main" "$APP_DIR" "$MAIN_VENV/bin/python" \
    "server.main:app" "$PORT"; then
    failed=1
  fi
  if ! stop_pid_file \
    "$VIDEO_PID_FILE" "video-workshop" "$VIDEO_APP_DIR" \
    "$VIDEO_VENV/bin/python" "run.py"; then
    failed=1
  fi
  return "$failed"
}

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
if [ ! -f "$SQLITE_BACKUP_SCRIPT" ]; then
  echo "Consistent SQLite backup helper is missing: $SQLITE_BACKUP_SCRIPT" >&2
  exit 1
fi

for venv_python in "$MAIN_VENV/bin/python" "$VIDEO_VENV/bin/python"; do
  if [ ! -x "$venv_python" ]; then
    echo "Production dependencies must be installed before startup: $venv_python" >&2
    exit 1
  fi
done

verify_dependency_contracts

# Refuse downtime/backup work when the database, registry, paths, release or
# canvas closure is already known unsafe.  The sidecar is intentionally the
# only deferred check because the new release process is not running yet.
verify_production_write_gate --skip-sidecar

shutdown_failed=0
if ! stop_pid_file \
  "$MAIN_PID_FILE" "main" "$APP_DIR" "$MAIN_VENV/bin/python" \
  "server.main:app" "$PORT"; then
  shutdown_failed=1
fi
if ! stop_pid_file \
  "$VIDEO_PID_FILE" "video-workshop" "$VIDEO_APP_DIR" \
  "$VIDEO_VENV/bin/python" "run.py"; then
  shutdown_failed=1
fi
if ! stop_port \
  "$PORT" "main" "$APP_DIR" "$MAIN_VENV/bin/python" "server.main:app"; then
  shutdown_failed=1
fi
if ! stop_port \
  "$VIDEO_WORKSHOP_PORT" "video-workshop" "$VIDEO_APP_DIR" \
  "$VIDEO_VENV/bin/python" "run.py"; then
  shutdown_failed=1
fi
if [ "$shutdown_failed" -ne 0 ]; then
  echo "Runtime shutdown could not be proven; refusing backup and startup." >&2
  exit 1
fi

backup_runtime_data

(
  cd "$VIDEO_APP_DIR"
  exec nohup "$VIDEO_VENV/bin/python" run.py
) > "$VIDEO_LOG" 2>&1 &
VIDEO_PID=$!
write_managed_pid_file "$VIDEO_PID_FILE" "$VIDEO_PID" "video-workshop" "$VIDEO_APP_DIR"
VIDEO_READY_GATE="1"
if ! wait_for_health \
  "$VIDEO_VENV/bin/python" \
  "$VIDEO_WORKSHOP_HEALTH_URL/api/health" \
  "Video workshop" \
  "0" \
  "$VIDEO_READY_GATE"; then
  stop_pid_file \
    "$VIDEO_PID_FILE" "video-workshop" "$VIDEO_APP_DIR" \
    "$VIDEO_VENV/bin/python" "run.py" || true
  exit 1
fi

# This audit opens SQLite read-only and performs no migration.  It runs after
# the loopback sidecar is healthy but before the main service can accept any
# business request.  Main lifespan independently repeats the same contract so
# bypassing this launcher still fails closed.
if ! verify_production_write_gate; then
  stop_pid_file \
    "$VIDEO_PID_FILE" "video-workshop" "$VIDEO_APP_DIR" \
    "$VIDEO_VENV/bin/python" "run.py" || true
  exit 1
fi

nohup "$MAIN_VENV/bin/python" -m uvicorn server.main:app --host "$HOST" --port "$PORT" > "$MAIN_LOG" 2>&1 &
MAIN_PID=$!
write_managed_pid_file "$MAIN_PID_FILE" "$MAIN_PID" "main" "$APP_DIR"
if ! wait_for_health \
  "$MAIN_VENV/bin/python" \
  "http://127.0.0.1:${PORT}/api/ready" \
  "Main service readiness" \
  "1"; then
  stop_managed_runtime || true
  exit 1
fi

echo "Started Dumate Studio on http://localhost:${PORT}"
echo "Started video workshop sidecar on ${VIDEO_WORKSHOP_HEALTH_URL} (loopback only)"
