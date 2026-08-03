#!/usr/bin/env bash
set -euo pipefail

# Read-only preflight for an unpacked release. This intentionally runs before
# application import/startup so a bad static closure or split ESM identity
# cannot reach migration code.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

args=(all --app-root "$APP_ROOT")
if [ -n "${ACG_RELEASE_ID:-}" ]; then
  args+=(--expected-release-id "$ACG_RELEASE_ID")
fi
exec python3 "$APP_ROOT/tools/verify_release_contracts.py" "${args[@]}" "$@"
