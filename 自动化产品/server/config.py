"""Runtime bootstrap policy shared by the main service and the store.

This module deliberately has no application imports.  It is safe to import
before ``server.store`` so environment-backed storage identities are frozen
only after the environment files have been parsed.
"""

from __future__ import annotations

import os
import re
import ipaddress
from pathlib import Path
from urllib.parse import urlsplit


SERVER_DIR = Path(__file__).resolve().parent
APP_DIR = SERVER_DIR.parent

_loaded_environment_files: list[Path] = []


def _clean_env_value(value: str) -> str:
    value = str(value or "").strip()
    if len(value) >= 2 and value[:1] == value[-1:] and value[:1] in {"\"", "'"}:
        return value[1:-1]
    return value


def _load_environment_file(path: Path) -> bool:
    try:
        lines = path.read_text("utf-8").splitlines()
    except (FileNotFoundError, IsADirectoryError, OSError, UnicodeError):
        return False
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        os.environ.setdefault(key, _clean_env_value(value))
    resolved = path.expanduser().resolve(strict=False)
    if resolved not in _loaded_environment_files:
        _loaded_environment_files.append(resolved)
    return True


def load_environment(app_dir: Path | None = None) -> tuple[Path, ...]:
    """Load an external environment file first, then local compatibility files.

    Existing process variables always win.  Production should set
    ``ACG_ENV_FILE`` to a persistent path outside the release; ``.env.local``
    and ``.env`` remain supported for local development.
    """

    base = Path(app_dir or APP_DIR).expanduser().resolve(strict=False)
    external = str(os.getenv("ACG_ENV_FILE") or "").strip()
    candidates: list[Path] = []
    if external:
        candidates.append(Path(external).expanduser())
    candidates.extend((base / ".env.local", base / ".env"))
    for candidate in candidates:
        _load_environment_file(candidate)
    return tuple(_loaded_environment_files)


def env_bool(name: str, default: bool = False) -> bool:
    value = str(os.getenv(name, "") or "").strip().lower()
    if not value:
        return bool(default)
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def runtime_mode() -> str:
    value = str(os.getenv("ACG_RUNTIME_MODE", "local") or "local").strip().lower()
    aliases = {"prod": "production", "dev": "local", "development": "local"}
    value = aliases.get(value, value)
    return value if value in {"local", "test", "production"} else "invalid"


def is_production() -> bool:
    return runtime_mode() == "production"


def is_read_only() -> bool:
    return env_bool("ACG_READ_ONLY", False)


def db_bootstrap_mode() -> str:
    configured = str(os.getenv("ACG_DB_BOOTSTRAP_MODE", "") or "").strip().lower()
    # Production can never opt back into startup mutation.  The migration CLI
    # calls its expand-only runner directly and therefore needs no "auto" mode.
    if runtime_mode() in {"production", "invalid"}:
        return "validate"
    if configured in {"auto", "validate"}:
        return configured
    # Local/test keeps the historical zero-command bootstrap.  Production is
    # fail-closed and may only validate migrations applied by the explicit CLI.
    return "auto"


def release_id() -> str:
    explicit = str(os.getenv("ACG_RELEASE_ID", "") or "").strip()
    if explicit:
        return explicit[:160]
    if is_production():
        return ""
    try:
        index = (APP_DIR / "index.html").read_text("utf-8")
    except (OSError, UnicodeError):
        return "local-unidentified"
    match = re.search(r"[?&]v=([A-Za-z0-9._-]{4,160})", index)
    return match.group(1) if match else "local-unidentified"


def readiness_token() -> str:
    return str(os.getenv("ACG_READY_TOKEN", "") or "").strip()


def require_internal_team() -> bool:
    # Production readiness must always prove that the audited ACG migration is
    # present.  An environment-file typo or an explicit ``0`` must not turn
    # this database compatibility gate off.
    if runtime_mode() in {"production", "invalid"}:
        return True
    return env_bool("ACG_REQUIRE_INTERNAL_TEAM", False)


def loopback_http_url_status(value: str, *, expected_port: int | None = None) -> dict:
    """Validate an unauthenticated same-host sidecar URL.

    The main service forwards user prompts and attachments to the video
    sidecar.  Keeping this contract to a literal loopback HTTP origin prevents
    a deployment variable from silently turning that proxy into an SSRF path.
    """

    raw = str(value or "").strip()
    status = {
        "ok": False,
        "scheme": "",
        "host": "",
        "port": None,
        "reason": "invalid-url",
    }
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except (TypeError, ValueError):
        return status

    status.update({
        "scheme": str(parsed.scheme or "").lower(),
        "host": str(parsed.hostname or "").lower(),
        "port": port,
    })
    if status["scheme"] != "http":
        status["reason"] = "http-required"
        return status
    if parsed.username is not None or parsed.password is not None:
        status["reason"] = "credentials-forbidden"
        return status
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        status["reason"] = "origin-only"
        return status
    try:
        host_address = ipaddress.ip_address(status["host"])
    except ValueError:
        status["reason"] = "literal-loopback-required"
        return status
    if not host_address.is_loopback:
        status["reason"] = "loopback-required"
        return status
    if port is None or not 1 <= int(port) <= 65535:
        status["reason"] = "explicit-port-required"
        return status
    if expected_port is not None and int(port) != int(expected_port):
        status["reason"] = "port-mismatch"
        return status
    status["ok"] = True
    status["reason"] = "ok"
    return status


def loaded_environment_files() -> tuple[Path, ...]:
    return tuple(_loaded_environment_files)


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def storage_path_status(paths: dict[str, tuple[Path, str]]) -> dict:
    """Validate storage identities without creating directories or files.

    Values are ``(path, kind)`` where kind is ``file``, ``dir`` or
    ``optional_file``.  The response intentionally contains no absolute paths.
    """

    checks: dict[str, dict] = {}
    release_root = Path(
        os.getenv("ACG_RELEASE_ROOT", str(APP_DIR)) or APP_DIR
    ).expanduser().resolve(strict=False)
    persistent_raw = str(os.getenv("ACG_PERSISTENT_ROOT", "") or "").strip()
    persistent_root = (
        Path(persistent_raw).expanduser().resolve(strict=False)
        if persistent_raw else None
    )
    production = is_production()
    for name, (raw_path, kind) in paths.items():
        path = Path(raw_path).expanduser()
        resolved = path.resolve(strict=False)
        exists = path.exists()
        type_ok = (
            (kind == "dir" and path.is_dir())
            or (kind == "file" and path.is_file())
            or (kind == "optional_file" and (not exists or path.is_file()))
        )
        outside_release = not _within(resolved, release_root)
        under_persistent = bool(
            persistent_root is not None and _within(resolved, persistent_root)
        )
        path_ok = bool(type_ok)
        if production:
            path_ok = bool(
                path.is_absolute()
                and type_ok
                and persistent_root is not None
                and under_persistent
                and outside_release
            )
        checks[name] = {
            "ok": path_ok,
            "exists": exists,
            "kind": kind,
            "underPersistentRoot": under_persistent,
            "outsideRelease": outside_release,
        }

    external_env = str(os.getenv("ACG_ENV_FILE", "") or "").strip()
    external_env_ok = True
    if production:
        if not external_env:
            external_env_ok = False
        else:
            env_path = Path(external_env).expanduser()
            env_resolved = env_path.resolve(strict=False)
            external_env_ok = bool(
                env_path.is_absolute()
                and env_path.is_file()
                and not _within(env_resolved, release_root)
            )
    return {
        "ok": all(item["ok"] for item in checks.values()) and external_env_ok,
        "checks": checks,
        "persistentRootConfigured": persistent_root is not None,
        "externalEnvironment": external_env_ok,
    }


# Importing config is the earliest common entry for both ``server.main`` and a
# direct ``server.store`` import.  Keep this call above every store-level path.
load_environment()
