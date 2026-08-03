"""Auditable, opt-in schema migration CLI.

Examples::

    python -m server.migrations status
    ACG_ALLOW_SCHEMA_MIGRATION=1 python -m server.migrations apply \
        --confirm-version 139001 --confirm-identity <status identity>

The apply command is expand-only.  It does not migrate ACG ownership, seed
accounts, normalize roles, or update credentials.

ACG ownership is a separate dry-run/apply pair::

    python -m server.migrations acg-preflight <confirmations>
    ACG_ALLOW_ACG_TEAM_MIGRATION=1 \
      python -m server.migrations acg-apply <same confirmations>
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .. import config

# Config must be loaded before store freezes DATA_DB/CUSTOM_CANVAS_BLOB_DIR.
config.load_environment()
from .. import store  # noqa: E402


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
        "error": status.get("error") or "",
    }


def _add_acg_confirmations(command):
    command.add_argument("--confirm-schema-version", type=int, required=True)
    command.add_argument("--confirm-identity", required=True)
    command.add_argument("--confirm-owner-username", required=True)
    command.add_argument("--confirm-team-id", required=True)


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
    acg_preflight = subparsers.add_parser(
        "acg-preflight", help="read-only ACG internal-team migration dry-run"
    )
    _add_acg_confirmations(acg_preflight)
    acg_apply = subparsers.add_parser(
        "acg-apply", help="apply the frozen ACG internal-team migration scope"
    )
    _add_acg_confirmations(acg_apply)
    args = parser.parse_args(argv)

    if args.command == "status":
        status = _safe_status()
        print(json.dumps(status, ensure_ascii=False, sort_keys=True))
        return 0 if status["ok"] else 2

    try:
        if args.command == "apply":
            if args.confirm_version != store.LATEST_SCHEMA_MIGRATION_VERSION:
                parser.error(
                    f"--confirm-version must equal {store.LATEST_SCHEMA_MIGRATION_VERSION}"
                )
            if str(os.getenv("ACG_ALLOW_SCHEMA_MIGRATION", "")).strip() != "1":
                parser.error("ACG_ALLOW_SCHEMA_MIGRATION=1 is required")
            result = store.apply_schema_migrations(expected_identity=args.confirm_identity)
        elif args.command == "acg-preflight":
            result = store.acg_internal_team_migration_preflight(
                expected_identity=args.confirm_identity,
                owner_username=args.confirm_owner_username,
                team_id=args.confirm_team_id,
                expected_schema_version=args.confirm_schema_version,
            )
        else:
            if str(os.getenv("ACG_ALLOW_ACG_TEAM_MIGRATION", "")).strip() != "1":
                parser.error("ACG_ALLOW_ACG_TEAM_MIGRATION=1 is required")
            result = store.apply_acg_internal_team_migration(
                expected_identity=args.confirm_identity,
                owner_username=args.confirm_owner_username,
                team_id=args.confirm_team_id,
                expected_schema_version=args.confirm_schema_version,
            )
    except (store.StoreNotReadyError, ValueError) as exc:
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
