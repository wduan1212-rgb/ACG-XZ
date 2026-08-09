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

Files created after the frozen 140004 migration use a separate, snapshot-bound
incremental settlement and never replay the historical ownership migration::

    ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT=1 \
      python -m server.migrations media-settle <confirmations>
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
from .. import model_usage_settlement  # noqa: E402
from .. import model_usage_settlement_v2  # noqa: E402
from .. import production_recovery  # noqa: E402
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
        "videoComposeSchemaVersion": status.get("videoComposeSchemaVersion"),
        "videoComposeSchemaChecksum": status.get("videoComposeSchemaChecksum") or "",
        "memberControlSchemaVersion": status.get("memberControlSchemaVersion"),
        "memberControlSchemaChecksum": status.get("memberControlSchemaChecksum") or "",
        "modelUsageSettlementSchemaVersion": status.get(
            "modelUsageSettlementSchemaVersion"
        ),
        "modelUsageSettlementSchemaChecksum": status.get(
            "modelUsageSettlementSchemaChecksum"
        ) or "",
        "productionRecoverySchemaVersion": status.get(
            "productionRecoverySchemaVersion"
        ),
        "productionRecoverySchemaChecksum": status.get(
            "productionRecoverySchemaChecksum"
        ) or "",
        "modelUsageSettlementV2SchemaVersion": status.get(
            "modelUsageSettlementV2SchemaVersion"
        ),
        "modelUsageSettlementV2SchemaChecksum": status.get(
            "modelUsageSettlementV2SchemaChecksum"
        ) or "",
        "mediaIsolationSchemaVersion": status.get("mediaIsolationSchemaVersion"),
        "mediaIsolationSchemaChecksum": status.get("mediaIsolationSchemaChecksum") or "",
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


def _add_usage_settlement_plan_confirmation(command):
    command.add_argument(
        "--review-plan",
        type=Path,
        required=True,
        help="exact operator-reviewed acg-model-usage-settlement-plan-v1 file",
    )


def _add_usage_settlement_v2_plan_confirmation(command):
    command.add_argument(
        "--review-plan",
        type=Path,
        required=True,
        help="exact operator-reviewed acg-model-usage-settlement-plan-v2 file",
    )
    command.add_argument(
        "--confirm-review-plan-sha256",
        required=True,
        help="independently recorded SHA-256 of the exact reviewed plan bytes",
    )


def _add_recovery_plan_confirmation(command, *, help_text):
    command.add_argument("--review-plan", type=Path, required=True, help=help_text)
    command.add_argument(
        "--confirm-review-plan-sha256", required=True,
        help="independently recorded SHA-256 of the exact reviewed plan bytes",
    )


def _verified_usage_settlement_inputs(args):
    plan, plan_sha256 = model_usage_settlement.load_review_plan(
        args.review_plan,
        expected_sha256=args.confirm_review_plan_sha256,
    )
    backup_binding = _verified_backup_binding(args, required=True)
    runtime_snapshot_binding = _verified_runtime_snapshot_binding(
        args, required=True,
    )
    operation_ids = [entry["operationId"] for entry in plan["entries"]]
    sidecar_receipts = model_usage_settlement.extract_sidecar_receipts(
        args.runtime_snapshot,
        operation_ids,
    )
    model_usage_settlement.verify_sidecar_hashes(plan, sidecar_receipts)
    return plan, plan_sha256, sidecar_receipts, backup_binding, runtime_snapshot_binding


def _verified_usage_settlement_v2_inputs(args):
    plan, plan_sha256 = model_usage_settlement_v2.load_review_plan(
        args.review_plan,
        expected_sha256=args.confirm_review_plan_sha256,
    )
    backup_binding = _verified_backup_binding(args, required=True)
    runtime_snapshot_binding = _verified_runtime_snapshot_binding(
        args, required=True,
    )
    sidecar_receipts = model_usage_settlement_v2.extract_and_verify_sidecars(
        args.runtime_snapshot, plan,
    )
    return plan, plan_sha256, sidecar_receipts, backup_binding, runtime_snapshot_binding


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
    media_settle = subparsers.add_parser(
        "media-settle",
        help="settle deterministic post-140004 private media registrations",
    )
    _add_resource_confirmations(media_settle)
    _add_runtime_snapshot_confirmation(media_settle, required=True)
    _add_backup_confirmation(media_settle)
    usage_inspect = subparsers.add_parser(
        "usage-settle-inspect",
        help="read exact central and snapshot receipt hashes for named operations",
    )
    usage_inspect.add_argument(
        "--operation-id", action="append", required=True,
        help="exact video-workshop operation ID; repeat for every reviewed operation",
    )
    _add_runtime_snapshot_confirmation(usage_inspect, required=True)
    usage_preflight = subparsers.add_parser(
        "usage-settle-preflight",
        help="validate one exact reviewed model-usage settlement plan without writes",
    )
    _add_resource_confirmations(usage_preflight)
    _add_usage_settlement_plan_confirmation(usage_preflight)
    _add_runtime_snapshot_confirmation(usage_preflight, required=True)
    _add_backup_confirmation(usage_preflight)
    usage_settle = subparsers.add_parser(
        "usage-settle",
        help="atomically settle only exact reviewed model-usage operations",
    )
    _add_resource_confirmations(usage_settle)
    _add_usage_settlement_plan_confirmation(usage_settle)
    _add_runtime_snapshot_confirmation(usage_settle, required=True)
    _add_backup_confirmation(usage_settle)
    usage_v2_inspect = subparsers.add_parser(
        "usage-settle-v2-inspect",
        help="read exact mixed-source central and snapshot receipt hashes",
    )
    usage_v2_inspect.add_argument(
        "--receipt-id", action="append", required=True,
        help="exact central receipt ID; repeat for the complete reviewed set",
    )
    _add_runtime_snapshot_confirmation(usage_v2_inspect, required=True)
    usage_v2_preflight = subparsers.add_parser(
        "usage-settle-v2-preflight",
        help="validate one exact mixed-source reviewed usage plan without writes",
    )
    _add_resource_confirmations(usage_v2_preflight)
    _add_usage_settlement_v2_plan_confirmation(usage_v2_preflight)
    _add_runtime_snapshot_confirmation(usage_v2_preflight, required=True)
    _add_backup_confirmation(usage_v2_preflight)
    usage_v2_settle = subparsers.add_parser(
        "usage-settle-v2",
        help="atomically settle exact central/sidecar receipts without provider calls",
    )
    _add_resource_confirmations(usage_v2_settle)
    _add_usage_settlement_v2_plan_confirmation(usage_v2_settle)
    _add_runtime_snapshot_confirmation(usage_v2_settle, required=True)
    _add_backup_confirmation(usage_v2_settle)
    video_usage_recover_inspect = subparsers.add_parser(
        "video-usage-recover-inspect",
        help="inspect exact durable sidecar completions missing from central usage",
    )
    _add_resource_confirmations(video_usage_recover_inspect)
    _add_runtime_snapshot_confirmation(video_usage_recover_inspect, required=True)
    _add_backup_confirmation(video_usage_recover_inspect)
    video_usage_recover_preflight = subparsers.add_parser(
        "video-usage-recover-preflight",
        help="validate an exact reviewed sidecar-to-central recovery plan",
    )
    _add_resource_confirmations(video_usage_recover_preflight)
    _add_recovery_plan_confirmation(
        video_usage_recover_preflight,
        help_text="operator-reviewed acg-video-workshop-usage-recovery-plan-v1",
    )
    _add_runtime_snapshot_confirmation(video_usage_recover_preflight, required=True)
    _add_backup_confirmation(video_usage_recover_preflight)
    video_usage_recover = subparsers.add_parser(
        "video-usage-recover",
        help="atomically import exact durable sidecar completions without provider calls",
    )
    _add_resource_confirmations(video_usage_recover)
    _add_recovery_plan_confirmation(
        video_usage_recover,
        help_text="operator-reviewed acg-video-workshop-usage-recovery-plan-v1",
    )
    _add_runtime_snapshot_confirmation(video_usage_recover, required=True)
    _add_backup_confirmation(video_usage_recover)
    resource_settle_preflight = subparsers.add_parser(
        "resource-settle-preflight",
        help="preview deterministic post-140002 canvas job scopes",
    )
    _add_resource_confirmations(resource_settle_preflight)
    _add_runtime_snapshot_confirmation(resource_settle_preflight, required=True)
    _add_backup_confirmation(resource_settle_preflight)
    resource_settle = subparsers.add_parser(
        "resource-settle",
        help="atomically add only deterministic post-140002 canvas job scopes",
    )
    _add_resource_confirmations(resource_settle)
    _add_runtime_snapshot_confirmation(resource_settle, required=True)
    _add_backup_confirmation(resource_settle)
    tenant_settle_preflight = subparsers.add_parser(
        "tenant-settle-preflight",
        help="preview strict personal-to-team scope and media adoption",
    )
    _add_resource_confirmations(tenant_settle_preflight)
    _add_runtime_snapshot_confirmation(tenant_settle_preflight, required=True)
    _add_backup_confirmation(tenant_settle_preflight)
    tenant_settle = subparsers.add_parser(
        "tenant-settle",
        help="atomically adopt verified personal scopes and media into one team",
    )
    _add_resource_confirmations(tenant_settle)
    _add_runtime_snapshot_confirmation(tenant_settle, required=True)
    _add_backup_confirmation(tenant_settle)
    canvas_recover_preflight = subparsers.add_parser(
        "canvas-recover-preflight",
        help="preview exact evidence-bound missing canvas blob recovery",
    )
    _add_resource_confirmations(canvas_recover_preflight)
    _add_recovery_plan_confirmation(
        canvas_recover_preflight,
        help_text="operator-reviewed acg-canvas-blob-recovery-plan-v1",
    )
    _add_runtime_snapshot_confirmation(canvas_recover_preflight, required=True)
    _add_backup_confirmation(canvas_recover_preflight)
    canvas_recover = subparsers.add_parser(
        "canvas-recover",
        help="restore only exact verified canvas blobs without overwrite",
    )
    _add_resource_confirmations(canvas_recover)
    _add_recovery_plan_confirmation(
        canvas_recover,
        help_text="operator-reviewed acg-canvas-blob-recovery-plan-v1",
    )
    _add_runtime_snapshot_confirmation(canvas_recover, required=True)
    _add_backup_confirmation(canvas_recover)
    incident_preflight = subparsers.add_parser(
        "incident-adjudicate-preflight",
        help="validate the exact non-resolving missing-media adjudication set",
    )
    _add_resource_confirmations(incident_preflight)
    _add_recovery_plan_confirmation(
        incident_preflight,
        help_text="operator-reviewed acg-production-incident-adjudication-plan-v1",
    )
    _add_runtime_snapshot_confirmation(incident_preflight, required=True)
    _add_backup_confirmation(incident_preflight)
    incident_apply = subparsers.add_parser(
        "incident-adjudicate",
        help="record immutable adjudications without changing readiness",
    )
    _add_resource_confirmations(incident_apply)
    _add_recovery_plan_confirmation(
        incident_apply,
        help_text="operator-reviewed acg-production-incident-adjudication-plan-v1",
    )
    _add_runtime_snapshot_confirmation(incident_apply, required=True)
    _add_backup_confirmation(incident_apply)
    media_isolation_inspect = subparsers.add_parser(
        "media-isolate-inspect",
        help="inspect exact current missing-media isolation evidence",
    )
    _add_resource_confirmations(media_isolation_inspect)
    _add_runtime_snapshot_confirmation(media_isolation_inspect, required=True)
    _add_backup_confirmation(media_isolation_inspect)
    media_isolation_preflight = subparsers.add_parser(
        "media-isolate-preflight",
        help="validate one exact user-authorized media isolation plan",
    )
    _add_resource_confirmations(media_isolation_preflight)
    _add_recovery_plan_confirmation(
        media_isolation_preflight,
        help_text="operator-reviewed acg-production-media-isolation-plan-v1",
    )
    _add_runtime_snapshot_confirmation(media_isolation_preflight, required=True)
    _add_backup_confirmation(media_isolation_preflight)
    media_isolation_apply = subparsers.add_parser(
        "media-isolate",
        help="record exact immutable isolation receipts without changing media/docs",
    )
    _add_resource_confirmations(media_isolation_apply)
    _add_recovery_plan_confirmation(
        media_isolation_apply,
        help_text="operator-reviewed acg-production-media-isolation-plan-v1",
    )
    _add_runtime_snapshot_confirmation(media_isolation_apply, required=True)
    _add_backup_confirmation(media_isolation_apply)
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
        elif args.command == "media-apply":
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
        elif args.command == "media-settle":
            if str(os.getenv("ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT", "")).strip() != "1":
                parser.error("ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT=1 is required")
            backup_binding = _verified_backup_binding(args, required=True)
            runtime_snapshot_binding = _verified_runtime_snapshot_binding(
                args, required=True,
            )
            result = store.settle_private_media_registry_incremental(
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=backup_binding,
                runtime_snapshot_binding=runtime_snapshot_binding,
            )
        elif args.command == "usage-settle-inspect":
            runtime_snapshot_binding = _verified_runtime_snapshot_binding(
                args, required=True,
            )
            operation_ids = sorted(set(args.operation_id or []))
            if len(operation_ids) != len(args.operation_id or []):
                raise model_usage_settlement.SettlementPlanError(
                    "inspection_operation_id_duplicate"
                )
            sidecar_receipts = model_usage_settlement.extract_sidecar_receipts(
                args.runtime_snapshot,
                operation_ids,
            )
            central = store.model_usage_settlement_evidence(operation_ids)
            central_by_id = {
                item["operationId"]: item for item in central["entries"]
            }
            result = {
                "ok": True,
                "dryRun": True,
                "databaseIdentity": central["databaseIdentity"],
                "snapshotManifestSha256": runtime_snapshot_binding["manifestSha256"],
                "snapshotMediaInventoryDigest": runtime_snapshot_binding[
                    "mediaInventoryDigest"
                ],
                "entries": [
                    {
                        **central_by_id[operation_id],
                        "sidecarReceiptSha256": model_usage_settlement.canonical_sha256(
                            sidecar_receipts[operation_id]
                        ),
                        "sidecarStatus": str(
                            sidecar_receipts[operation_id].get("status") or ""
                        ),
                        "sidecarProviderRefPresent": bool(
                            sidecar_receipts[operation_id].get("providerRef")
                        ),
                    }
                    for operation_id in operation_ids
                ],
            }
        elif args.command in {"usage-settle-preflight", "usage-settle"}:
            if (
                args.command == "usage-settle"
                and str(os.getenv("ACG_ALLOW_MODEL_USAGE_SETTLEMENT", "")).strip()
                != "1"
            ):
                parser.error("ACG_ALLOW_MODEL_USAGE_SETTLEMENT=1 is required")
            (
                plan,
                plan_sha256,
                sidecar_receipts,
                backup_binding,
                runtime_snapshot_binding,
            ) = _verified_usage_settlement_inputs(args)
            result = store.settle_model_usage_receipts_reviewed(
                plan=plan,
                plan_sha256=plan_sha256,
                sidecar_receipts=sidecar_receipts,
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=backup_binding,
                runtime_snapshot_binding=runtime_snapshot_binding,
                created_by=plan.get("reviewedBy") or "deployment",
                dry_run=args.command == "usage-settle-preflight",
            )
        elif args.command == "usage-settle-v2-inspect":
            runtime_snapshot_binding = _verified_runtime_snapshot_binding(
                args, required=True,
            )
            receipt_ids = sorted(set(args.receipt_id or []))
            if len(receipt_ids) != len(args.receipt_id or []):
                raise model_usage_settlement_v2.SettlementPlanV2Error(
                    "inspection_receipt_id_duplicate"
                )
            central = store.model_usage_settlement_v2_evidence(receipt_ids)
            sidecar_operations = [
                entry["operationId"] for entry in central["entries"]
                if entry["source"] == model_usage_settlement_v2.SIDECAR_SOURCE
            ]
            sidecars = (
                model_usage_settlement.extract_sidecar_receipts(
                    args.runtime_snapshot, sidecar_operations,
                ) if sidecar_operations else {}
            )
            result = {
                "ok": True,
                "dryRun": True,
                "databaseIdentity": central["databaseIdentity"],
                "snapshotManifestSha256": runtime_snapshot_binding["manifestSha256"],
                "snapshotMediaInventoryDigest": runtime_snapshot_binding[
                    "mediaInventoryDigest"
                ],
                "entries": [
                    {
                        **entry,
                        "sidecarReceiptSha256": (
                            model_usage_settlement_v2.canonical_sha256(
                                sidecars[entry["operationId"]]
                            ) if entry["source"] == model_usage_settlement_v2.SIDECAR_SOURCE
                            else ""
                        ),
                        "sidecarStatus": (
                            str(sidecars[entry["operationId"]].get("status") or "")
                            if entry["source"] == model_usage_settlement_v2.SIDECAR_SOURCE
                            else ""
                        ),
                    }
                    for entry in central["entries"]
                ],
            }
        elif args.command in {"usage-settle-v2-preflight", "usage-settle-v2"}:
            if (
                args.command == "usage-settle-v2"
                and str(os.getenv("ACG_ALLOW_MODEL_USAGE_SETTLEMENT_V2", "")).strip()
                != "1"
            ):
                parser.error("ACG_ALLOW_MODEL_USAGE_SETTLEMENT_V2=1 is required")
            (
                plan,
                plan_sha256,
                sidecar_receipts,
                backup_binding,
                runtime_snapshot_binding,
            ) = _verified_usage_settlement_v2_inputs(args)
            result = store.settle_model_usage_receipts_reviewed_v2(
                plan=plan,
                plan_sha256=plan_sha256,
                sidecar_receipts=sidecar_receipts,
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=backup_binding,
                runtime_snapshot_binding=runtime_snapshot_binding,
                created_by=plan.get("reviewedBy") or "deployment",
                dry_run=args.command == "usage-settle-v2-preflight",
            )
        elif args.command == "video-usage-recover-inspect":
            project_root = Path(
                str(os.getenv("VIDEO_WORKSHOP_PROJECTS_DIR", "")).strip()
            ).expanduser()
            result = store.video_workshop_usage_recovery_evidence(
                project_root,
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=_verified_backup_binding(args, required=True),
                runtime_snapshot_binding=_verified_runtime_snapshot_binding(
                    args, required=True,
                ),
            )
        elif args.command in {
            "video-usage-recover-preflight", "video-usage-recover",
        }:
            if (
                args.command == "video-usage-recover"
                and str(
                    os.getenv("ACG_ALLOW_VIDEO_WORKSHOP_USAGE_RECOVERY", "")
                ).strip() != "1"
            ):
                parser.error(
                    "ACG_ALLOW_VIDEO_WORKSHOP_USAGE_RECOVERY=1 is required"
                )
            plan, plan_sha256 = production_recovery.load_review_plan(
                args.review_plan,
                expected_sha256=args.confirm_review_plan_sha256,
                expected_format=store.VIDEO_WORKSHOP_USAGE_RECOVERY_PLAN_FORMAT,
            )
            operation_ids = [
                str(entry.get("operationId") or "")
                for entry in list(plan.get("entries") or [])
                if isinstance(entry, dict)
            ]
            sidecar_receipts = model_usage_settlement.extract_sidecar_receipts(
                args.runtime_snapshot, operation_ids,
            )
            result = store.recover_video_workshop_usage_reviewed(
                plan=plan,
                plan_sha256=plan_sha256,
                sidecar_receipts=sidecar_receipts,
                project_root=Path(
                    str(os.getenv("VIDEO_WORKSHOP_PROJECTS_DIR", "")).strip()
                ).expanduser(),
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=_verified_backup_binding(args, required=True),
                runtime_snapshot_binding=_verified_runtime_snapshot_binding(
                    args, required=True,
                ),
                created_by=plan.get("reviewedBy") or "deployment",
                dry_run=args.command == "video-usage-recover-preflight",
            )
        elif args.command in {
            "resource-settle-preflight", "resource-settle",
            "tenant-settle-preflight", "tenant-settle",
        }:
            backup_binding = _verified_backup_binding(args, required=True)
            runtime_snapshot_binding = _verified_runtime_snapshot_binding(
                args, required=True,
            )
            if args.command.startswith("resource-"):
                result = production_recovery.settle_resource_scopes_incremental(
                    expected_identity=args.confirm_identity,
                    expected_schema_version=args.confirm_schema_version,
                    backup_binding=backup_binding,
                    runtime_snapshot_binding=runtime_snapshot_binding,
                    dry_run=args.command.endswith("preflight"),
                )
            else:
                result = production_recovery.settle_tenant_adoptions(
                    expected_identity=args.confirm_identity,
                    expected_schema_version=args.confirm_schema_version,
                    backup_binding=backup_binding,
                    runtime_snapshot_binding=runtime_snapshot_binding,
                    dry_run=args.command.endswith("preflight"),
                )
        elif args.command in {"canvas-recover-preflight", "canvas-recover"}:
            plan, plan_sha256 = production_recovery.load_review_plan(
                args.review_plan,
                expected_sha256=args.confirm_review_plan_sha256,
                expected_format=production_recovery.CANVAS_RECOVERY_PLAN_FORMAT,
            )
            result = production_recovery.recover_canvas_blobs_reviewed(
                plan=plan, plan_sha256=plan_sha256,
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=_verified_backup_binding(args, required=True),
                runtime_snapshot_binding=_verified_runtime_snapshot_binding(
                    args, required=True,
                ),
                created_by=plan.get("reviewedBy") or "deployment",
                dry_run=args.command.endswith("preflight"),
            )
        elif args.command in {
            "incident-adjudicate-preflight", "incident-adjudicate",
        }:
            plan, plan_sha256 = production_recovery.load_review_plan(
                args.review_plan,
                expected_sha256=args.confirm_review_plan_sha256,
                expected_format=production_recovery.INCIDENT_ADJUDICATION_PLAN_FORMAT,
            )
            result = production_recovery.record_incident_adjudications(
                plan=plan, plan_sha256=plan_sha256,
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=_verified_backup_binding(args, required=True),
                runtime_snapshot_binding=_verified_runtime_snapshot_binding(
                    args, required=True,
                ),
                created_by=plan.get("reviewedBy") or "deployment",
                dry_run=args.command.endswith("preflight"),
            )
        elif args.command == "media-isolate-inspect":
            result = production_recovery.media_isolation_evidence(
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=_verified_backup_binding(args, required=True),
                runtime_snapshot_binding=_verified_runtime_snapshot_binding(
                    args, required=True,
                ),
            )
        elif args.command in {"media-isolate-preflight", "media-isolate"}:
            if (
                args.command == "media-isolate"
                and str(os.getenv("ACG_ALLOW_MEDIA_ISOLATION", "")).strip() != "1"
            ):
                parser.error("ACG_ALLOW_MEDIA_ISOLATION=1 is required")
            plan, plan_sha256 = production_recovery.load_review_plan(
                args.review_plan,
                expected_sha256=args.confirm_review_plan_sha256,
                expected_format=production_recovery.MEDIA_ISOLATION_PLAN_FORMAT,
            )
            result = production_recovery.isolate_missing_media_reviewed(
                plan=plan, plan_sha256=plan_sha256,
                expected_identity=args.confirm_identity,
                expected_schema_version=args.confirm_schema_version,
                backup_binding=_verified_backup_binding(args, required=True),
                runtime_snapshot_binding=_verified_runtime_snapshot_binding(
                    args, required=True,
                ),
                created_by=plan.get("reviewedBy") or "deployment",
                dry_run=args.command.endswith("preflight"),
            )
        else:
            raise ValueError("unsupported migration command")
    except (
        FileNotFoundError, OSError, sqlite3.Error, store.StoreNotReadyError,
        runtime_snapshot.SnapshotError,
        model_usage_settlement.SettlementPlanError,
        model_usage_settlement_v2.SettlementPlanV2Error,
        production_recovery.ProductionRecoveryError,
        ValueError,
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
