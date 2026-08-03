"""Auditable, opt-in schema migration CLI.

Examples::

    python -m server.migrations status
    ACG_ALLOW_SCHEMA_MIGRATION=1 python -m server.migrations apply \
        --confirm-version <approved next version> --confirm-identity <status identity> \
        --backup-manifest <snapshot.manifest.json> \
        --backup-database <snapshot.sqlite> \
        --confirm-backup-manifest-sha256 <recorded sha256>

The apply command is expand-only and applies the exact confirmed schema
migration.  It does not migrate ACG ownership, seed accounts, normalize roles,
or update credentials.

ACG ownership is a separate dry-run/apply pair::

    python -m server.migrations acg-preflight <confirmations>
    ACG_ALLOW_ACG_TEAM_MIGRATION=1 \
      python -m server.migrations acg-apply <same confirmations>

Legacy resource ownership is frozen only after the ACG mapping is complete::

    python -m server.migrations resource-preflight <confirmations>
    ACG_ALLOW_RESOURCE_SCOPE_MIGRATION=1 \
      python -m server.migrations resource-apply <same confirmations>

Private media ownership is then registered without changing any file URL::

    python -m server.migrations media-preflight <confirmations>
    ACG_ALLOW_PRIVATE_MEDIA_MIGRATION=1 \
      python -m server.migrations media-apply <same confirmations>
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import sqlite3
import sys
from pathlib import Path

from .. import config

# Config must be loaded before store freezes DATA_DB/CUSTOM_CANVAS_BLOB_DIR.
config.load_environment()
from .. import store  # noqa: E402
from ..scripts import consistent_sqlite_backup  # noqa: E402
from ..scripts import runtime_snapshot  # noqa: E402


def _safe_status() -> dict:
    status = store.database_readiness()
    return {
        "ok": bool(status.get("ok")),
        "exists": bool(status.get("exists")),
        "identity": status.get("identity") or "",
        "quickCheck": status.get("quickCheck"),
        "schemaVersion": status.get("schemaVersion"),
        "userVersion": status.get("userVersion"),
        "migrationVersion": status.get("migrationVersion"),
        "migrationDirty": status.get("migrationDirty"),
        "modelUsageMigrationVersion": status.get("modelUsageMigrationVersion"),
        "modelUsageMigrationChecksum": status.get("modelUsageMigrationChecksum") or "",
        "modelUsageUnresolved": status.get("modelUsageUnresolved"),
        "missingTables": status.get("missingTables") or [],
        "missingColumns": status.get("missingColumns") or {},
        "checksum": status.get("checksum") or "",
        "authSecret": bool(status.get("authSecret")),
        "internalTeam": bool(status.get("internalTeam")),
        "acgMigration": bool(status.get("acgMigration")),
        "acgMigrationVersion": status.get("acgMigrationVersion"),
        "acgMigrationChecksum": status.get("acgMigrationChecksum") or "",
        "acgMigrationDrift": status.get("acgMigrationDrift"),
        "resourceScopeSchema": bool(
            status.get("resourceScopeSchemaVersion")
            == store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
        ),
        "resourceScopeSchemaVersion": status.get("resourceScopeSchemaVersion"),
        "resourceScopeMigration": bool(status.get("resourceScopeMigration")),
        "resourceScopeMigrationVersion": status.get("resourceScopeMigrationVersion"),
        "resourceScopeMigrationChecksum": status.get("resourceScopeMigrationChecksum") or "",
        "resourceScopeMigrationDrift": status.get("resourceScopeMigrationDrift"),
        "resourceScopeMissing": status.get("resourceScopeMissing"),
        "resourceScopeOrphans": status.get("resourceScopeOrphans"),
        "resourceScopeInvalidTargets": status.get("resourceScopeInvalidTargets"),
        "privateMediaSchemaVersion": status.get("privateMediaSchemaVersion"),
        "privateMediaMigration": bool(status.get("privateMediaMigration")),
        "privateMediaMigrationVersion": status.get("privateMediaMigrationVersion"),
        "privateMediaMigrationChecksum": status.get("privateMediaMigrationChecksum") or "",
        "error": status.get("error") or "",
    }


def _add_acg_confirmations(command):
    command.add_argument("--confirm-schema-version", type=int, required=True)
    command.add_argument("--confirm-identity", required=True)
    command.add_argument("--confirm-owner-username", required=True)
    command.add_argument("--confirm-team-id", required=True)


def _add_resource_confirmations(command):
    command.add_argument("--confirm-schema-version", type=int, required=True)
    command.add_argument("--confirm-identity", required=True)


def _add_resource_override_confirmation(command):
    command.add_argument(
        "--override-manifest",
        type=Path,
        default=None,
        help=(
            "operator-reviewed acg-resource-scope-overrides-v1 manifest; "
            "required only when preflight reports override-eligible unresolved resources"
        ),
    )
    command.add_argument(
        "--confirm-override-manifest-sha256",
        default="",
        help="independently recorded SHA-256 of the exact override manifest file",
    )


def _add_media_override_confirmation(command):
    command.add_argument(
        "--override-manifest",
        type=Path,
        default=None,
        help="operator-reviewed acg-private-media-overrides-v1 manifest",
    )
    command.add_argument(
        "--confirm-override-manifest-sha256",
        default="",
        help="independently recorded SHA-256 of the exact media override file",
    )


def _add_runtime_snapshot_confirmation(command, *, required):
    command.add_argument(
        "--runtime-snapshot",
        type=Path,
        required=required,
        default=None,
        help="verified acg-runtime-snapshot-v1 root containing protected media",
    )
    command.add_argument(
        "--confirm-runtime-snapshot-manifest-sha256",
        required=required,
        default="",
        help="independently recorded SHA-256 of snapshot.manifest.json",
    )


def _verified_runtime_snapshot_binding(args, *, required):
    root = getattr(args, "runtime_snapshot", None)
    expected = str(
        getattr(args, "confirm_runtime_snapshot_manifest_sha256", "") or ""
    ).strip().lower()
    if root is None and not expected and not required:
        return None
    if root is None or not expected:
        raise store.StoreNotReadyError(
            "runtime snapshot path and confirmed manifest sha256 are required"
        )
    verified = runtime_snapshot.verify_snapshot(
        root,
        expected_manifest_sha256=expected,
    )
    actual = str(verified.get("manifestSha256") or "").strip().lower()
    if not hmac.compare_digest(expected, actual):
        raise store.StoreNotReadyError(
            "runtime snapshot confirmed manifest sha256 mismatch"
        )
    if (
        config.is_production()
        and verified.get("profile") != runtime_snapshot.PRODUCTION_COMPLETE_PROFILE
    ):
        raise store.StoreNotReadyError(
            "production-complete runtime snapshot is required"
        )
    return {
        "format": "acg-runtime-snapshot-binding-v1",
        "verified": True,
        "profile": str(verified.get("profile") or ""),
        "manifestSha256": actual,
        "componentNames": sorted(set(verified.get("componentNames") or [])),
        "mediaInventoryDigest": str(
            verified.get("mediaInventoryDigest") or ""
        ).strip().lower(),
    }


def _add_backup_confirmation(command, *, required=True):
    command.add_argument(
        "--backup-manifest",
        type=Path,
        required=required,
        default=None,
        help="verified acg-sqlite-backup-v2 manifest for this frozen database state",
    )
    command.add_argument(
        "--backup-database",
        type=Path,
        required=required,
        default=None,
        help="closed SQLite artifact referenced by the backup manifest",
    )
    command.add_argument(
        "--confirm-backup-manifest-sha256",
        required=required,
        default="",
        help="independently recorded SHA-256 of the exact manifest file",
    )


def _verified_backup_binding(args, *, required):
    manifest = getattr(args, "backup_manifest", None)
    database = getattr(args, "backup_database", None)
    digest = str(
        getattr(args, "confirm_backup_manifest_sha256", "") or ""
    ).strip()
    supplied = bool(manifest is not None or database is not None or digest)
    if not supplied and not required:
        return None
    if manifest is None or database is None or not digest:
        raise store.StoreNotReadyError(
            "backup manifest, database and confirmed sha256 are required"
        )
    return consistent_sqlite_backup.verify_backup_manifest(
        manifest,
        database,
        expected_manifest_sha256=digest,
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m server.migrations")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("status", help="read-only schema and ledger status")
    apply_parser = subparsers.add_parser("apply", help="apply expand-only schema migration")
    apply_parser.add_argument("--confirm-version", type=int, required=True)
    apply_parser.add_argument(
        "--confirm-identity",
        required=True,
        help="database identity printed by the immediately preceding status command",
    )
    _add_backup_confirmation(apply_parser)
    acg_preflight = subparsers.add_parser(
        "acg-preflight", help="read-only ACG internal-team migration dry-run"
    )
    _add_acg_confirmations(acg_preflight)
    acg_apply = subparsers.add_parser(
        "acg-apply", help="apply the frozen ACG internal-team migration scope"
    )
    _add_acg_confirmations(acg_apply)
    _add_backup_confirmation(acg_apply)
    resource_preflight = subparsers.add_parser(
        "resource-preflight", help="read-only legacy resource ownership dry-run"
    )
    _add_resource_confirmations(resource_preflight)
    _add_resource_override_confirmation(resource_preflight)
    _add_backup_confirmation(resource_preflight, required=False)
    resource_apply = subparsers.add_parser(
        "resource-apply", help="freeze deny-by-default legacy resource ownership"
    )
    _add_resource_confirmations(resource_apply)
    _add_resource_override_confirmation(resource_apply)
    _add_backup_confirmation(resource_apply)
    media_preflight = subparsers.add_parser(
        "media-preflight", help="read-only private media ownership dry-run"
    )
    _add_resource_confirmations(media_preflight)
    _add_media_override_confirmation(media_preflight)
    _add_runtime_snapshot_confirmation(media_preflight, required=False)
    _add_backup_confirmation(media_preflight, required=False)
    media_apply = subparsers.add_parser(
        "media-apply", help="freeze deny-by-default private media ownership"
    )
    _add_resource_confirmations(media_apply)
    _add_media_override_confirmation(media_apply)
    _add_runtime_snapshot_confirmation(media_apply, required=True)
    _add_backup_confirmation(media_apply)
    args = parser.parse_args(argv)

    if args.command == "status":
        status = _safe_status()
        print(json.dumps(status, ensure_ascii=False, sort_keys=True))
        return 0 if status["ok"] else 2

    try:
        if args.command == "apply":
            if str(os.getenv("ACG_ALLOW_SCHEMA_MIGRATION", "")).strip() != "1":
                parser.error("ACG_ALLOW_SCHEMA_MIGRATION=1 is required")
            backup_binding = consistent_sqlite_backup.verify_backup_manifest(
                args.backup_manifest,
                args.backup_database,
                expected_manifest_sha256=args.confirm_backup_manifest_sha256,
            )
            result = store.apply_schema_migrations(
                expected_identity=args.confirm_identity,
                backup_binding=backup_binding,
                migration_version=args.confirm_version,
            )
        elif args.command == "acg-preflight":
            result = store.acg_internal_team_migration_preflight(
                expected_identity=args.confirm_identity,
                owner_username=args.confirm_owner_username,
                team_id=args.confirm_team_id,
                expected_schema_version=args.confirm_schema_version,
            )
        elif args.command == "acg-apply":
            if str(os.getenv("ACG_ALLOW_ACG_TEAM_MIGRATION", "")).strip() != "1":
                parser.error("ACG_ALLOW_ACG_TEAM_MIGRATION=1 is required")
            backup_binding = consistent_sqlite_backup.verify_backup_manifest(
                args.backup_manifest,
                args.backup_database,
                expected_manifest_sha256=args.confirm_backup_manifest_sha256,
            )
            result = store.apply_acg_internal_team_migration(
                expected_identity=args.confirm_identity,
                owner_username=args.confirm_owner_username,
                team_id=args.confirm_team_id,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=backup_binding,
            )
        elif args.command == "resource-preflight":
            backup_binding = _verified_backup_binding(
                args,
                required=bool(
                    args.override_manifest
                    or args.confirm_override_manifest_sha256
                ),
            )
            result = store.resource_scope_migration_preflight(
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                override_manifest_path=args.override_manifest or "",
                expected_override_manifest_sha256=(
                    args.confirm_override_manifest_sha256
                ),
                backup_binding=backup_binding,
            )
        elif args.command == "resource-apply":
            if str(os.getenv("ACG_ALLOW_RESOURCE_SCOPE_MIGRATION", "")).strip() != "1":
                parser.error("ACG_ALLOW_RESOURCE_SCOPE_MIGRATION=1 is required")
            backup_binding = consistent_sqlite_backup.verify_backup_manifest(
                args.backup_manifest,
                args.backup_database,
                expected_manifest_sha256=args.confirm_backup_manifest_sha256,
            )
            result = store.apply_resource_scope_migration(
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=backup_binding,
                override_manifest_path=args.override_manifest or "",
                expected_override_manifest_sha256=(
                    args.confirm_override_manifest_sha256
                ),
            )
        elif args.command == "media-preflight":
            override_requested = bool(
                args.override_manifest
                or args.confirm_override_manifest_sha256
            )
            backup_binding = _verified_backup_binding(
                args, required=override_requested,
            )
            runtime_snapshot_binding = _verified_runtime_snapshot_binding(
                args,
                required=override_requested,
            )
            result = store.private_media_migration_preflight(
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                override_manifest_path=args.override_manifest or "",
                expected_override_manifest_sha256=(
                    args.confirm_override_manifest_sha256
                ),
                runtime_snapshot_binding=runtime_snapshot_binding,
                backup_binding=backup_binding,
            )
        else:
            if str(os.getenv("ACG_ALLOW_PRIVATE_MEDIA_MIGRATION", "")).strip() != "1":
                parser.error("ACG_ALLOW_PRIVATE_MEDIA_MIGRATION=1 is required")
            backup_binding = consistent_sqlite_backup.verify_backup_manifest(
                args.backup_manifest,
                args.backup_database,
                expected_manifest_sha256=args.confirm_backup_manifest_sha256,
            )
            runtime_snapshot_binding = _verified_runtime_snapshot_binding(
                args, required=True,
            )
            result = store.apply_private_media_migration(
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=backup_binding,
                override_manifest_path=args.override_manifest or "",
                expected_override_manifest_sha256=(
                    args.confirm_override_manifest_sha256
                ),
                runtime_snapshot_binding=runtime_snapshot_binding,
            )
    except (
        FileNotFoundError, OSError, sqlite3.Error, store.StoreNotReadyError,
        runtime_snapshot.SnapshotError, ValueError,
    ) as exc:
        print(json.dumps({
            "ok": False,
            "error": type(exc).__name__,
            "reason": str(exc)[:240],
        }, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("ok", True) else 2


if __name__ == "__main__":
    raise SystemExit(main())
