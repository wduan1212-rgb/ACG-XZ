#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/app"
VIDEO_APP_DIR="$APP_DIR/apps/video-workshop"
VIDEO_PYTHON="/opt/video-workshop-venv/bin/python"
PYTHON_BIN="${PYTHON_BIN:-python3}"
MAIN_PID=""
VIDEO_PID=""

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Configured Python runtime is missing: $PYTHON_BIN" >&2
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

export ACG_RUNTIME_MODE="${ACG_RUNTIME_MODE:-production}"
if [ "$ACG_RUNTIME_MODE" != "production" ]; then
  echo "Deployment entrypoint requires ACG_RUNTIME_MODE=production." >&2
  exit 1
fi
export ACG_DB_BOOTSTRAP_MODE="${ACG_DB_BOOTSTRAP_MODE:-validate}"
export FALLBACK_ENV="${FALLBACK_ENV:-${ACG_ENV_FILE:-}}"

export DATA_DB="${DATA_DB:-/data/data.sqlite}"
export LEGACY_DATA_FILE="${LEGACY_DATA_FILE:-/data/data.json}"
export UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
export COMPOSED_DIR="${COMPOSED_DIR:-/data/composed}"
export VIDEO_WORKSHOP_HOST="${VIDEO_WORKSHOP_HOST:-127.0.0.1}"
export VIDEO_WORKSHOP_PORT="${VIDEO_WORKSHOP_PORT:-8765}"
export VIDEO_WORKSHOP_URL="${VIDEO_WORKSHOP_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"
export VIDEO_WORKSHOP_HEALTH_URL="${VIDEO_WORKSHOP_HEALTH_URL:-http://127.0.0.1:${VIDEO_WORKSHOP_PORT}}"
export VIDEO_WORKSHOP_PROJECTS_DIR="${VIDEO_WORKSHOP_PROJECTS_DIR:-/data/video-workshop/projects}"
export VIDEO_WORKSHOP_OUTPUT_DIR="${VIDEO_WORKSHOP_OUTPUT_DIR:-/data/video-workshop/outputs}"
export VIDEO_WORKSHOP_UPLOAD_DIR="${VIDEO_WORKSHOP_UPLOAD_DIR:-/data/video-workshop/uploads}"
export CUSTOM_CANVAS_BLOB_DIR="${CUSTOM_CANVAS_BLOB_DIR:-/data/canvas_blobs}"
export BGM_SOURCE="${BGM_SOURCE:-platform}"
export BGM_LIBRARY_DIR="${BGM_LIBRARY_DIR:-/data/bgm-library}"
export HF_HOME="${HF_HOME:-/data/model-cache}"

case "$VIDEO_WORKSHOP_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "VIDEO_WORKSHOP_HOST must stay on a loopback address." >&2
    exit 1
    ;;
esac
if [ "${PORT:-8787}" = "$VIDEO_WORKSHOP_PORT" ]; then
  echo "Main PORT and VIDEO_WORKSHOP_PORT must be different." >&2
  exit 1
fi

RELEASE_CONTRACT_VERIFIER="$APP_DIR/deploy/verify_release_contracts.sh"

production_preflight() {
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


release_root = resolved("ACG_RELEASE_ROOT")
persistent_root = resolved("ACG_PERSISTENT_ROOT")
env_file = resolved("ACG_ENV_FILE")
fallback_env = resolved("FALLBACK_ENV")
if release_root and release_root != Path("/app").resolve():
    errors.append("ACG_RELEASE_ROOT must resolve to /app in this image")
if persistent_root and not persistent_root.is_dir():
    errors.append("ACG_PERSISTENT_ROOT must already exist as a directory")
if release_root and persistent_root and (
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
if release_root:
    for relative in (".env", ".env.local", "apps/video-workshop/.env.local"):
        if (release_root / relative).exists():
            errors.append(f"production release must not contain {relative}")

if not str(os.environ.get("ACG_RELEASE_ID", "")).strip():
    errors.append("ACG_RELEASE_ID must be explicitly configured")
if not str(os.environ.get("ACG_READY_TOKEN", "")).strip():
    errors.append("ACG_READY_TOKEN must be explicitly configured")
if str(os.environ.get("ACG_DB_BOOTSTRAP_MODE", "")).strip() != "validate":
    errors.append("ACG_DB_BOOTSTRAP_MODE must be validate in production")
if str(os.environ.get("ACG_READ_ONLY", "")).strip().lower() not in {
    "1", "true", "yes", "on",
}:
    errors.append("ACG_READ_ONLY must be enabled for this production release")
if str(os.environ.get("ACG_REQUIRE_INTERNAL_TEAM", "")).strip().lower() not in {
    "1", "true", "yes", "on",
}:
    errors.append("ACG_REQUIRE_INTERNAL_TEAM must be enabled in production")

try:
    sidecar_port = int(str(os.environ.get("VIDEO_WORKSHOP_PORT", "")).strip())
    if not 1 <= sidecar_port <= 65535:
        raise ValueError
except ValueError:
    sidecar_port = None
    errors.append("VIDEO_WORKSHOP_PORT must be an integer from 1 to 65535")
validate_sidecar_url("VIDEO_WORKSHOP_URL", sidecar_port)
validate_sidecar_url("VIDEO_WORKSHOP_HEALTH_URL", sidecar_port)

path_specs = {
    "DATA_DB": "file",
    "LEGACY_DATA_FILE": "optional_file",
    "UPLOAD_DIR": "dir",
    "COMPOSED_DIR": "dir",
    "CUSTOM_CANVAS_BLOB_DIR": "dir",
    "VIDEO_WORKSHOP_PROJECTS_DIR": "dir",
    "VIDEO_WORKSHOP_OUTPUT_DIR": "dir",
    "VIDEO_WORKSHOP_UPLOAD_DIR": "dir",
    "HF_HOME": "dir",
}
if str(os.environ.get("BGM_SOURCE", "")).strip() != "platform":
    path_specs["BGM_LIBRARY_DIR"] = "dir"

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

wait_for_json_gate() {
  local url="$1"
  local label="$2"
  local use_ready_token="${3:-0}"
  local require_service_ready="${4:-0}"
  "$PYTHON_BIN" - "$url" "$label" "$use_ready_token" "$require_service_ready" <<'PY'
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
                    not expected_read_only
                    or (
                        data.get("readOnly") is True
                        and data.get("writePolicy") == "deny-mutations"
                    )
                )
            )
        if data.get("ok") and service_contract_ok:
            print(f"{label}: {payload}")
            raise SystemExit(0)
        last_error = payload[:300]
    except Exception as exc:
        last_error = f"{exc.__class__.__name__}: {exc}"
    time.sleep(0.5)
print(f"{label} failed: {last_error}", file=sys.stderr)
raise SystemExit(1)
PY
}

shutdown() {
  trap - EXIT INT TERM
  if [ -n "$MAIN_PID" ] && kill -0 "$MAIN_PID" 2>/dev/null; then
    kill "$MAIN_PID" 2>/dev/null || true
  fi
  if [ -n "$VIDEO_PID" ] && kill -0 "$VIDEO_PID" 2>/dev/null; then
    kill "$VIDEO_PID" 2>/dev/null || true
  fi
  wait "$MAIN_PID" 2>/dev/null || true
  wait "$VIDEO_PID" 2>/dev/null || true
}
trap shutdown EXIT INT TERM

(
  cd "$VIDEO_APP_DIR"
  exec "$VIDEO_PYTHON" run.py
) &
VIDEO_PID=$!
VIDEO_READY_GATE="1"
if ! wait_for_json_gate \
  "${VIDEO_WORKSHOP_HEALTH_URL}/api/health" \
  "Video workshop live" \
  "0" \
  "$VIDEO_READY_GATE"; then
  exit 1
fi

"$PYTHON_BIN" -m uvicorn server.main:app \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-8787}" &
MAIN_PID=$!
if ! wait_for_json_gate \
  "http://127.0.0.1:${PORT:-8787}/api/ready" \
  "Main service readiness" \
  "1"; then
  exit 1
fi

while kill -0 "$MAIN_PID" 2>/dev/null && kill -0 "$VIDEO_PID" 2>/dev/null; do
  sleep 2
done

echo "A required service exited; stopping the remaining process." >&2
exit 1
