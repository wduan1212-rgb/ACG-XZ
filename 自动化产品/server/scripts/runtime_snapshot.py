#!/usr/bin/env python3
"""Create, verify and restore-drill one complete protected runtime snapshot.

The plan is explicit JSON.  Every protected component is copied into a new
snapshot directory, bound to one snapshot id and release id, and verified by
content hash.  Restore never targets the live paths: it only materializes an
empty isolation directory for a real recovery drill.

Example plan::

  {
    "format": "acg-runtime-snapshot-plan-v1",
    "releaseId": "approved-release-id",
    "components": [
      {"name": "database", "type": "sqlite", "path": "/srv/acg/shared/data.sqlite"},
      {"name": "uploads", "type": "directory", "path": "/srv/acg/shared/uploads"},
      {"name": "runtime-env", "type": "file", "path": "/srv/acg/shared/config/runtime.env"}
    ]
  }

All component paths must resolve below ``--persistent-root`` unless a regular
file explicitly declares ``allowOutsidePersistentRoot: true`` (for systemd or
Nginx configuration).  Symlinks and special files are rejected by default.
The production-complete profile may explicitly allow byte-only dereferencing
for named components; that policy is exact, component scoped and never follows
directory symlinks.  The caller must stop/freeze every writer before create;
this script verifies bytes, not the process freeze itself.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath


PLAN_FORMAT = "acg-runtime-snapshot-plan-v1"
SNAPSHOT_FORMAT = "acg-runtime-snapshot-v1"
RESTORE_FORMAT = "acg-runtime-restore-drill-v1"
PRODUCTION_COMPLETE_PROFILE = "acg-production-complete-v1"
PRODUCTION_COMPLETE_COMPONENTS = {
    # type, required, exact lexical path, outside persistent root,
    # dereference internal/component symlinks
    "database": ("sqlite", True, "server/data.sqlite", False, False),
    "legacy-data": ("file", False, "server/data.json", False, False),
    "uploads": ("directory", True, "server/uploads", False, False),
    "composed": ("directory", True, "server/composed", False, False),
    "canvas-blobs": (
        "directory", True, "server/canvas_blobs", False, False,
    ),
    "model-usage-spool": (
        "directory", False, "server/model_usage_spool", False, False,
    ),
    "server-logs": ("directory", False, "server/logs", False, False),
    "video-projects": (
        "directory", True, "runtime/video-workshop/projects", False, False,
    ),
    "video-uploads": (
        "directory", True, "runtime/video-workshop/uploads", False, False,
    ),
    "video-outputs": (
        "directory", True, "runtime/video-workshop/outputs", False, False,
    ),
    "bgm-library": (
        "directory", True, "runtime/bgm-library", False, False,
    ),
    "model-cache": (
        "directory", True, "runtime/model-cache", False, True,
    ),
    "runtime-env-public": ("file", True, ".env", False, False),
    "runtime-env-private": ("file", True, ".env.local", False, False),
    "runtime-env-v140": (
        "file", False, None, True, False,
    ),
    "systemd-main": (
        "file", True, "/etc/systemd/system/dumate-studio.service", True,
        False,
    ),
    "systemd-video": (
        "file", True,
        "/etc/systemd/system/dumate-studio-video-workshop.service", True,
        False,
    ),
    "systemd-main-dropins": (
        "directory", True,
        "/etc/systemd/system/dumate-studio.service.d", True, False,
    ),
    "systemd-video-dropins": (
        "directory", True,
        "/etc/systemd/system/dumate-studio-video-workshop.service.d", True,
        False,
    ),
    "nginx-site": (
        "file", True, "/etc/nginx/sites-enabled/xingzhenworld.com", True,
        True,
    ),
}
PRODUCTION_COMPONENT_SYMLINK_ROOTS = {
    # Debian/Ubuntu commonly links sites-enabled to sites-available.  Both
    # relative and absolute links are accepted only when the final regular file
    # remains below this exact root.
    "nginx-site": Path("/etc/nginx"),
}
PRODUCTION_MEDIA_COMPONENTS = {
    "uploads",
    "composed",
    "canvas-blobs",
    "video-uploads",
    "video-outputs",
}
PRODUCTION_RUNTIME_ENV_ROOT = Path("/data/dumate-studio/config")
PRODUCTION_RUNTIME_ENV_NAME_RE = re.compile(
    r"^runtime-v140(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,127})?\.env$"
)
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


class SnapshotError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_fsync(path: Path, content: bytes, mode: int = 0o600) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _lexical_absolute(path: Path) -> Path:
    """Return an absolute normalized path without resolving any symlink."""

    return Path(os.path.abspath(os.fspath(path)))


def _resolve_regular_symlink(
    path: Path,
    *,
    allowed_root: Path,
    allow_absolute_link: bool,
    label: str,
) -> tuple[Path, str]:
    """Resolve one explicitly approved symlink to a contained regular file."""

    lexical_root = _lexical_absolute(allowed_root)
    resolved_root = allowed_root.resolve(strict=True)
    current = _lexical_absolute(path)
    first_target = ""
    seen: set[Path] = set()
    for _hop in range(64):
        try:
            info = current.lstat()
        except FileNotFoundError as exc:
            raise SnapshotError(f"dangling_symlink_rejected:{label}") from exc
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise SnapshotError(f"symlink_loop_rejected:{label}") from exc
            raise SnapshotError(f"dangling_symlink_rejected:{label}") from exc
        if not stat.S_ISLNK(info.st_mode):
            try:
                resolved = current.resolve(strict=True)
                final_info = resolved.stat()
            except RuntimeError as exc:
                raise SnapshotError(f"symlink_loop_rejected:{label}") from exc
            except (FileNotFoundError, OSError) as exc:
                raise SnapshotError(f"dangling_symlink_rejected:{label}") from exc
            if not _within(resolved, resolved_root):
                raise SnapshotError(f"symlink_target_outside_component:{label}")
            if not stat.S_ISREG(final_info.st_mode):
                raise SnapshotError(f"symlink_target_not_regular:{label}")
            return resolved, first_target
        if current in seen:
            raise SnapshotError(f"symlink_loop_rejected:{label}")
        seen.add(current)
        try:
            raw_target = os.readlink(current)
        except OSError as exc:
            raise SnapshotError(f"symlink_read_failed:{label}") from exc
        if not first_target:
            first_target = raw_target
        absolute_target = Path(raw_target).is_absolute()
        if absolute_target and not allow_absolute_link:
            raise SnapshotError(f"absolute_symlink_rejected:{label}")
        current = _lexical_absolute(
            Path(raw_target) if absolute_target else current.parent / raw_target
        )
        if not (
            _within(current, lexical_root) or _within(current, resolved_root)
        ):
            raise SnapshotError(f"symlink_target_outside_component:{label}")
    raise SnapshotError(f"symlink_loop_rejected:{label}")


def _load_json(path: Path) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise SnapshotError(f"json_root_not_object:{path}")
    return payload, raw


def _load_backup_module():
    script = Path(__file__).with_name("consistent_sqlite_backup.py")
    spec = importlib.util.spec_from_file_location(
        f"consistent_sqlite_backup_{uuid.uuid4().hex}", script
    )
    if spec is None or spec.loader is None:
        raise SnapshotError("sqlite_backup_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _validate_production_component_contract(
    components: list[dict],
    persistent_root: Path,
    *,
    snapshot: bool,
) -> None:
    """Reject a production profile that merely reuses the expected names."""

    by_name = {str(item.get("name") or ""): item for item in components}
    expected_names = set(PRODUCTION_COMPLETE_COMPONENTS)
    if set(by_name) != expected_names:
        missing = sorted(expected_names - set(by_name))
        extra = sorted(set(by_name) - expected_names)
        detail = ",".join(missing or extra)
        raise SnapshotError(f"production_profile_component_set_invalid:{detail}")
    for name, (kind, required, relative, outside, dereference) in (
        PRODUCTION_COMPLETE_COMPONENTS.items()
    ):
        item = by_name[name]
        if str(item.get("type") or "") != kind:
            raise SnapshotError(f"production_profile_component_type_invalid:{name}")
        if bool(item.get("required", True)) is not required:
            raise SnapshotError(
                f"production_profile_component_required_invalid:{name}"
            )
        if bool(item.get("allowOutsidePersistentRoot", False)) is not outside:
            raise SnapshotError(
                f"production_profile_component_boundary_invalid:{name}"
            )
        actual_dereference = item.get("dereferenceInternalSymlinks", False)
        if (
            type(actual_dereference) is not bool
            or actual_dereference is not dereference
        ):
            raise SnapshotError(
                f"production_profile_component_dereference_invalid:{name}"
            )
        if required and snapshot and item.get("state") == "absent":
            raise SnapshotError(f"production_profile_component_absent:{name}")
        source = Path(str(item.get("source" if snapshot else "path") or ""))
        if relative is not None:
            expected = _lexical_absolute(persistent_root / relative)
            if _lexical_absolute(source) != expected:
                raise SnapshotError(
                    f"production_profile_component_path_invalid:{name}"
                )
        elif name == "runtime-env-v140":
            _validate_production_runtime_env_path(source)


def _validate_production_runtime_env_path(source: Path) -> None:
    """Allow only the versioned v140 environment file beside production config."""

    source = _lexical_absolute(source)
    allowed_root = _lexical_absolute(PRODUCTION_RUNTIME_ENV_ROOT)
    if (
        source.parent != allowed_root
        or not PRODUCTION_RUNTIME_ENV_NAME_RE.fullmatch(source.name)
    ):
        raise SnapshotError(
            "production_profile_component_path_invalid:runtime-env-v140"
        )


def _systemd_environment_files(path: Path, component: str) -> set[Path]:
    try:
        raw_lines = path.read_text("utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise SnapshotError(
            f"production_profile_systemd_unit_unreadable:{component}"
        ) from exc

    logical_lines: list[str] = []
    pending = ""
    for raw_line in raw_lines:
        stripped = raw_line.strip()
        if pending:
            stripped = pending + stripped
        if stripped.endswith("\\"):
            pending = stripped[:-1]
            continue
        logical_lines.append(stripped)
        pending = ""
    if pending:
        raise SnapshotError(
            f"production_profile_systemd_unit_invalid:{component}"
        )

    paths: set[Path] = set()
    for line in logical_lines:
        if not line or line.startswith(("#", ";")):
            continue
        key, separator, value = line.partition("=")
        if separator != "=" or key.strip() != "EnvironmentFile":
            continue
        try:
            entries = shlex.split(value, posix=True)
        except ValueError as exc:
            raise SnapshotError(
                f"production_profile_systemd_unit_invalid:{component}"
            ) from exc
        if not entries:
            raise SnapshotError(
                f"production_profile_systemd_unit_invalid:{component}"
            )
        for entry in entries:
            candidate = entry[1:] if entry.startswith("-") else entry
            path_value = Path(candidate)
            if not path_value.is_absolute():
                raise SnapshotError(
                    f"production_profile_systemd_environment_invalid:{component}"
                )
            paths.add(_lexical_absolute(path_value))
    return paths


def _validate_production_systemd_environment_binding(
    components: list[dict],
) -> None:
    by_name = {str(item.get("name") or ""): item for item in components}
    required_names = {
        "runtime-env-v140",
        "systemd-main",
        "systemd-video",
        "systemd-main-dropins",
        "systemd-video-dropins",
    }
    if not required_names.issubset(by_name):
        return

    runtime_env = by_name["runtime-env-v140"]
    runtime_path = _lexical_absolute(Path(str(runtime_env.get("path") or "")))
    _validate_production_runtime_env_path(runtime_path)
    content_path = Path(str(runtime_env.get("contentPath") or ""))
    if not content_path.is_file():
        raise SnapshotError("production_profile_runtime_environment_missing")

    expected = {runtime_path}
    unit_dropins = {
        "systemd-main": "systemd-main-dropins",
        "systemd-video": "systemd-video-dropins",
    }
    for component, dropin_component in unit_dropins.items():
        unit_path = Path(str(by_name[component].get("contentPath") or ""))
        actual = _systemd_environment_files(unit_path, component)
        if actual != expected:
            raise SnapshotError(
                f"production_profile_systemd_environment_mismatch:{component}"
            )
        dropin_root = Path(
            str(by_name[dropin_component].get("contentPath") or "")
        )
        if not dropin_root.is_dir():
            raise SnapshotError(
                f"production_profile_systemd_dropins_missing:{component}"
            )
        for dropin in sorted(dropin_root.iterdir(), key=lambda path: path.name):
            if not dropin.name.endswith(".conf"):
                continue
            if dropin.is_symlink() or not dropin.is_file():
                raise SnapshotError(
                    f"production_profile_systemd_dropin_invalid:{component}"
                )
            if _systemd_environment_files(dropin, component):
                raise SnapshotError(
                    "production_profile_systemd_environment_override_unsupported:"
                    f"{component}"
                )


def _media_inventory_digest_from_components(components: list[dict]) -> str:
    """Bind the five private-media directory inventories to one snapshot."""

    names = [str(item.get("name") or "") for item in components]
    if len(names) != len(set(names)):
        raise SnapshotError("media_inventory_component_duplicate")
    by_name = {str(item.get("name") or ""): item for item in components}
    digest = hashlib.sha256()
    for name in sorted(PRODUCTION_MEDIA_COMPONENTS):
        item = by_name.get(name)
        if not item:
            digest.update(f"{name}\0missing\0".encode("utf-8"))
            continue
        if item.get("state") == "absent":
            digest.update(f"{name}\0absent\0".encode("utf-8"))
            continue
        files = item.get("files")
        if not isinstance(files, list):
            raise SnapshotError(f"media_inventory_files_missing:{name}")
        for entry in sorted(files, key=lambda value: str(value.get("path") or "")):
            relative = str(entry.get("path") or "")
            size = entry.get("bytes")
            mtime_ns = entry.get("mtimeNs")
            content_sha256 = str(entry.get("sha256") or "").strip().lower()
            if (
                not relative
                or type(size) is not int
                or size < 0
                or type(mtime_ns) is not int
                or mtime_ns < 0
                or not re.fullmatch(r"[0-9a-f]{64}", content_sha256)
            ):
                raise SnapshotError(f"media_inventory_entry_invalid:{name}")
            digest.update(
                f"{name}\0{relative}\0{size}\0{mtime_ns}\0"
                f"{content_sha256}\0".encode("utf-8")
            )
    return digest.hexdigest()


def _validate_plan(plan: dict, persistent_root: Path) -> list[dict]:
    if plan.get("format") != PLAN_FORMAT:
        raise SnapshotError("plan_format_mismatch")
    if not str(plan.get("releaseId") or "").strip():
        raise SnapshotError("plan_release_id_missing")
    raw_components = plan.get("components")
    if not isinstance(raw_components, list) or not raw_components:
        raise SnapshotError("plan_components_missing")
    profile = str(plan.get("profile") or "").strip()
    if profile and profile != PRODUCTION_COMPLETE_PROFILE:
        raise SnapshotError("plan_profile_unknown")
    components: list[dict] = []
    names: set[str] = set()
    for raw in raw_components:
        if not isinstance(raw, dict):
            raise SnapshotError("plan_component_invalid")
        name = str(raw.get("name") or "")
        kind = str(raw.get("type") or "")
        if not NAME_RE.fullmatch(name) or name in names:
            raise SnapshotError(f"plan_component_name_invalid:{name}")
        if kind not in {"sqlite", "directory", "file"}:
            raise SnapshotError(f"plan_component_type_invalid:{name}")
        source = Path(str(raw.get("path") or ""))
        if not source.is_absolute():
            raise SnapshotError(f"plan_component_path_not_absolute:{name}")
        source = _lexical_absolute(source)
        dereference_value = raw.get("dereferenceInternalSymlinks", False)
        if type(dereference_value) is not bool:
            raise SnapshotError(f"plan_component_dereference_invalid:{name}")
        dereference = bool(dereference_value)
        if dereference and profile != PRODUCTION_COMPLETE_PROFILE:
            raise SnapshotError(f"plan_component_dereference_not_allowed:{name}")
        if source.is_symlink():
            if kind != "file" or not dereference:
                raise SnapshotError(f"plan_component_symlink:{name}")
            allowed_root = PRODUCTION_COMPONENT_SYMLINK_ROOTS.get(name)
            if allowed_root is None:
                raise SnapshotError(f"plan_component_dereference_not_allowed:{name}")
            content_path, _raw_target = _resolve_regular_symlink(
                source,
                allowed_root=allowed_root,
                allow_absolute_link=True,
                label=name,
            )
        else:
            content_path = source.resolve(strict=False)
        allow_outside = raw.get("allowOutsidePersistentRoot") is True
        if not _within(content_path, persistent_root):
            production_external_directory = (
                profile == PRODUCTION_COMPLETE_PROFILE
                and kind == "directory"
                and allow_outside
                and name in PRODUCTION_COMPLETE_COMPONENTS
                and PRODUCTION_COMPLETE_COMPONENTS[name][0] == "directory"
                and PRODUCTION_COMPLETE_COMPONENTS[name][3] is True
            )
            if not (
                allow_outside
                and (kind == "file" or production_external_directory)
            ):
                raise SnapshotError(f"plan_component_outside_persistent_root:{name}")
        required = raw.get("required", True) is not False
        if required and not content_path.exists():
            raise SnapshotError(f"plan_component_missing:{name}")
        if content_path.exists():
            if kind == "directory" and not content_path.is_dir():
                raise SnapshotError(f"plan_component_not_directory:{name}")
            if kind in {"file", "sqlite"} and not content_path.is_file():
                raise SnapshotError(f"plan_component_not_file:{name}")
        names.add(name)
        components.append({
            "name": name,
            "type": kind,
            "path": source,
            "contentPath": content_path,
            "required": required,
            "allowOutsidePersistentRoot": allow_outside,
            "dereferenceInternalSymlinks": dereference,
        })
    sqlite_components = [item for item in components if item["type"] == "sqlite"]
    if len(sqlite_components) != 1:
        raise SnapshotError("plan_requires_exactly_one_sqlite")
    if profile == PRODUCTION_COMPLETE_PROFILE:
        _validate_production_component_contract(
            components,
            persistent_root,
            snapshot=False,
        )
        _validate_production_systemd_environment_binding(components)
    return components


def _directory_entry_source(
    root: Path,
    path: Path,
    *,
    dereference_internal_symlinks: bool,
) -> tuple[Path, os.stat_result, dict]:
    relative = path.relative_to(root).as_posix()
    try:
        link_info = path.lstat()
    except OSError as exc:
        raise SnapshotError(f"directory_entry_unreadable:{relative}") from exc
    if stat.S_ISLNK(link_info.st_mode):
        if not dereference_internal_symlinks:
            raise SnapshotError(f"file_symlink_rejected:{path}")
        resolved, raw_target = _resolve_regular_symlink(
            path,
            allowed_root=root,
            allow_absolute_link=False,
            label=relative,
        )
        info = resolved.stat()
        return resolved, info, {
            "dereferencedSymlink": True,
            "linkTarget": raw_target,
            "targetPath": resolved.relative_to(
                root.resolve(strict=True)
            ).as_posix(),
        }
    if not stat.S_ISREG(link_info.st_mode):
        raise SnapshotError(f"special_file_rejected:{path}")
    return path, link_info, {}


def _directory_inventory(
    root: Path,
    *,
    dereference_internal_symlinks: bool = False,
) -> list[dict]:
    entries: list[dict] = []
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        for dirname in list(dirnames):
            path = current_path / dirname
            if path.is_symlink():
                raise SnapshotError(f"directory_symlink_rejected:{path}")
        for filename in filenames:
            path = current_path / filename
            content_path, info, symlink_metadata = _directory_entry_source(
                root,
                path,
                dereference_internal_symlinks=dereference_internal_symlinks,
            )
            entries.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "bytes": info.st_size,
                    "sha256": _sha256(content_path),
                    "mode": stat.S_IMODE(info.st_mode),
                    "mtimeNs": info.st_mtime_ns,
                    **symlink_metadata,
                }
            )
    return sorted(entries, key=lambda item: item["path"])


def _file_component_source(item: dict) -> tuple[Path, os.stat_result, dict]:
    """Revalidate one file component and return the bytes-bearing path."""

    source = item["path"]
    if source.is_symlink():
        if not item["dereferenceInternalSymlinks"]:
            raise SnapshotError(f"plan_component_symlink:{item['name']}")
        allowed_root = PRODUCTION_COMPONENT_SYMLINK_ROOTS.get(item["name"])
        if allowed_root is None:
            raise SnapshotError(
                f"plan_component_dereference_not_allowed:{item['name']}"
            )
        content_path, raw_target = _resolve_regular_symlink(
            source,
            allowed_root=allowed_root,
            allow_absolute_link=True,
            label=item["name"],
        )
        return content_path, content_path.stat(), {
            "sourceWasSymlink": True,
            "linkTarget": raw_target,
            "resolvedSource": str(content_path),
        }
    try:
        info = source.lstat()
    except OSError as exc:
        raise SnapshotError(f"plan_component_missing:{item['name']}") from exc
    if not stat.S_ISREG(info.st_mode):
        raise SnapshotError(f"special_file_rejected:{source}")
    return source, info, {"sourceWasSymlink": False}


def _content_inventory(entries: list[dict]) -> list[dict]:
    """Compare restored bytes and modes without relying on filesystem mtime precision."""
    return [
        {
            "path": item["path"],
            "bytes": item["bytes"],
            "sha256": item["sha256"],
            "mode": item["mode"],
        }
        for item in entries
    ]


def _restored_inventory(entries: list[dict]) -> list[dict]:
    """Compare every field that binds a restored file to its snapshot."""

    return [
        {
            "path": entry["path"],
            "bytes": entry["bytes"],
            "sha256": entry["sha256"],
            "mode": entry["mode"],
            "mtimeNs": entry["mtimeNs"],
        }
        for entry in entries
    ]


def _archive_directory(
    source: Path,
    archive: Path,
    entries: list[dict],
    *,
    dereference_internal_symlinks: bool = False,
) -> None:
    expected = {item["path"]: item for item in entries}
    with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as bundle:
        for relative, item in expected.items():
            path = source / PurePosixPath(relative)
            content_path, before, metadata = _directory_entry_source(
                source,
                path,
                dereference_internal_symlinks=dereference_internal_symlinks,
            )
            if (
                before.st_size != item["bytes"]
                or before.st_mtime_ns != item["mtimeNs"]
                or metadata != {
                    key: item[key]
                    for key in ("dereferencedSymlink", "linkTarget", "targetPath")
                    if key in item
                }
            ):
                raise SnapshotError(f"source_changed_during_snapshot:{relative}")
            member = tarfile.TarInfo(relative)
            member.size = before.st_size
            member.mode = stat.S_IMODE(before.st_mode)
            member.mtime = before.st_mtime
            with content_path.open("rb") as handle:
                bundle.addfile(member, handle)
            _after_path, after, after_metadata = _directory_entry_source(
                source,
                path,
                dereference_internal_symlinks=dereference_internal_symlinks,
            )
            if (
                before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or after.st_size != item["bytes"]
                or after.st_mtime_ns != item["mtimeNs"]
                or metadata != after_metadata
            ):
                raise SnapshotError(f"source_changed_during_snapshot:{relative}")
    with archive.open("rb") as handle:
        os.fsync(handle.fileno())
    _verify_archive(archive, entries)
    if _directory_inventory(
        source,
        dereference_internal_symlinks=dereference_internal_symlinks,
    ) != entries:
        raise SnapshotError(f"source_changed_during_snapshot:{source}")


def _safe_member_name(name: str) -> str:
    value = PurePosixPath(name)
    if value.is_absolute() or ".." in value.parts or not value.parts:
        raise SnapshotError(f"archive_path_unsafe:{name}")
    return value.as_posix()


def _verify_archive(archive: Path, entries: list[dict]) -> None:
    expected = {item["path"]: item for item in entries}
    observed: set[str] = set()
    with tarfile.open(archive, "r") as bundle:
        for member in bundle:
            name = _safe_member_name(member.name)
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                raise SnapshotError(f"archive_member_unsafe:{name}")
            if name not in expected or name in observed:
                raise SnapshotError(f"archive_member_unexpected:{name}")
            handle = bundle.extractfile(member)
            if handle is None:
                raise SnapshotError(f"archive_member_unreadable:{name}")
            digest = hashlib.sha256()
            count = 0
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                count += len(chunk)
                digest.update(chunk)
            item = expected[name]
            if count != item["bytes"] or digest.hexdigest() != item["sha256"]:
                raise SnapshotError(f"archive_member_hash_mismatch:{name}")
            observed.add(name)
    if observed != set(expected):
        raise SnapshotError("archive_members_missing")


def create_snapshot(plan_path: Path, persistent_root: Path, output: Path) -> dict:
    persistent_root = persistent_root.resolve(strict=True)
    if not persistent_root.is_dir():
        raise SnapshotError("persistent_root_not_directory")
    plan, plan_raw = _load_json(plan_path)
    components = _validate_plan(plan, persistent_root)
    if output.exists():
        raise SnapshotError(f"output_already_exists:{output}")
    if not output.parent.is_dir():
        raise SnapshotError(f"output_parent_missing:{output.parent}")
    output_resolved = output.resolve(strict=False)
    if any(_within(output_resolved, item["contentPath"]) for item in components):
        raise SnapshotError("output_inside_source_component")
    stage = Path(tempfile.mkdtemp(prefix=".runtime-snapshot-", dir=output.parent))
    os.chmod(stage, 0o700)
    snapshot_id = uuid.uuid4().hex
    manifest_components: list[dict] = []
    try:
        component_root = stage / "components"
        component_root.mkdir(mode=0o700)
        for item in components:
            name, kind, source = item["name"], item["type"], item["path"]
            content_source = item["contentPath"]
            if not content_source.exists():
                manifest_components.append(
                    {
                        "name": name,
                        "type": kind,
                        "source": str(source),
                        "required": item["required"],
                        "allowOutsidePersistentRoot": item[
                            "allowOutsidePersistentRoot"
                        ],
                        "dereferenceInternalSymlinks": item[
                            "dereferenceInternalSymlinks"
                        ],
                        "state": "absent",
                    }
                )
                continue
            common = {
                "name": name,
                "type": kind,
                "source": str(source),
                "required": item["required"],
                "allowOutsidePersistentRoot": item[
                    "allowOutsidePersistentRoot"
                ],
                "dereferenceInternalSymlinks": item[
                    "dereferenceInternalSymlinks"
                ],
            }
            if kind == "sqlite":
                destination = component_root / f"{name}.sqlite"
                db_manifest = component_root / f"{name}.sqlite.manifest.json"
                backup = _load_backup_module()
                payload = backup.create_backup(
                    content_source, destination, db_manifest
                )
                manifest_components.append(
                    {
                        **common,
                        "artifact": destination.relative_to(stage).as_posix(),
                        "artifactSha256": _sha256(destination),
                        "artifactBytes": destination.stat().st_size,
                        "databaseManifest": db_manifest.relative_to(stage).as_posix(),
                        "databaseManifestSha256": _sha256(db_manifest),
                        "quickCheck": (payload.get("backup") or {}).get("quickCheck"),
                    }
                )
            elif kind == "directory":
                entries = _directory_inventory(
                    content_source,
                    dereference_internal_symlinks=item[
                        "dereferenceInternalSymlinks"
                    ],
                )
                archive = component_root / f"{name}.tar"
                _archive_directory(
                    content_source,
                    archive,
                    entries,
                    dereference_internal_symlinks=item[
                        "dereferenceInternalSymlinks"
                    ],
                )
                manifest_components.append(
                    {
                        **common,
                        "artifact": archive.relative_to(stage).as_posix(),
                        "artifactSha256": _sha256(archive),
                        "artifactBytes": archive.stat().st_size,
                        "fileCount": len(entries),
                        "contentBytes": sum(entry["bytes"] for entry in entries),
                        "files": entries,
                    }
                )
            else:
                file_source, info, source_metadata = _file_component_source(item)
                source_sha256 = _sha256(file_source)
                after_initial_path, after_initial_hash, initial_metadata = (
                    _file_component_source(item)
                )
                if (
                    after_initial_path != file_source
                    or after_initial_hash.st_size != info.st_size
                    or after_initial_hash.st_mtime_ns != info.st_mtime_ns
                    or initial_metadata != source_metadata
                ):
                    raise SnapshotError(f"source_changed_during_snapshot:{source}")
                destination = component_root / f"{name}.file"
                shutil.copyfile(file_source, destination)
                os.chmod(destination, 0o600)
                with destination.open("rb") as handle:
                    os.fsync(handle.fileno())
                final_path, final_info, final_metadata = _file_component_source(item)
                final_source_sha256 = _sha256(final_path)
                after_final_path, after_final_hash, after_final_metadata = (
                    _file_component_source(item)
                )
                if (
                    final_path != file_source
                    or after_final_path != file_source
                    or final_info.st_mtime_ns != info.st_mtime_ns
                    or final_info.st_size != info.st_size
                    or after_final_hash.st_mtime_ns != info.st_mtime_ns
                    or after_final_hash.st_size != info.st_size
                    or final_metadata != source_metadata
                    or after_final_metadata != source_metadata
                    or final_source_sha256 != source_sha256
                    or _sha256(destination) != source_sha256
                ):
                    raise SnapshotError(f"source_changed_during_snapshot:{source}")
                manifest_components.append(
                    {
                        **common,
                        "artifact": destination.relative_to(stage).as_posix(),
                        "artifactSha256": _sha256(destination),
                        "artifactBytes": destination.stat().st_size,
                        "mode": stat.S_IMODE(info.st_mode),
                        **source_metadata,
                    }
                )
        manifest = {
            "format": SNAPSHOT_FORMAT,
            "profile": str(plan.get("profile") or ""),
            "snapshotId": snapshot_id,
            "releaseId": str(plan["releaseId"]),
            "createdAt": int(time.time() * 1000),
            "persistentRoot": str(persistent_root),
            "planSha256": hashlib.sha256(plan_raw).hexdigest(),
            "components": manifest_components,
        }
        encoded = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
        manifest_path = stage / "snapshot.manifest.json"
        _write_fsync(manifest_path, encoded)
        _write_fsync(stage / "snapshot.manifest.sha256", (hashlib.sha256(encoded).hexdigest() + "\n").encode("ascii"))
        _fsync_directory(component_root)
        _fsync_directory(stage)
        os.replace(stage, output)
        _fsync_directory(output.parent)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    verify_snapshot(output)
    return manifest


def verify_snapshot(
    root: Path,
    *,
    expected_manifest_sha256: str = "",
) -> dict:
    manifest_path = root / "snapshot.manifest.json"
    digest_path = root / "snapshot.manifest.sha256"
    if not root.is_dir() or not manifest_path.is_file() or not digest_path.is_file():
        raise SnapshotError("snapshot_manifest_missing")
    manifest, raw = _load_json(manifest_path)
    if manifest.get("format") != SNAPSHOT_FORMAT:
        raise SnapshotError("snapshot_format_mismatch")
    expected_digest = digest_path.read_text("ascii").strip()
    actual_digest = hashlib.sha256(raw).hexdigest()
    if expected_digest != actual_digest:
        raise SnapshotError("snapshot_manifest_hash_mismatch")
    confirmed_digest = str(expected_manifest_sha256 or "").strip().lower()
    if confirmed_digest:
        if not re.fullmatch(r"[0-9a-f]{64}", confirmed_digest):
            raise SnapshotError("snapshot_manifest_confirmation_invalid")
        if confirmed_digest != actual_digest:
            raise SnapshotError("snapshot_manifest_confirmation_mismatch")
    components = manifest.get("components")
    if not isinstance(components, list) or not components:
        raise SnapshotError("snapshot_components_missing")
    component_names = []
    for item in components:
        if not isinstance(item, dict):
            raise SnapshotError("snapshot_component_invalid")
        name = str(item.get("name") or "")
        if not NAME_RE.fullmatch(name):
            raise SnapshotError("snapshot_component_name_invalid")
        component_names.append(name)
    if len(component_names) != len(set(component_names)):
        raise SnapshotError("snapshot_component_name_duplicate")
    profile = str(manifest.get("profile") or "").strip()
    if profile and profile != PRODUCTION_COMPLETE_PROFILE:
        raise SnapshotError("snapshot_profile_unknown")
    if profile == PRODUCTION_COMPLETE_PROFILE:
        persistent_root = Path(str(manifest.get("persistentRoot") or ""))
        if not persistent_root.is_absolute():
            raise SnapshotError("production_snapshot_persistent_root_invalid")
        _validate_production_component_contract(
            components,
            persistent_root.resolve(strict=False),
            snapshot=True,
        )
    expected_artifacts = {"snapshot.manifest.json", "snapshot.manifest.sha256"}
    for item in components:
        if item.get("state") == "absent":
            continue
        artifact_name = _safe_member_name(str(item.get("artifact") or ""))
        expected_artifacts.add(artifact_name)
        artifact = root / artifact_name
        if not artifact.is_file():
            raise SnapshotError(f"snapshot_artifact_missing:{artifact_name}")
        if artifact.stat().st_size != int(item.get("artifactBytes") or -1):
            raise SnapshotError(f"snapshot_artifact_size_mismatch:{artifact_name}")
        if _sha256(artifact) != item.get("artifactSha256"):
            raise SnapshotError(f"snapshot_artifact_hash_mismatch:{artifact_name}")
        if item.get("type") == "directory":
            _verify_archive(artifact, item.get("files") or [])
        if item.get("type") == "sqlite":
            db_manifest_name = _safe_member_name(str(item.get("databaseManifest") or ""))
            expected_artifacts.add(db_manifest_name)
            db_manifest = root / db_manifest_name
            if not db_manifest.is_file() or _sha256(db_manifest) != item.get("databaseManifestSha256"):
                raise SnapshotError(f"database_manifest_mismatch:{item.get('name')}")
            with sqlite3.connect(f"file:{artifact}?mode=ro", uri=True) as conn:
                if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise SnapshotError(f"snapshot_database_quick_check_failed:{item.get('name')}")
    actual_artifacts = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }
    if actual_artifacts != expected_artifacts:
        raise SnapshotError("snapshot_unexpected_artifacts")
    return {
        "ok": True,
        "snapshotId": manifest.get("snapshotId"),
        "releaseId": manifest.get("releaseId"),
        "profile": profile,
        "componentNames": sorted(
            str(item.get("name") or "")
            for item in components
            if isinstance(item, dict)
        ),
        "componentCount": len(components),
        "mediaInventoryDigest": _media_inventory_digest_from_components(
            components
        ),
        "manifestSha256": expected_digest,
    }


def _safe_extract(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r") as bundle:
        members = []
        for member in bundle:
            _safe_member_name(member.name)
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise SnapshotError(f"archive_member_unsafe:{member.name}")
            members.append(member)
        bundle.extractall(destination, members=members)


def _restore_directory_mtimes(root: Path, entries: list[dict]) -> None:
    """Restore exact manifest nanoseconds without ever following a symlink."""

    for entry in entries:
        relative = _safe_member_name(str(entry.get("path") or ""))
        mtime_ns = entry.get("mtimeNs")
        if type(mtime_ns) is not int or mtime_ns < 0:
            raise SnapshotError(f"restored_directory_mtime_invalid:{relative}")
        path = root / PurePosixPath(relative)
        try:
            before = path.lstat()
        except OSError as exc:
            raise SnapshotError(
                f"restored_directory_file_missing:{relative}"
            ) from exc
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
            raise SnapshotError(f"restored_directory_file_unsafe:{relative}")
        try:
            os.utime(
                path,
                ns=(mtime_ns, mtime_ns),
                follow_symlinks=False,
            )
            after = path.lstat()
        except (OSError, TypeError, ValueError, OverflowError) as exc:
            raise SnapshotError(
                f"restored_directory_mtime_unavailable:{relative}"
            ) from exc
        if (
            stat.S_ISLNK(after.st_mode)
            or not stat.S_ISREG(after.st_mode)
            or after.st_mtime_ns != mtime_ns
        ):
            raise SnapshotError(f"restored_directory_mtime_mismatch:{relative}")


def restore_drill(
    snapshot: Path,
    output: Path,
    *,
    expected_manifest_sha256: str,
) -> dict:
    if not str(expected_manifest_sha256 or "").strip():
        raise SnapshotError("snapshot_manifest_confirmation_required")
    verified = verify_snapshot(
        snapshot,
        expected_manifest_sha256=expected_manifest_sha256,
    )
    if output.exists():
        raise SnapshotError(f"restore_output_already_exists:{output}")
    if not output.parent.is_dir():
        raise SnapshotError(f"restore_output_parent_missing:{output.parent}")
    if _within(output.resolve(strict=False), snapshot.resolve()):
        raise SnapshotError("restore_output_inside_snapshot")
    manifest, _raw = _load_json(snapshot / "snapshot.manifest.json")
    stage = Path(tempfile.mkdtemp(prefix=".runtime-restore-", dir=output.parent))
    os.chmod(stage, 0o700)
    restored: list[dict] = []
    try:
        for item in manifest["components"]:
            name = item["name"]
            target = stage / name
            if item.get("state") == "absent":
                restored.append({"name": name, "state": "absent"})
                continue
            artifact = snapshot / item["artifact"]
            if item["type"] == "directory":
                target.mkdir(mode=0o700)
                _safe_extract(artifact, target)
                _restore_directory_mtimes(target, item["files"])
                actual = _directory_inventory(target)
                if _restored_inventory(actual) != _restored_inventory(
                    item["files"]
                ):
                    raise SnapshotError(f"restored_directory_mismatch:{name}")
                restored.append({"name": name, "type": "directory", "fileCount": len(actual)})
            else:
                shutil.copyfile(artifact, target)
                os.chmod(target, 0o600)
                if _sha256(target) != item["artifactSha256"]:
                    raise SnapshotError(f"restored_file_mismatch:{name}")
                result = {"name": name, "type": item["type"], "bytes": target.stat().st_size}
                if item["type"] == "sqlite":
                    with sqlite3.connect(target) as conn:
                        quick = conn.execute("PRAGMA quick_check").fetchone()[0]
                    if quick != "ok":
                        raise SnapshotError(f"restored_database_quick_check_failed:{name}")
                    result["quickCheck"] = quick
                restored.append(result)
        report = {
            "format": RESTORE_FORMAT,
            "snapshotId": manifest["snapshotId"],
            "releaseId": manifest["releaseId"],
            "restoredAt": int(time.time() * 1000),
            "snapshotManifestSha256": verified["manifestSha256"],
            "components": restored,
            "ok": True,
        }
        encoded = (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
        _write_fsync(stage / "restore.report.json", encoded)
        _write_fsync(stage / "restore.report.sha256", (hashlib.sha256(encoded).hexdigest() + "\n").encode("ascii"))
        _fsync_directory(stage)
        os.replace(stage, output)
        _fsync_directory(output.parent)
        return report
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--plan", type=Path, required=True)
    create.add_argument("--persistent-root", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--snapshot", type=Path, required=True)
    verify.add_argument("--confirm-manifest-sha256", required=True)
    restore = sub.add_parser("restore-drill")
    restore.add_argument("--snapshot", type=Path, required=True)
    restore.add_argument("--output", type=Path, required=True)
    restore.add_argument("--confirm-manifest-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            create_snapshot(args.plan, args.persistent_root, args.output)
            confirmed = (
                args.output / "snapshot.manifest.sha256"
            ).read_text("ascii").strip()
            payload = verify_snapshot(
                args.output,
                expected_manifest_sha256=confirmed,
            )
        elif args.command == "verify":
            payload = verify_snapshot(
                args.snapshot,
                expected_manifest_sha256=args.confirm_manifest_sha256,
            )
        else:
            payload = restore_drill(
                args.snapshot,
                args.output,
                expected_manifest_sha256=args.confirm_manifest_sha256,
            )
    except (SnapshotError, OSError, ValueError, json.JSONDecodeError, sqlite3.Error, tarfile.TarError) as exc:
        print(f"Runtime snapshot failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
