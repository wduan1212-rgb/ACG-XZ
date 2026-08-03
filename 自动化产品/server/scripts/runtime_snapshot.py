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
Nginx configuration).  Symlinks and special files are rejected.  The caller
must stop/freeze every writer before create; this script verifies bytes, not
the process freeze itself.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
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
    "database": ("sqlite", True, "server/data.sqlite", False),
    "legacy-data": ("file", False, "server/data.json", False),
    "uploads": ("directory", True, "server/uploads", False),
    "composed": ("directory", True, "server/composed", False),
    "canvas-blobs": ("directory", True, "server/canvas_blobs", False),
    "model-usage-spool": (
        "directory", False, "server/model_usage_spool", False,
    ),
    "server-logs": ("directory", False, "server/logs", False),
    "video-projects": (
        "directory", True, "runtime/video-workshop/projects", False,
    ),
    "video-uploads": (
        "directory", True, "runtime/video-workshop/uploads", False,
    ),
    "video-outputs": (
        "directory", True, "runtime/video-workshop/outputs", False,
    ),
    "bgm-library": ("directory", True, "runtime/bgm-library", False),
    "model-cache": ("directory", True, "runtime/model-cache", False),
    "runtime-env-public": ("file", True, ".env", False),
    "runtime-env-private": ("file", True, ".env.local", False),
    "runtime-env-v140": (
        "file", False, "/data/dumate-studio/config/runtime-v140.env", True,
    ),
    "systemd-main": (
        "file", True, "/etc/systemd/system/dumate-studio.service", True,
    ),
    "systemd-video": (
        "file", True,
        "/etc/systemd/system/dumate-studio-video-workshop.service", True,
    ),
    "nginx-site": (
        "file", True, "/etc/nginx/sites-enabled/xingzhenworld.com", True,
    ),
}
PRODUCTION_MEDIA_COMPONENTS = {
    "uploads",
    "composed",
    "canvas-blobs",
    "video-uploads",
    "video-outputs",
}
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
    for name, (kind, required, relative, outside) in (
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
        if required and snapshot and item.get("state") == "absent":
            raise SnapshotError(f"production_profile_component_absent:{name}")
        source = Path(str(item.get("source" if snapshot else "path") or ""))
        if relative is not None:
            expected = (persistent_root / relative).resolve(strict=False)
            if source.resolve(strict=False) != expected:
                raise SnapshotError(
                    f"production_profile_component_path_invalid:{name}"
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
        if source.is_symlink():
            raise SnapshotError(f"plan_component_symlink:{name}")
        resolved = source.resolve(strict=False)
        allow_outside = raw.get("allowOutsidePersistentRoot") is True
        if not _within(resolved, persistent_root):
            if not (allow_outside and kind == "file"):
                raise SnapshotError(f"plan_component_outside_persistent_root:{name}")
        required = raw.get("required", True) is not False
        if required and not resolved.exists():
            raise SnapshotError(f"plan_component_missing:{name}")
        if resolved.exists():
            if kind == "directory" and not resolved.is_dir():
                raise SnapshotError(f"plan_component_not_directory:{name}")
            if kind in {"file", "sqlite"} and not resolved.is_file():
                raise SnapshotError(f"plan_component_not_file:{name}")
        names.add(name)
        components.append({
            "name": name,
            "type": kind,
            "path": resolved,
            "required": required,
            "allowOutsidePersistentRoot": allow_outside,
        })
    sqlite_components = [item for item in components if item["type"] == "sqlite"]
    if len(sqlite_components) != 1:
        raise SnapshotError("plan_requires_exactly_one_sqlite")
    profile = str(plan.get("profile") or "").strip()
    if profile and profile != PRODUCTION_COMPLETE_PROFILE:
        raise SnapshotError("plan_profile_unknown")
    if profile == PRODUCTION_COMPLETE_PROFILE:
        _validate_production_component_contract(
            components,
            persistent_root,
            snapshot=False,
        )
    return components


def _directory_inventory(root: Path) -> list[dict]:
    entries: list[dict] = []
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        for dirname in list(dirnames):
            path = current_path / dirname
            if path.is_symlink():
                raise SnapshotError(f"directory_symlink_rejected:{path}")
        for filename in filenames:
            path = current_path / filename
            if path.is_symlink():
                raise SnapshotError(f"file_symlink_rejected:{path}")
            info = path.stat()
            if not stat.S_ISREG(info.st_mode):
                raise SnapshotError(f"special_file_rejected:{path}")
            entries.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "bytes": info.st_size,
                    "sha256": _sha256(path),
                    "mode": stat.S_IMODE(info.st_mode),
                    "mtimeNs": info.st_mtime_ns,
                }
            )
    return sorted(entries, key=lambda item: item["path"])


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


def _archive_directory(source: Path, archive: Path, entries: list[dict]) -> None:
    expected = {item["path"]: item for item in entries}
    with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as bundle:
        for relative, item in expected.items():
            path = source / PurePosixPath(relative)
            before = path.stat()
            bundle.add(path, arcname=relative, recursive=False)
            after = path.stat()
            if (
                before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or after.st_size != item["bytes"]
                or after.st_mtime_ns != item["mtimeNs"]
            ):
                raise SnapshotError(f"source_changed_during_snapshot:{relative}")
    with archive.open("rb") as handle:
        os.fsync(handle.fileno())
    _verify_archive(archive, entries)
    if _directory_inventory(source) != entries:
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
    if any(_within(output_resolved, item["path"]) for item in components):
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
            if not source.exists():
                manifest_components.append(
                    {
                        "name": name,
                        "type": kind,
                        "source": str(source),
                        "required": item["required"],
                        "allowOutsidePersistentRoot": item[
                            "allowOutsidePersistentRoot"
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
            }
            if kind == "sqlite":
                destination = component_root / f"{name}.sqlite"
                db_manifest = component_root / f"{name}.sqlite.manifest.json"
                backup = _load_backup_module()
                payload = backup.create_backup(source, destination, db_manifest)
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
                entries = _directory_inventory(source)
                archive = component_root / f"{name}.tar"
                _archive_directory(source, archive, entries)
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
                info = source.stat()
                if not stat.S_ISREG(info.st_mode):
                    raise SnapshotError(f"special_file_rejected:{source}")
                source_sha256 = _sha256(source)
                after_initial_hash = source.stat()
                if (
                    after_initial_hash.st_size != info.st_size
                    or after_initial_hash.st_mtime_ns != info.st_mtime_ns
                ):
                    raise SnapshotError(f"source_changed_during_snapshot:{source}")
                destination = component_root / f"{name}.file"
                shutil.copyfile(source, destination)
                os.chmod(destination, 0o600)
                with destination.open("rb") as handle:
                    os.fsync(handle.fileno())
                final_info = source.stat()
                final_source_sha256 = _sha256(source)
                after_final_hash = source.stat()
                if (
                    final_info.st_mtime_ns != info.st_mtime_ns
                    or final_info.st_size != info.st_size
                    or after_final_hash.st_mtime_ns != info.st_mtime_ns
                    or after_final_hash.st_size != info.st_size
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
                actual = _directory_inventory(target)
                if _content_inventory(actual) != _content_inventory(item["files"]):
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
