#!/usr/bin/env python3
"""Create and verify a transactionally consistent SQLite backup.

The source is opened read-only and copied with SQLite's online backup API, so
WAL state is included in one database snapshot.  A destination quick_check and
SHA-256 digest are written only after the backup has closed successfully.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
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


def _quick_check(path: Path) -> str:
    # The backup may retain WAL journal-mode metadata.  Opening the closed,
    # private copy normally lets SQLite perform any harmless recovery/checkpoint
    # bookkeeping it requires before we hash the final single-file snapshot.
    with closing(sqlite3.connect(str(path), timeout=30)) as conn:
        rows = conn.execute("PRAGMA quick_check").fetchall()
    result = "\n".join(str(row[0]) for row in rows)
    if result != "ok":
        raise RuntimeError(f"SQLite quick_check failed: {result[:300]}")
    return result


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
        payload = {
            "format": "acg-sqlite-backup-v1",
            "database": destination.name,
            "bytes": size,
            "sha256": digest,
            "quickCheck": quick_check,
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
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
