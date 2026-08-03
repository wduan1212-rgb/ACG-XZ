#!/usr/bin/env python3
"""Create and verify a transactionally consistent SQLite backup.

The source is opened read-only and copied with SQLite's online backup API, so
WAL state is included in one database snapshot.  A destination quick_check and
SHA-256 digest are written only after the backup has closed successfully.

The v2 manifest also binds the snapshot to the source database inode identity,
resolved-path digest and logical SQLite contents.  Migration commands require
the independently recorded manifest-file SHA-256, so an edited or unverified
manifest cannot silently unlock a production write.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sqlite3
import sys
import time
import unicodedata
import uuid
from contextlib import closing
from pathlib import Path
from urllib.parse import quote


def _readonly_uri(path: Path) -> str:
    return f"file:{quote(str(path), safe='/')}?mode=ro"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _path_sha256(path: Path) -> str:
    resolved = path.expanduser().resolve(strict=False)
    return hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()


def _database_identity(path: Path) -> str:
    stat = path.stat()
    raw = f"{stat.st_dev}:{stat.st_ino}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _logical_sha256_connection(conn: sqlite3.Connection) -> str:
    """Hash logical schema/data without depending on WAL or page layout."""

    digest = hashlib.sha256()
    for statement in conn.iterdump():
        encoded = statement.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def _logical_sha256(path: Path) -> str:
    with closing(sqlite3.connect(_readonly_uri(path), uri=True, timeout=30)) as conn:
        conn.execute("BEGIN")
        try:
            value = _logical_sha256_connection(conn)
        finally:
            conn.rollback()
    return value


def _quick_check(path: Path, *, read_only: bool = False) -> str:
    # The backup may retain WAL journal-mode metadata.  Opening the closed,
    # private copy normally lets SQLite perform any harmless recovery/checkpoint
    # bookkeeping it requires before we hash the final single-file snapshot.
    target = _readonly_uri(path) if read_only else str(path)
    with closing(sqlite3.connect(target, timeout=30, uri=read_only)) as conn:
        rows = conn.execute("PRAGMA quick_check").fetchall()
    result = "\n".join(str(row[0]) for row in rows)
    if result != "ok":
        raise RuntimeError(f"SQLite quick_check failed: {result[:300]}")
    return result


def _strict_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate manifest key: {key}")
        result[key] = value
    return result


def _required_hex(value, length: int, label: str) -> str:
    normalized = str(value or "").strip().lower()
    if len(normalized) != length or any(
        char not in "0123456789abcdef" for char in normalized
    ):
        raise ValueError(f"invalid {label}")
    return normalized


def verify_backup_manifest(
    manifest: Path,
    backup_database: Path,
    *,
    expected_manifest_sha256: str,
) -> dict:
    """Verify an immutable v2 manifest and its closed SQLite artifact.

    The returned mapping contains only the source binding needed by the store's
    in-transaction migration gate.  No absolute paths or database contents are
    returned or printed.
    """

    manifest_input = Path(manifest).expanduser()
    backup_input = Path(backup_database).expanduser()
    if manifest_input.is_symlink():
        raise ValueError("backup manifest must be a regular non-symlink file")
    if backup_input.is_symlink():
        raise ValueError("backup database must be a regular non-symlink file")
    manifest = manifest_input.resolve(strict=True)
    backup_database = backup_input.resolve(strict=True)
    if not manifest.is_file():
        raise ValueError("backup manifest must be a regular non-symlink file")
    if not backup_database.is_file():
        raise ValueError("backup database must be a regular non-symlink file")
    expected_digest = _required_hex(
        expected_manifest_sha256, 64, "confirmed manifest SHA-256"
    )
    actual_manifest_digest = _sha256(manifest)
    if not hmac.compare_digest(expected_digest, actual_manifest_digest):
        raise ValueError("backup manifest SHA-256 confirmation mismatch")
    try:
        payload = json.loads(
            manifest.read_text("utf-8"), object_pairs_hook=_strict_json_object
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("backup manifest is not valid UTF-8 JSON") from exc
    if not isinstance(payload, dict) or payload.get("format") != "acg-sqlite-backup-v2":
        raise ValueError("verified acg-sqlite-backup-v2 manifest is required")
    if payload.get("verified") is not True:
        raise ValueError("backup manifest is not marked verified")
    if set(payload) != {"format", "verified", "createdAt", "source", "backup"}:
        raise ValueError("backup manifest fields do not match v2 contract")
    source = payload.get("source")
    backup = payload.get("backup")
    if not isinstance(source, dict) or set(source) != {
        "database", "identity", "pathSha256", "logicalSha256",
        "schemaVersion", "userVersion",
    }:
        raise ValueError("backup manifest source fields do not match v2 contract")
    if not isinstance(backup, dict) or set(backup) != {
        "database", "bytes", "sha256", "logicalSha256", "quickCheck",
    }:
        raise ValueError("backup manifest artifact fields do not match v2 contract")
    if backup.get("database") != backup_database.name:
        raise ValueError("backup database name does not match manifest")
    source_database = source.get("database")
    if source_database == "" or Path(str(source_database)).name != source_database:
        raise ValueError("invalid source database name in manifest")
    source_identity = _required_hex(source.get("identity"), 16, "source identity")
    source_path_sha256 = _required_hex(
        source.get("pathSha256"), 64, "source path SHA-256"
    )
    source_logical_sha256 = _required_hex(
        source.get("logicalSha256"), 64, "source logical SHA-256"
    )
    expected_backup_sha256 = _required_hex(
        backup.get("sha256"), 64, "backup SHA-256"
    )
    backup_logical_sha256 = _required_hex(
        backup.get("logicalSha256"), 64, "backup logical SHA-256"
    )
    if type(payload.get("createdAt")) is not int or payload["createdAt"] <= 0:
        raise ValueError("invalid backup creation timestamp")
    if type(source.get("schemaVersion")) is not int or source["schemaVersion"] < 0:
        raise ValueError("invalid source schema version")
    if type(source.get("userVersion")) is not int or source["userVersion"] < 0:
        raise ValueError("invalid source user version")
    if type(backup.get("bytes")) is not int or backup["bytes"] <= 0:
        raise ValueError("invalid backup byte size")
    if backup.get("quickCheck") != "ok":
        raise ValueError("backup manifest was not quick-check verified")
    if backup_database.stat().st_size != backup["bytes"]:
        raise ValueError("backup database size does not match manifest")
    if not hmac.compare_digest(_sha256(backup_database), expected_backup_sha256):
        raise ValueError("backup database SHA-256 does not match manifest")
    _quick_check(backup_database, read_only=True)
    actual_logical_sha256 = _logical_sha256(backup_database)
    if not hmac.compare_digest(actual_logical_sha256, backup_logical_sha256):
        raise ValueError("backup logical SHA-256 does not match manifest")
    if not hmac.compare_digest(source_logical_sha256, backup_logical_sha256):
        raise ValueError("source and backup logical SHA-256 differ")
    return {
        "format": "acg-sqlite-backup-v2",
        "verified": True,
        "manifestSha256": actual_manifest_digest,
        "sourceDatabase": source["database"],
        "sourceIdentity": source_identity,
        "sourcePathSha256": source_path_sha256,
        "sourceLogicalSha256": source_logical_sha256,
        "sourceSchemaVersion": source["schemaVersion"],
        "sourceUserVersion": source["userVersion"],
        "backupSha256": expected_backup_sha256,
    }


def _fsync_file(path: Path) -> None:
    """Flush a closed regular file, including metadata changed by chmod."""

    with path.open("rb") as handle:
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    """Persist directory entries created or removed by atomic publication."""

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _output_paths_alias(left: Path, right: Path) -> bool:
    """Conservatively detect two output names that may resolve to one file."""

    if left == right:
        return True
    try:
        same_parent = os.path.samefile(left.parent, right.parent)
    except OSError:
        same_parent = left.parent == right.parent
    if not same_parent:
        return False
    # APFS/HFS volumes may be case-insensitive and normalize Unicode names.
    # Rejecting the equivalent spellings is harmless on case-sensitive disks
    # and prevents the manifest rename from overwriting the database snapshot.
    def normalized_name(value: str) -> str:
        return unicodedata.normalize("NFC", value).casefold()

    return normalized_name(left.name) == normalized_name(right.name)


def create_backup(source: Path, destination: Path, manifest: Path) -> dict:
    source = source.expanduser().resolve(strict=True)
    destination = destination.expanduser().resolve(strict=False)
    manifest = manifest.expanduser().resolve(strict=False)

    if not source.is_file():
        raise ValueError("source must be an existing regular file")
    if _output_paths_alias(destination, manifest):
        raise ValueError("destination and manifest must be different files")
    if destination.exists() or manifest.exists():
        raise FileExistsError("destination and manifest must not already exist")
    if not destination.parent.is_dir() or not manifest.parent.is_dir():
        raise FileNotFoundError("destination and manifest parents must already exist")
    if source == destination:
        raise ValueError("source and destination must be different")

    source_identity = _database_identity(source)
    source_path_sha256 = _path_sha256(source)

    partial = destination.with_name(
        f".{destination.name}.partial-{os.getpid()}-{uuid.uuid4().hex}"
    )
    partial_manifest = manifest.with_name(
        f".{manifest.name}.partial-{os.getpid()}-{uuid.uuid4().hex}"
    )
    try:
        with closing(
            sqlite3.connect(_readonly_uri(source), uri=True, timeout=30)
        ) as src:
            with closing(sqlite3.connect(str(partial), timeout=30)) as dst:
                src.backup(dst)
                journal_mode = str(
                    dst.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
                ).lower()
                if journal_mode != "delete":
                    raise RuntimeError(
                        f"backup journal mode was not normalized: {journal_mode}"
                    )
        os.chmod(partial, 0o600)
        quick_check = _quick_check(partial)
        _fsync_file(partial)
        size = partial.stat().st_size
        digest = _sha256(partial)
        backup_logical_sha256 = _logical_sha256(partial)
        # A consistent backup is not sufficient for migration binding if a
        # writer changed the source immediately after the snapshot.  Require a
        # still-identical logical state and inode before publishing the pair.
        current_source_identity = _database_identity(source)
        current_source_logical_sha256 = _logical_sha256(source)
        if not hmac.compare_digest(source_identity, current_source_identity):
            raise RuntimeError("source database identity changed during backup")
        if not hmac.compare_digest(
            backup_logical_sha256, current_source_logical_sha256
        ):
            raise RuntimeError("source database changed during backup")
        with closing(
            sqlite3.connect(_readonly_uri(source), uri=True, timeout=30)
        ) as src:
            schema_version = int(src.execute("PRAGMA schema_version").fetchone()[0])
            user_version = int(src.execute("PRAGMA user_version").fetchone()[0])
        payload = {
            "format": "acg-sqlite-backup-v2",
            "verified": True,
            "createdAt": int(time.time() * 1000),
            "source": {
                "database": source.name,
                "identity": source_identity,
                "pathSha256": source_path_sha256,
                "logicalSha256": backup_logical_sha256,
                "schemaVersion": schema_version,
                "userVersion": user_version,
            },
            "backup": {
                "database": destination.name,
                "bytes": size,
                "sha256": digest,
                "logicalSha256": backup_logical_sha256,
                "quickCheck": quick_check,
            },
        }
        with partial_manifest.open("x", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

        published = []
        try:
            os.replace(partial, destination)
            published.append(destination)
            _fsync_directory(destination.parent)
            os.replace(partial_manifest, manifest)
            published.append(manifest)
            _fsync_directory(manifest.parent)
        except BaseException:
            cleanup_parents = set()
            for path in reversed(published):
                try:
                    path.unlink(missing_ok=True)
                    cleanup_parents.add(path.parent)
                except OSError:
                    pass
            for parent in cleanup_parents:
                try:
                    _fsync_directory(parent)
                except OSError:
                    pass
            raise
        return payload
    finally:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(f"{partial}{suffix}").unlink(missing_ok=True)
        partial_manifest.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create a verified SQLite backup without copying live WAL files"
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args(argv)
    manifest = args.manifest or args.destination.with_name(
        f"{args.destination.name}.manifest.json"
    )
    try:
        payload = create_backup(args.source, args.destination, manifest)
    except (FileNotFoundError, FileExistsError, OSError, RuntimeError, sqlite3.Error, ValueError) as exc:
        print(f"consistent SQLite backup failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({
        **payload,
        "manifestSha256": _sha256(manifest.expanduser().resolve(strict=True)),
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
